import { Component, ElementRef, computed, effect, input, output, signal, viewChild } from '@angular/core';

import { DispatchStatus } from '../../../../core/models/entities.model';
import { IconComponent } from '../../../../shared/components/icon/icon.component';

/**
 * Barra de estado de despacho.
 *
 * Ocupa todo el ancho y se queda pegada arriba al desplazarse, igual que en la
 * app. El estado no es un campo más del formulario: es el que decide qué pasa
 * con la actividad cuando llega a Visitrack —quién la ve, si cuenta como
 * cerrada, qué alerta dispara—, y tenerlo siempre a la vista evita el caso de
 * diligenciar veinte campos y enviar con el estado equivocado.
 *
 * Al pulsarla se abre un panel con todos los estados y su color. La lista corta
 * en un desplegable serviría igual, pero los colores son el lenguaje con el que
 * cada cliente organiza su operación: verlos juntos y grandes es lo que permite
 * elegir sin leer.
 */
@Component({
  selector: 'vt-status-bar',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './status-bar.component.html',
  styleUrl: './status-bar.component.scss',
})
export class StatusBarComponent {
  readonly statuses = input.required<DispatchStatus[]>();

  /** `DispatchID` del estado actual. Vacío si no hay ninguno. */
  readonly current = input('');

  readonly statusChange = output<string>();

  readonly open = signal(false);

  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  /** El estado elegido, resuelto. `null` mientras no haya ninguno. */
  readonly selected = computed<DispatchStatus | null>(() => {
    const id = String(this.current() ?? '');
    if (!id) return null;

    return this.statuses().find((status) => String(status.DispatchID) === id) ?? null;
  });

  /** Color del estado actual, o el neutro cuando no hay. */
  readonly color = computed(() => colorOf(this.selected()));

  constructor() {
    effect(() => {
      const element = this.dialog()?.nativeElement;
      if (!element) return;

      if (this.open() && !element.open) element.showModal();
      else if (!this.open() && element.open) element.close();
    });
  }

  /** Color de un estado de la lista. */
  colorOf(status: DispatchStatus | null): string {
    return colorOf(status);
  }

  toggle(): void {
    this.open.update((value) => !value);
  }

  close(): void {
    this.open.set(false);
  }

  choose(status: DispatchStatus | null): void {
    this.statusChange.emit(status ? String(status.DispatchID) : '');
    this.close();
  }

  isCurrent(status: DispatchStatus): boolean {
    return String(status.DispatchID) === String(this.current() ?? '');
  }

  /** Cierra al pulsar fuera de la tarjeta. */
  onBackdropClick(event: MouseEvent): void {
    if (event.target === this.dialog()?.nativeElement) this.close();
  }
}

/**
 * Color de un estado.
 *
 * `DispatchStatus.Color` llega como `#rrggbb`, pero hay registros antiguos con
 * el valor vacío o con basura. Se comprueba el formato antes de usarlo: un
 * color inválido en un `background` hace que la regla entera se descarte y la
 * bolita quedaría invisible, no gris.
 */
function colorOf(status: DispatchStatus | null): string {
  const raw = (status?.Color ?? '').toString().trim();
  return /^#[0-9a-f]{3,8}$/i.test(raw) ? raw : 'var(--vt-text-subtle)';
}
