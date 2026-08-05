import { Injectable, inject, signal } from '@angular/core';

import { SETTING_KEYS, SettingsRepository } from '../repositories/settings.repository';

/** Modo de color elegido por el usuario. */
export type ThemeMode = 'light' | 'dark' | 'system';

/** Clave del modo en `localStorage`. */
const THEME_KEY = 'visitrack.theme';
/** Clave del color de marca personalizado, en `localStorage`. */
const BRAND_KEY = 'visitrack.brandColor';

/** Clave del color de marca en `appSettings`. */
const BRAND_SETTING = 'brand_color';

/** Rojo corporativo. Es el punto de partida si nadie personaliza nada. */
export const DEFAULT_BRAND = '#d32029';

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
  }

  private applyMode(): void {
    document.documentElement.setAttribute('data-theme', this.mode());

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
    const channel = (value: number): number => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };

    const r = channel(parseInt(hex.slice(1, 3), 16));
    const g = channel(parseInt(hex.slice(3, 5), 16));
    const b = channel(parseInt(hex.slice(5, 7), 16));

    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    return luminance > 0.55 ? '#14161a' : '#ffffff';
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
