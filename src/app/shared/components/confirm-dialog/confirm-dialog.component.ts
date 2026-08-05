import { Component, ElementRef, effect, input, output, viewChild } from '@angular/core';

import { IconComponent } from '../icon/icon.component';

/** Tono del diálogo. Define el color del icono y del botón principal. */
export type DialogTone = 'brand' | 'warning' | 'danger' | 'info';

/**
 * Diálogo de confirmación o aviso.
 *
 * ## Por qué no `confirm()`
 *
 * El cuadro nativo del navegador no se puede vestir, sale con el idioma y el
 * aspecto del sistema, y bloquea el hilo mientras está abierto. En una
 * aplicación que ya tiene su propio lenguaje visual, aparece como algo de
 * fuera — y en un móvil, con el nombre del sitio en el título, más parece un
 * aviso del navegador que una pregunta de la aplicación.
 *
 * Este usa el `<dialog>` nativo, que sí trae lo que cuesta reimplementar bien:
 * foco atrapado, cierre con Escape y fondo inerte.
 *
 * ## Cómo se usa
 *
 * ```html
 * <vt-confirm-dialog
 *   [open]="asking()"
 *   tone="danger"
 *   icon="trash"
 *   title="¿Eliminar la ubicación?"
 *   message="Se perderán las coordenadas capturadas."
 *   confirmLabel="Eliminar"
 *   (confirm)="remove()"
 *   (cancel)="asking.set(false)"
 * />
 * ```
 */
@Component({
  selector: 'vt-confirm-dialog',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './confirm-dialog.component.html',
  styleUrl: './confirm-dialog.component.scss',
})
export class ConfirmDialogComponent {
  readonly open = input(false);

  readonly title = input.required<string>();
  readonly message = input('');

  /** Texto secundario, para el detalle técnico o la consecuencia. */
  readonly detail = input('');

  readonly icon = input('info');
  readonly tone = input<DialogTone>('brand');

  readonly confirmLabel = input('Aceptar');

  /**
   * Texto del botón de cancelar. Vacío lo oculta, para los avisos que solo
   * informan y no preguntan nada.
   */
  readonly cancelLabel = input('Cancelar');

  /** Bloquea el botón principal mientras la acción está en curso. */
  readonly busy = input(false);

  readonly confirm = output<void>();
  readonly cancel = output<void>();

  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    effect(() => {
      const element = this.dialog()?.nativeElement;
      if (!element) return;

      if (this.open() && !element.open) element.showModal();
      else if (!this.open() && element.open) element.close();
    });
  }

  /**
   * Cierra al pulsar fuera de la tarjeta.
   *
   * El `<dialog>` ocupa toda la pantalla y su `::backdrop` no recibe eventos,
   * así que el clic de fuera llega al propio dialog; comparar el objetivo con
   * el elemento distingue «fuera» de «dentro».
   */
  onBackdropClick(event: MouseEvent): void {
    if (event.target === this.dialog()?.nativeElement) this.cancel.emit();
  }
}
