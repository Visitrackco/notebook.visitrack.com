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
