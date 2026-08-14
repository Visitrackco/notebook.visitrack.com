import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';

import { AuthService } from './auth.service';
import { NotifyService } from './notify.service';

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
 */
@Injectable({ providedIn: 'root' })
export class SessionEndService {
  private readonly auth = inject(AuthService);
  private readonly notify = inject(NotifyService);
  private readonly router = inject(Router);

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
    if (this.ending || !this.auth.isAuthenticated()) return false;

    this.ending = true;

    try {
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
