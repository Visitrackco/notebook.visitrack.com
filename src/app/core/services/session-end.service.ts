import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';

import { esModoPublico } from '../config/modo-publico';
import { AuthService } from './auth.service';
import { NotifyService } from './notify.service';
import { SessionsApi } from './sessions.api';

/**
 * Qué hacer cuando el servidor deja de aceptar la sesión.
 *
 * ## Por qué es un servicio y no código dentro del interceptor
 *
 * El 401 llega por dos caminos distintos: las peticiones de `HttpClient`, que
 * pasan por el interceptor, y las que se hacen con `fetch()` —la
 * sincronización, sobre todo— que no pasan por ningún sitio. Si cada camino
 * resolviera lo suyo, habría dos versiones de la misma decisión y una de las
 * dos se quedaría atrás.
 *
 * ## Una sola vez, aunque fallen diez
 *
 * Cuando la sesión deja de valer, **todas** las peticiones en vuelo fallan a la
 * vez. Sin la marca de abajo, cada una abriría su propio cierre: el mismo aviso
 * diez veces, diez llamadas a `/logout` y diez navegaciones al inicio.
 *
 * La marca se levanta de forma **síncrona**, en el mismo instante en que llega
 * el primer 401. Comprobar `isAuthenticated()` no basta: es asíncrono, y los
 * diez 401 llegan antes de que el primer cierre termine.
 *
 * ## Un 401 es una acusación, no una prueba
 *
 * No todas las peticiones hablan de nuestra sesión. Al traer los datos de un
 * teléfono, parte del traspaso se autentica con el código del enlace y no con
 * el token del navegador: su 401 significa «ese código no vale». Tratarlo como
 * «tu sesión terminó» cerraba una sesión que estaba perfectamente viva, y con
 * varias cuentas recordadas en el mismo navegador el usuario acababa fuera sin
 * entender por qué — justo en mitad de un traspaso, que es cuando más trabajo
 * hay en juego.
 *
 * Por eso antes de cerrar se pregunta. Y solo se cierra con un **sí** del
 * servidor: si no se puede preguntar —sin red, servidor caído— la sesión se
 * queda. Estar dentro de más se arregla solo en la siguiente petición que sí
 * obtenga respuesta; estar fuera de menos obliga a volver a entrar, y en campo
 * eso puede ser no poder trabajar.
 */
@Injectable({ providedIn: 'root' })
export class SessionEndService {
  private readonly auth = inject(AuthService);
  private readonly notify = inject(NotifyService);
  private readonly router = inject(Router);
  private readonly sessions = inject(SessionsApi);

  private ending = false;

  /** Ya hay un cierre en marcha. */
  get isEnding(): boolean {
    return this.ending;
  }

  /**
   * Cierra la sesión y lleva al inicio, contando por qué.
   *
   * @param detail lo que dijo el servidor. Se enseña tal cual: distingue
   *   «caducó» de «se cerró desde otro equipo», y son cosas distintas para
   *   quien las lee.
   * @returns si este fue el que efectivamente cerró.
   */
  async handle(detail: string): Promise<boolean> {
    /*
     * En un enlace publico no hay sesion que cerrar, y cerrarla seria destruir
     * el trabajo.
     *
     * La «sesion» de una pestaña de enlace es un usuario sembrado sin token: no
     * caduca, no se cierra desde otro equipo y ningun 401 puede estar hablando
     * de ella. Los que llegan hablan de otra cosa —una integracion que el
     * servidor no autorizo, tipicamente— y tratarlos como el final de la sesion
     * echaba a quien estaba diligenciando a la pantalla de inicio, con lo
     * escrito a medias y sin ninguna forma de volver. Desde fuera se ve como si
     * la pagina se hubiera recargado sola.
     *
     * Lo que corresponde con ese 401 es lo que ya hace la pantalla de la
     * llamada: decir que no se pudo consultar y dejar reintentar.
     */
    if (esModoPublico()) return false;

    if (this.ending || !this.auth.isAuthenticated()) return false;

    /**
     * Se levanta **antes** de preguntar, no después.
     *
     * La comprobación tarda, y en ese rato llegan los otros nueve 401. Sin la
     * marca puesta ya, cada uno lanzaría su propia comprobación y acabaríamos
     * con diez preguntas para una sola respuesta.
     */
    this.ending = true;

    try {
      const token = this.auth.currentUser()?.Token ?? '';

      /**
       * Solo un `invalid` cierra. `valid` significa que el 401 venía de otra
       * cosa, y `unknown` que no se pudo saber: en ninguno de los dos hay
       * motivo para echar a nadie.
       */
      if ((await this.sessions.verify(token)) !== 'invalid') return false;

      // Pudo cerrarse por otra vía mientras se preguntaba.
      if (!this.auth.isAuthenticated()) return false;

      const message = detail || 'Vuelve a iniciar sesión para continuar.';

      // Con sonido, y del sistema si la pestaña no está a la vista: la sesión
      // puede caerse mientras la sincronización trabaja en segundo plano.
      void this.notify.failure('Tu sesión terminó', message);

      // Y por escrito, que es lo que sigue ahí cuando el aviso se desvanece.
      this.auth.noteSessionEnded(message);

      await this.auth.logout();
      await this.router.navigate(['/login']);

      return true;
    } finally {
      // Se baja al terminar, no antes: si se bajara al empezar, las que llegan
      // durante el cierre abrirían otro. A partir de aquí ya no hay sesión, y
      // la comprobación de arriba basta.
      this.ending = false;
    }
  }
}
