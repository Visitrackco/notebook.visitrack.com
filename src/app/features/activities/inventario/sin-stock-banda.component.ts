import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { TPipe } from '../../../core/i18n/t.pipe';
import { traducir } from '../../../core/i18n/idioma.service';
import { InventarioDeCampoService } from '../../../core/inventario/inventario-de-campo.service';
import { SurveyAnswerRepository } from '../../../core/repositories/survey-answer.repository';
import { ToastService } from '../../../core/services/toast.service';
import { IconComponent } from '../../../shared/components/icon/icon.component';

/**
 * «Actividades sin stock» en el listado: las de este usuario que el servidor
 * no pudo mover porque, al procesarlas, ya no había stock (otra salida llegó
 * antes). Gemelo de `SinStockScreen` del móvil, como una banda plegable: se
 * abre cada una para ajustar la cantidad y guardarla otra vez; cuando el
 * servidor la procesa bien, desaparece sola.
 */
@Component({
  selector: 'vt-sin-stock-banda',
  standalone: true,
  imports: [IconComponent, TPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (inventario.bloqueadas().length) {
      <section class="ssb" role="alert">
        <header class="ssb__cab">
          <vt-icon name="alert" [size]="18" />
          <strong>{{ 'inv.sinStockBanda' | t: { n: inventario.bloqueadas().length } }}</strong>
          <button type="button" class="ssb__btn" (click)="abierta.set(!abierta())">
            {{ (abierta() ? 'inv.ocultar' : 'inv.verTodas') | t }}
          </button>
        </header>
        @if (abierta()) {
          <p class="ssb__explica">{{ 'inv.sinStockExplica' | t }}</p>
          <ul class="ssb__lista">
            @for (b of inventario.bloqueadas(); track b.guid) {
              <li>
                <div>
                  <span class="ssb__id">{{ 'inv.sinStockActividad' | t: { id: b.answerId } }}</span>
                  <span class="ssb__msg">{{ b.mensaje }}</span>
                </div>
                <button type="button" class="ssb__btn ssb__btn--fuerte" (click)="abrir(b.guid)">
                  {{ 'inv.sinStockCorregir' | t }}
                </button>
              </li>
            }
          </ul>
        }
      </section>
    }
  `,
  styles: `
    .ssb {
      border: 1px solid rgba(211, 47, 47, 0.35); border-radius: 10px;
      background: rgba(211, 47, 47, 0.06); padding: 10px 12px; margin-bottom: 12px;
    }
    .ssb__cab { display: flex; align-items: center; gap: 8px; font-size: 14px; }
    .ssb__cab vt-icon { color: #d32f2f; }
    .ssb__cab strong { flex: 1; }
    .ssb__explica { margin: 8px 0; font-size: 13px; opacity: 0.85; }
    .ssb__lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .ssb__lista li {
      display: flex; justify-content: space-between; align-items: center; gap: 12px;
      border: 1px solid rgba(211, 47, 47, 0.2); border-radius: 8px; padding: 8px 10px;
    }
    .ssb__lista li > div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .ssb__id { font-weight: 700; font-size: 13px; }
    .ssb__msg { font-size: 12px; opacity: 0.85; }
    .ssb__btn {
      border: 1px solid rgba(211, 47, 47, 0.4); background: transparent; color: #d32f2f;
      border-radius: 8px; padding: 5px 10px; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap;
    }
    .ssb__btn--fuerte { background: #d32f2f; color: #fff; border-color: transparent; }
  `,
})
export class SinStockBandaComponent {
  protected readonly inventario = inject(InventarioDeCampoService);
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);

  readonly abierta = signal(false);

  async abrir(guid: string): Promise<void> {
    const a = (await this.answers.findByGuid(guid)) ?? (await this.answers.findByGuid(guid.toUpperCase()));
    if (!a) {
      this.toast.warning(traducir('inv.sinStockNoEsta'));
      return;
    }
    await this.router.navigate(['/formularios', a.SurveyID, 'actividad', a.GUID]);
  }
}
