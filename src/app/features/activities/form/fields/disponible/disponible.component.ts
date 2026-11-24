import { Component, computed, inject, input } from '@angular/core';

import { InventarioDeCampoService } from '../../../../../core/inventario/inventario-de-campo.service';
import { IconComponent } from '../../../../../shared/components/icon/icon.component';
import { TPipe } from '../../../../../core/i18n/t.pipe';

/** Una cantidad sin decimales de sobra: `12`, `2.5`. */
export function cifraDeStock(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/**
 * «Disponible: 12 und» de un item de una lista de productos.
 *
 * No pinta nada si el item no es un producto enlazado en Inventario o si la
 * web todavía no sabe su stock: la mayoría de las listas no son de productos y
 * no deben cambiar. Se repinta sola cuando llega stock nuevo (señal). Gemelo
 * de `DisponibleDeItem` del móvil.
 */
@Component({
  selector: 'vt-disponible',
  standalone: true,
  imports: [IconComponent, TPipe],
  template: `
    @if (stock(); as s) {
      <span class="disp" [class.disp--agotado]="s.disponible <= 0">
        <vt-icon name="box" [size]="13" />
        {{ 'inv.disponible' | t: { cantidad: cifra(s.disponible), unidad: s.unidad } }}
      </span>
    }
  `,
  styles: `
    :host {
      display: contents;
    }

    .disp {
      display: inline-flex;
      gap: 4px;
      align-items: center;
      font-size: 12px;
      font-weight: 600;
      line-height: 1.4;
      color: var(--vt-brand);
    }

    .disp--agotado {
      color: var(--vt-danger);
    }
  `,
})
export class DisponibleComponent {
  private readonly inventario = inject(InventarioDeCampoService);

  /** GUID del item de la lista. */
  readonly guid = input<string | null | undefined>('');

  readonly stock = computed(() => this.inventario.disponible(this.guid()));

  readonly cifra = cifraDeStock;
}
