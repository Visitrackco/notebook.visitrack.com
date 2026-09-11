import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/services/auth.service';

/** Una sala en la lista. */
export interface SalaResumen {
  id: number;
  nombre: string;
  descripcion: string;
  miembros: number;
  esAdmin: boolean;
  sinLeer: number;
  ultimoTexto: string;
  ultimoEn: string;
}

/** Quién está en una sala, y cómo se le ve. */
export interface MiembroDeSala {
  userId: number;
  nombre: string;
  esAdmin: boolean;
  estado?: 'activo' | 'ausente' | 'desconectado';
  clientes?: string[];
}

export interface AdjuntoDeMensaje {
  id: number;
  nombre: string;
  tipoMime: string;
  tamano: number;
}

export interface MensajeDeSala {
  id: number;
  salaId: number;
  seq: number;
  userId: number;
  autor: string;
  tipo: 'texto' | 'archivo' | 'voz';
  texto: string;
  segundos: number;
  clientId: string;
  creadoEn: string;
  adjuntos: AdjuntoDeMensaje[];

  /** Puesta por la pantalla mientras la petición viaja. No viene del servidor. */
  enviando?: boolean;
}

export interface FichaDeAdjunto {
  clave: string;
  nombre: string;
  tipoMime: string;
  tamano: number;
}

/**
 * El chat, que vive en **otro backend**.
 *
 * ## Por qué no pasa por el interceptor de siempre
 *
 * Porque `authInterceptor` pone la cabecera `x-token`, que es como habla
 * cloud-server, y Module espera `Authorization: Bearer`. Son dos servidores
 * distintos con dos formas de saludar, y aquí se saluda como espera el que
 * recibe.
 *
 * El token es **el mismo**: el que emitió cloud-server al iniciar sesión.
 * Module lo reconoce porque comparte base de datos con él y tiene su llave en
 * una variable aparte, usada solo para el chat — ver `sesion-de-campo.ts` allí.
 * No hay una segunda sesión que mantener.
 */
@Injectable({ providedIn: 'root' })
export class ChatApi {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);

  private get base(): string {
    return `${environment.moduleUrl}/chat`;
  }

  /** El token de la sesión, como lo espera Module. */
  private get cabeceras(): HttpHeaders {
    return new HttpHeaders({
      Authorization: `Bearer ${this.auth.currentUser()?.Token ?? ''}`,
    });
  }

  // ── Salas ─────────────────────────────────────────────────────────────────

  salas(): Promise<SalaResumen[]> {
    return firstValueFrom(
      this.http.get<SalaResumen[]>(`${this.base}/salas`, { headers: this.cabeceras }),
    );
  }

  miembros(salaId: number): Promise<MiembroDeSala[]> {
    return firstValueFrom(
      this.http.get<MiembroDeSala[]>(`${this.base}/salas/${salaId}/miembros`, {
        headers: this.cabeceras,
      }),
    );
  }

  // ── Mensajes ──────────────────────────────────────────────────────────────

  /** Los últimos de una sala. Es abrirla. */
  ultimos(salaId: number): Promise<MensajeDeSala[]> {
    return firstValueFrom(
      this.http.get<MensajeDeSala[]>(`${this.base}/salas/${salaId}/mensajes`, {
        headers: this.cabeceras,
      }),
    );
  }

  /**
   * Lo que haya **después** de ese número.
   *
   * Es ponerse al día tras una desconexión, en una sola llamada. El socket solo
   * trae lo que llega mientras está conectado; esto es lo que cubre el hueco.
   */
  desde(salaId: number, seq: number): Promise<MensajeDeSala[]> {
    return firstValueFrom(
      this.http.get<MensajeDeSala[]>(`${this.base}/salas/${salaId}/mensajes?desde=${seq}`, {
        headers: this.cabeceras,
      }),
    );
  }

  escribir(
    salaId: number,
    datos: {
      texto?: string;
      tipo?: 'texto' | 'archivo' | 'voz';
      clientId?: string;
      segundos?: number;
      adjuntos?: FichaDeAdjunto[];
    },
  ): Promise<MensajeDeSala> {
    return firstValueFrom(
      this.http.post<MensajeDeSala>(`${this.base}/salas/${salaId}/mensajes`, datos, {
        headers: this.cabeceras,
      }),
    );
  }

  marcarLeido(salaId: number, hastaSeq: number): Promise<unknown> {
    return firstValueFrom(
      this.http.post(
        `${this.base}/salas/${salaId}/leido`,
        { hastaSeq },
        { headers: this.cabeceras },
      ),
    );
  }

  // ── Archivos ──────────────────────────────────────────────────────────────

  /**
   * Sube el archivo y devuelve su ficha. **No manda el mensaje.**
   *
   * Se sube primero y después se escribe el mensaje nombrando la ficha: así un
   * archivo a medio subir no deja un mensaje roto en la conversación de todos.
   */
  subirAdjunto(salaId: number, archivo: File | Blob, nombre?: string): Promise<FichaDeAdjunto> {
    const cuerpo = new FormData();
    cuerpo.append('archivo', archivo, nombre ?? (archivo as File).name ?? 'archivo');

    return firstValueFrom(
      this.http.post<FichaDeAdjunto>(`${this.base}/salas/${salaId}/adjuntos`, cuerpo, {
        headers: this.cabeceras,
      }),
    );
  }

  /**
   * Una dirección para ver o descargar un adjunto.
   *
   * **Caduca en cinco minutos**, así que se pide al abrir y no se guarda: una
   * dirección firmada archivada en memoria deja de servir sin avisar y el
   * archivo parece roto.
   */
  direccionDe(adjuntoId: number, descargar = false): Promise<{ url: string; nombre: string }> {
    return firstValueFrom(
      this.http.get<{ url: string; nombre: string }>(
        `${this.base}/adjuntos/${adjuntoId}/direccion${descargar ? '?descargar=1' : ''}`,
        { headers: this.cabeceras },
      ),
    );
  }
}
