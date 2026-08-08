import { Injectable, computed, signal } from '@angular/core';

/** Una acción que se puede lanzar con el teclado. */
export interface Shortcut {
  /** Identificador único. */
  id: string;

  /**
   * Combinación, en minúsculas y con los modificadores por delante:
   * `ctrl+s`, `alt+arrowright`, `?`. Las secuencias van separadas por espacio:
   * `g f` es «pulsa G y después F».
   */
  keys: string;

  /** Qué hace, para el panel de ayuda. */
  label: string;

  /** Grupo en el panel de ayuda: «Navegación», «Formulario»… */
  group: string;

  run: () => void;
}

/**
 * Cuánto se espera la segunda tecla de una secuencia.
 *
 * Un segundo y medio: suficiente para pensar «¿a dónde iba?» y corto para que
 * una `f` tecleada al rato no se lea como la continuación de una `g` olvidada.
 */
const SEQUENCE_MS = 1500;

/**
 * Atajos de teclado.
 *
 * ## Para qué
 *
 * Quien diligencia desde un escritorio pasa el día en la misma pantalla: abrir
 * un formulario, responder, guardar, volver, repetir. Cada uno de esos pasos
 * son varios clics y un recorrido con el ratón. Con teclado son dos teclas.
 *
 * ## Solo donde hay teclado
 *
 * En una tableta o un teléfono no hay atajos que valgan, y el panel de ayuda
 * solo sería ruido. Se activan cuando el dispositivo apunta con precisión —hay
 * ratón— que es la señal más fiable de que además hay teclado.
 *
 * ## Por qué las pantallas registran sus acciones
 *
 * «Guardar» no significa lo mismo en un formulario que en el editor de una
 * ubicación, y en el listado no significa nada. En vez de un servicio que sepa
 * de todas las pantallas, cada una registra lo suyo mientras vive y lo retira al
 * salir. Así el panel de ayuda enseña siempre lo que de verdad se puede hacer
 * **ahí**.
 */
@Injectable({ providedIn: 'root' })
export class ShortcutsService {
  private readonly registry = signal(new Map<string, Shortcut>());

  /** La paleta de comandos está abierta. */
  readonly paletteOpen = signal(false);

  /** El panel de ayuda está abierto. */
  readonly helpOpen = signal(false);

  /** Primera tecla de una secuencia a medias. */
  private pending = '';
  private pendingTimer?: ReturnType<typeof setTimeout>;

  /**
   * ¿Este equipo tiene teclado?
   *
   * Se pregunta por el puntero fino, que es lo que distingue un escritorio de
   * una pantalla táctil. No hay forma de preguntar por el teclado directamente,
   * y esta es la aproximación que menos se equivoca.
   */
  readonly enabled = computed(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(pointer: fine)').matches;
  });

  /** Los atajos registrados, agrupados para el panel de ayuda. */
  readonly groups = computed(() => {
    const groups = new Map<string, Shortcut[]>();

    for (const shortcut of this.registry().values()) {
      const list = groups.get(shortcut.group) ?? [];
      list.push(shortcut);
      groups.set(shortcut.group, list);
    }

    return [...groups.entries()].map(([title, items]) => ({ title, items }));
  });

  /**
   * Registra un atajo mientras la pantalla viva.
   *
   * Devuelve la función que lo retira; conviene llamarla al destruir, o el
   * panel de ayuda seguiría ofreciendo algo que ya no existe.
   */
  register(shortcut: Shortcut): () => void {
    this.registry.update((current) => new Map(current).set(shortcut.id, shortcut));

    return () => {
      this.registry.update((current) => {
        const next = new Map(current);
        next.delete(shortcut.id);
        return next;
      });
    };
  }

  /** Registra varios de una vez. */
  registerAll(shortcuts: readonly Shortcut[]): () => void {
    const undo = shortcuts.map((shortcut) => this.register(shortcut));
    return () => undo.forEach((remove) => remove());
  }

  /**
   * Atiende una pulsación. Devuelve `true` si se consumió.
   *
   * Lo llama un único escuchador puesto en el armazón: repartirlo por pantallas
   * significaría varios escuchadores compitiendo por la misma tecla.
   */
  handle(event: KeyboardEvent): boolean {
    if (!this.enabled()) return false;

    const combo = comboOf(event);
    if (!combo) return false;

    /**
     * Escribiendo, casi nada es un atajo.
     *
     * Una `g` dentro de un campo de texto es una letra, no «ir a». Solo pasan
     * las combinaciones con Ctrl o Alt —que nadie teclea sin querer— y Escape,
     * que es la salida universal.
     */
    if (isTyping(event.target) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (combo !== 'escape') return false;
    }

    // Una secuencia a medias: se prueba con las dos teclas juntas.
    const sequence = this.pending ? `${this.pending} ${combo}` : '';
    const shortcut = this.find(sequence) ?? this.find(combo);

    this.clearPending();

    if (shortcut) {
      event.preventDefault();
      shortcut.run();
      return true;
    }

    // No coincide con nada, pero **empieza** algo: se espera la siguiente.
    if (!sequence && this.startsSequence(combo)) {
      this.pending = combo;
      this.pendingTimer = setTimeout(() => (this.pending = ''), SEQUENCE_MS);
      event.preventDefault();
      return true;
    }

    return false;
  }

  private find(keys: string): Shortcut | null {
    if (!keys) return null;

    for (const shortcut of this.registry().values()) {
      if (shortcut.keys === keys) return shortcut;
    }

    return null;
  }

  private startsSequence(combo: string): boolean {
    for (const shortcut of this.registry().values()) {
      if (shortcut.keys.startsWith(`${combo} `)) return true;
    }

    return false;
  }

  private clearPending(): void {
    clearTimeout(this.pendingTimer);
    this.pending = '';
  }

  // ── Paleta y ayuda ─────────────────────────────────────────────────────────

  togglePalette(): void {
    this.helpOpen.set(false);
    this.paletteOpen.update((open) => !open);
  }

  toggleHelp(): void {
    this.paletteOpen.set(false);
    this.helpOpen.update((open) => !open);
  }

  closeAll(): void {
    this.paletteOpen.set(false);
    this.helpOpen.set(false);
  }
}

/**
 * La combinación como texto.
 *
 * `Ctrl` y `Meta` cuentan como lo mismo: el mismo atajo tiene que funcionar
 * igual en Windows y en un Mac sin declararlo dos veces.
 */
function comboOf(event: KeyboardEvent): string {
  const key = event.key.toLowerCase();

  // Un modificador suelto no es un atajo, es la mitad de uno.
  if (['control', 'alt', 'shift', 'meta'].includes(key)) return '';

  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('ctrl');
  if (event.altKey) parts.push('alt');

  // `Shift` no se anota: ya viene dentro del carácter (`?` es Shift+7 en un
  // teclado español, y anotarlo obligaría a declarar `shift+?`).
  parts.push(key);

  return parts.join('+');
}

/** ¿El foco está en algo donde se escribe? */
function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;

  const tag = element.tagName;

  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    element.isContentEditable === true
  );
}
