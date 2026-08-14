import { Component, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { ElementRef } from '@angular/core';
import QRCode from 'qrcode';

import { DeviceLinkService } from '../../core/services/device-link.service';
import { IconComponent } from '../../shared/components/icon/icon.component';

/**
 * Traer al navegador el trabajo que está en el teléfono.
 *
 * ## Por qué existe
 *
 * El navegador solo ve lo que llegó a Visitrack. Quien lleva días en campo
 * tiene en su teléfono actividades a medias, ubicaciones que creó y fotos que
 * no han podido subir por falta de señal — y desde un computador no hay forma
 * de continuar ese trabajo.
 *
 * ## Por qué un código y no una contraseña
 *
 * Porque el navegador no es quien tiene que demostrar nada: **quien está
 * autenticado es el teléfono**. Aquí solo se enseña a qué equipo hay que
 * entregar los datos, y el teléfono decide si acepta viendo qué navegador y qué
 * sistema lo piden.
 *
 * Eso hace del código una credencial, y por eso dura cinco minutos y se gasta
 * al primer uso. La cuenta atrás está a la vista: un código sin caducar
 * visible en una pantalla es una sesión al alcance de quien pase por detrás.
 */
@Component({
  selector: 'vt-link',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './link.component.html',
  styleUrl: './link.component.scss',
})
export class LinkComponent {
  readonly link = inject(DeviceLinkService);

  private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('qr');

  /** Segundos que le quedan al código. */
  readonly secondsLeft = signal(0);

  readonly lastLink = signal(this.link.lastLink());

  /** Para el porcentaje de la barra en la plantilla. */
  readonly Math = Math;

  readonly expired = computed(() => this.link.state() === 'caducado');

  /** Lo que se está enseñando arriba, en una frase. */
  readonly headline = computed(() => {
    switch (this.link.state()) {
      case 'pendiente':
        return 'Escanea este código con tu teléfono';

      case 'reclamado':
        return 'Teléfono reconocido. Preparando el envío…';

      case 'transfiriendo':
        return 'Trayendo tu trabajo…';

      case 'sincronizando':
        return 'Descargando tus datos…';

      case 'listo':
        return 'Listo';

      case 'caducado':
        return 'El código caducó';

      case 'error':
        return 'No se pudo vincular';

      default:
        return 'Vincular teléfono';
    }
  });

  private ticker?: ReturnType<typeof setInterval>;

  constructor() {
    /**
     * Al entrar, se empieza de cero.
     *
     * El servicio vive en la raíz y conserva lo suyo al salir de aquí. Si entre
     * una visita y otra se cerró sesión y entró otra cuenta, el código que
     * quedaba en pantalla lleva dentro el usuario anterior — el servidor lo
     * rechazaría al reclamarlo y el QR se vería normal fallando sin motivo
     * aparente. Un traspaso en curso de la misma cuenta sí se respeta.
     */
    this.link.refresh();
    this.lastLink.set(this.link.lastLink());

    /**
     * El código se dibuja cuando llega, no cuando se pide.
     *
     * El lienzo no existe hasta que la pantalla entra en modo «pendiente», así
     * que dibujarlo antes no pintaría nada y tampoco daría error — el fallo
     * más difícil de encontrar de los dos.
     */
    effect(() => {
      const code = this.link.code();
      const canvas = this.canvas()?.nativeElement;

      if (!code || !canvas) return;

      untracked(() => {
        void QRCode.toCanvas(canvas, code, {
          width: 260,
          margin: 1,
          errorCorrectionLevel: 'M',
        }).catch((error: unknown) => console.error('[Vincular] no se pudo dibujar el código', error));
      });
    });

    // La cuenta atrás. Va aquí y no en el servicio porque es solo presentación:
    // quien decide si el código sirve es el servidor.
    effect(() => {
      const expires = this.link.expiresAt();

      untracked(() => {
        clearInterval(this.ticker);
        if (!expires) return;

        const tick = () => {
          const left = Math.max(0, Math.round((expires.getTime() - Date.now()) / 1000));
          this.secondsLeft.set(left);
          if (left === 0) clearInterval(this.ticker);
        };

        tick();
        this.ticker = setInterval(tick, 1000);
      });
    });
  }

  /** El reloj, en minutos y segundos. */
  readonly countdown = computed(() => {
    const total = this.secondsLeft();
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;

    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  });

  async start(): Promise<void> {
    this.lastLink.set(this.link.lastLink());
    await this.link.start();
  }

  cancel(): void {
    this.link.stop();
  }

  /** Cuándo fue la última vinculación, en palabras. */
  whenLinked(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';

    return date.toLocaleString('es-CO', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}
