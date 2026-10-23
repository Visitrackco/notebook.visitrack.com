import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { segmentosResaltados } from '../../utils/resaltado';

/**
 * Un texto con lo buscado marcado: `<vt-resaltado [texto]="nombre" [busqueda]="q" />`.
 *
 * Sin tildes ni mayúsculas, y todas las veces que aparezca. Pinta trozos
 * interpolados —nunca `innerHTML`—, así que un valor con marcado se ve como
 * texto y no se ejecuta. Ver `segmentosResaltados`.
 *
 * Es un elemento en línea: se pone donde iba `{{ texto }}` sin cambiar el
 * diseño. La plantilla va en una sola línea a propósito: un salto entre el
 * `<mark>` y el texto vecino se vería como un espacio que no está en el valor.
 */
@Component({
  selector: 'vt-resaltado',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@for (trozo of segmentos(); track $index) {@if (trozo.resaltado) {<mark class="vt-resaltado">{{ trozo.texto }}</mark>} @else {<ng-container>{{ trozo.texto }}</ng-container>}}`,
  styles: [
    `
      .vt-resaltado {
        background: var(--vt-resaltado-fondo);
        color: var(--vt-resaltado-texto);
        border-radius: 2px;
        padding: 0 1px;
        margin: 0 -1px;
        /* Un salto de renglón dentro de la marca repite el relleno en cada trozo. */
        box-decoration-break: clone;
        -webkit-box-decoration-break: clone;
      }
    `,
  ],
})
export class ResaltadoComponent {
  readonly texto = input<unknown>('');

  /** Lo escrito en el buscador. Vacío: el texto sale tal cual. */
  readonly busqueda = input<unknown>('');

  readonly segmentos = computed(() => segmentosResaltados(this.texto(), this.busqueda()));
}
