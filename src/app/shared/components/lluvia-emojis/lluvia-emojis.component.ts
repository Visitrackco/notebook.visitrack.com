import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { LluviaEmojisService } from '../../../core/services/lluvia-emojis.service';

/**
 * Las caritas que suben por la pantalla cuando una regla del flujo lo pide.
 *
 * ## Por qué vive en la raíz y no dentro del formulario
 *
 * Porque no es del formulario: es de la pantalla. Metida en el árbol de los
 * campos tendría que caber en algún sitio, se recortaría al llegar al borde de
 * la lista y subiría con el desplazamiento cuando alguien moviera la página.
 * Aquí flota por encima de todo, ocupa la ventana entera y no obliga a que
 * ningún campo sepa que existe. Es el mismo sitio que los avisos, y por lo
 * mismo. Ver `App`.
 *
 * ## Por qué no bloquea nada
 *
 * `pointer-events: none` en el contenedor: los clics y los dedos la atraviesan.
 * Una animación que se coma tres segundos de toques en un formulario de
 * cuarenta preguntas es una animación que alguien va a pedir que quitemos.
 *
 * ## Por qué CSS y no `requestAnimationFrame`
 *
 * Hasta ochenta caritas subiendo a la vez. Movidas desde JavaScript, cada
 * fotograma pasaría por el hilo que además está guardando el formulario con
 * cada tecla; en CSS las mueve el compositor y ni siquiera repintan. Y la
 * trayectoria de cada una está decidida de antemano —ver `LluviaEmojisService`—,
 * así que no hay nada que recalcular por el camino.
 */
@Component({
  selector: 'vt-lluvia-emojis',
  standalone: true,
  template: `
    @for (lluvia of lluvias.lluvias(); track lluvia.id) {
      <!-- «aria-hidden»: es adorno. Un lector de pantalla anunciando ochenta
           veces «fiesta» tapa lo único que importa, que es el formulario. -->
      <div class="lluvia" aria-hidden="true">
        @for (carita of lluvia.caritas; track $index) {
          <!--
            Los estilos vienen ya armados desde el servicio, y la plantilla no
            llama a ningún método.

            Una llamada aquí se ejecuta en cada ciclo de detección de cambios y
            devolvía un objeto nuevo, así que Angular reescribía los estilos de
            las cien caritas cada vez. Sin Zone.js los ciclos los disparan las
            señales —varias por cada tecla en un campo—, y eso era lo que hacía
            que escribir con una lluvia en pantalla se sintiera pastoso. Ver la
            nota de Carita en el servicio.
          -->
          <span class="lluvia__sube" [style]="carita.estiloViaje">
            <span class="lluvia__vaiven" [style]="carita.estiloVaiven">{{
              carita.figura
            }}</span>
          </span>
        }
      </div>
    }
  `,
  styles: [
    `
      .lluvia {
        position: fixed;
        inset: 0;
        z-index: 1300;
        overflow: hidden;

        /* Lo que hace que no estorbe. Ver la explicación de la clase. */
        pointer-events: none;
      }

      /*
       * Nace por debajo del borde de abajo y muere por encima del de arriba: así
       * ni aparece ni desaparece a la vista, que es lo que delata que aquello es
       * un elemento y no algo que pasa volando.
       */
      .lluvia__sube {
        position: absolute;
        bottom: -80px;
        line-height: 1;
        will-change: transform, opacity;
        animation-name: lluvia-sube, lluvia-tinte;
        animation-timing-function: linear;

        /* «both»: antes de que le toque salir se queda invisible en su sitio de
           partida, y al terminar no vuelve de un salto al borde de abajo. */
        animation-fill-mode: both;
      }

      @keyframes lluvia-sube {
        to {
          transform: translate3d(0, calc(-100vh - 160px), 0);
        }
      }

      /*
       * Aparece y se apaga.
       *
       * Un emoji que se corta de golpe al llegar arriba se ve como un fallo de
       * dibujo. Entrando y saliendo con un desvanecido, el ojo lo lee como que
       * se aleja.
       */
      @keyframes lluvia-tinte {
        0% {
          opacity: 0;
        }

        12% {
          opacity: 1;
        }

        75% {
          opacity: 1;
        }

        100% {
          opacity: 0;
        }
      }

      /*
       * El vaivén va en un elemento aparte porque son dos movimientos con ritmos
       * distintos sobre la misma propiedad: subir es una vez y de un tirón,
       * mecerse es varias y de ida y vuelta. En el mismo elemento, el segundo
       * «transform» pisaría al primero y las caritas se quedarían abajo
       * meciéndose.
       */
      .lluvia__vaiven {
        display: inline-block;
        animation-name: lluvia-vaiven;
        animation-timing-function: ease-in-out;
        animation-direction: alternate;
        animation-fill-mode: both;
      }

      @keyframes lluvia-vaiven {
        from {
          transform: translateX(calc(var(--lluvia-vaiven) * -1))
            rotate(calc(var(--lluvia-giro) * -1));
        }

        to {
          transform: translateX(var(--lluvia-vaiven)) rotate(var(--lluvia-giro));
        }
      }

      /**
       * Quien pidió que nada se mueva no ve la lluvia.
       *
       * No se trata de acortarla: son decenas de objetos cruzando la pantalla, y
       * para quien tiene sensibilidad al movimiento eso es exactamente lo que la
       * preferencia del sistema está pidiendo que no ocurra. La información no se
       * pierde por ello — una animación es celebración, no dato.
       */
      @media (prefers-reduced-motion: reduce) {
        .lluvia {
          display: none;
        }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LluviaEmojisComponent {
  protected readonly lluvias = inject(LluviaEmojisService);
}
