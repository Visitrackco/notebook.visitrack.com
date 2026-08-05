import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';

/** En qué punto está el autoguardado. */
export type AutosaveState =
  /** No hay nada que guardar. */
  | 'idle'
  /** Hay cambios esperando a que venza el retardo. */
  | 'pending'
  /** Escribiendo en la base. */
  | 'saving'
  /** Todo guardado. */
  | 'saved'
  /** La última escritura falló. */
  | 'error';

/** Cuánto se espera antes de escribir, si quien programa no dice otra cosa. */
const DEFAULT_DELAY_MS = 800;

/** Una escritura en espera. */
interface PendingWrite {
  timer: ReturnType<typeof setTimeout>;
  save: () => Promise<unknown>;
}

/**
 * Autoguardado con retardo.
 *
 * ## El problema que resuelve
 *
 * Escribir en cada pulsación convierte un campo de texto en decenas de
 * transacciones de IndexedDB por frase, y la pestaña se nota pesada al
 * escribir. No escribir hasta que el usuario pulse un botón significa perder lo
 * diligenciado cuando el navegador se cierra, que es exactamente lo que pasa en
 * campo — se acaba la batería, se cierra la pestaña por error, el sistema mata
 * el proceso.
 *
 * El término medio es agrupar: se espera un momento sin cambios y se escribe
 * una vez. Cada clave tiene su propio temporizador, así que dos campos que se
 * editan a la vez no se pisan ni se serializan entre sí.
 *
 * ## Por qué siempre hay que vaciar antes de salir
 *
 * Un retardo abre una ventana en la que lo escrito todavía no está en la base.
 * Si en esa ventana el usuario cambia de pantalla o cierra la pestaña, ese
 * último cambio se pierde — y es siempre el más reciente, el que más recuerda
 * haber hecho. Por eso este servicio se engancha a `visibilitychange` y
 * `pagehide` para vaciar solo, y por eso las pantallas deben llamar a [flush]
 * antes de navegar.
 *
 * ## Cómo se usa
 *
 * ```ts
 * this.autosave.schedule(`answer:${guid}`, () =>
 *   this.answers.update(id, { Fields: JSON.stringify(fields) }),
 * );
 * ```
 *
 * Programar de nuevo la misma clave reemplaza lo anterior: solo importa el
 * último estado, no el camino para llegar a él.
 */
@Injectable({ providedIn: 'root' })
export class AutosaveService {
  private readonly destroyRef = inject(DestroyRef);

  /** Escrituras esperando su turno, por clave. */
  private readonly pending = new Map<string, PendingWrite>();

  /** Escrituras en curso, para que [flush] pueda esperarlas. */
  private readonly inFlight = new Set<Promise<unknown>>();

  private readonly _state = signal<AutosaveState>('idle');
  private readonly _lastSavedAt = signal<Date | null>(null);
  private readonly _lastError = signal<string>('');

  /** Estado actual, para pintar el indicador de «Guardando…» / «Guardado». */
  readonly state = this._state.asReadonly();

  /** Cuándo se completó la última escritura. */
  readonly lastSavedAt = this._lastSavedAt.asReadonly();

  /** Mensaje del último fallo. Vacío si no ha habido ninguno. */
  readonly lastError = this._lastError.asReadonly();

  /** true mientras haya algo sin escribir. */
  readonly isDirty = computed(() => this._state() === 'pending' || this._state() === 'saving');

  constructor() {
    // El navegador no avisa que va a cerrar la pestaña con tiempo suficiente
    // para esperar una promesa, pero sí da la oportunidad de lanzarla. Vaciar
    // aquí convierte "se perdió lo último que escribí" en un caso raro (cierre
    // abrupto del proceso) en vez de en el comportamiento normal.
    const flushNow = () => void this.flush();

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushNow();
    });
    window.addEventListener('pagehide', flushNow);

    this.destroyRef.onDestroy(() => {
      document.removeEventListener('visibilitychange', flushNow);
      window.removeEventListener('pagehide', flushNow);
      for (const entry of this.pending.values()) clearTimeout(entry.timer);
      this.pending.clear();
    });
  }

  /**
   * Programa una escritura para dentro de [delayMs].
   *
   * Si esa clave ya tenía una pendiente, la reemplaza — cada llamada trae el
   * estado completo, no un incremento.
   */
  schedule(key: string, save: () => Promise<unknown>, delayMs = DEFAULT_DELAY_MS): void {
    this.cancel(key);

    const timer = setTimeout(() => {
      this.pending.delete(key);
      void this.run(save);
    }, delayMs);

    this.pending.set(key, { timer, save });
    this._state.set('pending');
  }

  /**
   * Escribe ya, sin esperar el retardo.
   *
   * Sin clave, vacía todo lo pendiente. Se resuelve cuando la base confirmó las
   * escrituras, así que se puede esperar antes de navegar.
   */
  async flush(key?: string): Promise<void> {
    const entries = key
      ? ([[key, this.pending.get(key)]] as const)
      : ([...this.pending.entries()] as const);

    for (const [entryKey, entry] of entries) {
      if (!entry) continue;
      clearTimeout(entry.timer);
      this.pending.delete(entryKey);
      void this.run(entry.save);
    }

    // Las escrituras ya lanzadas también cuentan: quien llama a flush quiere
    // saber que no queda nada en el aire, no solo que se disparó lo pendiente.
    await Promise.allSettled([...this.inFlight]);
  }

  /** Descarta lo pendiente de una clave sin escribirlo. */
  cancel(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.pending.delete(key);

    if (this.pending.size === 0 && this.inFlight.size === 0) {
      this._state.set('idle');
    }
  }

  /** ¿Queda algo sin escribir para esta clave? */
  isPending(key: string): boolean {
    return this.pending.has(key);
  }

  /** Ejecuta una escritura y lleva la cuenta del estado. */
  private async run(save: () => Promise<unknown>): Promise<void> {
    this._state.set('saving');

    const promise = save();
    this.inFlight.add(promise);

    try {
      await promise;
      this._lastSavedAt.set(new Date());
      this._lastError.set('');
      // Solo se anuncia «guardado» cuando de verdad no queda nada: si mientras
      // se escribía llegaron cambios nuevos, el indicador debe seguir en marcha.
      if (this.pending.size === 0 && this.inFlight.size === 1) this._state.set('saved');
    } catch (error) {
      console.error('[Autosave] no se pudo guardar', error);
      this._lastError.set(error instanceof Error ? error.message : String(error));
      this._state.set('error');
    } finally {
      this.inFlight.delete(promise);
    }
  }
}
