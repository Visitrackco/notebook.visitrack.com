import { Component, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { filter, map, startWith } from 'rxjs';

import { ChatSocketService } from './chat-socket.service';

/**
 * «Te está hablando Fulano», flotando abajo mientras dura la transmisión.
 *
 * ## Por qué hace falta
 *
 * La voz llega y suena, venga de la sala que venga. Pero sin nada en pantalla,
 * lo único que se oye es a alguien hablando **sin saber quién ni desde dónde**:
 * con seis salas, contestar exige abrir el chat y adivinar en cuál era. La
 * respuesta llega tarde o no llega, y entonces el walkie deja de usarse.
 *
 * ## Por qué abajo, y no arriba como el aviso de un mensaje
 *
 * Porque no compiten por lo mismo. El de un mensaje es una interrupción que
 * aparece y se va, y arriba está fuera del paso. Esto **dura lo que dura la
 * transmisión** y hay que poder pulsarlo mientras suena: abajo es donde ya se
 * espera encontrar lo que está pasando ahora.
 *
 * ## Y por qué en ámbar
 *
 * Es una transmisión en curso, no un error ni un mensaje nuevo. El rojo diría
 * «algo va mal», y el color de la aplicación ya lo usa el aviso de mensaje. El
 * ámbar dice «en el aire», que es lo que es.
 */
@Component({
  selector: 'vt-hablando-que-flota',
  standalone: true,
  template: `
    @if (loQueSuena(); as turno) {
      <button type="button" class="hab" (click)="abrir(turno.salaId)">
        <span class="hab__ondas" aria-hidden="true">
          @for (barra of barras; track barra) {
            <i [style.animation-delay.ms]="barra * 110"></i>
          }
        </span>

        <span class="hab__texto">
          <strong>{{ turno.nombre || 'Alguien' }} te está hablando</strong>
          <small>Pulsa para abrir la sala</small>
        </span>

        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path d="M9 18l6-6-6-6" fill="none" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    }
  `,
  styles: [
    `
      :host {
        position: fixed;
        right: 0;
        bottom: 24px;
        left: 0;
        z-index: 60;
        display: flex;
        justify-content: center;

        /* El hueco alrededor no puede tragarse los clics de lo que hay
           debajo: el anfitrión ocupa el ancho entero y solo el botón recibe. */
        pointer-events: none;
      }

      .hab {
        display: flex;
        gap: 12px;
        align-items: center;
        max-width: min(420px, calc(100vw - 32px));
        padding: 10px 18px 10px 14px;
        color: #fff;
        font: inherit;
        text-align: left;
        background: #3a2a00;
        border: 1px solid rgba(255, 179, 0, 0.55);
        border-radius: 999px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32);
        cursor: pointer;
        pointer-events: auto;
        animation: hab-entra 260ms ease-out;
      }

      .hab:hover {
        border-color: rgba(255, 179, 0, 0.9);
      }

      .hab__texto {
        display: flex;
        min-width: 0;
        flex-direction: column;
      }

      .hab__texto strong {
        overflow: hidden;
        font-size: 14px;
        font-weight: 600;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .hab__texto small {
        color: rgba(255, 179, 0, 0.9);
        font-size: 12px;
      }

      /* Las barras de sonido. Cada una entra desfasada, para que se lea como
         una onda recorriéndolas y no como un bloque que sube y baja. */
      .hab__ondas {
        display: flex;
        gap: 3px;
        align-items: center;
        height: 26px;
      }

      .hab__ondas i {
        width: 3px;
        height: 30%;
        background: linear-gradient(to top, #ffb300, #ff6d00);
        border-radius: 999px;
        animation: hab-onda 900ms ease-in-out infinite;
      }

      @keyframes hab-onda {
        0%,
        100% {
          height: 30%;
        }
        50% {
          height: 100%;
        }
      }

      @keyframes hab-entra {
        from {
          opacity: 0;
          transform: translateY(14px);
        }
      }

      /*
       * Quien pide menos movimiento no pierde el aviso, solo el baile: las
       * barras se quedan quietas a media altura y sigue leyéndose como sonido.
       */
      @media (prefers-reduced-motion: reduce) {
        .hab,
        .hab__ondas i {
          animation: none;
        }

        .hab__ondas i {
          height: 65%;
        }
      }
    `,
  ],
})
export class HablandoQueFlotaComponent {
  private readonly chat = inject(ChatSocketService);
  private readonly router = inject(Router);

  /** Cinco barras. El número solo existe para poder desfasarlas en la plantilla. */
  readonly barras = [0, 1, 2, 3, 4];

  /** En qué dirección está la aplicación ahora mismo. */
  private readonly donde = toSignal(
    this.router.events.pipe(
      takeUntilDestroyed(),
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
      startWith(this.router.url),
    ),
    { initialValue: this.router.url },
  );

  /** Se oculta a mano al pulsar, hasta que llegue otra transmisión. */
  private readonly cerrado = signal('');

  /**
   * La transmisión que merece anunciarse, o nula.
   *
   * **No la de la sala que se tiene delante.** Ahí la conversación ya lo dice
   * con su propia franja, y un segundo aviso flotando encima tapa justo los
   * mensajes que se están mirando.
   */
  readonly loQueSuena = computed(() => {
    const turno = this.chat.hablando();

    if (!turno?.salaId) return null;

    const ruta = this.donde().split(/[?#]/)[0];
    if (ruta === `/chat/${turno.salaId}`) return null;

    if (this.cerrado() === `${turno.salaId}:${turno.userId}`) return null;

    return turno;
  });

  abrir(salaId: number): void {
    const turno = this.chat.hablando();

    // Se marca como visto antes de navegar: si no, al llegar a la sala el
    // aviso seguiría un instante encima de ella.
    if (turno) this.cerrado.set(`${turno.salaId}:${turno.userId}`);

    void this.router.navigate(['/chat', salaId]);
  }
}
