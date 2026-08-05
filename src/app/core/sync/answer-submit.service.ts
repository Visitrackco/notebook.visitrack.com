import { Injectable, inject, signal } from '@angular/core';

import { SurveyAnswer } from '../models/entities.model';
import { ANSWER_STATE } from '../models/activity.model';
import { BinaryState } from '../models/sync.model';
import { BinaryResourceRepository } from '../repositories/binary.repository';
import { SurveyAnswerRepository } from '../repositories/survey-answer.repository';
import { ConnectivityService } from '../services/connectivity.service';
import { BinaryVerifyService } from './binary-verify.service';
import { UploadApiService } from './upload-api.service';

/** En qué terminó el envío de una actividad. */
export type SubmitOutcome =
  /** Creada en Visitrack y confirmada. */
  | 'sent'
  /** Detenida hasta que sus archivos estén en el bucket. */
  | 'waiting'
  /** No hay conexión. Se reintentará sola. */
  | 'offline'
  /** El servidor la rechazó o no se pudo confirmar. */
  | 'error';

export interface SubmitResult {
  outcome: SubmitOutcome;
  message: string;
  /** Archivos que faltan por confirmar, cuando quedó esperando. */
  pendingFiles?: number;
}

/**
 * Envía una actividad a Visitrack respetando el estado de sus archivos.
 *
 * ## La regla
 *
 * Una actividad **no se crea en Visitrack hasta que todos sus archivos estén
 * confirmados en el bucket**. Antes se enviaba en paralelo a la subida de las
 * fotos, así que podía llegar a la plataforma apuntando a archivos que todavía
 * no existían — y eso es peor que llegar tarde: la actividad parece completa y
 * nadie vuelve a mirarla.
 *
 * Mientras espera, queda en estado «Esperando archivos» y visible como tal en
 * el listado. Nunca se detiene en silencio.
 *
 * ## El marcado va antes de la espera
 *
 * Se registra que está esperando **antes** de empezar a esperar. Si el usuario
 * cierra la pestaña en mitad del proceso, la actividad ya quedó anotada y el
 * reintento la retoma; al revés, se perdería en un limbo del que nadie la
 * saca.
 */
@Injectable({ providedIn: 'root' })
export class AnswerSubmitService {
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly binaries = inject(BinaryResourceRepository);
  private readonly verify = inject(BinaryVerifyService);
  private readonly api = inject(UploadApiService);
  private readonly connectivity = inject(ConnectivityService);

  /** Actividades que se están enviando ahora mismo. */
  private readonly inFlight = new Set<string>();

  /** GUID de la actividad en curso, para que la interfaz lo señale. */
  readonly sending = signal<string>('');

  /**
   * Envía una actividad.
   *
   * @param attempts rondas de verificación antes de dejarla esperando. El
   *   guardado usa el ciclo completo —el trabajo de AWS puede tardar varios
   *   minutos—; el botón de reintento usa uno corto, porque hay alguien
   *   mirando la pantalla.
   */
  async submit(answer: SurveyAnswer, attempts = 6): Promise<SubmitResult> {
    if (!answer.GUID || answer.ID == null) {
      return { outcome: 'error', message: 'La actividad no tiene identificador.' };
    }

    if (this.inFlight.has(answer.GUID)) {
      return { outcome: 'waiting', message: 'Esta actividad ya se está enviando.' };
    }

    if (!this.connectivity.isOnline()) {
      return {
        outcome: 'offline',
        message: 'Sin conexión. La actividad se enviará cuando vuelva la red.',
      };
    }

    this.inFlight.add(answer.GUID);
    this.sending.set(answer.GUID);

    try {
      const blocking = await this.binaries.countBlockingByAnswer(answer.GUID);

      if (blocking === 0) return await this.create(answer);

      // Se marca antes de esperar: ver el párrafo de la clase.
      await this.answers.update(answer.ID, { isSaved: ANSWER_STATE.WAITING_BINARIES });

      const ready = await this.verify.ensureAnswerOnline(answer.GUID, attempts);

      if (!ready) {
        const left = await this.binaries.countBlockingByAnswer(answer.GUID);
        return {
          outcome: 'waiting',
          pendingFiles: left,
          message:
            left === 1
              ? 'Falta 1 archivo por terminar de subir. La actividad se enviará sola cuando esté listo.'
              : `Faltan ${left} archivos por terminar de subir. La actividad se enviará sola cuando estén listos.`,
        };
      }

      return await this.create(answer);
    } catch (error) {
      console.error('[Submit] fallo enviando la actividad', error);
      return { outcome: 'error', message: 'No se pudo enviar la actividad.' };
    } finally {
      this.inFlight.delete(answer.GUID);
      this.sending.set('');
    }
  }

  /**
   * Crea la actividad y comprueba que quedó de verdad.
   *
   * La comprobación existe por un caso real: el backend responde correcto pero
   * la inserción falla después. Sin verificar, la actividad quedaba en verde
   * sin existir en la plataforma, y nadie la volvía a enviar porque para el
   * dispositivo ya estaba resuelta.
   */
  private async create(answer: SurveyAnswer): Promise<SubmitResult> {
    // Se relee de la base: entre abrir el formulario y llegar aquí, el
    // autoguardado pudo escribir campos que la copia en memoria no tiene.
    const fresh = (await this.answers.findByGuid(answer.GUID)) ?? answer;

    const row: Record<string, unknown> = {
      ...fresh,
      UpdatedOn: new Date().toISOString(),
    };

    const result = await this.api.createAnswer(row);

    if (!result.ok) {
      if (fresh.ID != null) {
        await this.answers.update(fresh.ID, { isSaved: ANSWER_STATE.PENDING });
      }

      return {
        outcome: 'error',
        message: result.error ?? 'El servidor rechazó la actividad.',
      };
    }

    const exists = await this.api.answerExists(fresh.GUID);

    if (fresh.ID != null) {
      await this.answers.update(fresh.ID, {
        // Sin confirmación se queda pendiente, no sincronizada: es preferible
        // reenviar de más a dar por buena una actividad que no llegó.
        isSaved: exists ? ANSWER_STATE.SYNCED : ANSWER_STATE.PENDING,
        IsUpload: exists ? '1' : fresh.IsUpload,
        SyncOn: exists ? new Date().toISOString() : fresh.SyncOn,
      });
    }

    const lost = await this.countLost(fresh.GUID);

    if (lost > 0 && fresh.ID != null) {
      // Queda constancia en la propia actividad de que llegó incompleta y por
      // qué, en vez de descubrirlo revisando la plataforma semanas después.
      await this.answers.update(fresh.ID, {
        Msg:
          lost === 1
            ? 'La actividad se envió sin 1 archivo: el original ya no estaba en este dispositivo.'
            : `La actividad se envió sin ${lost} archivos: los originales ya no estaban en este dispositivo.`,
      });
    }

    if (!exists) {
      return {
        outcome: 'error',
        message: 'El servidor recibió la actividad pero no se pudo confirmar. Se reintentará.',
      };
    }

    return {
      outcome: 'sent',
      message:
        lost > 0
          ? `Actividad enviada, pero ${lost} archivo(s) no se pudieron recuperar.`
          : 'Actividad enviada a Visitrack.',
    };
  }

  /** Archivos que se perdieron y ya no van a subir. */
  private async countLost(answerGuid: string): Promise<number> {
    const all = await this.binaries.findByAnswer(answerGuid);
    return all.filter((binary) => binary.BinaryState === BinaryState.Unrecoverable).length;
  }
}
