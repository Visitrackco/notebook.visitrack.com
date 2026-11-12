import { Component, inject, input } from '@angular/core';

import { IdiomaService } from './idioma.service';
import { TPipe } from './t.pipe';

/**
 * Selector Español / English.
 *
 * Dos botones en vez de un desplegable: son solo dos opciones y así se ve de
 * un vistazo cuál está activa. Los nombres van cada uno en su propio idioma,
 * que es lo que busca quien no entiende el que está puesto.
 */
@Component({
  selector: 'vt-selector-idioma',
  standalone: true,
  imports: [TPipe],
  template: `
    <div
      class="idioma"
      [class.idioma--compacto]="compacto()"
      role="radiogroup"
      [attr.aria-label]="'comun.idioma' | t"
    >
      @for (op of idioma.opciones; track op.valor) {
        <button
          type="button"
          role="radio"
          class="idioma__op"
          [class.idioma__op--activo]="idioma.idioma() === op.valor"
          [attr.aria-checked]="idioma.idioma() === op.valor"
          [attr.lang]="op.valor"
          [title]="op.nombre"
          (click)="idioma.cambiar(op.valor)"
        >
          {{ compacto() ? op.corto : op.nombre }}
        </button>
      }
    </div>
  `,
  styles: `
    .idioma {
      display: inline-flex;
      gap: 2px;
      padding: 2px;
      border-radius: 999px;
      background: color-mix(in srgb, currentColor 9%, transparent);
    }

    .idioma__op {
      border: 0;
      border-radius: 999px;
      padding: 5px 12px;
      background: transparent;
      color: inherit;
      font: inherit;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      opacity: 0.72;
    }

    .idioma--compacto .idioma__op {
      padding: 3px 10px;
      font-size: 12px;
    }

    .idioma__op:hover {
      opacity: 1;
    }

    .idioma__op--activo {
      background: var(--vt-surface, #fff);
      color: var(--vt-brand, inherit);
      opacity: 1;
      box-shadow: 0 1px 2px rgb(0 0 0 / 12%);
    }

    .idioma__op:focus-visible {
      outline: 2px solid currentColor;
      outline-offset: 1px;
    }
  `,
})
export class SelectorIdiomaComponent {
  protected readonly idioma = inject(IdiomaService);

  /** Muestra «ES / EN» en vez de los nombres completos. */
  readonly compacto = input(false);
}
