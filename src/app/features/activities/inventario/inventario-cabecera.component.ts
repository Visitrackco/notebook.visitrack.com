import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { MatTooltipModule } from '@angular/material/tooltip';

import { TPipe } from '../../../core/i18n/t.pipe';
import { DescuentoDeInventario, InventarioDeCampoService } from '../../../core/inventario/inventario-de-campo.service';
import { SurveyAnswer } from '../../../core/models/entities.model';
import { ConfirmDialogComponent } from '../../../shared/components/confirm-dialog/confirm-dialog.component';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { textoDeCuando, textoDeRepetir, textoDelNegativo, textoDelTipo } from './inventario-textos';

/** Las actividades cuyo aviso de «sin stock» ya se enseñó al abrirlas en esta pestaña. */
const yaAvisadas = new Set<string>();

/**
 * En la cabecera de la actividad, gemelo de `IconoDeInventario` e
 * `IconoSinStock` del móvil:
 *
 * - una etiqueta amarilla si el formulario mueve inventario. Al pulsarla dice
 *   qué movimiento hace, cuándo, qué pasa sin stock y cómo va el descuento de
 *   esta actividad (ya se descontó, ya cumple o qué le falta);
 * - un aviso rojo si el servidor la frenó por falta de stock. Se enseña solo
 *   una vez al abrirla, y queda el icono para volver a leerlo.
 *
 * Sin perfil ni freno no pinta nada.
 */
@Component({
  selector: 'vt-inventario-cabecera',
  standalone: true,
  imports: [ConfirmDialogComponent, IconComponent, MatTooltipModule, TPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (frenada(); as b) {
      <button
        type="button"
        class="invc invc--rojo"
        (click)="viendoSinStock.set(true)"
        [matTooltip]="'inv.sinStockAvisoTitulo' | t"
        [attr.aria-label]="'inv.sinStockAvisoTitulo' | t"
      >
        <vt-icon name="alert" [size]="17" />
      </button>
      <vt-confirm-dialog
        [open]="viendoSinStock()"
        tone="danger"
        icon="alert"
        [title]="'inv.sinStockAvisoTitulo' | t"
        [message]="'inv.sinStockAvisoTexto' | t: { detalle: b.mensaje }"
        [confirmLabel]="'inv.entendido' | t"
        cancelLabel=""
        (confirm)="viendoSinStock.set(false)"
        (cancel)="viendoSinStock.set(false)"
      />
    }

    @if (perfil()) {
      <button
        type="button"
        class="invc invc--amarillo"
        (click)="abrir()"
        [matTooltip]="'inv.formularioMueve' | t"
        [attr.aria-label]="'inv.formularioMueve' | t"
      >
        <vt-icon name="tag" [size]="17" />
      </button>
      <vt-confirm-dialog
        [open]="viendo()"
        tone="warning"
        icon="tag"
        [title]="'inv.formularioMueve' | t"
        [message]="mensaje()"
        [detail]="descuento()?.texto ?? ''"
        [confirmLabel]="'inv.entendido' | t"
        cancelLabel=""
        (confirm)="viendo.set(false)"
        (cancel)="viendo.set(false)"
      />
    }
  `,
  styles: `
    :host { display: inline-flex; align-items: center; gap: 4px; }
    .invc {
      display: inline-grid; place-items: center; width: 32px; height: 32px;
      border: 1px solid transparent; border-radius: 8px; cursor: pointer;
    }
    .invc--amarillo { color: #f5b400; background: rgba(245, 180, 0, 0.12); }
    .invc--amarillo:hover { border-color: rgba(245, 180, 0, 0.5); }
    .invc--rojo { color: #d32f2f; background: rgba(211, 47, 47, 0.1); }
    .invc--rojo:hover { border-color: rgba(211, 47, 47, 0.45); }
  `,
})
export class InventarioCabeceraComponent {
  private readonly inventario = inject(InventarioDeCampoService);

  readonly answer = input.required<SurveyAnswer>();

  readonly perfil = computed(() => this.inventario.perfilDe(this.answer().SurveyID));
  readonly frenada = computed(() => this.inventario.bloqueadaDe(this.answer().GUID));

  readonly viendo = signal(false);
  readonly viendoSinStock = signal(false);
  readonly descuento = signal<DescuentoDeInventario | null>(null);

  readonly mensaje = computed(() => {
    const p = this.perfil();
    if (!p) return '';
    return `${textoDelTipo(p)} · ${textoDeCuando(p)}. ${textoDelNegativo(p)} ${textoDeRepetir(p)}`;
  });

  constructor() {
    // Frenada por falta de stock: se dice sola al abrirla, una vez.
    effect(() => {
      const b = this.frenada();
      if (!b || yaAvisadas.has(b.guid)) return;
      yaAvisadas.add(b.guid);
      untracked(() => this.viendoSinStock.set(true));
    });
  }

  async abrir(): Promise<void> {
    this.descuento.set(null);
    this.viendo.set(true);
    this.descuento.set(await this.inventario.comoVaElDescuento(this.answer()));
  }
}
