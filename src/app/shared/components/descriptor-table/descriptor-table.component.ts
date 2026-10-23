import { Component, computed, input } from '@angular/core';

import { Descriptor } from '../../utils/descriptors';

/**
 * Los descriptivos de una ubicación o un activo, en dos columnas: la etiqueta a
 * la izquierda y el valor al lado. Es `TablaDeDescriptivos` del móvil.
 *
 * Con una rejilla y no con un par por línea: así todos los valores arrancan en
 * la misma vertical y se leen de un vistazo. La columna de etiquetas mide lo
 * que mide la etiqueta más larga, pero nunca más del 42 % del ancho; lo que no
 * cabe —una etiqueta o un valor largos— baja de renglón en vez de cortarse.
 *
 * Va con `span` y no con una lista de definiciones (`dl`) porque casi siempre
 * vive dentro de un botón o un enlace —la fila que se toca para elegir—, y ahí
 * solo cabe contenido de frase.
 */
@Component({
  selector: 'vt-descriptor-table',
  standalone: true,
  template: `
    <span class="dtab">
      @for (item of shown(); track $index) {
        <span class="dtab__lab">{{ item.lab }}</span>
        <span class="dtab__val" [class.dtab__val--empty]="!item.val">{{ item.val || '—' }}</span>
      }
    </span>
  `,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
      }

      .dtab {
        display: grid;
        grid-template-columns: fit-content(42%) minmax(0, 1fr);
        gap: 3px 12px;
        font-size: var(--vt-text-xs);
        text-align: start;
        line-height: 1.35;
      }

      .dtab__lab,
      .dtab__val {
        min-width: 0;
        overflow-wrap: anywhere;
      }

      .dtab__lab {
        font-weight: 600;
        color: var(--vt-text-muted);
      }

      .dtab__val {
        color: var(--vt-text);
      }

      .dtab__val--empty {
        color: var(--vt-text-subtle);
      }
    `,
  ],
})
export class DescriptorTableComponent {
  readonly descriptors = input.required<Descriptor[]>();

  /** Cuántos mostrar como mucho. 0 = todos. */
  readonly max = input(0);

  readonly shown = computed(() => {
    const all = this.descriptors();
    const max = this.max();
    return max > 0 ? all.slice(0, max) : all;
  });
}
