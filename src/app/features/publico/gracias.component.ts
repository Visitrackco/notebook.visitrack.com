import { DestroyRef, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { guidPublico, RUTA_ENLACE } from '../../core/config/modo-publico';
import { PendingUploadService } from '../../core/sync/pending-upload.service';
import { IconComponent } from '../../shared/components/icon/icon.component';

/** Cada cuánto se vuelve a mirar si ya subió. */
const LATIDO_MS = 4000;

/**
 * El final de un enlace público.
 *
 * ## Por qué no basta con «Gracias»
 *
 * Porque en este momento la respuesta **todavía puede no haber llegado**. La
 * cola sube primero los archivos, espera a que el servidor confirme que están en
 * el bucket y solo entonces crea la actividad — con tres fotos y una conexión
 * de campo eso son segundos o minutos.
 *
 * Y aquí no hay red de seguridad: no hay sesión con la que reconocer a esta
 * persona mañana, ni proceso de servidor que rescate una respuesta abandonada.
 * Si cierra la pestaña antes de tiempo, lo que queda se guarda en este navegador
 * y solo se recupera volviendo a abrir **el mismo enlace en el mismo equipo**.
 *
 * Así que esta pantalla dice la verdad y la sigue diciendo hasta que deje de
 * haber algo en vuelo. Un «Gracias, ya está» mostrado sobre una subida a medias
 * es la forma más segura de perder el trabajo de alguien.
 */
@Component({
  selector: 'vt-gracias',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './gracias.component.html',
  styleUrl: './gracias.component.scss',
})
export class GraciasComponent {
  private readonly uploads = inject(PendingUploadService);
  private readonly router = inject(Router);

  /** Lo que queda por llegar a Visitrack. */
  readonly pendientes = this.uploads.pending;

  readonly reintentando = signal(false);

  /** Nada pendiente: se puede cerrar tranquilo. */
  readonly listo = computed(() => this.pendientes().length === 0);

  /** Está esperando a que sus archivos estén en el bucket. */
  readonly esperandoArchivos = computed(() =>
    this.pendientes().some((p) => p.blockingFiles > 0),
  );

  /** Alguna necesita que una persona la corrija: no se arregla sola. */
  readonly atascadas = computed(() => this.pendientes().filter((p) => p.issue !== null));

  readonly titulo = computed(() => {
    if (this.listo()) return '¡Gracias! Ya quedó registrado';
    if (this.atascadas().length > 0) return 'No se pudo enviar del todo';
    if (this.esperandoArchivos()) return 'Enviando tus archivos…';

    return 'Enviando…';
  });

  readonly explicacion = computed(() => {
    if (this.listo()) {
      /*
       * Y se dice que puede cerrar.
       *
       * Es lo que casi todo el mundo va a hacer, y decirlo cierra el asunto: sin
       * esa frase la pantalla se queda con un botón de «llenar otra» y la duda
       * de si hace falta pulsar algo para que lo enviado cuente.
       */
      return 'Tu respuesta llegó completa. Ya puedes cerrar esta página, o llenar otra si te falta alguna.';
    }

    if (this.atascadas().length > 0) {
      return (
        'Algo en la respuesta no cuadra y hace falta revisarla. Avísale a quien te ' +
        'envió el enlace, y no cierres esta página hasta entonces.'
      );
    }

    if (this.esperandoArchivos()) {
      return (
        'Las fotos y los archivos se están subiendo. No cierres esta página hasta ' +
        'que termine, o habrá que hacerlo otra vez.'
      );
    }

    return 'Un momento, se está enviando. No cierres esta página todavía.';
  });

  constructor() {
    void this.uploads.refresh();

    /*
     * Se vuelve a mirar cada pocos segundos.
     *
     * La cola trabaja por su cuenta y no avisa a nadie al terminar; sin este
     * latido, la pantalla se quedaría diciendo «enviando» para siempre sobre una
     * respuesta que ya llegó, y esta es la única pantalla que esa persona va a
     * ver.
     *
     * Se para al salir: un intervalo suelto sigue despertando la pestaña.
     */
    const latido = setInterval(() => void this.uploads.refresh(), LATIDO_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(latido));
  }

  /** Vuelve a intentar lo que quedó. */
  async reintentar(): Promise<void> {
    this.reintentando.set(true);

    try {
      await this.uploads.run();
    } finally {
      this.reintentando.set(false);
      await this.uploads.refresh();
    }
  }

  /**
   * Empieza otra respuesta con el mismo enlace.
   *
   * ## Por qué esta es la única salida
   *
   * Porque es lo único que quien abrió un enlace puede querer hacer después de
   * terminar: llenar otra. No hay a dónde «volver» —no vino de ningún sitio de
   * la aplicación— y sacarlo a la pantalla de inicio lo dejaba delante de un
   * formulario de acceso que no le sirve, con una cuenta que no tiene.
   *
   * Se va a la puerta del enlace y no se crea la actividad desde aquí: ahí es
   * donde vive todo lo que hay que rehacer —resolver el enlace, pedir la
   * ubicación y el activo si el enlace no los fijó— y repetirlo aquí sería la
   * misma secuencia escrita dos veces.
   *
   * La respuesta que se acaba de guardar **sigue subiendo** mientras tanto: la
   * cola vive en el armazón, que no se desmonta al cambiar de pantalla.
   */
  otro(): void {
    void this.router.navigate(['/', RUTA_ENLACE, guidPublico()]);
  }
}
