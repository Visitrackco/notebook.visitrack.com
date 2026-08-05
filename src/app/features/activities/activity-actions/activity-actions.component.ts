import { Component, ElementRef, effect, input, output, viewChild } from '@angular/core';

import { IconComponent } from '../../../shared/components/icon/icon.component';

/** Identificador de cada acción. Lo consume quien abre el panel. */
export type ActivityAction =
  | 'open'
  | 'pdf'
  | 'reprocess'
  | 'reassign'
  | 'copy'
  | 'delete';

/** Una acción del panel, ya resuelta para esta actividad concreta. */
export interface ActionItem {
  id: ActivityAction;
  label: string;
  /** Qué hace, en pocas palabras. Va bajo la etiqueta. */
  hint: string;
  icon: string;
  /** Tono del disco: 'brand' | 'neutral' | 'warning' | 'danger'. */
  tone: 'brand' | 'neutral' | 'warning' | 'danger';
  /**
   * Cuando está deshabilitada, el motivo.
   *
   * Se muestra en lugar del `hint`. Deshabilitar sin explicar convierte una
   * regla de negocio en un botón que «no funciona», y quien la encuentra no
   * tiene forma de saber qué le falta para poder usarla.
   */
  disabledReason?: string;
}

/**
 * Panel de acciones de una actividad.
 *
 * Réplica del panel inferior de la app: una cuadrícula de discos grandes en vez
 * de un menú de líneas finas. Se usa a menudo con una mano y a veces con
 * guantes, así que cada acción ocupa un área generosa y se distingue por color
 * y forma antes que por su texto.
 *
 * Usa el `<dialog>` nativo y no una superposición propia: trae el foco
 * atrapado, el cierre con Escape y el fondo inerte sin que haya que
 * implementarlos —y sin equivocarse al hacerlo—.
 */
@Component({
  selector: 'vt-activity-actions',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './activity-actions.component.html',
  styleUrl: './activity-actions.component.scss',
})
export class ActivityActionsComponent {
  /** Título del panel: describe de qué actividad se trata. */
  readonly title = input('Actividad');
  readonly subtitle = input('');

  readonly actions = input.required<ActionItem[]>();

  /** El panel se muestra cuando pasa a `true`. */
  readonly open = input(false);

  readonly choose = output<ActivityAction>();
  readonly close = output<void>();

  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    effect(() => {
      const element = this.dialog()?.nativeElement;
      if (!element) return;

      if (this.open() && !element.open) {
        element.showModal();
      } else if (!this.open() && element.open) {
        element.close();
      }
    });
  }

  onSelect(action: ActionItem): void {
    if (action.disabledReason) return;
    this.choose.emit(action.id);
  }

  /**
   * Cierra al pulsar fuera de la tarjeta.
   *
   * El `<dialog>` ocupa toda la pantalla y su `::backdrop` no recibe eventos,
   * así que el clic de fuera llega al propio dialog. Comparando el objetivo con
   * el elemento se distingue «fuera» de «dentro».
   */
  onBackdropClick(event: MouseEvent): void {
    if (event.target === this.dialog()?.nativeElement) this.close.emit();
  }
}
