import { Component, computed, inject, input } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';

import { FormField } from '../../../../../core/forms/form-schema';
import { AuthService } from '../../../../../core/services/auth.service';
import { IconComponent } from '../../../../../shared/components/icon/icon.component';

/**
 * Marcadores que el formulario puede dejar en la dirección. Los mismos del
 * hipervínculo y de la app: la plantilla la escribe el diseñador una sola vez.
 */
const PLACEHOLDERS = {
  TOKEN: '[TOKEN]',
  ANSWERGUID: '[ANSWERGUID]',
  USERGUID: '[USERGUID]',
} as const;

/**
 * Campo `webform` con URL: lo mismo que el hipervínculo (misma plantilla con
 * `[TOKEN]`/`[ANSWERGUID]`/`[USERGUID]`), pero en vez de abrir otra pestaña la
 * dirección se **renderiza aquí dentro**, en un iframe. Es el equivalente web
 * del WebView nativo del móvil.
 *
 * La plantilla no se toca ni se guarda: se resuelve sobre una copia cada vez,
 * porque el token caduca.
 */
@Component({
  selector: 'vt-webform-field',
  standalone: true,
  imports: [IconComponent],
  template: `
    @if (hasLink()) {
      <div class="webform">
        <div class="webform__bar">
          <span class="webform__preview" [title]="preview()">{{ preview() }}</span>
          <button type="button" class="webform__open" (click)="openTab()">
            <vt-icon name="send" [size]="14" />
            Abrir en pestaña
          </button>
        </div>
        <iframe
          class="webform__frame"
          [src]="safeUrl()"
          referrerpolicy="no-referrer"
          sandbox="allow-forms allow-scripts allow-same-origin allow-popups"
          loading="lazy"
        ></iframe>
      </div>
    } @else {
      <p class="webform__vacio">Este campo no tiene una dirección configurada.</p>
    }
  `,
  styles: [
    `
      .webform {
        display: flex;
        flex-direction: column;
        border: 1px solid var(--mat-sys-outline-variant, #cbd5e1);
        border-radius: 12px;
        overflow: hidden;
      }
      .webform__bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 6px 10px;
        background: var(--mat-sys-surface-container-high, #eef1f5);
        font-size: 12px;
      }
      .webform__preview {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--mat-sys-on-surface-variant, #475569);
      }
      .webform__open {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        border: 0;
        background: transparent;
        color: var(--mat-sys-primary, #b3122a);
        font: inherit;
        font-weight: 600;
        cursor: pointer;
        white-space: nowrap;
      }
      .webform__frame {
        width: 100%;
        height: 520px;
        border: 0;
        background: #fff;
      }
      .webform__vacio {
        margin: 0;
        font-size: 13px;
        color: var(--mat-sys-on-surface-variant, #475569);
      }
    `,
  ],
})
export class WebformFieldComponent {
  private readonly auth = inject(AuthService);
  private readonly sanitizer = inject(DomSanitizer);

  readonly field = input.required<FormField>();
  readonly answerGuid = input('');

  /** La plantilla, tal como la escribió el diseñador del formulario. */
  readonly template = computed(() => (this.field().val || this.field().url || '').trim());

  readonly hasLink = computed(() => this.template().length > 0);

  /** La dirección sin el token, para enseñarla en la barra. */
  readonly preview = computed(() => {
    const url = this.resolve(false);
    return url.length > 90 ? `${url.slice(0, 87)}…` : url;
  });

  /** La dirección resuelta (con token), ya marcada como segura para el iframe. */
  readonly safeUrl = computed<SafeResourceUrl>(() =>
    this.sanitizer.bypassSecurityTrustResourceUrl(this.resolve(true)),
  );

  /** Sustituye los marcadores por los valores de la sesión. */
  private resolve(withToken: boolean): string {
    const user = this.auth.currentUser();
    let url = this.template();
    if (!url) return '';

    url = url.replaceAll(PLACEHOLDERS.TOKEN, withToken ? (user?.Token ?? '') : '•••');
    url = url.replaceAll(PLACEHOLDERS.ANSWERGUID, this.answerGuid());
    url = url.replaceAll(PLACEHOLDERS.USERGUID, user?.GUID ?? '');

    return url.replaceAll('[]', '');
  }

  /** Abre el destino en otra pestaña, por si el iframe lo bloquea el sitio. */
  openTab(): void {
    const url = this.resolve(true);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }
}
