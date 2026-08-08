import {
  Component,
  ElementRef,
  computed,
  effect,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import { sanitizeHtml, serializeForStorage, toPlainText } from '../../../../../core/forms/rich-text';
import { IconComponent } from '../../../../../shared/components/icon/icon.component';

/** Colores de letra y de resaltado. Los mismos del editor de fotos. */
const COLORS = [
  { name: 'Negro', value: '#111827' },
  { name: 'Rojo', value: '#dc2626' },
  { name: 'Naranja', value: '#ea580c' },
  { name: 'Verde', value: '#16a34a' },
  { name: 'Azul', value: '#2563eb' },
  { name: 'Morado', value: '#7c3aed' },
];

const HIGHLIGHTS = [
  { name: 'Amarillo', value: '#fef08a' },
  { name: 'Verde', value: '#bbf7d0' },
  { name: 'Azul', value: '#bfdbfe' },
  { name: 'Rosa', value: '#fbcfe8' },
  { name: 'Gris', value: '#e5e7eb' },
];

/** Qué paleta está abierta. */
type Palette = 'none' | 'text' | 'highlight';

/**
 * Campo de área de texto, con formato.
 *
 * ## Por qué un editor y no un `<textarea>`
 *
 * Es donde se escriben las observaciones de una inspección, y ahí hace falta
 * poder enumerar hallazgos y resaltar lo que no puede pasar desapercibido. La
 * app lo resolvió con un editor de texto enriquecido y esto es su equivalente:
 * los mismos controles y, sobre todo, **el mismo formato de almacenamiento**,
 * para que una observación escrita en el teléfono se lea igual aquí.
 *
 * ## Por qué `contenteditable` y no una librería
 *
 * Los controles que hacen falta —negrita, listas, color— los resuelve el propio
 * navegador. Traer un editor completo añadiría cientos de kilobytes a una
 * aplicación que debe abrir sin conexión, y habría que enseñarle a hablar el
 * HTML concreto que espera el backend.
 *
 * `document.execCommand` está marcado como obsoleto y no tiene sustituto: la
 * API que iba a reemplazarlo nunca se implementó. Todos los navegadores lo
 * mantienen porque medio internet depende de él.
 */
@Component({
  selector: 'vt-rich-text-field',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './rich-text-field.component.html',
  styleUrl: './rich-text-field.component.scss',
})
export class RichTextFieldComponent {
  readonly value = input('');
  readonly placeholder = input('');
  readonly readOnly = input(false);
  readonly invalid = input(false);

  readonly valueChange = output<string>();

  private readonly editorRef = viewChild<ElementRef<HTMLElement>>('editor');

  readonly colors = COLORS;
  readonly highlights = HIGHLIGHTS;

  readonly palette = signal<Palette>('none');
  readonly focused = signal(false);
  readonly length = signal(0);

  readonly counter = computed(() => {
    const count = this.length();
    return `${count} ${count === 1 ? 'caracter' : 'caracteres'}`;
  });

  /**
   * Lo último que se publicó.
   *
   * Es lo que distingue un cambio venido de fuera —abrir otra actividad— de un
   * eco de lo que acaba de escribirse. Sin esta comparación, reescribir el
   * contenido en cada ciclo colocaría el cursor al principio a cada tecla.
   */
  private lastEmitted = '';

  constructor() {
    effect(() => {
      const incoming = this.value();
      const editor = this.editorRef()?.nativeElement;

      untracked(() => {
        if (!editor || incoming === this.lastEmitted) return;

        // El valor guardado puede venir del servidor o de otro cliente: se
        // sanea antes de tocar el DOM, no después.
        editor.innerHTML = sanitizeHtml(incoming);
        this.lastEmitted = incoming;
        this.updateLength();
      });
    });
  }

  // ── Edición ────────────────────────────────────────────────────────────────

  /**
   * Aplica un comando del navegador sobre la selección.
   *
   * El foco se devuelve al editor antes de ejecutar: pulsar un botón de la
   * barra se lo lleva, y sin selección el comando no tiene sobre qué actuar.
   */
  exec(command: string, argument?: string): void {
    if (this.readOnly()) return;

    const editor = this.editorRef()?.nativeElement;
    editor?.focus();

    document.execCommand(command, false, argument);
    this.palette.set('none');
    this.publish();
  }

  /** Inserta la fecha y la hora actuales, como en la app. */
  insertDateTime(): void {
    const now = new Date();

    const stamp = now.toLocaleString('es-CO', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    this.exec('insertText', `${stamp} `);
  }

  /**
   * Quita todo el formato de lo seleccionado.
   *
   * `removeFormat` no toca las listas —son estructura, no formato de
   * carácter—, así que se apagan aparte. Es lo que espera quien pulsa
   * «limpiar»: que el texto vuelva a ser texto.
   */
  clearFormat(): void {
    if (this.readOnly()) return;

    const editor = this.editorRef()?.nativeElement;
    editor?.focus();

    document.execCommand('removeFormat');
    document.execCommand('insertUnorderedList', false);
    document.execCommand('insertOrderedList', false);

    this.palette.set('none');
    this.publish();
  }

  togglePalette(which: Palette): void {
    this.palette.update((current) => (current === which ? 'none' : which));
  }

  /** Publica el contenido tras escribir. */
  onInput(): void {
    this.publish();
  }

  /**
   * Limpia lo que se pega.
   *
   * Pegar de Word o de una página web trae fuentes, tamaños, tablas y a veces
   * scripts. Se intercepta y se inserta como texto: el formato lo pone el
   * usuario con la barra, que es la única forma de que lo guardado siga siendo
   * lo que el backend sabe leer.
   */
  onPaste(event: ClipboardEvent): void {
    event.preventDefault();

    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text) document.execCommand('insertText', false, text);

    this.publish();
  }

  private publish(): void {
    const editor = this.editorRef()?.nativeElement;
    if (!editor) return;

    const stored = serializeForStorage(editor.innerHTML);

    this.updateLength();

    if (stored === this.lastEmitted) return;

    this.lastEmitted = stored;
    this.valueChange.emit(stored);
  }

  private updateLength(): void {
    const editor = this.editorRef()?.nativeElement;
    this.length.set(toPlainText(editor?.innerHTML ?? '').trimEnd().length);
  }
}
