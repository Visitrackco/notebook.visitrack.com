import { Injectable } from '@angular/core';

import { ANSWER_STATE } from '../models/activity.model';
import { Asset, LocationForm, Survey, SurveyAnswer } from '../models/entities.model';
import { BaseRepository } from './base.repository';

/** Datos mínimos para crear una actividad. */
export interface CreateAnswerInput {
  survey: Pick<Survey, 'SurveyID' | 'Title'>;
  userId: string;
  companyId: number | string;
  /** Actividad padre, cuando nace de un formulario vinculado. */
  parentGuid?: string;
}

/**
 * Actividades: cada diligenciamiento de un formulario.
 *
 * Tiene archivo propio porque, a diferencia del resto de catálogos —que solo se
 * descargan y se leen—, este store **se escribe desde la interfaz**: aquí nacen
 * las actividades, se les cuelga la ubicación y el activo, y se descartan las
 * que quedaron a medias. Toda esa lógica vive junta para que nadie escriba en
 * `SurveyAnswers` por su cuenta y se salte una regla.
 *
 * ## Los valores por defecto no son opcionales
 *
 * En el móvil la tabla declara `DEFAULT` para casi todas las columnas, así que
 * un `INSERT` parcial queda consistente. IndexedDB no tiene nada de eso: guarda
 * el objeto tal cual se le pasa. Si aquí se omite un campo, queda `undefined` y
 * más adelante se sube a Visitrack como tal. Por eso [buildDraft] escribe la
 * fila **completa**, con los mismos valores por defecto que el `CREATE TABLE`
 * del móvil.
 */
@Injectable({ providedIn: 'root' })
export class SurveyAnswerRepository extends BaseRepository<SurveyAnswer> {
  protected readonly storeName = 'SurveyAnswers';

  // ───────────────────────────────────────────────────────────────────────────
  // Lectura
  // ───────────────────────────────────────────────────────────────────────────

  async findByUser(userId: string): Promise<SurveyAnswer[]> {
    return this.query({
      index: 'byUserID',
      range: userId,
      filter: (a) => a.IsDelete !== '1',
    });
  }

  async findByGuid(guid: string): Promise<SurveyAnswer | null> {
    return this.getByIndex('byGUID', guid);
  }

  /** Actividades de un formulario, de la más reciente a la más antigua. */
  async findBySurvey(userId: string, surveyId: string): Promise<SurveyAnswer[]> {
    const answers = await this.query({
      index: 'byUserID',
      range: userId,
      filter: (a) => a.IsDelete !== '1' && a.SurveyID === surveyId,
    });
    return answers.sort((a, b) => (b.UpdatedOn ?? '').localeCompare(a.UpdatedOn ?? ''));
  }

  /** Cuántas actividades tiene cada formulario. Alimenta el contador del listado. */
  async countBySurvey(userId: string): Promise<Record<string, number>> {
    const answers = await this.findByUser(userId);
    const counts: Record<string, number> = {};

    for (const answer of answers) {
      counts[answer.SurveyID] = (counts[answer.SurveyID] ?? 0) + 1;
    }
    return counts;
  }

  /** Pendientes de enviar al servidor (`isSaved = 1`). */
  async findPendingSync(userId: string): Promise<SurveyAnswer[]> {
    return this.query({
      index: 'byUserID',
      range: userId,
      filter: (a) => a.isSaved === ANSWER_STATE.PENDING && a.IsDelete !== '1',
    });
  }

  /**
   * Detenidas esperando que sus archivos queden confirmados (`isSaved = 3`).
   *
   * No es lo mismo que "pendiente": estas no se pueden enviar todavía aunque
   * haya conexión, porque llegarían con las fotos rotas.
   */
  async findWaitingBinaries(userId: string): Promise<SurveyAnswer[]> {
    return this.query({
      index: 'byUserID',
      range: userId,
      filter: (a) => a.isSaved === ANSWER_STATE.WAITING_BINARIES && a.IsDelete !== '1',
    });
  }

  /** Cuántas actividades esperan archivos, por formulario. */
  async countWaitingBinariesBySurvey(userId: string): Promise<Record<string, number>> {
    const waiting = await this.findWaitingBinaries(userId);
    const counts: Record<string, number> = {};

    for (const answer of waiting) {
      counts[answer.SurveyID] = (counts[answer.SurveyID] ?? 0) + 1;
    }
    return counts;
  }

  /** Borradores: creados aquí y nunca guardados. */
  async findDrafts(userId: string): Promise<SurveyAnswer[]> {
    return this.query({
      index: 'byUserID',
      range: userId,
      filter: (a) => a.eraser === 1 && a.IsDelete !== '1',
    });
  }

  /** Borradores hijos de una actividad (formularios vinculados). */
  async findDraftChildren(userId: string, parentGuid: string): Promise<SurveyAnswer[]> {
    if (!parentGuid) return [];

    return this.query({
      index: 'byUserID',
      range: userId,
      filter: (a) => a.eraser === 1 && a.ParentGUID === parentGuid,
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Escritura
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Crea la actividad y la deja guardada de inmediato.
   *
   * Nace como **borrador** (`eraser = 1`, `isSaved = 0`): existe en la base
   * desde el primer momento, antes de que el usuario escriba nada. No es un
   * detalle de implementación — es lo que permite que las fotos y las filas de
   * MasterDetail se cuelguen de algo, y lo que hace que cerrar la pestaña a
   * medio diligenciar no borre el trabajo.
   *
   * Devuelve la actividad ya con su `ID` asignado.
   */
  async createDraft(input: CreateAnswerInput): Promise<SurveyAnswer> {
    const draft = this.buildDraft(input);
    const id = await this.put(draft);
    return { ...draft, ID: Number(id) };
  }

  /** Fila completa de una actividad nueva, con todos los valores por defecto. */
  private buildDraft(input: CreateAnswerInput): SurveyAnswer {
    const now = new Date().toISOString();

    return {
      GUID: crypto.randomUUID(),
      SurveyID: input.survey.SurveyID,
      UserID: input.userId,
      CompanyID: String(input.companyId ?? ''),

      // El título del formulario viaja como descriptivo `[DEF]`: es lo que
      // Visitrack usa para nombrar la actividad cuando aún no tiene datos.
      Titles: JSON.stringify([{ lab: '[DEF]', val: input.survey.Title }]),
      Fields: '',

      AnswerID: '',
      Consecutive: '',

      LocationTypeID: '',
      LocationID: '',
      LocationGUID: '',
      LocationName: '',

      AssetID: '',
      AssetGUID: '',
      AssetName: '',

      WorkZoneID: '',

      Latitude: '',
      Longitude: '',
      Accuracy: '',

      CreatedOn: now,
      UpdatedOn: now,
      CompletedOn: '',
      Received: '',

      isSaved: ANSWER_STATE.UNSAVED,
      toSync: 0,
      IsUpload: '0',
      SyncOn: '0',

      Status: '',
      StatusInternal: '1',

      ParentGUID: input.parentGuid ?? '',
      Sheduled: '0',

      IsMovilDeleted: 0,
      DeletingPolicy: 0,
      IsDelete: '0',

      eraser: 1,
      Msg: '',
    };
  }

  /**
   * Asocia una ubicación a la actividad.
   *
   * Se guarda en el acto, sin esperar a que el usuario llegue al formulario: si
   * abandona el flujo a mitad de camino y vuelve a entrar, la actividad ya tiene
   * su ubicación y no se le vuelve a preguntar.
   *
   * `LocationID` cae al GUID cuando la ubicación se creó en el cliente y todavía
   * no tiene identificador del servidor.
   */
  async attachLocation(id: number, location: LocationForm): Promise<SurveyAnswer | null> {
    const locationId = (location.LocationID ?? '').toString();

    return this.update(id, {
      LocationTypeID: location.LocationTypeGUID ?? '',
      LocationID: locationId || location.GUID,
      LocationGUID: location.GUID,
      LocationName: location.Name ?? '',
      WorkZoneID: location.WorkZoneID ?? '',
      UpdatedOn: new Date().toISOString(),
    });
  }

  /** Asocia un activo. Mismo criterio de guardado inmediato que la ubicación. */
  async attachAsset(id: number, asset: Asset): Promise<SurveyAnswer | null> {
    const assetId = (asset.AssetID ?? '').toString();
    // '0' es tan inservible como vacío: el servidor lo usa para "sin asignar".
    const resolved = assetId && assetId !== '0' ? assetId : asset.GUID;

    return this.update(id, {
      AssetID: resolved,
      AssetGUID: asset.GUID,
      AssetName: asset.Name ?? '',
      UpdatedOn: new Date().toISOString(),
    });
  }

  /**
   * Marca la actividad como guardada: deja de ser un borrador descartable.
   *
   * @param waitingBinaries true si tiene archivos que aún no están en el bucket.
   *   Entonces queda en `WAITING_BINARIES` en lugar de `PENDING`: la actividad
   *   **no** se envía mientras sus fotos no hayan llegado, porque una actividad
   *   en Visitrack que apunta a imágenes inexistentes es peor que una que
   *   todavía no llegó — la primera parece completa y nadie la revisa.
   * @param completedOn marca de «terminada de verdad», o vacío si no lo está.
   *   De ella cuelga la regla de borrado del formulario, así que solo se sella
   *   cuando no falta ningún obligatorio. Ver [RetentionPolicyService].
   */
  async markSaved(
    id: number,
    waitingBinaries = false,
    completedOn = '',
  ): Promise<SurveyAnswer | null> {
    return this.update(id, {
      eraser: 0,
      isSaved: waitingBinaries ? ANSWER_STATE.WAITING_BINARIES : ANSWER_STATE.PENDING,
      UpdatedOn: new Date().toISOString(),

      // Vacío no borra lo que ya estuviera sellado: una actividad completada no
      // deja de estarlo porque se vuelva a guardar.
      ...(completedOn ? { CompletedOn: completedOn } : {}),
    });
  }

  /**
   * Elimina una actividad.
   *
   * Si ya subió a Visitrack (`IsUpload = '1'`) **no se borra**: se marca para
   * que la sincronización propague el borrado al servidor. Borrarla aquí sin más
   * la dejaría viva en Visitrack y desaparecida en el equipo, que es la peor de
   * las dos posibilidades — nadie volvería a saber de ella.
   *
   * @returns 'deleted' si se borró de verdad, 'flagged' si quedó marcada.
   */
  async remove(answer: SurveyAnswer): Promise<'deleted' | 'flagged'> {
    if (answer.ID == null) return 'deleted';

    if (answer.IsUpload === '1') {
      await this.update(answer.ID, {
        IsDelete: '1',
        isSaved: ANSWER_STATE.PENDING,
        StatusInternal: '4',
        UpdatedOn: new Date().toISOString(),
      });
      return 'flagged';
    }

    await this.delete(answer.ID);
    return 'deleted';
  }
}
