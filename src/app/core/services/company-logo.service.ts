import { Injectable, inject, signal } from '@angular/core';
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
    this.logoUrl.set(URL.createObjectURL(blob));
  }

  /** Publica una URL remota tal cual. */
  private setUrl(url: string): void {
    this.revokeCurrent();
    this.logoUrl.set(url);
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
