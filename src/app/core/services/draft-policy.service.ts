import { Injectable, inject } from '@angular/core';

import { SurveyAnswer } from '../models/entities.model';
import { SETTING_KEYS, SettingsRepository } from '../repositories/settings.repository';
import { SurveyAnswerRepository } from '../repositories/survey-answer.repository';
import { AuthService } from './auth.service';
import { BinaryStorageService } from './binary-storage.service';

/** Modos del ajuste de borradores. */
export const DRAFT_MODE = {
  /** Las actividades a medias se conservan y se limpian por tiempo. */
  ENABLED: 'enabled',
  /** Se descartan al salir del formulario sin guardar. */
  DISABLED: 'disabled',
} as const;

/** Horas que sobrevive un borrador cuando el usuario no configuró otra cosa. */
const DEFAULT_DRAFT_HOURS = 12;

/**
 * Qué pasa con una actividad que se abrió pero nunca se guardó.
 *
 * ## Por qué existe
 *
 * Los campos se persisten solos —eso no es negociable: las filas de
 * MasterDetail y las fotos necesitan una actividad de la cual colgar—, así que
 * **la actividad existe en la base desde que se abre el formulario**, haya o no
 * pulsado Guardar el usuario.
 *
 * Eso deja dos comportamientos legítimos, y cuál se quiere depende de cómo
 * trabaje cada persona:
 *
 * - **Modo borrador activado** (por defecto): la actividad a medias queda en la
 *   lista marcada como borrador y se limpia sola pasadas las horas
 *   configuradas. Nadie pierde trabajo por cerrar la pestaña.
 * - **Modo borrador desactivado**: se comporta como un formulario clásico — si
 *   no se guarda, no queda nada. El autoguardado sigue funcionando igual; lo
 *   que cambia es que al salir se descarta.
 *
 * ## Qué nunca se descarta
 *
 * Solo las actividades con `eraser = 1`, que son las creadas aquí y nunca
 * guardadas. Las que bajan del servidor entran con `eraser = 0`, así que una
 * actividad asignada desde la plataforma **no puede perderse** por esta vía
 * aunque el usuario entre y salga sin tocar nada.
 *
 * ## Por qué es un ajuste por usuario
 *
 * En el móvil vivía en una tabla global y produjo un problema real: quien
 * desactivaba los borradores se lo aplicaba a cualquier otra cuenta que
 * iniciara sesión después en el mismo equipo, y esa persona perdía actividades
 * por una preferencia que nunca eligió. Aquí va a nombre de la cuenta.
 */
@Injectable({ providedIn: 'root' })
export class DraftPolicyService {
  private readonly settings = inject(SettingsRepository);
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly binaries = inject(BinaryStorageService);
  private readonly auth = inject(AuthService);

  private get userId(): string {
    return this.auth.currentUser()?.UserID ?? '';
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Preferencia
  // ───────────────────────────────────────────────────────────────────────────

  /** ¿Están desactivados los borradores? (o sea: descartar al salir sin guardar) */
  async isDisabled(): Promise<boolean> {
    const value = await this.settings.getUserSetting(
      SETTING_KEYS.DRAFT_MODE,
      this.userId,
      DRAFT_MODE.ENABLED,
    );
    return value === DRAFT_MODE.DISABLED;
  }

  async setDisabled(disabled: boolean): Promise<void> {
    await this.settings.setUserSetting(
      SETTING_KEYS.DRAFT_MODE,
      this.userId,
      disabled ? DRAFT_MODE.DISABLED : DRAFT_MODE.ENABLED,
    );
  }

  /** Horas de vida de un borrador antes de limpiarse solo. */
  async draftHours(): Promise<number> {
    const hours = await this.settings.getNumber(
      SETTING_KEYS.DRAFT_HOURS,
      this.userId,
      DEFAULT_DRAFT_HOURS,
    );
    return hours > 0 ? hours : DEFAULT_DRAFT_HOURS;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Descarte
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * ¿Hay que descartar esta actividad al salir del formulario?
   *
   * Solo si los borradores están desactivados **y** sigue siendo un borrador.
   * Después de guardar, `eraser` queda en 0 y esto responde `false`, así que el
   * camino normal —diligenciar, guardar, salir— nunca pregunta nada.
   */
  async shouldDiscardOnExit(guid: string): Promise<boolean> {
    if (!guid) return false;
    if (!(await this.isDisabled())) return false;

    const answer = await this.answers.findByGuid(guid);
    return answer?.eraser === 1;
  }

  /**
   * Descarta un borrador y, en cascada, los borradores que él creó.
   *
   * Los hijos son actividades de formularios vinculados. Los que ya se guardaron
   * no se tocan: son trabajo terminado que casualmente nació desde aquí.
   *
   * @returns cuántas actividades se eliminaron.
   */
  async discard(guid: string): Promise<number> {
    if (!guid) return 0;

    const userId = this.userId;
    let removed = 0;

    const children = await this.answers.findDraftChildren(userId, guid);
    for (const child of children) {
      if (await this.drop(child)) removed++;
    }

    const answer = await this.answers.findByGuid(guid);
    if (answer && (await this.drop(answer))) removed++;

    return removed;
  }

  /**
   * Borra un borrador con todo lo que colgaba de él.
   *
   * Las fotos, firmas y grabaciones se van con la actividad. Sin esto, un
   * borrador descartado deja su contenido en la base local sin nada que vuelva a
   * nombrarlo: no aparece en ninguna pantalla, no se sube a ningún sitio y
   * ocupa la cuota del navegador hasta que se borren los datos del sitio.
   *
   * @returns true si había algo que borrar.
   */
  private async drop(answer: SurveyAnswer): Promise<boolean> {
    if (answer.ID == null) return false;

    await this.binaries.removeByAnswer(answer.GUID);
    await this.answers.delete(answer.ID);
    return true;
  }

  /**
   * Barre los borradores que quedaron huérfanos.
   *
   * Si el navegador se cierra de golpe, el descarte al salir nunca corre y el
   * borrador queda en la lista — justo lo que el usuario pidió no ver. Esto se
   * ejecuta al entrar al listado de actividades.
   *
   * No hace nada con los borradores activados: allí son legítimos y los limpia
   * [purgeExpired] por tiempo.
   *
   * @param exceptGuid Actividad abierta en este momento, que no se toca.
   */
  async cleanupOrphans(exceptGuid?: string): Promise<number> {
    if (!(await this.isDisabled())) return 0;

    const drafts = await this.answers.findDrafts(this.userId);
    let removed = 0;

    for (const draft of drafts) {
      if (exceptGuid && draft.GUID === exceptGuid) continue;
      if (await this.drop(draft)) removed++;
    }

    return removed;
  }

  /**
   * Elimina los borradores que superaron su tiempo de vida.
   *
   * Se cuenta desde `CreatedOn`, no desde la última edición: un borrador que se
   * retoca cada rato pero nunca se guarda seguiría acumulándose para siempre si
   * el reloj se reiniciara con cada cambio.
   */
  async purgeExpired(): Promise<number> {
    const hours = await this.draftHours();
    const drafts = await this.answers.findDrafts(this.userId);
    const limit = hours * 60 * 60 * 1000;
    const now = Date.now();

    let removed = 0;

    for (const draft of drafts) {
      if (draft.ID == null) continue;

      const created = Date.parse(draft.CreatedOn ?? '');
      if (!Number.isFinite(created)) continue;
      if (now - created < limit) continue;

      if (await this.drop(draft)) removed++;
    }

    return removed;
  }

  /** ¿Cuándo caduca este borrador? `null` si no es borrador o no se sabe. */
  async expiresAt(answer: Pick<SurveyAnswer, 'eraser' | 'CreatedOn'>): Promise<Date | null> {
    if (answer.eraser !== 1) return null;

    const created = Date.parse(answer.CreatedOn ?? '');
    if (!Number.isFinite(created)) return null;

    const hours = await this.draftHours();
    return new Date(created + hours * 60 * 60 * 1000);
  }
}

/**
 * Cuánto falta para una fecha, en horas y minutos.
 *
 * Con precisión de minuto y no «en 3 horas» redondeado: un borrador se pierde
 * de verdad, y quien lo mira necesita saber si le da tiempo a terminarlo ahora
 * o si puede dejarlo para después de comer. La diferencia entre «3 h» y «3 h
 * 55 min» es exactamente esa decisión.
 *
 * Devuelve solo la cantidad —«3 h 25 min»— para que cada sitio la meta en su
 * propia frase.
 */
export function cuantoFalta(fecha: Date | null): string {
  if (!fecha) return '';

  const ms = fecha.getTime() - Date.now();
  if (ms <= 0) return 'menos de un minuto';

  const minutos = Math.floor(ms / 60_000);

  if (minutos < 60) return minutos <= 1 ? 'menos de un minuto' : `${minutos} min`;

  const horas = Math.floor(minutos / 60);
  const sueltos = minutos % 60;

  if (horas < 24) return sueltos ? `${horas} h ${sueltos} min` : `${horas} h`;

  const dias = Math.floor(horas / 24);
  const restantes = horas % 24;

  const cuenta = dias === 1 ? '1 día' : `${dias} días`;
  return restantes ? `${cuenta} ${restantes} h` : cuenta;
}
