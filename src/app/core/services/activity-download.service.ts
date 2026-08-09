import { Injectable, inject } from '@angular/core';

import { ANSWER_STATE } from '../models/activity.model';
import { SurveyAnswer } from '../models/entities.model';
import { SurveyRepository } from '../repositories/entity.repositories';
import { SurveyAnswerRepository } from '../repositories/survey-answer.repository';
import { DispatchFilesService } from '../sync/dispatch-files.service';
import { DataRevisionService } from '../sync/data-revision.service';
import { AuthService } from './auth.service';
import { HistoryActivity } from './activity-history.api';

/** Cómo quedó la actividad después de bajarla. */
export interface DownloadResult {
  ok: boolean;
  /** Archivos cuyo contenido quedó guardado. */
  files: number;
  /** Se podrá abrir y modificar, o solo mirar. */
  editable: boolean;
  message: string;
}

/**
 * Bajar al dispositivo una actividad consultada en el historial.
 *
 * ## Qué se guarda
 *
 * La actividad tal como está en el servidor —sus respuestas sin aplanar— y el
 * contenido de sus archivos. A partir de ahí se puede abrir sin conexión, que
 * es justo el caso para el que se descarga: se consulta la historia del equipo
 * en la oficina y se sale a campo, donde no hay señal.
 *
 * ## Editable solo si es mía
 *
 * Una actividad ajena se guarda **a nombre de su dueño**, no del usuario que la
 * baja. No es un adorno: todas las consultas locales —el listado, los
 * pendientes de subir, los borradores— van por el índice `byUserID`. Guardarla
 * con el dueño original la deja invisible para esas consultas, y por lo tanto
 * fuera del ciclo de subida. Se puede mirar y no se puede pisar.
 *
 * Si la actividad es mía, entra por la puerta normal como una actividad ya
 * sincronizada, y se comporta igual que las demás.
 */
@Injectable({ providedIn: 'root' })
export class ActivityDownloadService {
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly surveys = inject(SurveyRepository);
  private readonly files = inject(DispatchFilesService);
  private readonly revisions = inject(DataRevisionService);
  private readonly auth = inject(AuthService);

  async download(activity: HistoryActivity): Promise<DownloadResult> {
    const user = this.auth.currentUser();

    if (!user) {
      return { ok: false, files: 0, editable: false, message: 'No hay sesión activa.' };
    }

    try {
      /**
       * Se necesita el formulario para poder abrirla.
       *
       * El historial pinta cualquier actividad porque el servidor le manda las
       * preguntas ya cruzadas con las respuestas. Editarla es otra cosa: eso lo
       * hace el motor de formularios con la definición local. Sin ella, la
       * actividad se baja igual —para consultarla sin conexión— pero no se
       * puede abrir a modificar, y hay que decirlo.
       */
      const survey = await this.surveys.findBySurveyId(String(activity.SurveyID));
      const editable = activity.isMine && survey !== null;

      const existing = await this.answers.findByGuid(activity.GUID);
      const record = this.recordOf(activity, String(user.UserID), String(user.CompanyID));

      // Con el `ID` anterior si ya estaba: sin él, IndexedDB asignaría una llave
      // nueva y quedarían dos copias de la misma actividad.
      if (existing?.ID != null) record.ID = existing.ID;

      await this.answers.put(record);

      const files = await this.files.syncOne(record);

      this.revisions.touchActivities();
      if (files > 0) this.revisions.touchBinaries();

      return {
        ok: true,
        files,
        editable,
        message: this.messageOf(activity, survey !== null, files),
      };
    } catch (error) {
      console.error('[Historial] no se pudo descargar la actividad', error);

      return {
        ok: false,
        files: 0,
        editable: false,
        message: 'No se pudo descargar la actividad.',
      };
    }
  }

  /**
   * La copia que ya hay en el dispositivo, si la hay.
   *
   * Devuelve el registro y no un `true`/`false` porque quien pregunta necesita
   * saber **en qué estado** está: descargar encima de una actividad con cambios
   * sin enviar borra trabajo que no está en ningún otro sitio.
   */
  async localCopy(guid: string): Promise<SurveyAnswer | null> {
    return this.answers.findByGuid(guid);
  }

  /**
   * ¿Esa copia local tiene trabajo que todavía no llegó a Visitrack?
   *
   * Cualquier estado que no sea «sincronizada», la marca de pendiente de envío
   * o la de borrador. Ante la duda cuenta como que sí: avisar de más molesta,
   * perder una hora de campo no se arregla.
   */
  hasUnsentWork(answer: SurveyAnswer): boolean {
    return (
      answer.isSaved !== ANSWER_STATE.SYNCED ||
      Number(answer.toSync) === 1 ||
      Number(answer.eraser) === 1
    );
  }

  /** La fila local que representa a la actividad del servidor. */
  private recordOf(activity: HistoryActivity, userId: string, companyId: string): SurveyAnswer {
    const now = new Date().toISOString();

    return {
      GUID: activity.GUID,
      SurveyID: String(activity.SurveyID),

      // La clave de todo el mecanismo: ver el comentario de la clase.
      UserID: activity.isMine ? userId : String(activity.AssignedTo ?? ''),
      CompanyID: companyId,

      Titles: JSON.stringify([{ lab: '[DEF]', val: activity.SurveyName ?? '' }]),
      Fields: JSON.stringify(activity.JSONAnswers ?? []),

      AnswerID: activity.Consecutive ?? '',
      Consecutive: activity.Consecutive ?? '',

      LocationTypeID: '',
      LocationID: activity.LocationID != null ? String(activity.LocationID) : '',
      LocationGUID: '',
      LocationName: activity.LocationName ?? '',

      AssetID: activity.AssetID != null ? String(activity.AssetID) : '',
      AssetGUID: '',
      AssetName: activity.AssetName ?? '',

      WorkZoneID: '',

      Latitude: '',
      Longitude: '',
      Accuracy: '',

      CreatedOn: activity.CreatedOn ?? now,
      UpdatedOn: activity.UpdatedOn ?? now,
      CompletedOn: activity.CompletedOn ?? '',
      Received: '',

      /**
       * Llega ya sincronizada, porque lo está: se acaba de leer del servidor.
       *
       * `toSync` en cero es lo que impide que el ciclo de subida la vuelva a
       * mandar. Una actividad bajada que se reenvía sería una edición que nadie
       * hizo.
       */
      isSaved: ANSWER_STATE.SYNCED,
      toSync: 0,
      IsUpload: '1',
      SyncOn: '0',

      Status: activity.StatusName ?? '',
      StatusInternal: '1',

      ParentGUID: '',
      Sheduled: '0',

      IsMovilDeleted: 0,
      DeletingPolicy: 0,
      IsDelete: '0',

      eraser: 0,
      Msg: '',
    };
  }

  private messageOf(activity: HistoryActivity, hasSurvey: boolean, files: number): string {
    const parts: string[] = ['Actividad descargada'];

    if (files > 0) parts.push(`con ${files} archivo${files === 1 ? '' : 's'}`);

    if (!activity.isMine) {
      parts.push('— es de otro usuario, así que queda solo para consultar');
    } else if (!hasSurvey) {
      parts.push('— para modificarla hay que descargar antes su formulario');
    }

    return `${parts.join(' ')}.`;
  }
}
