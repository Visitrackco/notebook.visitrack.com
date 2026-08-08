import { Component, inject } from '@angular/core';

import { ShortcutsService } from '../../../core/services/shortcuts.service';
import { IconComponent } from '../icon/icon.component';

/**
 * El panel con los atajos disponibles.
 *
 * ## Por qué se genera solo
 *
 * No es una lista escrita a mano: sale de los atajos **registrados en ese
 * momento**, así que enseña los del formulario cuando se está en un formulario
 * y los generales cuando no. Una lista fija se desactualiza en cuanto alguien
 * añade o quita uno, y entonces enseña atajos que no funcionan — que es peor
 * que no enseñar ninguno.
 */
@Component({
  selector: 'vt-shortcuts-help',
  standalone: true,
  imports: [IconComponent],
  template: `
    @if (shortcuts.helpOpen()) {
      <div class="help" (click)="close()">
        <div class="help__panel" (click)="$event.stopPropagation()">
          <header class="help__head">
            <strong>Atajos de teclado</strong>

            <button type="button" (click)="close()" aria-label="Cerrar">
              <vt-icon name="close" [size]="18" />
            </button>
          </header>

          <div class="help__body">
            @for (group of shortcuts.groups(); track group.title) {
              <section class="help__group">
                <h3>{{ group.title }}</h3>

                <ul>
                  @for (item of group.items; track item.id) {
                    <li>
                      <span>{{ item.label }}</span>

                      <span class="help__keys">
                        @for (key of keysOf(item.keys); track $index) {
                          <kbd>{{ key }}</kbd>
                        }
                      </span>
                    </li>
                  }
                </ul>
              </section>
            }
          </div>

          <footer class="help__foot">
            Los atajos no funcionan mientras escribes en un campo, salvo los que
            llevan <kbd>Ctrl</kbd>.
          </footer>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .help {
        position: fixed;
        inset: 0;
        z-index: 80;
        display: grid;
        place-items: center;
        padding: var(--vt-space-4);
        background: rgb(8 10 13 / 45%);
      }

      .help__panel {
        display: flex;
        flex-direction: column;
        width: min(560px, 100%);
        max-height: 80vh;
        overflow: hidden;
        background: var(--vt-surface);
        border-radius: var(--vt-radius-lg);
        box-shadow: 0 24px 64px rgb(0 0 0 / 35%);
      }

      .help__head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--vt-space-4);
        border-bottom: 1px solid var(--vt-rule);

        strong {
          font-size: var(--vt-text-base);
          font-weight: 650;
          color: var(--vt-text);
        }

        button {
          display: grid;
          place-items: center;
          width: 32px;
          height: 32px;
          color: var(--vt-text-muted);
          background: none;
          border: 0;
          border-radius: var(--vt-radius);

          &:hover {
            background: var(--vt-surface-2);
          }
        }
      }

      .help__body {
        flex: 1;
        padding: var(--vt-space-4);
        overflow-y: auto;
      }

      .help__group {
        & + & {
          margin-top: var(--vt-space-4);
        }

        h3 {
          margin: 0 0 6px;
          font-size: 10px;
          font-weight: 700;
          color: var(--vt-text-subtle);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }

        ul {
          padding: 0;
          margin: 0;
          list-style: none;
        }

        li {
          display: flex;
          gap: var(--vt-space-3);
          align-items: center;
          justify-content: space-between;
          padding: 7px 0;
          font-size: var(--vt-text-sm);
          color: var(--vt-text);
          border-bottom: 1px solid var(--vt-rule);
        }
      }

      .help__keys {
        display: inline-flex;
        flex-shrink: 0;
        gap: 4px;
      }

      .help__foot {
        padding: 10px var(--vt-space-4);
        font-size: var(--vt-text-xs);
        color: var(--vt-text-subtle);
        background: var(--vt-surface-2);
        border-top: 1px solid var(--vt-rule);
      }

      kbd {
        padding: 2px 7px;
        font-family: var(--vt-font);
        font-size: 11px;
        font-weight: 700;
        color: var(--vt-text-muted);
        background: var(--vt-surface-2);
        border: 1px solid var(--vt-rule-strong);
        border-bottom-width: 2px;
        border-radius: 4px;
      }
    `,
  ],
})
export class ShortcutsHelpComponent {
  readonly shortcuts = inject(ShortcutsService);

  close(): void {
    this.shortcuts.closeAll();
  }

  /**
   * La combinación, tecla a tecla y con los nombres que se ven en el teclado.
   *
   * Se guardan en minúsculas y con `+` porque así se comparan; enseñarlas así
   * obligaría a traducir mentalmente `alt+arrowright`.
   */
  keysOf(keys: string): string[] {
    return keys
      .split(' ')
      .flatMap((combo) => combo.split('+'))
      .map((key) => LABELS[key] ?? key.toUpperCase());
  }
}

const LABELS: Record<string, string> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  arrowright: '→',
  arrowleft: '←',
  arrowup: '↑',
  arrowdown: '↓',
  escape: 'Esc',
  enter: 'Enter',
  '/': '/',
  '?': '?',
};
