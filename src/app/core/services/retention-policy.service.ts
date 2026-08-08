import { Injectable, inject } from '@angular/core';

import { environment } from '../../../environments/environment';
import { ANSWER_STATE } from '../models/activity.model';
import { Survey, SurveyAnswer } from '../models/entities.model';
import { SurveyRepository } from '../repositories/entity.repositories';
import { SurveyAnswerRepository } from '../repositories/survey-answer.repository';
import { UploadApiService } from '../sync/upload-api.service';
import { AuthService } from './auth.service';
import { BinaryStorageService } from './binary-storage.service';
import { ConnectivityService } from './connectivity.service';

/**
 * Unidad de la política de borrado del formulario.
 *
 * Los números son los de la plataforma; no se traducen a segundos al leerlos
 * porque el diseñador del formulario escribe «30 días», y ese es el dato que
 * hay que poder enseñarle al usuario tal cual.
 */
const MAINT_UNIT = {
  NONE: 0,
  MINUTES: 1,
  HOURS: 2,
  DAYS: 3,
} as const;

/** Cuánto dura cada unidad. */
const MS: Record<number, number> = {
  [MAINT_UNIT.MINUTES]: 60_000,
  [MAINT_UNIT.HOURS]: 3_600_000,
  [MAINT_UNIT.DAYS]: 86_400_000,
};

/** La política de un formulario, resuelta. */
export interface RetentionRule {
  /** El formulario borra sus actividades completadas pasado un tiempo. */
  enabled: boolean;

  unit: number;
  value: number;

  /** «30 días», «12 horas». Para enseñarlo donde el usuario lo va a leer. */
  label: string;
}

/**
 * Cuánto vive una actividad **completada** en este equipo.
 *
 * ## Qué regla es esta
 *
 * No es la de los borradores. Un borrador es trabajo a medias y lo limpia
 * [DraftPolicyService] por horas configuradas en el equipo. Esto es otra cosa:
 * una actividad **terminada y ya confirmada en Visitrack**, que el formulario
 * manda retirar del dispositivo pasado un tiempo.
 *
 * La regla la escribe quien diseña el formulario, no el usuario:
 * `DeviceMaintType` dice la unidad (1 minutos, 2 horas, 3 días; 0 = nunca) y
 * `DeviceMaintValue` la cantidad. Se cuenta desde `CompletedOn`.
 *
 * ## Por qué el dato no se pierde
 *
 * Borrar aquí **no borra nada en Visitrack**. El servidor marca la actividad
 * con `DeletingPolicy = 1` y quita su fila de sincronización para que no vuelva
 * a bajar; el registro sigue entero en la plataforma. Lo que se libera es el
 * espacio del equipo, que es de lo que trata la regla.
 *
 * ## Las tres condiciones antes de borrar
 *
 * 1. **Completada de verdad** (`isSaved = 2` y con `CompletedOn`). Una
 *    actividad pendiente de subir no se toca por mucho que envejezca.
 * 2. **Existe en Visitrack**. Se pregunta al servidor una por una. Hubo un caso
 *    real de «verde falso» —el backend responde correcto y la inserción falla
 *    después—, y borrar por tiempo una actividad que nunca llegó sería perder
 *    el trabajo sin que nadie se entere. Si no está, se reenvía y se deja para
 *    la vuelta siguiente.
 * 3. **El servidor confirma la retirada**. Si esa llamada falla, la actividad
 *    se queda: volverá a intentarse.
 *
 * Sin conexión no se borra nada. Es deliberado: las tres comprobaciones
 * necesitan servidor, y saltárselas convertiría una limpieza en una pérdida.
 */
@Injectable({ providedIn: 'root' })
export class RetentionPolicyService {
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly surveys = inject(SurveyRepository);
  private readonly binaries = inject(BinaryStorageService);
  private readonly api = inject(UploadApiService);
  private readonly auth = inject(AuthService);
  private readonly connectivity = inject(ConnectivityService);

  /** La regla de un formulario. */
  ruleOf(survey: Pick<Survey, 'DeviceMaintType' | 'DeviceMaintValue'> | null): RetentionRule {
    const unit = Number(survey?.DeviceMaintType ?? 0);
    const value = Number(survey?.DeviceMaintValue ?? 0);

    if (!unit || !value || !MS[unit]) {
      return { enabled: false, unit: 0, value: 0, label: '' };
    }

    return { enabled: true, unit, value, label: `${value} ${unitName(unit, value)}` };
  }

  /**
   * Cuándo se retirará esta actividad del equipo.
   *
   * `null` cuando no aplica: no está completada, el formulario no tiene regla,
   * o no se sabe cuándo se completó.
   */
  expiresAt(
    answer: Pick<SurveyAnswer, 'isSaved' | 'CompletedOn'>,
    rule: RetentionRule,
  ): Date | null {
    if (!rule.enabled) return null;
    if (Number(answer.isSaved) !== ANSWER_STATE.SYNCED) return null;

    const completed = Date.parse(answer.CompletedOn ?? '');
    if (!Number.isFinite(completed)) return null;

    return new Date(completed + rule.value * MS[rule.unit]);
  }

  /** Lo mismo, cargando el formulario. Para una actividad suelta. */
  async expiresAtOf(answer: SurveyAnswer): Promise<Date | null> {
    if (Number(answer.isSaved) !== ANSWER_STATE.SYNCED) return null;

    const survey = await this.surveys.findBySurveyId(answer.SurveyID);
    return this.expiresAt(answer, this.ruleOf(survey));
  }

  /**
   * Retira las actividades completadas que cumplieron su plazo.
   *
   * @returns cuántas se retiraron.
   */
  async purgeExpired(): Promise<number> {
    const user = this.auth.currentUser();

    // Las tres comprobaciones necesitan servidor. Sin él no se borra: una
    // limpieza que no puede verificar nada es una pérdida de datos.
    if (!user || this.connectivity.isOffline()) return 0;

    const all = await this.answers.query({ index: 'byUserID', range: user.UserID });
    const rules = new Map<string, RetentionRule>();

    const now = Date.now();
    let removed = 0;

    for (const answer of all) {
      if (answer.ID == null) continue;
      if (Number(answer.isSaved) !== ANSWER_STATE.SYNCED) continue;

      let rule = rules.get(answer.SurveyID);

      if (!rule) {
        rule = this.ruleOf(await this.surveys.findBySurveyId(answer.SurveyID));
        rules.set(answer.SurveyID, rule);
      }

      const expires = this.expiresAt(answer, rule);
      if (!expires || expires.getTime() > now) continue;

      if (await this.retire(answer)) removed++;
    }

    return removed;
  }

  /** Las que se retirarán dentro del plazo indicado, con su fecha. */
  async expiringWithin(hours: number): Promise<{ answer: SurveyAnswer; expires: Date }[]> {
    const user = this.auth.currentUser();
    if (!user) return [];

    const all = await this.answers.query({ index: 'byUserID', range: user.UserID });
    const rules = new Map<string, RetentionRule>();

    const limit = Date.now() + hours * 3_600_000;
    const soon: { answer: SurveyAnswer; expires: Date }[] = [];

    for (const answer of all) {
      if (Number(answer.isSaved) !== ANSWER_STATE.SYNCED) continue;

      let rule = rules.get(answer.SurveyID);

      if (!rule) {
        rule = this.ruleOf(await this.surveys.findBySurveyId(answer.SurveyID));
        rules.set(answer.SurveyID, rule);
      }

      const expires = this.expiresAt(answer, rule);
      if (expires && expires.getTime() <= limit) soon.push({ answer, expires });
    }

    soon.sort((a, b) => a.expires.getTime() - b.expires.getTime());
    return soon;
  }

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Retira una actividad del equipo, comprobando antes que esté a salvo.
   *
   * @returns true si de verdad se retiró.
   */
  private async retire(answer: SurveyAnswer): Promise<boolean> {
    if (answer.ID == null) return false;

    /**
     * ¿Existe de verdad en Visitrack?
     *
     * El caso que obliga a preguntarlo: el backend responde correcto y la
     * inserción falla después. La actividad queda en verde sin existir, y
     * borrarla por tiempo sería perder el trabajo sin que nadie se entere.
     */
    const exists = await this.api.answerExists(answer.GUID, 2);

    if (!exists) {
      // No está: se vuelve a mandar y se deja para la próxima vuelta, que ya
      // encontrará la comprobación en positivo.
      await this.answers.update(answer.ID, { isSaved: ANSWER_STATE.PENDING });
      return false;
    }

    // El servidor marca `DeletingPolicy = 1` y quita su fila de
    // sincronización: la actividad sigue entera allá, deja de bajar aquí.
    const released = await this.release(answer);
    if (!released) return false;

    await this.binaries.removeByAnswer(answer.GUID);
    await this.answers.delete(answer.ID);

    return true;
  }

  /** Avisa al servidor de que esta actividad ya no vive en el dispositivo. */
  private async release(answer: SurveyAnswer): Promise<boolean> {
    const base = environment.useLocalApi ? environment.localApiUrl : environment.apiUrl;

    try {
      const reply = await fetch(`${base}/deleteSurveysAnswers`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          GUID: answer.GUID,
          ID: answer.AnswerID ?? '',
          UserID: this.auth.currentUser()?.UserID ?? '',
        }),
      });

      if (!reply.ok) return false;

      const result = (await reply.json()) as { status?: boolean };
      return result?.status === true;
    } catch (error) {
      console.warn('[Retención] no se pudo liberar la actividad', error);
      return false;
    }
  }
}

/** El nombre de la unidad, en singular o plural. */
function unitName(unit: number, value: number): string {
  const one = value === 1;

  if (unit === MAINT_UNIT.MINUTES) return one ? 'minuto' : 'minutos';
  if (unit === MAINT_UNIT.HOURS) return one ? 'hora' : 'horas';

  return one ? 'día' : 'días';
}

/**
 * Cuánto falta, en palabras.
 *
 * Vive aquí y no en cada pantalla porque la frase tiene que ser la misma en
 * todas: el listado, la ficha y el aviso hablan del mismo plazo.
 */
export function timeLeft(expires: Date): string {
  const ms = expires.getTime() - Date.now();

  if (ms <= 0) return 'se retirará en la próxima limpieza';

  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return minutes <= 1 ? 'se retira en menos de un minuto' : `se retira en ${minutes} min`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? 'se retira en 1 hora' : `se retira en ${hours} horas`;

  const days = Math.round(hours / 24);
  return days === 1 ? 'se retira mañana' : `se retira en ${days} días`;
}
