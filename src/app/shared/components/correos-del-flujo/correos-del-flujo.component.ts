import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';

import {
  CorreoConEstado,
  CorreoService,
  ESTADO_DE_CORREO,
  EstadoDeCorreo,
} from '../../../core/services/correo.service';
import { IconComponent } from '../icon/icon.component';

/**
 * «Correos del flujo» de una actividad: qué correo pidió cada regla y en qué
 * quedó.
 *
 * ## Para qué
 *
 * Al guardar, quien diligencia ve «Correo en camino» y ahí se acababa lo que
 * sabía. Si el job lo mandó, si se está reintentando o si se desistió —y por
 * qué— solo se veía en la bandeja de Module, que no abre quien está en campo.
 * Este bloque lo pone en la propia actividad: asunto, para, el estado con su
 * color y, si falló o salió con avisos, el motivo completo.
 *
 * Al montarse pinta lo que ya sabe la cola local y pregunta al servidor. No se
 * pinta nada si la actividad no tiene correos: un bloque vacío en cada
 * actividad sería ruido.
 *
 * ```html
 * <vt-correos-del-flujo [answerGuid]="guid" />
 * ```
 */
@Component({
  selector: 'vt-correos-del-flujo',
  standalone: true,
  imports: [DatePipe, IconComponent],
  template: `
    @if (correos().length) {
      <section class="cf" aria-label="Correos del flujo">
        <header class="cf__cab">
          <vt-icon name="mail" [size]="16" />
          <h2 class="cf__titulo">Correos del flujo</h2>
          <button
            type="button"
            class="cf__recargar"
            (click)="recargar()"
            [disabled]="cargando()"
            title="Volver a preguntar al servidor"
            aria-label="Actualizar el estado de los correos"
          >
            <vt-icon name="refresh" [size]="14" />
          </button>
        </header>

        <ul class="cf__lista">
          @for (c of correos(); track $index) {
            <li class="cf__fila">
              <span [class]="'cf__pill cf__pill--' + tono(c.estado)">{{ texto(c.estado) }}</span>

              <div class="cf__cuerpo">
                <p class="cf__asunto" [title]="c.asunto">{{ c.asunto || '(sin asunto)' }}</p>
                <p class="cf__para">
                  Para: {{ c.para || '—' }}
                  @if (c.copia) {
                    <span class="cf__copia">· Copia: {{ c.copia }}</span>
                  }
                </p>

                <!-- El motivo entero, en varias líneas: recortado no sirve para
                     arreglar nada. -->
                @if (c.ultimoError && c.estado !== 'enviado') {
                  <p [class]="'cf__motivo cf__motivo--' + tono(c.estado)">{{ c.ultimoError }}</p>
                }

                <p class="cf__pie">
                  @if (c.enviado) {
                    Enviado {{ c.enviado | date: 'dd/MM/yy HH:mm' }}
                  } @else if (c.creado) {
                    Pedido {{ c.creado | date: 'dd/MM/yy HH:mm' }}
                  }
                  @if (c.intentos > 1) {
                    · {{ c.intentos }} intentos
                  }
                </p>
              </div>
            </li>
          }
        </ul>
      </section>
    }
  `,
  styles: `
    :host {
      display: block;
    }

    .cf {
      display: flex;
      flex-direction: column;
      gap: var(--vt-space-2);
      padding: var(--vt-space-3) var(--vt-space-4);
      background: var(--vt-surface);
      border: 1px solid var(--vt-border, var(--vt-control-border));
      border-radius: var(--vt-radius-md);
    }

    .cf__cab {
      display: flex;
      gap: var(--vt-space-2);
      align-items: center;
      color: var(--vt-text-subtle);
    }

    .cf__titulo {
      flex: 1;
      margin: 0;
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--vt-text);
    }

    .cf__recargar {
      display: inline-flex;
      padding: 4px;
      color: var(--vt-text-subtle);
      cursor: pointer;
      background: transparent;
      border: 0;
      border-radius: var(--vt-radius-full);
    }

    .cf__recargar:hover:not(:disabled) {
      color: var(--vt-text);
      background: var(--vt-surface-2);
    }

    .cf__recargar:disabled {
      opacity: 0.5;
      cursor: default;
    }

    .cf__lista {
      display: flex;
      flex-direction: column;
      gap: var(--vt-space-2);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .cf__fila {
      display: flex;
      gap: var(--vt-space-3);
      align-items: flex-start;
      min-width: 0;
    }

    .cf__cuerpo {
      flex: 1;
      min-width: 0;
    }

    .cf__asunto {
      margin: 0;
      overflow: hidden;
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--vt-text);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .cf__para,
    .cf__pie {
      margin: 2px 0 0;
      font-size: 0.75rem;
      color: var(--vt-text-subtle);
      overflow-wrap: anywhere;
    }

    .cf__motivo {
      margin: 4px 0 0;
      padding: 6px 8px;
      font-size: 0.75rem;
      line-height: 1.45;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      border-radius: var(--vt-radius-sm, 6px);
    }

    .cf__motivo--rojo {
      color: var(--vt-danger);
      background: var(--vt-danger-bg);
    }

    .cf__motivo--ambar,
    .cf__motivo--gris,
    .cf__motivo--azul {
      color: var(--vt-warning);
      background: var(--vt-warning-bg);
    }

    .cf__pill {
      flex-shrink: 0;
      padding: 2px 9px;
      font-size: 0.75rem;
      font-weight: 600;
      white-space: nowrap;
      border-radius: var(--vt-radius-full);
    }

    .cf__pill--gris {
      color: var(--vt-text-muted, var(--vt-text-subtle));
      background: var(--vt-surface-2);
    }

    .cf__pill--azul {
      color: var(--vt-info);
      background: var(--vt-info-bg);
    }

    .cf__pill--verde {
      color: var(--vt-success);
      background: var(--vt-success-bg);
    }

    .cf__pill--ambar {
      color: var(--vt-warning);
      background: var(--vt-warning-bg);
    }

    .cf__pill--rojo {
      color: var(--vt-danger);
      background: var(--vt-danger-bg);
    }
  `,
})
export class CorreosDelFlujoComponent {
  private readonly servicio = inject(CorreoService);

  /** La actividad. */
  readonly answerGuid = input.required<string>();

  readonly cargando = signal(false);

  readonly correos = computed<CorreoConEstado[]>(
    () => this.servicio.resumenes().get(this.answerGuid().toLowerCase())?.correos ?? [],
  );

  constructor() {
    // Al abrir (o cambiar de) actividad: lo local primero, y luego el servidor.
    effect(() => {
      const guid = this.answerGuid();
      untracked(() => void this.cargar(guid));
    });
  }

  recargar(): void {
    void this.cargar(this.answerGuid());
  }

  texto(estado: EstadoDeCorreo): string {
    return ESTADO_DE_CORREO[estado]?.texto ?? estado;
  }

  tono(estado: EstadoDeCorreo): string {
    return ESTADO_DE_CORREO[estado]?.tono ?? 'gris';
  }

  private async cargar(guid: string): Promise<void> {
    if (!guid) return;

    this.cargando.set(true);

    try {
      await this.servicio.cargarLocales([guid]);
      await this.servicio.refrescar([guid]);
    } finally {
      this.cargando.set(false);
    }
  }
}
