import { Component, ElementRef, computed, effect, input, output, signal, viewChild } from '@angular/core';

import { IconComponent } from '../../../../shared/components/icon/icon.component';

/** Una página, tal como la ve la navegación. */
export interface PageMark {
  index: number;
  label: string;
  current: boolean;
  /** Tiene obligatorios sin responder. */
  incomplete: boolean;
}

/**
 * Navegación entre páginas del formulario.
 *
 * Va abajo y pegada, como en la app: es donde está la mano después de responder
 * el último campo de la página, y en un formulario largo un control arriba
 * queda fuera de pantalla justo cuando hace falta.
 *
 * ## Puntos, no una lista de números
 *
 * Con pocas páginas se muestran puntos —el actual alargado— porque lo que
 * importa a esa escala es *dónde estoy* y *cuánto falta*, no el número exacto.
 * Pasadas ocho, los puntos dejan de distinguirse y se cambia por el contador
 * «3 / 12», que a esa altura sí dice más.
 *
 * En ambos casos el indicador es pulsable y abre el listado completo, con el
 * nombre de cada página y cuáles tienen algo pendiente. Es la misma decisión de
 * la app: el indicador compacto informa, y el panel permite navegar.
 */
@Component({
  selector: 'vt-page-nav',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './page-nav.component.html',
  styleUrl: './page-nav.component.scss',
})
export class PageNavComponent {
  readonly pages = input.required<PageMark[]>();
  readonly current = input(0);

  /** Guardando: bloquea el botón para no enviar dos veces. */
  readonly saving = input(false);

  readonly goTo = output<number>();
  readonly save = output<void>();

  /**
   * Salir de la actividad.
   *
   * Solo se ofrece cuando el formulario tiene **una sola página**: ahí
   * «Anterior» no lleva a ninguna parte y su sitio queda mejor empleado en la
   * única salida que existe. Con varias páginas, salir se hace por la flecha de
   * la cabecera, y ese hueco lo necesita la navegación.
   *
   * Quien lo escucha aplica las mismas comprobaciones que la flecha de arriba
   * —vaciar el autoguardado y avisar si el borrador se va a descartar—, así que
   * las dos salidas se comportan igual.
   */
  readonly leave = output<void>();

  readonly pickerOpen = signal(false);

  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  /** Pasadas ocho páginas los puntos dejan de leerse: se pasa al contador. */
  readonly useDots = computed(() => this.pages().length <= 8);

  readonly hasPages = computed(() => this.pages().length > 1);

  /** Formulario de una sola página: no hay a dónde retroceder. */
  readonly isSinglePage = computed(() => this.pages().length <= 1);
  readonly isFirst = computed(() => this.current() === 0);
  readonly isLast = computed(() => this.current() >= this.pages().length - 1);

  /** Cuántas páginas tienen obligatorios sin responder. */
  readonly incompleteCount = computed(
    () => this.pages().filter((page) => page.incomplete).length,
  );

  constructor() {
    effect(() => {
      const element = this.dialog()?.nativeElement;
      if (!element) return;

      if (this.pickerOpen() && !element.open) element.showModal();
      else if (!this.pickerOpen() && element.open) element.close();
    });
  }

  openPicker(): void {
    if (this.hasPages()) this.pickerOpen.set(true);
  }

  closePicker(): void {
    this.pickerOpen.set(false);
  }

  choose(index: number): void {
    this.closePicker();
    this.goTo.emit(index);
  }

  previous(): void {
    if (!this.isFirst()) this.goTo.emit(this.current() - 1);
  }

  next(): void {
    if (!this.isLast()) this.goTo.emit(this.current() + 1);
  }

  onBackdropClick(event: MouseEvent): void {
    if (event.target === this.dialog()?.nativeElement) this.closePicker();
  }
}
