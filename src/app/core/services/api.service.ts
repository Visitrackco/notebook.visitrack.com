import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, tap, throwError, timeout } from 'rxjs';

import { environment } from '../../../environments/environment';
import { ConnectivityService } from './connectivity.service';

/** Error normalizado que devuelve esta capa. */
export interface ApiError {
  /** Mensaje listo para mostrarle al usuario. */
  message: string;
  /** Código HTTP. 0 cuando la petición nunca llegó al servidor. */
  status: number;
  /** true si falló por red o timeout, no por rechazo del servidor. */
  isNetworkError: boolean;
  /** Cuerpo original, para depurar. */
  raw?: unknown;
}

/**
 * Cliente HTTP contra el backend de Visitrack.
 *
 * Concentra tres cosas que de otro modo se repetirían en cada servicio: la URL
 * base según el entorno, el timeout, y la traducción de errores a mensajes que
 * el usuario pueda entender.
 *
 * También informa a `ConnectivityService` del resultado de cada llamada, que es
 * lo que permite a la interfaz saber si de verdad hay conexión — y no solo si
 * el navegador cree que la hay.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly connectivity = inject(ConnectivityService);

  /** URL base según la configuración del entorno. */
  private get baseUrl(): string {
    return environment.useLocalApi ? environment.localApiUrl : environment.apiUrl;
  }

  get<T>(path: string, params?: Record<string, string | number | boolean>): Observable<T> {
    return this.wrap(this.http.get<T>(this.url(path), { params: this.toParams(params) }));
  }

  post<T>(path: string, body: unknown): Observable<T> {
    return this.wrap(this.http.post<T>(this.url(path), body));
  }

  put<T>(path: string, body: unknown): Observable<T> {
    return this.wrap(this.http.put<T>(this.url(path), body));
  }

  delete<T>(path: string, params?: Record<string, string | number | boolean>): Observable<T> {
    return this.wrap(this.http.delete<T>(this.url(path), { params: this.toParams(params) }));
  }

  /** Sube un archivo por multipart. */
  upload<T>(path: string, formData: FormData): Observable<T> {
    return this.wrap(this.http.post<T>(this.url(path), formData));
  }

  // ───────────────────────────────────────────────────────────────────────────

  private url(path: string): string {
    const clean = path.startsWith('/') ? path : `/${path}`;
    return `${this.baseUrl}${clean}`;
  }

  private toParams(params?: Record<string, string | number | boolean>): HttpParams {
    let result = new HttpParams();
    if (!params) return result;

    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      result = result.set(key, String(value));
    }
    return result;
  }

  /**
   * Aplica timeout, reporte de conectividad y normalización de errores.
   *
   * Va como método genérico y no como un arreglo de operadores esparcido en
   * `.pipe(...)`: el spread hace que TypeScript pierda el tipo y todo termine
   * como `Observable<unknown>`.
   */
  private wrap<T>(source: Observable<T>): Observable<T> {
    return source.pipe(
      timeout(environment.requestTimeout * 1000),
      tap(() => this.connectivity.reportSuccess()),
      catchError((error: unknown) => throwError(() => this.normalize(error))),
    );
  }

  /**
   * Convierte cualquier fallo en un [ApiError] con un mensaje presentable.
   *
   * La distinción clave es entre "no llegué al servidor" y "el servidor me dijo
   * que no": la primera se reintenta sola cuando vuelva la conexión, la segunda
   * necesita que el usuario haga algo.
   */
  private normalize(error: unknown): ApiError {
    // Timeout de rxjs: la petición salió pero nunca volvió.
    if (error instanceof Error && error.name === 'TimeoutError') {
      this.connectivity.reportNetworkFailure();
      return {
        message: 'El servidor tardó demasiado en responder. Inténtalo de nuevo.',
        status: 0,
        isNetworkError: true,
        raw: error,
      };
    }

    if (error instanceof HttpErrorResponse) {
      // status 0 = la petición no llegó a destino (sin red, CORS, DNS, servidor caído).
      if (error.status === 0) {
        this.connectivity.reportNetworkFailure();
        return {
          message: 'No hay conexión con el servidor. Los cambios se guardarán en este dispositivo.',
          status: 0,
          isNetworkError: true,
          raw: error.error,
        };
      }

      // El servidor respondió, así que la conexión está bien.
      this.connectivity.reportSuccess();

      return {
        message: this.messageFor(error),
        status: error.status,
        isNetworkError: false,
        raw: error.error,
      };
    }

    return {
      message: 'Ocurrió un error inesperado.',
      status: -1,
      isNetworkError: false,
      raw: error,
    };
  }

  /**
   * Mensaje para el usuario a partir de la respuesta.
   *
   * Se prefiere el que manda el backend cuando existe: suele ser el detalle
   * real ("Contraseña incorrecta", "El usuario no está activo"), mucho más útil
   * que un texto genérico por código HTTP.
   */
  private messageFor(error: HttpErrorResponse): string {
    const body = error.error;

    if (typeof body === 'string' && body.trim() && !body.trim().startsWith('<')) {
      return body.trim();
    }

    if (body && typeof body === 'object') {
      const candidate =
        (body as Record<string, unknown>)['message'] ??
        (body as Record<string, unknown>)['error'] ??
        (body as Record<string, unknown>)['Message'];

      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }

    switch (error.status) {
      case 400:
        return 'La solicitud no es válida.';
      case 401:
        return 'Tu sesión expiró. Inicia sesión de nuevo.';
      case 403:
        return 'No tienes permiso para realizar esta acción.';
      case 404:
        return 'El recurso solicitado no existe en el servidor.';
      case 500:
        return 'Error en el servidor. Comunícate con tu administrador.';
      case 503:
        return 'El servicio no está disponible en este momento.';
      default:
        return `Ocurrió un error (${error.status}).`;
    }
  }
}
