import { Injectable, computed, inject, signal } from '@angular/core';

import { BinaryResource, BinaryState } from '../models/sync.model';
import { BinaryResourceRepository } from '../repositories/binary.repository';
import { AuthService } from '../services/auth.service';
import { BinaryStorageService } from '../services/binary-storage.service';
import { ConnectivityService } from '../services/connectivity.service';
import { DataRevisionService } from './data-revision.service';
import { UploadApiService } from './upload-api.service';

/** En qué va la subida. */
export interface UploadProgress {
  running: boolean;
  total: number;
  done: number;
  failed: number;
  /** Último archivo procesado, para nombrarlo en pantalla. */
  current: string;
  message: string;
}

/**
 * Cuántos archivos se suben a la vez.
 *
 * De uno en uno desaprovecha la conexión; todos a la vez satura una red móvil y
 * hace que fallen por tiempo de espera los que están al final de la cola. Cinco
 * es el mismo lote que usa la app, y en campo funciona.
 */
const BATCH = 5;

/**
 * Sube al servidor los archivos que todavía están solo en el navegador.
 *
 * ## Qué significa «subido»
 *
 * Que el servidor reciba el archivo **no** lo deja disponible: lo guarda en
 * disco y un trabajo por lotes lo pasa al bucket de AWS cada minuto. Por eso al
 * subir se marca `InRepository` y no `Online` — la confirmación la da
 * [BinaryVerifyService] preguntando al servidor, y es lo que libera la
 * actividad para enviarse.
 *
 * Saltarse esa distinción es lo que hacía que llegaran actividades a Visitrack
 * apuntando a fotografías que aún no existían.
 */
@Injectable({ providedIn: 'root' })
export class BinaryUploadService {
  private readonly binaries = inject(BinaryResourceRepository);
  private readonly storage = inject(BinaryStorageService);
  private readonly api = inject(UploadApiService);
  private readonly revisions = inject(DataRevisionService);
  private readonly auth = inject(AuthService);
  private readonly connectivity = inject(ConnectivityService);

  readonly progress = signal<UploadProgress>({
    running: false,
    total: 0,
    done: 0,
    failed: 0,
    current: '',
    message: '',
  });

  readonly isRunning = computed(() => this.progress().running);

  /**
   * La corrida en curso.
   *
   * Se guarda para que quien llame mientras ya hay una subida pueda **esperar**
   * a que acabe en vez de recibir un retorno inmediato y creer que no quedaba
   * nada pendiente. Es justo lo que necesita el envío de una actividad.
   */
  private current: Promise<number> | null = null;

  /** Espera a que termine la subida en curso, si la hay. */
  async waitUntilIdle(): Promise<void> {
    try {
      await this.current;
    } catch {
      // Un fallo de la corrida anterior no debe propagarse a quien solo espera.
    }
  }

  /**
   * Sube los archivos pendientes.
   *
   * @param answerGuid Limita la subida a los archivos de una actividad.
   * @returns cuántos archivos quedaron en el servidor.
   */
  async uploadPending(answerGuid?: string): Promise<number> {
    if (this.current) {
      await this.waitUntilIdle();

      // Sin actividad concreta, la corrida anterior ya barrió todo lo que había.
      if (!answerGuid) return 0;
    }

    const run = this.run(answerGuid);
    this.current = run;

    try {
      return await run;
    } finally {
      this.current = null;
    }
  }

  private async run(answerGuid?: string): Promise<number> {
    const user = this.auth.currentUser();
    if (!user) return 0;

    const pending = await this.findPending(answerGuid);

    if (pending.length === 0) {
      this.progress.set({
        running: false,
        total: 0,
        done: 0,
        failed: 0,
        current: '',
        message: 'No hay archivos pendientes por subir.',
      });
      return 0;
    }

    if (!this.connectivity.isOnline()) {
      this.progress.set({
        running: false,
        total: pending.length,
        done: 0,
        failed: 0,
        current: '',
        message: 'Sin conexión. Los archivos se subirán cuando vuelva la red.',
      });
      return 0;
    }

    this.progress.set({
      running: true,
      total: pending.length,
      done: 0,
      failed: 0,
      current: '',
      message: 'Subiendo archivos…',
    });

    let uploaded = 0;
    let failed = 0;

    for (let index = 0; index < pending.length; index += BATCH) {
      const batch = pending.slice(index, index + BATCH);

      // Dentro del lote van en paralelo; entre lotes, en serie. Así se
      // aprovecha la conexión sin lanzar cincuenta peticiones a la vez.
      const results = await Promise.all(
        batch.map((resource) => this.uploadOne(resource, user.CompanyID)),
      );

      for (const ok of results) {
        if (ok) uploaded++;
        else failed++;
      }

      this.progress.update((state) => ({
        ...state,
        done: uploaded,
        failed,
        current: batch[batch.length - 1]?.GUID ?? '',
      }));
    }

    this.progress.set({
      running: false,
      total: pending.length,
      done: uploaded,
      failed,
      current: '',
      message: describeOutcome(uploaded, failed),
    });

    return uploaded;
  }

  /**
   * Sube un archivo y anota en qué quedó.
   *
   * Si el contenido ya no está en el navegador se marca `Unrecoverable` en vez
   * de reintentar para siempre: el archivo no va a aparecer, y dejarlo
   * pendiente mantendría su actividad detenida indefinidamente sin que nadie
   * pueda hacer nada al respecto.
   */
  private async uploadOne(
    resource: BinaryResource,
    companyId: string | number,
  ): Promise<boolean> {
    const blob = await this.storage.loadBlob(resource.GUID);

    if (!blob) {
      await this.setState(resource, BinaryState.Unrecoverable);
      return false;
    }

    const result = await this.api.uploadBinary(blob, resource, companyId);
    if (!result.ok) return false;

    // `InRepository`, no `Online`: el servidor lo tiene, el bucket todavía no.
    await this.binaries.put({
      ...resource,
      BinaryState: BinaryState.InRepository,
      IsSync: 1,
      Uploaded: 1,
    });

    // Archivo a archivo, no al terminar el lote: en una subida de cincuenta
    // fotos la pantalla los va tachando conforme salen, en vez de quedarse
    // quieta hasta el final.
    this.revisions.touchBinaries();
    return true;
  }

  private async setState(resource: BinaryResource, state: BinaryState): Promise<void> {
    await this.binaries.put({ ...resource, BinaryState: state });
    this.revisions.touchBinaries();
  }

  /** Archivos que todavía no llegaron al servidor. */
  private async findPending(answerGuid?: string): Promise<BinaryResource[]> {
    const all = answerGuid
      ? await this.binaries.findByAnswer(answerGuid)
      : await this.binaries.query({ index: 'byUserID', range: this.auth.currentUser()?.UserID });

    return all.filter((binary) => binary.BinaryState === BinaryState.Pending);
  }
}

function describeOutcome(uploaded: number, failed: number): string {
  if (failed === 0 && uploaded === 0) return 'No había archivos pendientes.';
  if (failed === 0) return `${uploaded} archivo(s) enviados al servidor.`;
  if (uploaded === 0) return `No se pudo subir ningún archivo (${failed} fallaron).`;

  return `${uploaded} archivo(s) enviados · ${failed} con error.`;
}
