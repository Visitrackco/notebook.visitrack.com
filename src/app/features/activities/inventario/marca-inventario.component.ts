import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { TPipe } from '../../../core/i18n/t.pipe';
import { InventarioDeCampoService } from '../../../core/inventario/inventario-de-campo.service';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { textoDelTipo } from './inventario-textos';

/**
 * La marca corta de la tarjeta del formulario: «Inventario · Salida». Para
 * reconocer de un vistazo qué formularios mueven stock. Gemelo de
 * `MarcaDeInventario` del móvil. Sin perfil no pinta nada.
 */
@Component({
  selector: 'vt-marca-inventario',
  standalone: true,
  imports: [IconComponent, TPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (tipo(); as t) {
      <span class="minv"><vt-icon name="tag" [size]="13" /> {{ 'inv.marca' | t: { tipo: t } }}</span>
    }
  `,
  styles: `
    :host { display: inline-flex; max-width: 100%; }
    .minv {
      display: inline-flex; align-items: center; gap: 4px; max-width: 100%;
      padding: 2px 9px; border-radius: 9999px; font-size: 12px; font-weight: 600;
      background: rgba(245, 180, 0, 0.16);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .minv vt-icon { color: #f5b400; flex: none; }
  `,
})
export class MarcaInventarioComponent {
  private readonly inventario = inject(InventarioDeCampoService);

  readonly surveyId = input.required<unknown>();

  readonly tipo = computed(() => {
    const p = this.inventario.perfilDe(this.surveyId());
    return p ? textoDelTipo(p) : '';
  });
}
