import { Component, inject } from '@angular/core';

import { Toast, ToastService } from '../../../core/services/toast.service';
import { IconComponent } from '../icon/icon.component';

/**
 * Los avisos emergentes en pantalla.
 *
 * Abajo a la izquierda en el escritorio —lejos del contenido que se está
 * leyendo y del pulgar que guarda— y ocupando el ancho abajo en un teléfono,
 * que es el único sitio donde caben sin tapar nada.
 *
 * Cada uno cuenta qué pasó y, si hay algo que hacer con ello, lleva un botón.
 * Se van solos; el aspa está para quien quiera despejar antes.
 */
@Component({
  selector: 'vt-toasts',
  standalone: true,
  imports: [IconComponent],
  template: `
    @if (toasts.toasts().length > 0) {
      <div class="toasts" role="status" aria-live="polite">
        @for (toast of toasts.toasts(); track toast.id) {
          <div class="toast" [class]="'toast--' + toast.tone">
            <span class="toast__icon">
              <vt-icon [name]="toast.icon" [size]="18" />
            </span>

            <div class="toast__text">
              <strong>{{ toast.title }}</strong>
              @if (toast.detail) {
                <span>{{ toast.detail }}</span>
              }
            </div>

            @if (toast.action) {
              <button type="button" class="toast__action" (click)="run(toast)">
                {{ toast.action.label }}
              </button>
            }

            <button
              type="button"
              class="toast__close"
              (click)="toasts.dismiss(toast.id)"
              aria-label="Cerrar aviso"
            >
              <vt-icon name="close" [size]="16" />
            </button>
          </div>
        }
      </div>
    }
  `,
  styles: [
    `
      .toasts {
        position: fixed;
        right: var(--vt-space-4);
        bottom: var(--vt-space-4);
        z-index: 90;
        display: flex;
        flex-direction: column;
        gap: 10px;
        width: min(420px, calc(100vw - 2 * var(--vt-space-4)));
      }

      /**
       * Rectangular y oscuro, como los avisos que la gente ya conoce.
       *
       * El fondo oscuro no depende del tema: un aviso tiene que distinguirse
       * del contenido esté la aplicación en claro o en oscuro, y con el color
       * de superficie se confundiría con una tarjeta más.
       */
      .toast {
        display: flex;
        gap: 12px;
        align-items: center;
        padding: 13px 14px;
        color: rgb(255 255 255 / 92%);
        background: #23272e;
        border-radius: var(--vt-radius);
        box-shadow: 0 8px 28px rgb(0 0 0 / 30%);
        animation: toast-in 200ms ease-out;
      }

      /* Entra desde el borde por el que aparece: naciendo a la izquierda con el
         aviso pegado a la derecha, el movimiento contradecía su posición. */
      @keyframes toast-in {
        from {
          opacity: 0;
          transform: translateX(16px);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .toast {
          animation-duration: 1ms;
        }
      }

      .toast__icon {
        display: grid;
        flex-shrink: 0;
        place-items: center;
        width: 32px;
        height: 32px;
        border-radius: var(--vt-radius-full);
      }

      .toast--info .toast__icon {
        color: #7cc0ff;
        background: rgb(124 192 255 / 16%);
      }

      .toast--success .toast__icon {
        color: #6fd39a;
        background: rgb(111 211 154 / 16%);
      }

      .toast--warning .toast__icon {
        color: #ffc46b;
        background: rgb(255 196 107 / 16%);
      }

      .toast--error .toast__icon {
        color: #ff8b8b;
        background: rgb(255 139 139 / 16%);
      }

      .toast__text {
        display: flex;
        flex: 1;
        flex-direction: column;
        min-width: 0;

        strong {
          font-size: var(--vt-text-sm);
          font-weight: 650;
        }

        /* El detalle en un tono más bajo: se lee si interesa, y si no, el
           título ya dijo lo esencial. */
        span {
          font-size: var(--vt-text-xs);
          color: rgb(255 255 255 / 65%);
        }
      }

      .toast__action {
        flex-shrink: 0;
        padding: 6px 12px;
        font-family: var(--vt-font);
        font-size: var(--vt-text-xs);
        font-weight: 700;
        color: #9fd0ff;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        background: none;
        border: 0;
        border-radius: var(--vt-radius);

        &:hover {
          background: rgb(255 255 255 / 10%);
        }
      }

      .toast__close {
        display: grid;
        flex-shrink: 0;
        place-items: center;
        width: 28px;
        height: 28px;
        color: rgb(255 255 255 / 55%);
        background: none;
        border: 0;
        border-radius: var(--vt-radius);

        &:hover {
          color: #fff;
          background: rgb(255 255 255 / 10%);
        }
      }

      @media (max-width: 640px) {
        .toasts {
          right: 8px;
          bottom: 8px;
          left: 8px;
          width: auto;
        }
      }
    `,
  ],
})
export class ToastsComponent {
  readonly toasts = inject(ToastService);

  run(toast: Toast): void {
    toast.action?.run();
    this.toasts.dismiss(toast.id);
  }
}
