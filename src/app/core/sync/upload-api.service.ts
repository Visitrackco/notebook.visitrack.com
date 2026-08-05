import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';

import { environment } from '../../../environments/environment';
import { BinaryResource } from '../models/sync.model';

/** Respuesta normalizada de cualquiera de estas llamadas. */
export interface UploadResult {
  ok: boolean;
  /** Mensaje para el usuario cuando algo falla. */
  error?: string;
  /** true si el servidor no tiene el endpoint desplegado. */
  notImplemented?: boolean;
}

/** Estado de un archivo respecto al bucket, según el servidor. */
export type BucketState = 'online' | 'queued' | 'discarded' | 'missing';

/** Lo que responde la verificación para cada archivo. */
export interface BucketCheck {
  GUID: string;
  state: BucketState;
}

/** Resultado completo de una verificación en lote. */
export interface BucketReport extends UploadResult {
  allOnline: boolean;
  results: BucketCheck[];
}

/**
 * Las cuatro llamadas que necesita el envío de una actividad.
 *
 * Van aparte de [ApiService] porque tres de ellas no encajan en su forma: la
 * subida es multipart con campos sueltos, la creación de la actividad es un
 * `PUT` con el JSON crudo de la fila, y la verificación tiene que distinguir un
 * 404 —el servidor no tiene el endpoint— de un fallo real. Meterlas allí
 * habría obligado a llenar de excepciones un cliente que hoy es sencillo.
 *
 * Los nombres de endpoint y de campo son los mismos que usa la app móvil, sin
 * traducir: el backend es el mismo y cambiarlos aquí solo crearía una segunda
 * versión de la verdad.
 */
@Injectable({ providedIn: 'root' })
export class UploadApiService {
  private readonly http = inject(HttpClient);

  private get baseUrl(): string {
    return environment.useLocalApi ? environment.localApiUrl : environment.apiUrl;
  }

  /**
   * Sube el contenido de un archivo.
   *
   * El servidor lo deja en disco y un trabajo por lotes lo pasa al bucket de
   * AWS cada minuto. Por eso una respuesta correcta aquí **no** significa que
   * el archivo ya esté disponible: eso lo dice [verifyBinariesInBucket].
   */
  async uploadBinary(
    blob: Blob,
    resource: BinaryResource,
    /** El identificador de compañía viaja como número en la sesión y como
        texto en el formulario multipart; se acepta cualquiera de los dos. */
    companyId: string | number,
  ): Promise<UploadResult> {
    const form = new FormData();

    // El nombre del archivo lleva el GUID y la extensión porque es lo que el
    // servidor usa para clasificarlo; sin extensión acaba en la carpeta de
    // descartes y nunca llega al bucket.
    const filename = resource.Ext ? `${resource.GUID}.${resource.Ext}` : resource.GUID;

    form.append('archivo', blob, filename);
    form.append('CompanyID', String(companyId));
    form.append('UserID', resource.UserID);
    form.append('TypeBinarie', String(resource.TypeBinarie));

    try {
      const response = await firstValueFrom(
        this.http
          .post<{ status?: boolean; error?: string }>(
            `${this.baseUrl}/uploadBinarieServerTwo`,
            form,
            { headers: { 'x-token': 'gjhgj' } },
          )
          .pipe(timeout(120_000)),
      );

      if (response?.status) return { ok: true };
      return { ok: false, error: response?.error ?? 'El servidor rechazó el archivo.' };
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  }

  /**
   * Crea la actividad en Visitrack.
   *
   * Se manda la fila local tal cual, que es lo que espera el backend; la app
   * hace exactamente lo mismo.
   */
  async createAnswer(row: Record<string, unknown>): Promise<UploadResult> {
    try {
      const response = await firstValueFrom(
        this.http
          .put<{ status?: boolean; error?: string }>(
            `${this.baseUrl}/createdSurveysAnswers`,
            row,
            { headers: { 'Content-Type': 'application/json' } },
          )
          .pipe(timeout(120_000)),
      );

      if (response?.status) return { ok: true };
      return { ok: false, error: response?.error ?? 'El servidor rechazó la actividad.' };
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  }

  /**
   * ¿Quedó de verdad creada la actividad?
   *
   * Existe por un caso real: el backend responde correcto pero la inserción
   * falla después, y la actividad se marcaba como sincronizada sin estarlo —el
   * «verde falso»—. Se reintenta un par de veces porque la escritura puede
   * tardar un instante en verse.
   */
  async answerExists(guid: string, attempts = 3): Promise<boolean> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await firstValueFrom(
          this.http
            .get<{ status?: boolean; exists?: boolean }>(
              `${this.baseUrl}/verifyAnswerExists`,
              { params: { GUID: guid } },
            )
            .pipe(timeout(15_000)),
        );

        if (response?.status !== true) return false;
        if (response.exists === true) return true;

        // Todavía no aparece: se espera un poco antes del siguiente intento.
        if (attempt < attempts) await wait(1500);
      } catch {
        return false;
      }
    }

    return false;
  }

  /**
   * Pregunta al servidor cuáles de estos archivos ya están en el bucket.
   *
   * Si el endpoint no está desplegado —responde 404 o 501— se devuelve
   * `notImplemented` en vez de un error: sin él la aplicación tiene que seguir
   * funcionando, no quedarse bloqueada esperando una confirmación que nadie va
   * a dar.
   */
  async verifyBinariesInBucket(
    resources: readonly BinaryResource[],
    answerGuid: string,
    companyId: string | number,
  ): Promise<BucketReport> {
    if (resources.length === 0) {
      return { ok: true, allOnline: true, results: [] };
    }

    const body = {
      CompanyID: companyId,
      UserID: resources[0].UserID,
      AnswerGUID: answerGuid,
      binaries: resources.map((resource) => ({
        GUID: resource.GUID,
        Ext: resource.Ext ?? '',
        TypeBinarie: resource.TypeBinarie,
      })),
    };

    try {
      const response = await firstValueFrom(
        this.http
          .post<{ status?: boolean; allOnline?: boolean; results?: BucketCheck[]; error?: string }>(
            `${this.baseUrl}/verifyBinariesInBucket`,
            body,
            { headers: { 'Content-Type': 'application/json' } },
          )
          .pipe(timeout(60_000)),
      );

      if (response?.status !== true) {
        return {
          ok: false,
          allOnline: false,
          results: [],
          error: response?.error ?? 'No se pudo verificar el estado de los archivos.',
        };
      }

      return {
        ok: true,
        allOnline: response.allOnline === true,
        results: response.results ?? [],
      };
    } catch (error) {
      if (isMissingEndpoint(error)) {
        return {
          ok: false,
          notImplemented: true,
          allOnline: false,
          results: [],
          error: 'El servidor todavía no tiene habilitada la verificación de archivos.',
        };
      }

      return { ok: false, allOnline: false, results: [], error: describe(error) };
    }
  }
}

/** ¿El fallo es «este endpoint no existe» y no un error de verdad? */
function isMissingEndpoint(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  return status === 404 || status === 501;
}

/** Traduce el fallo a algo que el usuario pueda entender. */
function describe(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return 'El servidor tardó demasiado en responder.';
  }

  const status = (error as { status?: number })?.status;

  if (status === 0 || status === undefined) {
    return 'No hay conexión con el servidor.';
  }

  if (status === 413) {
    return 'El archivo es demasiado grande para el servidor.';
  }

  return `El servidor respondió con un error (${status}).`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
