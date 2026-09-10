import { Injectable, inject, signal } from '@angular/core';

import { BinaryResource, BinaryState } from '../models/sync.model';
import { BinaryResourceRepository } from '../repositories/binary.repository';
import { AuthService } from '../services/auth.service';
import { BinaryUploadService } from './binary-upload.service';
import { DataRevisionService } from './data-revision.service';
import { BucketState, UploadApiService } from './upload-api.service';

/** Resultado de una verificación. */
export interface VerifyOutcome {
  /** Cuántos pasaron a estar confirmados en el bucket. */
  confirmed: number;
  /** Cuántos siguen esperando el trabajo por lotes del servidor. */
  queued: number;
  /** Cuántos hubo que volver a subir porque el servidor no los tiene. */
  missing: number;
  /** true si el servidor no tiene el endpoint desplegado. */
  notImplemented: boolean;
  message: string;
}

/**
 * Cuántas rondas de verificación se hacen antes de rendirse.
 *
 * El trabajo del servidor corre cada minuto, así que confirmar un archivo puede
 * tardar más que la paciencia de quien está mirando la pantalla. Se usan pocos
 * intentos cuando el usuario espera una respuesta y más cuando el proceso corre
 * solo en segundo plano.
 */
const DEFAULT_ATTEMPTS = 6;

/** Cuánto se espera entre rondas, subiendo. */
const BACKOFF_MS = [2000, 4000, 8000, 15000, 25000, 40000];

/**
 * Confirma si los archivos ya llegaron al bucket de AWS.
 *
 * ## Por qué hace falta este paso
 *
 * El servidor recibe el archivo y responde correcto, pero lo deja en su disco:
 * un trabajo por lotes lo sube al bucket cada minuto. Entre esas dos cosas hay
 * una ventana en la que el archivo «está subido» y sin embargo no existe para
 * nadie más.
 *
 * Enviar la actividad en esa ventana es lo que producía registros en Visitrack
 * apuntando a fotografías rotas. Este servicio cierra el hueco: pregunta al
 * servidor archivo por archivo y solo cuando responde `online` se libera la
 * actividad.
 *
 * ## Cuando el endpoint no existe
 *
 * Si el servidor no tiene desplegada la verificación, se devuelve
 * `notImplemented` y **no** se bloquea nada. Una función de servidor que falta
 * no puede dejar al usuario sin poder enviar su trabajo.
 */
@Injectable({ providedIn: 'root' })
export class BinaryVerifyService {
  private readonly binaries = inject(BinaryResourceRepository);
  private readonly uploads = inject(BinaryUploadService);
  private readonly api = inject(UploadApiService);
  private readonly revisions = inject(DataRevisionService);
  private readonly auth = inject(AuthService);

  readonly verifying = signal(false);

  /** Última verificación, para mostrarla en la pantalla de archivos. */
  readonly lastOutcome = signal<VerifyOutcome | null>(null);

  /**
   * Verifica todos los archivos que aún no están confirmados.
   *
   * @param uploadFirst sube los que ni siquiera han salido del navegador.
   */
  async verifyAll(uploadFirst = true): Promise<VerifyOutcome> {
    const user = this.auth.currentUser();
    if (!user) return empty();

    if (uploadFirst) await this.uploads.uploadPending();

    const all = await this.binaries.query({ index: 'byUserID', range: user.UserID });
    return this.verify(all.filter(isUnconfirmed), '', user.CompanyID);
  }

  /**
   * Verifica los archivos de una actividad, insistiendo hasta que estén todos.
   *
   * @returns true si ninguno bloquea ya el envío.
   */
  async ensureAnswerOnline(answerGuid: string, attempts = DEFAULT_ATTEMPTS): Promise<boolean> {
    const user = this.auth.currentUser();
    if (!user) return false;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const pending = (await this.binaries.findByAnswer(answerGuid)).filter(blocks);
      if (pending.length === 0) return true;

      // Lo que ni siquiera salió del navegador se sube antes de preguntar por
      // ello: el servidor no puede confirmar algo que nunca recibió.
      if (pending.some((binary) => binary.BinaryState === BinaryState.Pending)) {
        await this.uploads.uploadPending(answerGuid);
      }

      const outcome = await this.verify(
        (await this.binaries.findByAnswer(answerGuid)).filter(isUnconfirmed),
        answerGuid,
        user.CompanyID,
      );

      // Sin verificación en el servidor no hay nada que esperar: se da por
      // bueno lo que el servidor dijo haber recibido y la actividad sigue.
      if (outcome.notImplemented) return true;

      const left = (await this.binaries.findByAnswer(answerGuid)).filter(blocks);
      if (left.length === 0) return true;

      // Última ronda: no tiene sentido esperar para no volver a preguntar.
      if (attempt < attempts - 1) {
        await wait(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
      }
    }

    return false;
  }

  /**
   * Deja en línea **unos archivos concretos**, no toda la actividad.
   *
   * ## Para qué
   *
   * Para una llamada a un servicio cuya entrada apunta a un campo de
   * fotografía. Lo que viaja es **la dirección** de la foto, y esa dirección
   * solo lleva a alguna parte cuando el archivo ya está en el bucket: recién
   * tomada, la foto vive solo en el navegador. Llamar ahí es mandarle a alguien
   * de fuera una dirección que no resuelve, y lo que contesta el analizador de
   * imágenes es que eso no es una fotografía.
   *
   * ## Por qué no vale [ensureAnswerOnline]
   *
   * Porque espera a **todas** las fotos de la actividad. Pulsar un botón que
   * consulta una sola foto no debe quedarse esperando a las otras once que se
   * tomaron antes y que a ese servicio no le importan: se sentiría como un
   * botón colgado, y con mala señal serían minutos.
   *
   * Devuelve `true` cuando todas las nombradas están confirmadas — y también
   * cuando no hay ninguna que esperar, que es lo corriente.
   */
  async ensureBinariesOnline(
    answerGuid: string,
    guids: readonly string[],
    attempts = DEFAULT_ATTEMPTS,

    /**
     * Para poder dejar de esperar.
     *
     * La espera entre rondas llega a cuarenta segundos, asi que sin esto
     * «cancelar» tardaria casi un minuto en notarse — y quien lo pulsa
     * concluiria, con razon, que el boton de cancelar tampoco funciona.
     */
    corte?: AbortSignal,
  ): Promise<boolean> {
    const buscados = new Set(guids.filter(Boolean));
    if (!buscados.size) return true;

    const user = this.auth.currentUser();
    if (!user) return false;

    /*
     * Se miran solo los archivos de esta actividad que estén entre los pedidos.
     *
     * Un GUID que no aparece no se espera: puede ser una foto de otra
     * actividad, o un campo que se respondió con una dirección escrita a mano.
     * Bloquear por algo que no tenemos sería no dejar llamar nunca.
     */
    const suyos = async () =>
      (await this.binaries.findByAnswer(answerGuid)).filter((b) => buscados.has(b.GUID));

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (corte?.aborted) return false;

      const pending = (await suyos()).filter(blocks);
      if (pending.length === 0) return true;

      // Lo que ni siquiera salió del navegador se sube antes de preguntar por
      // ello: el servidor no puede confirmar algo que nunca recibió.
      if (pending.some((binary) => binary.BinaryState === BinaryState.Pending)) {
        await this.uploads.uploadPending(answerGuid);
      }

      const outcome = await this.verify(
        (await suyos()).filter(isUnconfirmed),
        answerGuid,
        user.CompanyID,
      );

      // Sin verificación en el servidor no hay nada que esperar: se da por
      // bueno lo que el servidor dijo haber recibido, igual que al enviar.
      if (outcome.notImplemented) return true;

      if ((await suyos()).filter(blocks).length === 0) return true;

      // Última ronda: no tiene sentido esperar para no volver a preguntar.
      if (attempt < attempts - 1) {
        await esperarOCortar(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)], corte);
      }
    }

    return !corte?.aborted && (await suyos()).filter(blocks).length === 0;
  }

  /**
   * Pregunta al servidor por un conjunto de archivos y anota lo que responda.
   *
   * Los que el servidor no tiene se devuelven al estado inicial para que la
   * siguiente subida los reintente. Sin eso quedarían marcados como recibidos
   * por un servidor que no los tiene, esperando una confirmación imposible.
   */
  private async verify(
    resources: BinaryResource[],
    answerGuid: string,
    companyId: string | number,
  ): Promise<VerifyOutcome> {
    if (resources.length === 0) {
      const outcome = { ...empty(), message: 'No hay archivos por confirmar.' };
      this.lastOutcome.set(outcome);
      return outcome;
    }

    this.verifying.set(true);

    try {
      const report = await this.api.verifyBinariesInBucket(resources, answerGuid, companyId);

      if (report.notImplemented) {
        const outcome: VerifyOutcome = {
          ...empty(),
          notImplemented: true,
          message: 'El servidor todavía no puede confirmar archivos. Se dan por enviados.',
        };
        this.lastOutcome.set(outcome);
        return outcome;
      }

      if (!report.ok) {
        const outcome: VerifyOutcome = {
          ...empty(),
          message: report.error ?? 'No se pudo confirmar el estado de los archivos.',
        };
        this.lastOutcome.set(outcome);
        return outcome;
      }

      const byGuid = new Map(resources.map((resource) => [resource.GUID, resource]));
      let confirmed = 0;
      let queued = 0;
      let missing = 0;

      for (const check of report.results) {
        const resource = byGuid.get(check.GUID);
        if (!resource) continue;

        const state = mapState(check.state);
        if (state === null) continue;

        if (state === BinaryState.Online) confirmed++;
        else if (state === BinaryState.Pending) missing++;
        else if (state === BinaryState.InRepository) queued++;

        // El que hay que volver a subir pierde también sus banderas heredadas,
        // o la consulta de pendientes no lo recogería.
        await this.binaries.put({
          ...resource,
          BinaryState: state,
          IsSync: state === BinaryState.Pending ? 0 : resource.IsSync,
          Uploaded: state === BinaryState.Pending ? 0 : resource.Uploaded,
          VerifyAttempts: (resource.VerifyAttempts ?? 0) + 1,
          VerifiedOn: new Date().toISOString(),
        });
      }

      // Un solo aviso para todo el lote: el servidor responde por todos a la
      // vez, y notificar archivo por archivo dispararía una recarga de la
      // pantalla por cada uno de los cincuenta.
      if (report.results.length > 0) this.revisions.touchBinaries();

      const outcome: VerifyOutcome = {
        confirmed,
        queued,
        missing,
        notImplemented: false,
        message: describe(confirmed, queued, missing),
      };

      this.lastOutcome.set(outcome);
      return outcome;
    } finally {
      this.verifying.set(false);
    }
  }
}

/** ¿Este archivo impide enviar su actividad? */
function blocks(binary: BinaryResource): boolean {
  return (
    binary.BinaryState === BinaryState.Pending || binary.BinaryState === BinaryState.InRepository
  );
}

/** ¿Merece la pena preguntar por él? */
function isUnconfirmed(binary: BinaryResource): boolean {
  return binary.BinaryState !== BinaryState.Online;
}

/** Traduce la respuesta del servidor a nuestro estado. */
function mapState(state: BucketState): BinaryState | null {
  switch (state) {
    case 'online':
      return BinaryState.Online;
    case 'queued':
      return BinaryState.InRepository;
    case 'discarded':
      return BinaryState.Discarded;
    case 'missing':
      // El servidor no lo tiene: vuelve a la cola de subida.
      return BinaryState.Pending;
    default:
      return null;
  }
}

function describe(confirmed: number, queued: number, missing: number): string {
  const parts: string[] = [];

  if (confirmed > 0) parts.push(`${confirmed} confirmado(s) en línea`);
  if (queued > 0) parts.push(`${queued} esperando al servidor`);
  if (missing > 0) parts.push(`${missing} por volver a subir`);

  return parts.length > 0
    ? parts.join(' · ')
    : 'Los archivos todavía no están disponibles. Inténtalo en un momento.';
}

function empty(): VerifyOutcome {
  return { confirmed: 0, queued: 0, missing: 0, notImplemented: false, message: '' };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Espera, o deja de esperar en cuanto lo pidan.
 *
 * Se limpia el temporizador y el oyente en los dos caminos: dejar vivo un
 * `setTimeout` de cuarenta segundos por cada cancelacion es una fuga pequeña
 * que en una jornada de campo deja de ser pequeña.
 */
function esperarOCortar(ms: number, corte?: AbortSignal): Promise<void> {
  if (!corte) return wait(ms);
  if (corte.aborted) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const listo = () => {
      clearTimeout(reloj);
      corte.removeEventListener('abort', listo);
      resolve();
    };

    const reloj = setTimeout(listo, ms);
    corte.addEventListener('abort', listo, { once: true });
  });
}

