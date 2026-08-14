import { Injectable, inject } from '@angular/core';

import { Survey, SurveyAnswer } from '../models/entities.model';
import { SurveyRepository } from '../repositories/entity.repositories';
import { SurveyAnswerRepository } from '../repositories/survey-answer.repository';
import { AuthService } from '../services/auth.service';
import { DataRevisionService } from '../sync/data-revision.service';
import { parseAnswerFields, parseQuestions } from './form-schema';

/**
 * Sufijo que hace que un campo del hijo herede del padre.
 *
 * La herencia **no la hace el servidor**: el hijo nace con los valores ya
 * dentro. Y no basta con que dos campos se llamen igual — el del hijo tiene que
 * pedirlo, terminando su `apiId` en esto. Sin ese acuerdo explícito, dos
 * formularios que casualmente comparten un `apiId` se copiarían datos entre sí
 * sin que nadie lo haya decidido.
 */
const SUFFIX = '_INHERIT';

export interface LinkedChild {
  /** La actividad hija, si ya existe. */
  answer: SurveyAnswer | null;
  /** El formulario al que apunta el campo. */
  survey: Survey | null;
}

/**
 * Formularios vinculados: una actividad que cuelga de otra.
 *
 * ## Qué son
 *
 * Un campo de tipo `form` no se responde: **abre otra actividad**, de otro
 * formulario, colgada de la que se está diligenciando. Es lo que usan los
 * planificadores —el cronograma de Diamante, el Planeador de Brillantex— para
 * desplegar las visitas que se van a hacer.
 *
 * ## Cómo se enlazan
 *
 * El campo guarda `{ gui, tit }`: el GUID de la actividad hija y el título de su
 * formulario. La hija guarda `ParentGUID`. Con las dos puntas se puede navegar
 * en los dos sentidos sin buscar en toda la base.
 *
 * ## Qué hereda
 *
 * La ubicación, el activo y la zona **siempre** —una visita a una sede es a esa
 * sede— y además los campos que lo pidan con el sufijo `_INHERIT`. Ver [SUFFIX].
 */
@Injectable({ providedIn: 'root' })
export class LinkedFormService {
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly surveys = inject(SurveyRepository);
  private readonly auth = inject(AuthService);
  private readonly revisions = inject(DataRevisionService);

  /**
   * Qué hay detrás de un campo vinculado.
   *
   * @param fid GUID del formulario hijo, que es lo que guarda el campo.
   * @param value valor actual del campo: `{ gui, tit }` si ya se creó.
   */
  async resolve(fid: string, value: unknown): Promise<LinkedChild> {
    const survey = fid ? await this.surveys.getByIndex('byGUID', fid) : null;

    const guid = (value as { gui?: unknown })?.gui;
    const answer = guid ? await this.answers.findByGuid(String(guid)) : null;

    return { answer, survey };
  }

  /**
   * Crea la actividad hija y devuelve el valor que hay que guardar en el campo.
   *
   * Si ya existía, no se crea otra: se devuelve la que hay. Un campo vinculado
   * apunta a **una** actividad, y crear una segunda dejaría la primera
   * huérfana con lo que ya se hubiera respondido en ella.
   */
  async create(
    parent: SurveyAnswer,
    survey: Survey,
    currentValue: unknown,
  ): Promise<{ answer: SurveyAnswer; value: { gui: string; tit: string } } | null> {
    const user = this.auth.currentUser();

    if (!user) return null;

    const existing = await this.resolve('', currentValue);

    if (existing.answer) {
      return {
        answer: existing.answer,
        value: { gui: existing.answer.GUID, tit: survey.Title },
      };
    }

    const now = new Date().toISOString();

    const child: SurveyAnswer = {
      GUID: crypto.randomUUID(),
      SurveyID: String(survey.SurveyID),
      UserID: String(user.UserID),
      CompanyID: String(user.CompanyID ?? ''),

      Titles: JSON.stringify([{ lab: '[DEF]', val: survey.Title }]),
      Fields: await this.inheritedFields(parent, survey),

      AnswerID: '',
      Consecutive: '',

      // La visita hija ocurre donde la del padre: copiarlo evita volver a
      // preguntarlo y, sobre todo, evita que se responda otra sede por error.
      LocationTypeID: parent.LocationTypeID ?? '',
      LocationID: parent.LocationID ?? '',
      LocationGUID: parent.LocationGUID ?? '',
      LocationName: parent.LocationName ?? '',

      AssetID: parent.AssetID ?? '',
      AssetGUID: parent.AssetGUID ?? '',
      AssetName: parent.AssetName ?? '',

      WorkZoneID: parent.WorkZoneID ?? '',

      Latitude: '',
      Longitude: '',
      Accuracy: '',

      CreatedOn: now,
      UpdatedOn: now,
      CompletedOn: '',
      Received: '',

      isSaved: 0,
      toSync: 0,
      IsUpload: '0',
      SyncOn: '0',

      Status: '',
      StatusInternal: '1',

      /** El vínculo hacia arriba. Es lo que viaja al servidor. */
      ParentGUID: parent.GUID,
      Sheduled: '0',

      IsMovilDeleted: 0,
      DeletingPolicy: 0,
      IsDelete: '0',

      // Nace como borrador, igual que cualquier actividad recién abierta: si se
      // sale sin responder nada, no queda un registro vacío por ahí.
      eraser: 1,
      Msg: '',
    };

    const id = await this.answers.put(child);

    this.revisions.touchActivities();

    return {
      answer: { ...child, ID: Number(id) },
      value: { gui: child.GUID, tit: survey.Title },
    };
  }

  /**
   * Los `Fields` iniciales del hijo, con lo heredado del padre.
   *
   * El cruce es por `apiId`, no por identificador: los identificadores son
   * propios de cada formulario, y lo que dice «esto es el mismo dato» es el
   * nombre de negocio.
   *
   * @returns el JSON listo para guardar, o `''` si no hay nada que heredar.
   */
  private async inheritedFields(parent: SurveyAnswer, child: Survey): Promise<string> {
    try {
      const parentSurvey = await this.surveys.findBySurveyId(String(parent.SurveyID));

      if (!parentSurvey) return '';

      // 1. Los valores del padre, por identificador de campo.
      const values = new Map(parseAnswerFields(parent.Fields).map((entry) => [entry.id, entry]));

      // 2. Su estructura, para pasar de identificador a `apiId`.
      const byApiId = new Map<string, { val: unknown; fty: string }>();

      for (const page of parseQuestions(parentSurvey.JSONQuestion)) {
        for (const field of page.fie) {
          const api = String((field as { apiId?: unknown }).apiId ?? '');
          const entry = values.get(field.id);

          // Sin `apiId` no hay con qué cruzar, y sin valor no hay qué heredar.
          if (!api || !entry) continue;

          byApiId.set(api, { val: entry.val, fty: entry.fty });
        }
      }

      if (byApiId.size === 0) return '';

      // 3. Los campos del hijo que lo piden.
      const inherited: { id: string; val: unknown; fty: string; hid: boolean }[] = [];

      for (const page of parseQuestions(child.JSONQuestion)) {
        for (const field of page.fie) {
          const api = String((field as { apiId?: unknown }).apiId ?? '');

          if (!api.toUpperCase().endsWith(SUFFIX)) continue;

          const base = api.slice(0, api.length - SUFFIX.length);
          const source = base ? byApiId.get(base) : undefined;

          if (!source) continue;

          inherited.push({
            id: field.id,
            val: source.val,
            fty: field.fty || source.fty,
            hid: Boolean((field as { hid?: unknown }).hid),
          });
        }
      }

      return inherited.length > 0 ? JSON.stringify(inherited) : '';
    } catch (error) {
      // Ante cualquier fallo el hijo nace en blanco, que es lo que hacía antes
      // de que existiera la herencia: se pierde una comodidad, no un dato.
      console.warn('[Vinculado] no se pudieron heredar los valores', error);
      return '';
    }
  }
}
