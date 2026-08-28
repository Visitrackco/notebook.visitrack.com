import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { DatabaseService } from '../database/database.service';
import { UserRepository } from '../repositories/user.repository';
import { ApiService } from './api.service';

/** Respuesta de `GET /getCompanyLogo`. */
interface CompanyLogoResponse {
  status: boolean;
  logoUrl: string | null;
  logoHash: string | null;
  error?: string;
}

/** Registro del logo guardado localmente. */
interface StoredLogo {
  GUID: string;
  blob: Blob;
  mimeType: string;
  createdAt: string;
}

/**
 * Logo de la compañía.
 *
 * ## El obstáculo: el bucket no permite CORS
 *
 * `GET /getCompanyLogo` devuelve una **URL** de S3, no la imagen. Y el bucket
 * `logocompanies` responde 200 a una petición directa pero **no envía
 * cabeceras `Access-Control-Allow-Origin`**, así que `fetch()` desde el
 * navegador falla y nunca se obtiene el binario.
 *
 * Un `<img src="...">`, en cambio, sí la muestra: las imágenes no necesitan
 * CORS para pintarse, solo para leer sus bytes.
 *
 * ## La estrategia, en dos niveles
 *
 * 1. **Mostrar la URL de inmediato.** Es lo que garantiza que el logo aparezca
 *    con conexión, hoy, sin depender de nada más.
 * 2. **Intentar guardar el binario** para verlo sin conexión. Si CORS lo
 *    impide, no pasa nada: se sigue usando la URL, que además queda guardada
 *    en el usuario para recordarla entre sesiones.
 *
 * Para que el logo funcione **realmente sin conexión** haría falta que el
 * backend sirva la imagen (un `/getCompanyLogoImage?companyId=` que devuelva el
 * binario) o que el bucket habilite CORS. Cualquiera de las dos hace que el
 * nivel 2 empiece a funcionar sin tocar esta clase.
 */
@Injectable({ providedIn: 'root' })
export class CompanyLogoService {
  private readonly api = inject(ApiService);
  private readonly db = inject(DatabaseService);
  private readonly users = inject(UserRepository);

  /** Store donde vive el binario. Se reutiliza el de archivos. */
  private readonly store = 'BinariesData';

  /** URL de objeto lista para poner en un `<img>`. `null` si no hay logo. */
  readonly logoUrl = signal<string | null>(null);

  /*
   * ─── Fondo del logo ─────────────────────────────────────────────────────
   *
   * Un logo con fondo transparente y trazo oscuro desaparece sobre el panel
   * oscuro: se ve un hueco donde debería estar la marca de la compañía. La
   * solución es ponerlo sobre una placa blanca, como en un membrete.
   *
   * ## Por qué no se detecta la transparencia sola
   *
   * Lo natural sería dibujarlo en un `canvas` y mirar el canal alfa. No se
   * puede: el bucket `logocompanies` **no envía cabeceras CORS** —el mismo
   * motivo por el que este servicio no logra descargar el binario— y leer los
   * píxeles de una imagen de otro origen sin permiso lanza un error de
   * seguridad. El navegador lo pinta, pero no deja mirarlo.
   *
   * Así que se decide por el formato, que sí se conoce por la extensión: JPEG
   * no admite transparencia; PNG, SVG y WEBP sí. Y por encima queda la palabra
   * del usuario, que es quien está viendo el resultado.
   */
  readonly fondoLogo = signal<'auto' | 'blanco' | 'sin'>(
    (localStorage.getItem('vt-fondo-logo') as any) ?? 'auto',
  );

  /**
   * Si la imagen resultó tener transparencia de verdad.
   *
   * `null` mientras no se sepa —que es lo habitual, ver `analizarTransparencia`—.
   */
  private readonly transparente = signal<boolean | null>(null);

  /** ¿Va sobre placa blanca? */
  readonly conPlaca = computed(() => {
    const elegido = this.fondoLogo();
    if (elegido === 'blanco') return true;
    if (elegido === 'sin') return false;

    // Si se pudo mirar la imagen, manda lo que diga.
    const medido = this.transparente();
    if (medido !== null) return medido;

    const url = (this.logoUrl() ?? '').toLowerCase();
    if (!url) return false;

    // Un blob local no dice su formato en la dirección; en la duda, placa: es
    // el caso que se ve mal, y el otro solo añade un marco discreto.
    if (url.startsWith('blob:')) return true;

    return !/\.(jpe?g)(\?|$)/.test(url);
  });

  /**
   * Intenta averiguar si la imagen tiene zonas transparentes.
   *
   * ## Por qué «intenta»
   *
   * Dibujar la imagen en un `canvas` y leer el canal alfa es la forma correcta,
   * pero solo funciona si el navegador tiene permiso para leer sus bytes. El
   * bucket `logocompanies` **no envía cabeceras CORS**, así que una imagen
   * servida desde su URL «contamina» el lienzo y `getImageData` lanza una
   * excepción de seguridad: se pinta, pero no se deja mirar.
   *
   * Sí funciona cuando la imagen es un `blob:` propio —el caso en que este
   * servicio logró descargarla— y funcionaría con todas el día que el bucket
   * habilite CORS o el backend sirva el binario. Por eso el intento se queda
   * aquí en vez de descartarse: cuando eso pase, la detección empieza a
   * funcionar sola, sin tocar nada.
   *
   * Mientras tanto falla en silencio y decide el formato, que es la mejor
   * aproximación disponible.
   */
  private analizarTransparencia(url: string): void {
    this.transparente.set(null);
    if (!url) return;

    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      try {
        // Se mira en pequeño: 64x64 basta para saber si hay alfa, y evita
        // recorrer millones de píxeles de un logo grande.
        const lado = 64;
        const lienzo = document.createElement('canvas');
        lienzo.width = lado;
        lienzo.height = lado;

        const ctx = lienzo.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;

        ctx.drawImage(img, 0, 0, lado, lado);
        const datos = ctx.getImageData(0, 0, lado, lado).data;

        // Un píxel con alfa por debajo de 250 ya es transparencia visible; el
        // umbral deja pasar el suavizado de los bordes, que casi todo PNG tiene
        // y que no significa que el fondo sea transparente.
        let translucidos = 0;
        for (let i = 3; i < datos.length; i += 4) {
          if (datos[i] < 250) translucidos++;
        }

        // Un 3% del lienzo: por debajo es antialias de contornos, por encima es
        // fondo transparente de verdad.
        this.transparente.set(translucidos > lado * lado * 0.03);
      } catch {
        // Lienzo contaminado: no se puede saber, y decide el formato.
        this.transparente.set(null);
      }
    };

    img.onerror = () => this.transparente.set(null);
    img.src = url;
  }

  /** Cambia el fondo y lo recuerda entre sesiones. */
  cambiarFondo(valor: 'auto' | 'blanco' | 'sin'): void {
    this.fondoLogo.set(valor);
    localStorage.setItem('vt-fondo-logo', valor);
  }

  /** Llave del logo de una compañía dentro del store. */
  private key(companyId: number | string): string {
    return `company-logo-${companyId}`;
  }

  /**
   * Muestra el logo con lo que haya guardado localmente.
   *
   * Prefiere el binario —se ve sin conexión— y cae a la URL recordada del
   * usuario, que al menos funciona mientras haya red. Se llama al arrancar: es
   * instantáneo y no consulta al servidor.
   */
  async loadFromCache(companyId: number | string, userId?: string): Promise<boolean> {
    try {
      const stored = await this.db.transaction(this.store, 'readonly', (tx) =>
        this.db.request<StoredLogo | undefined>(tx.objectStore(this.store).get(this.key(companyId))),
      );

      if (stored?.blob) {
        this.publish(stored.blob);
        return true;
      }

      // Sin binario (lo habitual mientras el bucket no permita CORS): se usa la
      // URL que quedó guardada la última vez.
      if (userId) {
        const user = await this.users.getByIndex('byUserID', userId);
        const remembered = user?.LogoCompany ?? '';

        if (remembered.startsWith('http')) {
          this.setUrl(remembered);
          return true;
        }
      }

      return false;
    } catch (error) {
      console.warn('[CompanyLogo] No se pudo leer el logo local', error);
      return false;
    }
  }

  /**
   * Descarga el logo si cambió y lo guarda.
   *
   * Devuelve `true` si al terminar hay un logo disponible. Nunca lanza: que
   * falle el logo no puede impedir usar la aplicación.
   */
  async refresh(companyId: number | string, userId: string): Promise<boolean> {
    try {
      const info = await firstValueFrom(
        this.api.get<CompanyLogoResponse>('/getCompanyLogo', { companyId }),
      );

      if (!info?.status || !info.logoUrl) {
        // La compañía no tiene logo configurado en Visitrack.
        return this.loadFromCache(companyId, userId);
      }

      // Se pinta ya con la URL: no depende de CORS y es lo que garantiza que
      // el logo se vea. La caché del binario viene después, si se puede.
      this.setUrl(info.logoUrl);

      // La URL queda recordada para pintarla al recargar sin volver a consultar.
      await this.users.updateCompanyLogo(userId, info.logoUrl, info.logoHash ?? '');

      // Intento de caché para uso sin conexión. Falla mientras el bucket no
      // habilite CORS, y eso no rompe nada: la URL ya está mostrándose.
      const blob = await this.download(info.logoUrl);
      if (blob) {
        await this.save(companyId, blob);
        this.publish(blob);
      }

      return true;
    } catch (error) {
      console.warn('[CompanyLogo] No se pudo actualizar el logo', error);
      return this.loadFromCache(companyId, userId);
    }
  }

  /** Libera la URL de objeto. Se llama al cerrar sesión. */
  clear(): void {
    const current = this.logoUrl();
    if (current) URL.revokeObjectURL(current);
    this.logoUrl.set(null);
  }

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Publica el blob como URL de objeto.
   *
   * Revoca la anterior antes de crear la nueva: sin eso, cada refresco dejaría
   * un blob retenido en memoria hasta recargar la página.
   */
  private publish(blob: Blob): void {
    this.revokeCurrent();
    const objeto = URL.createObjectURL(blob);
    this.logoUrl.set(objeto);
    this.analizarTransparencia(objeto);
  }

  /** Publica una URL remota tal cual. */
  private setUrl(url: string): void {
    this.revokeCurrent();
    this.logoUrl.set(url);
    this.analizarTransparencia(url);
  }

  /** Libera la URL actual solo si era un objeto creado por nosotros. */
  private revokeCurrent(): void {
    const previous = this.logoUrl();
    if (previous?.startsWith('blob:')) URL.revokeObjectURL(previous);
  }

  private async download(url: string): Promise<Blob | null> {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      return await response.blob();
    } catch {
      // Lo esperado hoy: el bucket no envía cabeceras CORS. No se registra como
      // error porque no lo es — el logo ya se está mostrando por su URL.
      return null;
    }
  }

  private async save(companyId: number | string, blob: Blob): Promise<void> {
    const record: StoredLogo = {
      GUID: this.key(companyId),
      blob,
      mimeType: blob.type || 'image/png',
      createdAt: new Date().toISOString(),
    };

    await this.db.transaction(this.store, 'readwrite', (tx) =>
      this.db.request(tx.objectStore(this.store).put(record)),
    );
  }

}
