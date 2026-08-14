import { Injectable, inject, signal } from '@angular/core';

import { SurveyAnswer } from '../models/entities.model';
import { ANSWER_STATE } from '../models/activity.model';
import { BinaryState } from '../models/sync.model';
import { BinaryResourceRepository } from '../repositories/binary.repository';
import { SurveyAnswerRepository } from '../repositories/survey-answer.repository';
import { ActivityService } from '../services/activity.service';
import { ConnectivityService } from '../services/connectivity.service';
import { BinaryVerifyService } from './binary-verify.service';
import { DataRevisionService } from './data-revision.service';
import { EntityUploadService } from './entity-upload.service';
import { UploadApiService } from './upload-api.service';

/** En qué terminó el envío de una actividad. */
export type SubmitOutcome =
  /** Creada en Visitrack y confirmada. */
  | 'sent'
  /** Detenida hasta que sus archivos estén en el bucket. */
  | 'waiting'
  /** No hay conexión. Se reintentará sola. */
  | 'offline'
  /** Sus datos no cuadran entre sí. Necesita que el usuario la corrija. */
  | 'blocked'
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
 * ## La misma regla con las entidades
 *
 * Y tampoco sale antes que la ubicación, el activo o los ítems de lista que se
 * crearon en este dispositivo y que ella referencia. Mientras no han subido, la
 * actividad no lleva sus identificadores sino sus GUID —el identificador lo
 * asigna el servidor—, así que llegaría a Visitrack apuntando a algo que del
 * otro lado no existe. Y a diferencia de los archivos, esto no se arregla
 * después: el registro ya está creado y parece completo. Ver
 * [EntityUploadService].
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
  private readonly activities = inject(ActivityService);
  private readonly revisions = inject(DataRevisionService);
  private readonly connectivity = inject(ConnectivityService);
  private readonly entities = inject(EntityUploadService);

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
  /**
   * @param extra campos que viajan **solo en el envío**, sin escribirse en la
   *   actividad. Es lo que usa el correo de Brillantex para mandar su estado
   *   sin cambiar el que la actividad tiene aquí — igual que la app, donde el
   *   `extra` se mezcla en el cuerpo de `createAnswer` y no en la base.
   */
  async submit(
    answer: SurveyAnswer,
    attempts = 6,
    extra: Record<string, unknown> = {},
  ): Promise<SubmitResult> {
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
      /**
       * Nada sale con los datos descuadrados.
       *
       * Se comprueba también aquí y no solo al abrirla: una actividad ya
       * guardada —incluso ya sincronizada y reabierta para corregir— puede
       * haber cambiado de ubicación sin que se actualizara su activo, y en ese
       * momento nadie está mirando la pantalla. Subirla dejaría en Visitrack un
       * registro que afirma haber inspeccionado un equipo donde no está.
       *
       * No se reintenta sola: hace falta que una persona elija. Por eso queda
       * anotado en la actividad, que es donde el usuario lo va a leer.
       */
      const issue = await this.activities.findIssueOf(answer);

      if (issue) {
        await this.answers.update(answer.ID, {
          isSaved: ANSWER_STATE.PENDING,
          Msg: issue.message,
        });

        this.revisions.touchActivities();

        return { outcome: 'blocked', message: issue.message };
      }

      /**
       * Y nada sale antes que las entidades que referencia.
       *
       * Se intenta subirlas aquí mismo antes de rendirse: en el caso normal
       * —hay conexión y el servidor responde— la actividad sigue su camino en
       * la misma pasada y el usuario no llega a enterarse de que hubo un orden
       * que respetar.
       */
      const waitingEntities = await this.entities.ensureFor(answer);

      if (waitingEntities) {
        await this.answers.update(answer.ID, { Msg: waitingEntities });
        this.revisions.touchActivities();

        return { outcome: 'waiting', message: waitingEntities };
      }

      const blocking = await this.binaries.countBlockingByAnswer(answer.GUID);

      if (blocking === 0) return await this.create(answer, extra);

      // Se marca antes de esperar: ver el párrafo de la clase.
      await this.answers.update(answer.ID, { isSaved: ANSWER_STATE.WAITING_BINARIES });

      // Se avisa en el momento, no al final: la espera puede durar minutos, y
      // durante todo ese rato el listado tiene que mostrar «esperando archivos»
      // en vez del estado con el que entró.
      this.revisions.touchActivities();

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

      return await this.create(answer, extra);
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
  private async create(
    answer: SurveyAnswer,
    extra: Record<string, unknown> = {},
  ): Promise<SubmitResult> {
    // Se relee de la base: entre abrir el formulario y llegar aquí, el
    // autoguardado pudo escribir campos que la copia en memoria no tiene.
    const fresh = (await this.answers.findByGuid(answer.GUID)) ?? answer;

    const row: Record<string, unknown> = {
      ...fresh,
      UpdatedOn: new Date().toISOString(),
      // Lo puntual del envío, encima de lo guardado. Ver `submit`.
      ...extra,
    };

    /**
     * Lo que ya subió una vez viaja como **modificación**, no como alta.
     *
     * El procedimiento del servidor recibe `CompanyStatusID` y `StatusInternal`
     * juntos, y es el segundo el que decide qué hace con el primero: con `'1'`
     * lo trata como un alta, y un alta de algo que ya existe no cambia nada.
     * Ese `'1'` es el que trae el registro desde que se creó y no se movía
     * nunca, así que **volver a guardar no actualizaba el servidor**: la
     * actividad quedaba terminada aquí y sin estado en Visitrack.
     *
     * Se marca como modificación en dos casos:
     *
     * - **Ya se subió** (`IsUpload = '1'`). Un reenvío es por definición una
     *   modificación, lleve estado o no: también las respuestas corregidas.
     * - **Lleva estado**. Es lo que hace la app móvil, y cubre a los
     *   formularios que deciden su estado al guardar —Brillantex, Inverpack—
     *   incluso la primera vez.
     */
    const yaSubio = String(fresh.IsUpload ?? '') === '1';
    const llevaEstado = String(row['Status'] ?? '').trim() !== '';

    if (yaSubio || llevaEstado) row['StatusInternal'] = '2';

    console.debug(
      `[Envío] ${fresh.GUID.slice(0, 8)} estado=${row['Status'] || '(ninguno)'} ` +
        `interno=${row['StatusInternal']}`,
    );

    const result = await this.api.createAnswer(row);

    if (!result.ok) {
      if (fresh.ID != null) {
        await this.answers.update(fresh.ID, { isSaved: ANSWER_STATE.PENDING });
        this.revisions.touchActivities();
      }

      return {
        outcome: 'error',
        message: result.error ?? 'El servidor rechazó la actividad.',
      };
    }

    const exists = await this.api.answerExists(fresh.GUID);

    if (fresh.ID != null) {
      /**
       * `CompletedOn` se sella aquí, y solo la primera vez.
       *
       * Es el momento en que la actividad está de verdad terminada: existe en
       * Visitrack y ya no depende de este equipo. De esa marca cuelga la regla
       * de borrado del formulario —ver [RetentionPolicyService]—, así que sin
       * ella la actividad se quedaría en el dispositivo para siempre.
       *
       * No se reescribe en un reenvío: el plazo cuenta desde que se completó,
       * no desde el último intento, o una actividad que se reintenta sola nunca
       * llegaría a cumplirlo.
       */
      const completedOn = fresh.CompletedOn || new Date().toISOString();

      await this.answers.update(fresh.ID, {
        // Sin confirmación se queda pendiente, no sincronizada: es preferible
        // reenviar de más a dar por buena una actividad que no llegó.
        isSaved: exists ? ANSWER_STATE.SYNCED : ANSWER_STATE.PENDING,
        IsUpload: exists ? '1' : fresh.IsUpload,
        SyncOn: exists ? new Date().toISOString() : fresh.SyncOn,
        CompletedOn: exists ? completedOn : fresh.CompletedOn,
      });

      this.revisions.touchActivities();
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
