import { Injectable, inject, signal } from '@angular/core';

import {
  esModoPublico,
  fondoDelEnlace,
  guardarFondoDelEnlace,
} from '../config/modo-publico';
import { SETTING_KEYS, SettingsRepository } from '../repositories/settings.repository';

/** Modo de color elegido por el usuario. */
export type ThemeMode = 'light' | 'dark' | 'system';

/** Clave del modo en `localStorage`. */
const THEME_KEY = 'visitrack.theme';
/** Clave del color de marca personalizado, en `localStorage`. */
const BRAND_KEY = 'visitrack.brandColor';
/** Clave del color de fondo de la página, en `localStorage`. */
const FONDO_KEY = 'visitrack.fondoColor';

/** Clave del color de marca en `appSettings`. */
const BRAND_SETTING = 'brand_color';
/** Clave del color de fondo en `appSettings`. */
const FONDO_SETTING = 'fondo_color';

/** Rojo corporativo. Es el punto de partida si nadie personaliza nada. */
export const DEFAULT_BRAND = '#d32029';

/**
 * Lo claro que tiene que ser un fondo para admitirse.
 *
 * ## Por que solo se aceptan tonos claros
 *
 * Porque el fondo de la pagina es lo unico que cambia: todo lo que va encima
 * —las tarjetas de las preguntas, los campos, los bordes, el menu— sigue con
 * los tonos del tema, calculados para superficies claras. Un fondo oscuro deja
 * tarjetas blancas flotando sobre negro y bordes que no se distinguen de nada.
 *
 * Podria arreglarse recalculando el tema entero a partir del color elegido, y
 * no es lo que se pidio: se pidio elegir el papel, no rehacer la aplicacion.
 *
 * 0.55 de luminancia relativa (WCAG) deja pasar los pasteles —los sugeridos
 * rondan 0.86— y hasta un gris claro (#d0d0d0, 0.63), y corta cualquier tono
 * medio: un azul de marca se queda en 0.26 y el rojo corporativo en 0.15.
 */
const FONDO_LUMINANCIA_MINIMA = 0.55;

/**
 * Fondos sugeridos.
 *
 * Tonos muy claros —y un solo oscuro— a propósito: es el papel sobre el que se
 * lee un formulario entero, no un color de marca. Un fondo saturado deja las
 * tarjetas blancas vibrando encima y cansa a las tres preguntas.
 *
 * El primero es la cadena vacía y no un color: significa «el de la aplicación»,
 * que es distinto de elegir un gris parecido — con el vacío, el modo oscuro
 * sigue funcionando solo.
 */
export const FONDO_PRESETS: readonly { name: string; value: string }[] = [
  { name: 'El de la aplicación', value: '' },
  { name: 'Blanco', value: '#ffffff' },
  { name: 'Arena', value: '#f5f1e8' },
  { name: 'Menta', value: '#eaf4ee' },
  { name: 'Cielo', value: '#eaf1f8' },
  { name: 'Lavanda', value: '#f0edf7' },
  { name: 'Rosa', value: '#fbeef0' },
];

/** Colores sugeridos en el selector del perfil. */
export const BRAND_PRESETS: readonly { name: string; value: string }[] = [
  { name: 'Rojo Visitrack', value: '#d32029' },
  { name: 'Carmesí', value: '#9f1239' },
  { name: 'Naranja', value: '#ea580c' },
  { name: 'Ámbar', value: '#b45309' },
  { name: 'Verde', value: '#15803d' },
  { name: 'Azul', value: '#1d4ed8' },
  { name: 'Índigo', value: '#4338ca' },
  { name: 'Grafito', value: '#3f3f46' },
];

/**
 * Tema de la aplicación: modo claro/oscuro y color de marca.
 *
 * ## Cómo funciona
 *
 * El tema completo se deriva de unas pocas variables CSS. Este servicio no
 * manipula estilos de componentes: escribe `data-theme` en `<html>` y
 * sobrescribe `--vt-brand*`. Todo lo demás se repinta solo, porque cada
 * componente consume esas variables en vez de definir colores propios.
 *
 * ## Dónde se guarda, y quién manda
 *
 * La preferencia se escribe en **`localStorage`** y en **IndexedDB**
 * (`appSettings`, como ajuste de dispositivo). No es redundancia por descuido:
 * el tema debe aplicarse **antes del primer render** e IndexedDB es asíncrono,
 * así que leerlo solo de ahí produciría un parpadeo de claro a oscuro al cargar.
 *
 * Al arrancar **manda `localStorage`**: es síncrono y se escribe en el mismo
 * momento en que el usuario elige, así que refleja su última decisión sin
 * margen de error. La base es el respaldo — se consulta solo cuando
 * `localStorage` no tiene el valor, por ejemplo tras limpiar el navegador.
 *
 * Es un ajuste del **dispositivo**, no de la cuenta: quien trabaja de noche
 * quiere el modo oscuro con cualquier usuario que use ese equipo.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly settings = inject(SettingsRepository);

  readonly mode = signal<ThemeMode>(this.readMode());
  readonly brandColor = signal<string>(this.readBrand());

  /**
   * Color de fondo de la página. Cadena vacía = el de la aplicación.
   *
   * Vacío y no un gris concreto: así el modo oscuro sigue resolviéndose solo,
   * que es lo que pasaría si se guardara «#f5f6f8» y alguien pasara a oscuro.
   */
  readonly fondoColor = signal<string>(this.readFondo());

  /**
   * El usuario ya eligió tema en esta sesión.
   *
   * Cierra la ventana a que la lectura asíncrona de la base —que arrancó al
   * construir el servicio— llegue tarde y pise una elección más reciente.
   */
  private userChanged = false;

  constructor() {
    this.apply();
    this.watchSystemPreference();

    // Completa lo que falte desde la base. Ver `loadFromDatabase` para la
    // política de precedencia.
    void this.loadFromDatabase();
  }

  /** Cambia el modo de color. */
  setMode(mode: ThemeMode): void {
    this.userChanged = true;

    this.mode.set(mode);
    localStorage.setItem(THEME_KEY, mode);
    this.applyMode();

    void this.persist(SETTING_KEYS.THEME, mode);
  }

  /** Alterna entre claro y oscuro. Si estaba en 'system', parte de lo actual. */
  toggleMode(): void {
    this.setMode(this.isDarkActive() ? 'light' : 'dark');
  }

  /**
   * Cambia el color de marca.
   *
   * Los tonos claro y oscuro se calculan a partir del color base, así que basta
   * con elegir uno y el resto queda coherente.
   */
  setBrandColor(hex: string): void {
    const normalized = this.normalizeHex(hex);
    if (!normalized) return;

    this.brandColor.set(normalized);
    localStorage.setItem(BRAND_KEY, normalized);
    this.applyBrand();
    void this.persist(BRAND_SETTING, normalized);
  }

  /**
   * Cambia el color de fondo de la página.
   *
   * Cadena vacía vuelve al de la aplicación, que es lo mismo que no haber
   * elegido nunca: se borra la preferencia en vez de guardar un gris.
   */
  setFondoColor(hex: string): void {
    const normalized = hex.trim() === '' ? '' : this.normalizeHex(hex);
    if (normalized === null) return;

    // Un tono oscuro se ignora en vez de aplicarse a medias: ver
    // `FONDO_LUMINANCIA_MINIMA`. Quien llama avisa; aqui solo no se hace.
    if (normalized && !this.esFondoClaro(normalized)) return;

    this.userChanged = true;

    this.fondoColor.set(normalized);

    if (normalized) localStorage.setItem(FONDO_KEY, normalized);
    else localStorage.removeItem(FONDO_KEY);

    this.applyFondo();
    void this.persist(FONDO_SETTING, normalized);
  }

  /**
   * Pinta un fondo **sin guardarlo en ninguna parte**.
   *
   * Es para el fondo que trae un enlace público: es del enlace, no de quien lo
   * abre. Guardarlo sería peor que inútil — `localStorage` se comparte entre
   * todas las pestañas del mismo origen, así que abrir un enlace con fondo
   * verde le cambiaría el fondo a la sesión que esa persona tenga abierta al
   * lado. La base pública sí está aislada; `localStorage` no.
   */
  aplicarFondoDeEnlace(hex: string): void {
    const normalized = this.normalizeHex(hex);
    if (!normalized) return;

    /*
     * Tambien se comprueba lo que trae el enlace.
     *
     * Module ya no deja guardar un fondo oscuro, pero un enlace creado antes de
     * esa regla puede tener uno, y quien lo abre no tiene forma de arreglarlo:
     * se quedaria con un formulario ilegible y sin ningun ajuste a mano. Mejor
     * el gris de siempre.
     */
    if (!this.esFondoClaro(normalized)) {
      console.warn(
        '[Enlace] el color de fondo es demasiado oscuro y se ignora:',
        normalized,
      );
      return;
    }

    this.fondoColor.set(normalized);
    this.applyFondo();

    /*
     * Y se apunta en la pestaña.
     *
     * El enlace solo se resuelve en `#/e/<guid>`; recargar la actividad no
     * vuelve a pasar por ahí, así que sin esto el color se perdía en cada F5.
     * Va en `sessionStorage` —no en `localStorage`— para que no se le cuele a
     * la sesión que esa persona tenga abierta en otra pestaña.
     */
    guardarFondoDelEnlace(normalized);
  }

  /** Vuelve al rojo corporativo. */
  resetBrandColor(): void {
    this.brandColor.set(DEFAULT_BRAND);
    localStorage.removeItem(BRAND_KEY);
    this.applyBrand();
    void this.persist(BRAND_SETTING, DEFAULT_BRAND);
  }

  /**
   * Completa la preferencia desde la base cuando `localStorage` no la tiene.
   *
   * ## Quién manda
   *
   * **`localStorage` gana siempre que tenga valor.** Se escribe de forma
   * síncrona en el mismo momento en que el usuario elige, así que refleja su
   * última decisión sin margen de error. IndexedDB se escribe en paralelo pero
   * de forma asíncrona: puede fallar o quedar rezagada, y entonces contiene un
   * valor viejo.
   *
   * La versión anterior daba prioridad a la base y producía justo eso: elegías
   * claro, recargabas, y un instante después volvía a oscuro porque la lectura
   * asíncrona traía el valor anterior y pisaba lo aplicado.
   *
   * La base sirve para lo que `localStorage` no cubre: recuperar la preferencia
   * si se limpió el almacenamiento del sitio parcialmente.
   */
  private async loadFromDatabase(): Promise<void> {
    try {
      // Si el usuario ya eligió mientras se leía la base, su decisión manda.
      if (this.userChanged) return;

      const hasLocalMode = localStorage.getItem(THEME_KEY) !== null;
      const hasLocalBrand = localStorage.getItem(BRAND_KEY) !== null;

      // ── Modo ────────────────────────────────────────────────────────────
      if (hasLocalMode) {
        // localStorage manda: solo se asegura que la base esté al día.
        await this.persist(SETTING_KEYS.THEME, this.mode());
      } else {
        const stored = await this.settings.getDeviceSetting(SETTING_KEYS.THEME);

        if (
          !this.userChanged &&
          (stored === 'light' || stored === 'dark' || stored === 'system')
        ) {
          this.mode.set(stored);
          localStorage.setItem(THEME_KEY, stored);
          this.applyMode();
        }
      }

      /*
       * ── Color de fondo ──────────────────────────────────────────────────
       *
       * En una pestaña de enlace público esto no se toca: el fondo lo decide el
       * enlace, y ni la preferencia personal de quien lo abre ni nada guardado
       * en la base pueden pisarlo. Una lectura asíncrona que llegara tarde le
       * cambiaría el color al formulario a media pantalla.
       *
       * Se salta **solo este bloque**, no lo que viene detrás: el color de
       * marca sí se reconcilia igual en los dos modos.
       */
      if (!esModoPublico()) {
        // Se mira si la clave **existe**, no si tiene valor: la cadena vacía es
        // una elección («el de la aplicación») y no se guarda, así que aquí se
        // distingue por la ausencia de la clave, igual que las otras dos.
        if (localStorage.getItem(FONDO_KEY) !== null) {
          await this.persist(FONDO_SETTING, this.fondoColor());
        } else {
          const stored = this.normalizeHex(
            (await this.settings.getDeviceSetting(FONDO_SETTING)) ?? '',
          );

          if (!this.userChanged && stored) {
            this.fondoColor.set(stored);
            localStorage.setItem(FONDO_KEY, stored);
            this.applyFondo();
          }
        }
      }

      // ── Color de marca ──────────────────────────────────────────────────
      if (hasLocalBrand) {
        await this.persist(BRAND_SETTING, this.brandColor());
      } else {
        const stored = this.normalizeHex(await this.settings.getDeviceSetting(BRAND_SETTING));

        if (!this.userChanged && stored) {
          this.brandColor.set(stored);
          localStorage.setItem(BRAND_KEY, stored);
          this.applyBrand();
        }
      }
    } catch (error) {
      // Sin base disponible se sigue con localStorage: el tema es una
      // preferencia, no puede impedir que la aplicación arranque.
      console.warn('[Theme] No se pudo leer la preferencia guardada', error);
    }
  }

  /** Guarda un ajuste en la base, sin dejar que un fallo rompa nada. */
  private async persist(key: string, value: string): Promise<void> {
    try {
      await this.settings.setDeviceSetting(key, value);
    } catch (error) {
      console.warn(`[Theme] No se pudo guardar "${key}"`, error);
    }
  }

  /**
   * ¿Este color sirve como fondo de pagina?
   *
   * Publico porque la pantalla que lo ofrece necesita poder decirlo **antes**
   * de intentarlo: rechazar en silencio un color que alguien acaba de elegir se
   * lee como que la aplicacion no responde.
   */
  esFondoClaro(hex: string): boolean {
    const normalized = this.normalizeHex(hex);

    return normalized ? this.luminancia(normalized) >= FONDO_LUMINANCIA_MINIMA : false;
  }

  /** ¿Está el modo oscuro en efecto ahora mismo? */
  isDarkActive(): boolean {
    const mode = this.mode();
    if (mode === 'dark') return true;
    if (mode === 'light') return false;
    return matchMedia('(prefers-color-scheme: dark)').matches;
  }

  // ───────────────────────────────────────────────────────────────────────────

  private apply(): void {
    this.applyMode();
    this.applyBrand();
    this.applyFondo();
  }

  /**
   * Escribe el fondo de la página.
   *
   * Una sola variable, `--vt-bg`, porque es de la que cuelga todo: el `body` la
   * usa directamente y Material la recibe por `--mat-sys-background`. Sin valor
   * se **quita** la propiedad en vez de escribir un gris, y así el CSS vuelve a
   * mandar — incluido el fondo oscuro cuando se cambia de modo.
   *
   * ## Y **solo** esa variable
   *
   * Hubo una version que ademas forzaba `--vt-text` para que el texto
   * contrastara con el fondo elegido. Fue un error con consecuencias visibles:
   * `--vt-text` no es el texto de la pagina, es el de **todo** —incluido el que
   * va dentro de las tarjetas blancas de cada pregunta—, asi que ponerlo en
   * blanco por un fondo oscuro dejaba los campos ilegibles.
   *
   * El contraste se garantiza de otra forma: no admitiendo fondos oscuros. Ver
   * `FONDO_LUMINANCIA_MINIMA`.
   */
  private applyFondo(): void {
    const root = document.documentElement;
    const fondo = this.fondoColor();

    if (!fondo) {
      root.style.removeProperty('--vt-bg');
      return;
    }

    root.style.setProperty('--vt-bg', fondo);
  }

  private applyMode(): void {
    document.documentElement.setAttribute('data-theme', this.mode());

    // El texto sobre el fondo elegido depende del modo, así que se recalcula
    // al cambiarlo. Sin esto, pasar a oscuro con un fondo claro puesto dejaba
    // el texto blanco sobre blanco.
    this.applyFondo();

    // Tiñe la barra del navegador en móviles para que no rompa el conjunto.
    const meta = document.querySelector('meta[name="theme-color"]');
    meta?.setAttribute('content', this.isDarkActive() ? '#0d0e11' : '#16181d');
  }

  /**
   * Escribe el color de marca y sus variantes.
   *
   * Solo se aplica si difiere del valor por defecto: así el CSS conserva el
   * control cuando nadie personalizó nada, incluyendo el ajuste que el tema
   * oscuro hace del rojo para que no vibre sobre el fondo.
   */
  private applyBrand(): void {
    const root = document.documentElement;
    const brand = this.brandColor();

    if (brand === DEFAULT_BRAND) {
      root.style.removeProperty('--vt-brand');
      root.style.removeProperty('--vt-brand-dark');
      root.style.removeProperty('--vt-brand-light');
      root.style.removeProperty('--vt-brand-tint');
      root.style.removeProperty('--vt-on-brand');
      return;
    }

    root.style.setProperty('--vt-brand', brand);
    root.style.setProperty('--vt-brand-dark', this.shade(brand, -0.2));
    root.style.setProperty('--vt-brand-light', this.shade(brand, 0.22));
    root.style.setProperty(
      '--vt-brand-tint',
      this.isDarkActive() ? this.shade(brand, -0.72) : this.shade(brand, 0.9),
    );

    // Texto legible sobre el color elegido. Sin esto, un color claro (ámbar,
    // por ejemplo) deja el texto blanco ilegible, y uno muy oscuro hace lo
    // mismo con el texto negro.
    root.style.setProperty('--vt-on-brand', this.readableOn(brand));
  }

  /**
   * Devuelve blanco o negro, el que contraste mejor sobre [hex].
   *
   * Usa la luminancia relativa de WCAG: no basta con promediar los canales,
   * porque el ojo es mucho más sensible al verde que al azul. Un amarillo y un
   * azul con el mismo promedio RGB necesitan colores de texto opuestos.
   *
   * El umbral 0.55 está por encima del 0.5 teórico a propósito: favorece el
   * texto oscuro en los tonos medios, donde el blanco empieza a costar.
   */
  private readableOn(hex: string): string {
    return this.luminancia(hex) > 0.55 ? '#14161a' : '#ffffff';
  }

  /**
   * Luminancia relativa de WCAG, entre 0 (negro) y 1 (blanco).
   *
   * No basta con promediar los canales: el ojo es mucho mas sensible al verde
   * que al azul, y un amarillo y un azul con el mismo promedio RGB se ven con
   * claridades muy distintas.
   */
  private luminancia(hex: string): number {
    const canal = (value: number): number => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };

    const r = canal(parseInt(hex.slice(1, 3), 16));
    const g = canal(parseInt(hex.slice(3, 5), 16));
    const b = canal(parseInt(hex.slice(5, 7), 16));

    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /**
   * Reacciona a que el sistema cambie de claro a oscuro.
   *
   * Solo importa en modo 'system'; en los otros el usuario ya eligió.
   */
  private watchSystemPreference(): void {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (this.mode() === 'system') this.apply();
    });
  }

  private readMode(): ThemeMode {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
  }

  private readBrand(): string {
    return this.normalizeHex(localStorage.getItem(BRAND_KEY) ?? '') ?? DEFAULT_BRAND;
  }

  /**
   * El fondo con el que arranca la aplicación.
   *
   * En una pestaña de enlace público manda **el del enlace**, que se apuntó al
   * abrirlo: es del enlace y no de quien lo abre, así que no tiene por qué
   * mirar la preferencia personal de nadie —ni dejarse pisar por ella—.
   *
   * Leerlo aquí, y no esperar a resolver el enlace, es lo que hace que un F5 en
   * mitad del formulario no muestre un fogonazo gris antes de recuperar el
   * color: para cuando se pinta el primer fotograma ya está puesto.
   */
  private readFondo(): string {
    if (esModoPublico()) return this.normalizeHex(fondoDelEnlace()) ?? '';

    return this.normalizeHex(localStorage.getItem(FONDO_KEY) ?? '') ?? '';
  }

  /** Valida y normaliza un color hex. Devuelve `null` si no lo es. */
  private normalizeHex(value: string): string | null {
    const hex = value.trim().toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(hex)) return null;
    return hex;
  }

  /**
   * Aclara u oscurece un color.
   *
   * [amount] entre -1 (a negro) y 1 (a blanco). Es una mezcla lineal en RGB:
   * no es perceptualmente uniforme como lo sería en OKLCH, pero para generar
   * un hover y un tinte a partir de un color base resulta suficiente y evita
   * arrastrar una librería de color.
   */
  private shade(hex: string, amount: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);

    const target = amount > 0 ? 255 : 0;
    const ratio = Math.abs(amount);

    const mix = (channel: number) =>
      Math.round(channel + (target - channel) * ratio)
        .toString(16)
        .padStart(2, '0');

    return `#${mix(r)}${mix(g)}${mix(b)}`;
  }
}
