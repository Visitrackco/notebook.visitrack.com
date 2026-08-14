import { Injectable, inject } from '@angular/core';

import { AuthService } from './auth.service';
import { SessionEndService } from './session-end.service';

/**
 * `fetch` hacia el backend, con la sesión puesta.
 *
 * ## Por qué existe
 *
 * El interceptor de Angular solo ve lo que pasa por `HttpClient`. Buena parte de
 * la sincronización usa `fetch()` directamente —porque necesita leer la
 * respuesta como flujo, o cancelarla con un `AbortSignal`, cosas que ahí se
 * hacen mejor— y esas llamadas **salían sin token**. El síntoma es un 401 en
 * mitad de la sincronización mientras el resto de la aplicación funciona: costó
 * verlo precisamente porque no era «la web no manda token», era «estas cinco no
 * lo mandan».
 *
 * Con esto hay dos caminos y un solo sitio donde se decide qué cabecera va y qué
 * hacer si el servidor rechaza la sesión.
 *
 * ## Lo que no pasa por aquí
 *
 * Las direcciones que no son del backend —el sonido de aviso, el logo de la
 * plataforma, los archivos que sirve `/dispatchFile`— siguen con `fetch` a
 * secas: no llevan sesión y no deben llevarla.
 */
@Injectable({ providedIn: 'root' })
export class ApiFetchService {
  private readonly auth = inject(AuthService);
  private readonly sessionEnd = inject(SessionEndService);

  /**
   * Como `fetch`, más la cabecera `x-token` y el manejo del 401.
   *
   * Devuelve la respuesta tal cual —incluido el 401— para que quien llama siga
   * decidiendo qué hacer con ella. Lo único que se resuelve aquí es el cierre de
   * sesión, que no es asunto de cada servicio.
   */
  async fetch(input: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers ?? {});
    const token = this.auth.currentUser()?.Token;

    if (token && !headers.has('x-token')) headers.set('x-token', token);

    const response = await fetch(input, { ...init, headers });

    if (response.status === 401) {
      void this.sessionEnd.handle(await this.reasonOf(response));
    }

    return response;
  }

  /**
   * El motivo que dio el servidor, si lo dio.
   *
   * Se lee sobre un clon: el cuerpo de una respuesta se puede consumir una sola
   * vez, y quien llamó todavía tiene que poder leerlo.
   */
  private async reasonOf(response: Response): Promise<string> {
    try {
      const body = await response.clone().json();

      return typeof body?.error === 'string' ? body.error : '';
    } catch {
      return '';
    }
  }
}
