import { Component, computed, input, signal } from '@angular/core';

import { IconComponent } from '../icon/icon.component';

/**
 * Una explicación que se pide, no que se impone.
 *
 * ## Por qué no un `title`
 *
 * El texto emergente del navegador tarda un segundo en aparecer, se corta, no
 * se puede leer con el teclado y en un teléfono no existe. Para una aclaración
 * de dos líneas eso es suficiente; para explicar cómo se calcula algo —que es
 * justo lo que la gente se pregunta cuando ve un número que no cuadra— no.
 *
 * ## Por qué no un párrafo fijo
 *
 * Porque se lee una vez. Un texto permanente junto a cada dato acaba siendo
 * ruido que se salta hasta quien lo necesitaba: la duda aparece más tarde, al
 * ver el número, y entonces conviene tenerla a un clic y no antes.
 *
 * ```html
 * <vt-hint label="Cómo se calcula el porcentaje">
 *   Cuenta las preguntas visibles que ya tienen respuesta.
 * </vt-hint>
 * ```
 */
@Component({
  selector: 'vt-hint',
  standalone: true,
  imports: [IconComponent],
  template: `
    <button
      type="button"
      class="hint__trigger"
      [class.hint__trigger--on]="open()"
      [attr.aria-expanded]="open()"
      [attr.aria-label]="label()"
      [title]="label()"
      (click)="toggle($event)"
    >
      <vt-icon name="info" [size]="size()" />
    </button>

    @if (open()) {
      <!-- El velo cierra al pulsar fuera. Transparente: la explicación no
           bloquea la pantalla, solo se quita de en medio al primer clic. -->
      <div class="hint__veil" (click)="close()"></div>

      <div class="hint__panel" [class.hint__panel--right]="align() === 'right'" role="note">
        <strong>{{ label() }}</strong>
        <ng-content />
      </div>
    }
  `,
  styles: [
    `
      :host {
        position: relative;
        display: inline-flex;
      }

      .hint__trigger {
        display: grid;
        place-items: center;
        padding: 2px;
        color: var(--vt-text-subtle);
        background: none;
        border: 0;
        border-radius: var(--vt-radius-full);

        &:hover,
        &--on {
          color: var(--vt-brand);
        }
      }

      .hint__veil {
        position: fixed;
        inset: 0;
        z-index: 40;
      }

      /**
       * El panel se ancla al icono y se sale de la caja del padre a propósito:
       * la explicación necesita ancho para leerse, y el sitio donde vive el
       * icono suele ser una fila estrecha.
       */
      .hint__panel {
        position: absolute;
        top: calc(100% + 8px);
        left: 0;
        z-index: 41;
        display: flex;
        flex-direction: column;
        gap: 6px;
        width: max-content;
        max-width: min(320px, 80vw);
        padding: var(--vt-space-3) var(--vt-space-4);
        font-family: var(--vt-font);
        font-size: var(--vt-text-xs);
        line-height: 1.5;
        color: var(--vt-text-muted);
        text-align: left;
        text-transform: none;
        letter-spacing: normal;
        background: var(--vt-surface);
        border: 1px solid var(--vt-rule);
        border-radius: var(--vt-radius);
        box-shadow: 0 12px 32px rgb(0 0 0 / 18%);

        strong {
          font-size: var(--vt-text-xs);
          font-weight: 700;
          color: var(--vt-text);
        }

        p {
          margin: 0;
        }

        /* Un dato dentro de la explicación —una fórmula, un ejemplo— se separa
           del resto para poder encontrarlo sin releer el párrafo. */
        em {
          font-style: normal;
          font-weight: 650;
          color: var(--vt-text);
        }
      }

      /* Anclado a la derecha cuando el icono vive al final de su fila: hacia la
         izquierda el panel se saldría de la pantalla. */
      .hint__panel--right {
        right: 0;
        left: auto;
      }
    `,
  ],
})
export class HintComponent {
  /** Título de la explicación. También es la etiqueta accesible del icono. */
  readonly label = input.required<string>();

  readonly size = input(14);

  /** Hacia dónde se abre el panel. */
  readonly align = input<'left' | 'right'>('left');

  private readonly shown = signal(false);
  readonly open = computed(() => this.shown());

  toggle(event: Event): void {
    // El icono suele vivir dentro de algo pulsable —una cabecera, una fila—, y
    // pedir la explicación no debe activar además lo que hay debajo.
    event.stopPropagation();
    this.shown.update((value) => !value);
  }

  close(): void {
    this.shown.set(false);
  }
}
