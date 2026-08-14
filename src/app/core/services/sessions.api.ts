import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';

import { environment } from '../../../environments/environment';

/** Una sesión abierta del usuario. */
export interface UserSession {
  ID: number;
  DeviceID: string;
  Platform: string | null;
  DeviceName: string | null;
  IssuedOn: string;
  LastSeenOn: string | null;
  ExpiresOn: string;

  /** Es el equipo desde el que se está mirando. */
  isCurrent: boolean;
}

interface Reply<T> {
  status?: boolean;
  response?: T;
  error?: string;
}

/**
 * Lo que se sabe de una sesión tras preguntarle al servidor.
 *
 * `unknown` es un resultado de pleno derecho y no un fallo: no poder preguntar
 * —sin red, el servidor caído— **no** es lo mismo que una sesión rechazada, y
 * confundirlos es lo que echa de la aplicación a quien solo se quedó sin
 * cobertura.
 */
export type SessionCheck = 'valid' | 'invalid' | 'unknown';

/**
 * Las sesiones abiertas del usuario, y cómo cerrarlas.
 *
 * ## Cerrar una sesión pide la contraseña
 *
 * No es una acción más: echa a alguien de un equipo, y en campo eso puede
 * significar un teléfono que deja de sincronizar en mitad de una jornada. Si
 * alguien deja el navegador abierto un minuto, lo que no debería poder hacer un
 * tercero es dejar a esa persona fuera. La contraseña es lo que separa «tengo
 * tu pantalla delante» de «soy tú».
 */
@Injectable({ providedIn: 'root' })
export class SessionsApi {
  private readonly http = inject(HttpClient);

  private get baseUrl(): string {
    return environment.useLocalApi ? environment.localApiUrl : environment.apiUrl;
  }

  /**
   * ¿El servidor sigue aceptando esta sesión?
   *
   * ## Por qué hace falta preguntar
   *
   * Un 401 llega desde cualquier petición, y **no todas hablan de nuestra
   * sesión**: durante un traspaso entre equipos hay llamadas que se autentican
   * con el código del enlace y no con el token del navegador, y su 401 dice
   * «ese código no vale», no «tu sesión terminó». Cerrar por eso echa de la
   * aplicación a quien tenía la sesión correcta abierta.
   *
   * `mySessions` responde exactamente a la pregunta: si el servidor devuelve la
   * lista, es que aceptó el token.
   *
   * ## Por qué con `fetch` y no con `HttpClient`
   *
   * `HttpClient` pasa por el interceptor, que ante un 401 desencadena el cierre
   * de sesión. El comprobante no puede provocar lo que está comprobando. Aquí
   * se manda el token a mano y no se avisa a nadie.
   *
   * @param token el de la sesión que se quiere comprobar.
   */
  async verify(token: string): Promise<SessionCheck> {
    // Sin token no hay nada que comprobar, y tampoco nada que conservar.
    if (!token) return 'invalid';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), environment.requestTimeout * 1000);

    try {
      const response = await fetch(`${this.baseUrl}/mySessions`, {
        headers: { 'x-token': token },
        signal: controller.signal,
      });

      if (response.status === 401) return 'invalid';

      /**
       * Cualquier otra cosa —500, 404, un proxy de por medio— **no** es una
       * respuesta sobre la sesión. Decir «inválida» aquí sería inventarse una
       * confirmación que el servidor no dio.
       */
      if (!response.ok) return 'unknown';

      const body = (await response.json()) as Reply<UserSession[]> | null;

      return body?.status === true ? 'valid' : 'unknown';
    } catch {
      // Sin red, o se acabó el tiempo. No se sabe.
      return 'unknown';
    } finally {
      clearTimeout(timer);
    }
  }

  async list(): Promise<UserSession[]> {
    try {
      const reply = await firstValueFrom(
        this.http
          .get<Reply<UserSession[]>>(`${this.baseUrl}/mySessions`)
          .pipe(timeout(environment.requestTimeout * 1000)),
      );

      return reply?.status ? (reply.response ?? []) : [];
    } catch {
      return [];
    }
  }

  /**
   * Cierra una sesión concreta, o todas menos ésta.
   *
   * @returns cuántas se cerraron, o el error para enseñarlo tal cual — «la
   *   contraseña no es correcta» tiene que llegar con esas palabras.
   */
  async close(
    password: string,
    target: { sessionId?: number; others?: boolean },
  ): Promise<{ ok: boolean; closed: number; error?: string }> {
    try {
      const reply = await firstValueFrom(
        this.http
          .post<Reply<{ closed: number }>>(`${this.baseUrl}/closeSession`, {
            password,
            SessionID: target.sessionId,
            others: target.others === true,
          })
          .pipe(timeout(environment.requestTimeout * 1000)),
      );

      if (!reply?.status) {
        return { ok: false, closed: 0, error: reply?.error ?? 'No se pudo cerrar.' };
      }

      return { ok: true, closed: reply.response?.closed ?? 0 };
    } catch (error) {
      const status = (error as { status?: number })?.status;

      // El 403 es la contraseña incorrecta, y su mensaje es el que hay que
      // enseñar: cualquier otra cosa sería esconder la única causa que el
      // usuario puede arreglar.
      const detail = (error as { error?: { error?: string } })?.error?.error;

      if (status === 403 && detail) return { ok: false, closed: 0, error: detail };

      return {
        ok: false,
        closed: 0,
        error: status ? `No se pudo cerrar (${status}).` : 'Sin conexión con el servidor.',
      };
    }
  }
}
