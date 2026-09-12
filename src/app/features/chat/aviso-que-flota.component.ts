import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';

import { AvisoQueFlotaService } from './aviso-que-flota.service';

/**
 * El aviso que sube flotando cuando llega un mensaje del chat.
 *
 * ## Por qué vive en la raíz y no en la pantalla del chat
 *
 * Porque es justo cuando **no** se tiene el chat abierto cuando hace falta: el
 * aviso tiene que salir igual desde Actividades, desde un formulario a medio
 * llenar o desde los informes. Montado dentro del chat, solo aparecía donde ya
 * se veía el mensaje.
 *
 * ## Por qué sube y no baja
 *
 * Porque bajando desde arriba tapa la cabecera, que es donde está el título de
 * lo que se está haciendo y los botones de la pantalla. Subiendo desde el
 * costado entra por donde no hay nada y sale por arriba, y en su camino no cubre
 * ningún control.
 *
 * La cola, las duraciones y el filtro de la pestaña están en
 * `AvisoQueFlotaService`; aquí solo se pinta y se responde al clic.
 */
@Component({
  selector: 'vt-aviso-que-flota',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (aviso of enPantalla(); track aviso.clave) {
      <!--
        \`role="status"\` y no \`alert\`: es informativo, no urgente. Con \`alert\` el
        lector de pantalla interrumpe lo que esté leyendo, y un mensaje de chat
        no justifica cortar a alguien a media frase.

        La duración viaja como variable de CSS porque la decide la cola: el que
        sale con gente detrás dura la mitad. Ver \`AvisoQueFlotaService\`.
      -->
      <div class="aqf" role="status" aria-live="polite" [style.--aqf-dura.ms]="aviso.duracionMs">
        <button type="button" class="aqf__burbuja" (click)="abrir(aviso.salaId)">
          <span class="aqf__inicial" aria-hidden="true">{{ aviso.inicial }}</span>

          <span class="aqf__texto">
            <span class="aqf__autor">{{ aviso.autor }}</span>
            <span class="aqf__resumen">{{ aviso.resumen }}</span>
          </span>
        </button>
      </div>
    }
  `,
  styles: [
    `
      /*
        El envoltorio hace el recorrido; la burbuja de dentro hace la entrada.

        Van separados porque son dos movimientos con ritmos distintos —entra
        deprisa desde el costado, sube despacio durante todo el rato— y meterlos
        en una sola animación obliga a interpolar las dos cosas en los mismos
        fotogramas: la entrada se estiraba a lo largo de los cuatro segundos y la
        burbuja cruzaba la pantalla de lado en vez de asomarse.
      */
      .aqf {
        position: fixed;
        bottom: 24px;

        /*
          Pegado al costado izquierdo: es por donde entra, y la pila de avisos
          general vive abajo a la derecha. Compartiendo esquina se taparían, que
          es justo lo que pasaba cuando esto era un toast más.
        */
        left: 16px;

        /*
          Por encima de la pila de avisos (90) porque dura segundos y ella se
          queda: si algo tiene que ceder, es lo permanente. Por debajo de los
          diálogos modales, que sí piden una respuesta.
        */
        z-index: 120;
        max-width: min(380px, calc(100vw - 32px));
        animation: aqf-flota var(--aqf-dura, 4200ms) linear forwards;

        /* Mientras cruza no debe comerse los clics de la pantalla que hay
           debajo: solo la burbuja es tocable. */
        pointer-events: none;
      }

      /*
        Sube un tercio de la ventana en todo su recorrido y se apaga al final.

        Lo justo para que se lea como que se va, sin cruzarla entera y llamar la
        atención. El apagado empieza al 75%: hasta ahí está a plena opacidad, que
        es cuando se lee.
      */
      @keyframes aqf-flota {
        0% {
          opacity: 1;
          transform: translateY(0);
        }

        75% {
          opacity: 1;
          transform: translateY(-22vh);
        }

        100% {
          opacity: 0;
          transform: translateY(-30vh);
        }
      }

      .aqf__burbuja {
        display: flex;
        gap: 10px;
        align-items: center;
        width: 100%;
        padding: 8px 16px 8px 8px;
        font: inherit;
        color: var(--vt-text);
        text-align: left;
        cursor: pointer;
        background: var(--vt-surface);
        border: 1px solid color-mix(in srgb, var(--vt-brand) 35%, transparent);

        /* Redonda del todo: se distingue de una tarjeta, de un toast o de un
           diálogo de un vistazo, que es lo que evita que se lea como algo que
           hay que atender. */
        border-radius: var(--vt-radius-full, 999px);
        box-shadow: 0 6px 18px rgb(0 0 0 / 22%);
        pointer-events: auto;
        animation: aqf-entra calc(var(--aqf-dura, 4200ms) * 0.12)
          cubic-bezier(0.34, 1.3, 0.64, 1) backwards;
      }

      /*
        Entra desde fuera del costado.

        El desplazamiento va en porcentaje del propio ancho y no en píxeles
        fijos: con una cifra fija, una burbuja larga empezaba ya medio visible en
        vez de asomarse desde fuera.
      */
      @keyframes aqf-entra {
        from {
          opacity: 0;
          transform: translateX(-110%);
        }
      }

      .aqf__burbuja:hover {
        border-color: var(--vt-brand);
      }

      .aqf__inicial {
        display: grid;
        flex: 0 0 auto;
        place-items: center;
        width: 34px;
        height: 34px;
        color: #fff;
        font-size: 0.9rem;
        font-weight: 700;
        background: var(--vt-brand);
        border-radius: var(--vt-radius-full, 999px);
      }

      .aqf__texto {
        display: flex;
        flex-direction: column;
        gap: 1px;

        /* Sin esto el texto no se encoge y el text-overflow de los hijos no
           llega a aplicarse: la burbuja crecía hasta salirse de la ventana. */
        min-width: 0;
      }

      .aqf__autor,
      .aqf__resumen {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }

      .aqf__autor {
        font-size: 0.78rem;
        font-weight: 700;
      }

      .aqf__resumen {
        color: var(--vt-text-muted);
        font-size: 0.76rem;
      }

      /*
        Quien pidió menos movimiento no lo pidió solo para las transiciones.

        Sin recorrido, el aviso aparece donde nace y se va cuando le toca. El
        reloj que lo retira es de JavaScript y no depende de la animación, así
        que quitarla no lo deja pegado en pantalla.
      */
      @media (prefers-reduced-motion: reduce) {
        .aqf,
        .aqf__burbuja {
          animation: none;
        }
      }

      @media (max-width: 640px) {
        .aqf {
          right: 12px;
          left: 12px;
          max-width: none;
        }
      }
    `,
  ],
})
export class AvisoQueFlotaComponent {
  private readonly avisos = inject(AvisoQueFlotaService);
  private readonly router = inject(Router);

  /**
   * El aviso puesto, como lista de cero o un elemento.
   *
   * Es un `@for` con `track` y no un `@if` a propósito: con `@if` Angular
   * reaprovecha el nodo al cambiar de aviso y la animación no vuelve a arrancar,
   * así que el segundo salía ya arriba y desvanecido, donde se había apagado el
   * primero. Rastreando por la clave, cada aviso es un elemento nuevo y su
   * animación empieza de cero.
   */
  readonly enPantalla = computed(() => {
    const a = this.avisos.puesto();

    return a ? [a] : [];
  });

  /** Se tocó: a la sala, y la cola se vacía. */
  abrir(salaId: number): void {
    this.avisos.tocado();

    void this.router.navigate(['/chat', salaId]);
  }
}
