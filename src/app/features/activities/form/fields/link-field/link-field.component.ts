import { Component, computed, inject, input, signal } from '@angular/core';

import { FormField } from '../../../../../core/forms/form-schema';
import { AuthService } from '../../../../../core/services/auth.service';
import { IconComponent } from '../../../../../shared/components/icon/icon.component';

/**
 * Marcadores que el formulario puede dejar en la dirección.
 *
 * Son los mismos de la app, y con los mismos nombres: la plantilla la escribe
 * el diseñador de formularios en Visitrack, una sola vez para los dos clientes.
 * Renombrarlos aquí obligaría a mantener dos versiones de cada enlace.
 */
const PLACEHOLDERS = {
  /** Token de la sesión, para que el destino no vuelva a pedir credenciales. */
  TOKEN: '[TOKEN]',
  /** GUID de la actividad abierta. */
  ANSWERGUID: '[ANSWERGUID]',
  /** GUID del usuario. */
  USERGUID: '[USERGUID]',
} as const;

/**
 * Campo de hipervínculo.
 *
 * ## Para qué sirve de verdad
 *
 * No es un enlace decorativo: es la puerta a otro sistema desde dentro del
 * formulario. Un tablero, un manual, una herramienta de la compañía. La
 * dirección lleva marcadores que se sustituyen al pulsar —el token de la
 * sesión, la actividad, el usuario—, y eso es lo que permite que el destino
 * sepa quién llega y desde dónde sin pedir credenciales otra vez.
 *
 * ## Por qué se resuelve al pulsar y no al cargar
 *
 * El token caduca. Resolviéndolo al abrir el formulario, un enlace copiado
 * media hora antes llevaría uno ya vencido — y peor, quedaría **guardado** en
 * el campo. Aquí la plantilla no se toca nunca: cada acción parte de ella y
 * resuelve sobre una copia, igual que hace la app.
 */
@Component({
  selector: 'vt-link-field',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './link-field.component.html',
  styleUrl: './link-field.component.scss',
})
export class LinkFieldComponent {
  private readonly auth = inject(AuthService);

  readonly field = input.required<FormField>();

  /** Actividad abierta, para el marcador de la actividad. */
  readonly answerGuid = input('');

  readonly feedback = signal('');

  /** La plantilla, tal como la escribió el diseñador del formulario. */
  readonly template = computed(() => (this.field().val || this.field().url || '').trim());

  readonly label = computed(() => this.field().lab || this.field().txt || 'Abrir enlace');

  readonly hasLink = computed(() => this.template().length > 0);

  /**
   * La dirección sin el token, para enseñarla.
   *
   * Un token en pantalla es una credencial a la vista de quien mire por encima
   * del hombro, y en campo se trabaja con gente alrededor. Se muestra el
   * destino, que es lo que importa saber antes de pulsar.
   */
  readonly preview = computed(() => {
    const url = this.resolve({ withToken: false });
    return url.length > 70 ? `${url.slice(0, 67)}…` : url;
  });

  /** El destino tiene marcadores que dependen de la sesión. */
  readonly isDynamic = computed(() =>
    Object.values(PLACEHOLDERS).some((mark) => this.template().includes(mark)),
  );

  /**
   * Sustituye los marcadores por los valores de la sesión.
   *
   * `[]` sobrante se limpia al final, como en la app: los formularios traen
   * pares vacíos de plantillas que se editaron a medias, y dejarlos produce
   * direcciones que el navegador rechaza.
   */
  private resolve(options: { withToken: boolean }): string {
    const user = this.auth.currentUser();
    let url = this.template();

    if (!url) return '';

    url = url.replaceAll(
      PLACEHOLDERS.TOKEN,
      options.withToken ? (user?.Token ?? '') : '•••',
    );
    url = url.replaceAll(PLACEHOLDERS.ANSWERGUID, this.answerGuid());
    url = url.replaceAll(PLACEHOLDERS.USERGUID, user?.GUID ?? '');

    return url.replaceAll('[]', '');
  }

  /**
   * Abre el destino en otra pestaña.
   *
   * `noopener` no es opcional: sin él, la página abierta puede manipular la que
   * la abrió a través de `window.opener`, y aquí la que abre es un formulario a
   * medio diligenciar.
   */
  open(): void {
    const url = this.resolve({ withToken: true });
    if (!url) return;

    const opened = window.open(url, '_blank', 'noopener,noreferrer');

    // Un bloqueador de ventanas emergentes devuelve null. Decirlo evita que el
    // usuario pulse cinco veces creyendo que no funcionó.
    if (!opened) {
      this.feedback.set(
        'El navegador bloqueó la ventana. Permite las ventanas emergentes de este sitio.',
      );
    }
  }

  /** Copia la dirección ya resuelta. */
  async copy(): Promise<void> {
    const url = this.resolve({ withToken: true });
    if (!url) return;

    try {
      await navigator.clipboard.writeText(url);
      this.feedback.set('Enlace copiado.');
    } catch {
      this.feedback.set('No se pudo copiar. Ábrelo y copia la dirección desde la barra.');
    }
  }

  /**
   * Comparte por los medios del sistema.
   *
   * Solo aparece donde existe `navigator.share` —móviles y algunos
   * escritorios—. Donde no, el botón no se dibuja en vez de fallar al pulsarlo.
   */
  readonly canShare = typeof navigator !== 'undefined' && Boolean(navigator.share);

  async share(): Promise<void> {
    const url = this.resolve({ withToken: true });
    if (!url) return;

    try {
      await navigator.share({ title: this.label(), text: this.label(), url });
    } catch {
      // Cancelar el diálogo de compartir también entra aquí, y eso no es un
      // error del que haya que informar.
    }
  }
}
