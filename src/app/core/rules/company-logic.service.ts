import { Injectable, inject, signal } from '@angular/core';

import { AnswerField, FormPage, parseAnswerFields } from '../forms/form-schema';
import { resolveCatalogOwnerId } from '../config/company-rules';
import { DispatchStatus, SurveyAnswer } from '../models/entities.model';
import { DispatchStatusRepository, SurveyRepository } from '../repositories/entity.repositories';
import { SurveyAnswerRepository } from '../repositories/survey-answer.repository';
import { AuthService } from '../services/auth.service';
import { Indicator, evaluate } from './brillantex';
import { CRONOGRAMA, FieldWrite, PLANEADOR, PlanConfig, planificar } from './planificador';
import { cubrimientos } from './diamante';
import { BASE_COMPLETADO, elegirEstadoDeCompletada, esDeTrabajo, idsDelFormulario, queLeToca } from './estado-de-completada';
import { STATUS_RULES, statusFor } from './status-rules';

/** Compañías con reglas propias al guardar. */
const BRILLANTEX = 2259;
const DIAMANTE = 2030;

/** El planeador de Brillantex, que no es una inspección sino planificación. */
const PLANEADOR_SURVEY = '16681';

/** Cronograma de ruta de Diamante. */
const CRONOGRAMA_SURVEY = '22814';

/** Los formularios de cubrimientos de Diamante. */
const CUBRIMIENTOS_SURVEYS = [
  '14051', '14319', '14320', '14321', '14322', '14328', '14569', '14329', '14330',
];

/**
 * Las reglas de negocio propias de cada compañía, al guardar.
 *
 * ## Dónde encaja
 *
 * La app móvil ejecuta esto en `formInterface.dart` justo después de guardar,
 * mirando el `CompanyID` de la sesión y el `SurveyID` de la actividad. Aquí es
 * lo mismo, en `commit()` del formulario.
 *
 * ## Cada equipo decide sobre su propia actividad
 *
 * Que la regla exista en los dos clientes **no la ejecuta dos veces**: cada uno
 * la aplica a la actividad que está guardando, que es suya. Lo que hay que
 * cuidar no es la duplicación de efectos sino la **divergencia** — que una
 * copia cambie y la otra no.
 *
 * ## Dos formas, según lo que haga la regla
 *
 * - **Tabla de condiciones** (`status-rules.ts`) para las que solo miran campos
 *   y eligen un estado. Se leen de un vistazo y viajan al servidor el día que
 *   se decida moverlas.
 * - **Código** (`brillantex.ts`) para las que recorren filas, siguen la
 *   definición del formulario y calculan indicadores. Fingir que caben en una
 *   tabla habría producido una tabla ilegible.
 *
 * ## Solo escribe en la actividad local
 *
 * Ninguna llamada a servicios. El estado y los indicadores viajan después con
 * la subida normal, así que aplicarlo desde la web no interfiere con nada de lo
 * que haga un teléfono.
 */
@Injectable({ providedIn: 'root' })
export class CompanyLogicService {
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly auth = inject(AuthService);
  private readonly estados = inject(DispatchStatusRepository);
  private readonly surveys = inject(SurveyRepository);

  /**
   * Lo último que una regla quiso decirle al usuario.
   *
   * Algunas reglas —las de planificación— no solo deciden un estado: avisan de
   * que falta un dato o de que la fecha quedó en el pasado. En la app eso sale
   * como un mensaje al pie; aquí se deja aquí y lo recoge quien guardó, que es
   * el único que sabe dónde mostrarlo.
   */
  readonly message = signal('');

  /**
   * Aplica lo que corresponda a esta actividad recién guardada.
   *
   * @returns el estado que quedó, o `null` si ninguna regla aplicaba.
   */
  async onSaved(
    answer: SurveyAnswer,
    fields: readonly AnswerField[],
    pages: readonly FormPage[] = [],
    incomplete = false,
  ): Promise<string | null> {
    const user = this.auth.currentUser();

    if (!user || answer.ID == null) return null;

    const company = Number(user.CompanyID);
    const survey = String(answer.SurveyID);

    try {
      if (company === BRILLANTEX && survey === PLANEADOR_SURVEY) {
        return await this.runPlan(answer, PLANEADOR, fields);
      }

      if (company === BRILLANTEX) {
        return await this.runBrillantex(answer, survey, fields, pages);
      }

      if (company === DIAMANTE && survey === CRONOGRAMA_SURVEY) {
        return await this.runPlan(answer, CRONOGRAMA, fields);
      }

      if (company === DIAMANTE && CUBRIMIENTOS_SURVEYS.includes(survey)) {
        return await this.runCubrimientos(answer, fields);
      }

      // «Guardar de todos modos» en la app solo pasa por Brillantex y
      // Diamante: las reglas de tabla (Inverpack) esperan al guardado válido.
      if (incomplete) return null;

      return await this.runTable(answer, company, survey, fields);
    } catch (error) {
      // Una regla que falla no puede impedir que la actividad quede guardada:
      // el trabajo del usuario vale más que el estado que le corresponda.
      console.error('[Reglas] no se pudo aplicar la regla de la compañía', error);
      return null;
    }
  }

  // ── Estado de completada ──────────────────────────────────────────────────

  /**
   * El estado de despacho «completado» al guardar sin obligatorios pendientes.
   *
   * Es lo que hace la app en `formInterface.dart` justo antes de los procesos
   * de cada compañía:
   *
   * - **Cuál**: el de completada **del formulario** si tiene estados propios
   *   (`JSONStatuses`), y si no, el de la compañía. Ver
   *   `estado-de-completada.ts`: un formulario con lista propia nunca recibe
   *   el de la compañía.
   * - **Cuándo**: si la actividad no tiene estado (o el suyo no está en el
   *   catálogo, o es de base «Completado») lo recibe, salvo que ya tuviera
   *   uno, que se conserva. Brillantex y 3502 pasan a completada aunque ya
   *   tuvieran otro. El Planeador de Brillantex no se toca.
   *
   * Va antes de [onSaved], igual que en la app: la regla de la compañía
   * (Inverpack, por ejemplo) decide después y manda sobre esto.
   *
   * @returns el estado que quedó, o `null` si no cambió.
   */
  async completarEstado(answer: SurveyAnswer): Promise<string | null> {
    if (answer.ID == null) return null;

    try {
      const decision = await this.estadoAlCompletar(answer);
      if (!decision) return null;

      const { actual, nuevo } = decision;
      if (!nuevo || nuevo === actual) return null;

      await this.answers.update(answer.ID, { Status: nuevo, UpdatedOn: new Date().toISOString() });
      this.log('Estado de completada', nuevo, actual ? `antes ${actual}` : 'no tenía estado');
      return nuevo;
    } catch (error) {
      console.error('[Reglas] no se pudo poner el estado de completada', error);
      return null;
    }
  }

  /**
   * Con qué estado quedaría la actividad al completarse, **sin escribirlo**.
   *
   * Lo usa también el guardado para que el flujo de «al guardar» evalúe ya
   * con ese estado: una regla «si el estado es PAGO COMPLETO, manda el
   * correo» tiene que cumplirse en el mismo guardado que lo pone.
   *
   * `nuevo` es `null` cuando el guardado no toca el estado.
   */
  /** GUID → el estado con que se abrió la actividad. Lo anota el formulario al montarse. */
  private readonly estadosAlAbrir = new Map<string, string>();

  /** Anota con qué estado se abre la actividad (ver [estadoAlCompletar]). */
  anotarEstadoAlAbrir(answer: SurveyAnswer): void {
    if (answer?.GUID) this.estadosAlAbrir.set(answer.GUID, String(answer.Status ?? '').trim());
  }

  async estadoAlCompletar(answer: SurveyAnswer): Promise<{ actual: string; nuevo: string | null } | null> {
    const user = this.auth.currentUser();
    if (!user) return null;

    try {
      const catalogo = await this.estados.findByUser(resolveCatalogOwnerId(user));
      const fresh = (await this.answers.findByGuid(answer.GUID)) ?? answer;
      const actual = String(fresh.Status ?? '').trim();

      const survey = await this.surveys.findBySurveyId(String(fresh.SurveyID));
      const completada = elegirEstadoDeCompletada(catalogo, idsDelFormulario(survey?.JSONStatuses));

      // Como `getDispatchStatusAnswer` en la app: el estado se busca entre
      // los del propio usuario, no en el catálogo compartido.
      const propios =
        resolveCatalogOwnerId(user) === Number(user.UserID)
          ? catalogo
          : await this.estados.findByUser(Number(user.UserID));

      const nuevo = queLeToca({
        actual,
        cerrado: this.tieneEstadoCerrado(actual, propios),
        meta: completada ? String(completada.DispatchID) : null,
        compania: Number(user.CompanyID),
        formulario: String(fresh.SurveyID),
        deTrabajo: esDeTrabajo(propios.find((s) => String(s.DispatchID) === actual)?.BaseStatusID),
        // Sin saber con qué se abrió, se supone que sí se eligió: se conserva.
        elegidoAlEditar: !this.estadosAlAbrir.has(fresh.GUID) || this.estadosAlAbrir.get(fresh.GUID) !== actual,
      });

      return { actual, nuevo };
    } catch (error) {
      console.error('[Reglas] no se pudo calcular el estado de completada', error);
      return null;
    }
  }

  /** `getDispatchStatusAnswer` de la app: ¿tiene un estado conocido y no de base «Completado»? */
  private tieneEstadoCerrado(actual: string, catalogo: readonly DispatchStatus[]): boolean {
    const id = Number(actual);
    if (!actual || !Number.isFinite(id) || id < 0) return false;

    const estado = catalogo.find((s) => Number(s.DispatchID) === id);
    if (!estado) return false;

    return Number(estado.BaseStatusID) !== BASE_COMPLETADO;
  }

  // ── Reglas declarativas ───────────────────────────────────────────────────

  private async runTable(
    answer: SurveyAnswer,
    company: number,
    survey: string,
    fields: readonly AnswerField[],
  ): Promise<string | null> {
    const decision = statusFor(STATUS_RULES, company, survey, fields);

    if (!decision) return null;

    await this.answers.update(answer.ID!, {
      Status: decision.status,
      UpdatedOn: new Date().toISOString(),
    });

    this.log(decision.rule, decision.status, decision.reason);

    return decision.status;
  }

  // ── Brillantex ────────────────────────────────────────────────────────────

  private async runBrillantex(
    answer: SurveyAnswer,
    survey: string,
    fields: readonly AnswerField[],
    pages: readonly FormPage[],
  ): Promise<string | null> {
    // Los seis formularios con regla. El Planeador queda fuera a propósito:
    // no decide un estado sino el flujo de la pantalla. Ver el documento.
    const outcome = evaluate(survey, fields, pages);

    if (!outcome) return null;

    const changes: Partial<SurveyAnswer> = {
      Status: outcome.status,
      UpdatedOn: new Date().toISOString(),
    };

    if (outcome.completed) changes.CompletedOn = new Date().toISOString();

    if (outcome.indicators.length > 0) {
      // Se relee la actividad: `flush()` acaba de escribir sus campos, y el
      // objeto que llegó aquí puede ser anterior a esa escritura.
      const fresh = (await this.answers.findByGuid(answer.GUID)) ?? answer;

      changes.Fields = this.withValues(fresh.Fields, outcome.indicators);
      changes.Titles = this.withTitles(fresh.Titles, outcome.indicators);
    }

    await this.answers.update(answer.ID!, changes);

    this.log(outcome.label, outcome.status, outcome.reason);

    return outcome.status;
  }

  // ── Planificación y cubrimientos ──────────────────────────────────────────

  /**
   * Cronograma de ruta y Planeador.
   *
   * Además del estado, estas **escriben campos**: habilitan los formularios
   * vinculados de los motivos elegidos. Y pueden tener algo que decirle al
   * usuario, que es lo que va en [message].
   */
  private async runPlan(
    answer: SurveyAnswer,
    config: PlanConfig,
    fields: readonly AnswerField[],
  ): Promise<string | null> {
    const outcome = planificar(config, fields, String(answer.Status ?? ''));

    this.message.set(outcome.message);

    const changes: Partial<SurveyAnswer> = { UpdatedOn: new Date().toISOString() };

    if (outcome.status) changes.Status = outcome.status;
    if (outcome.completed) changes.CompletedOn = new Date().toISOString();

    if (outcome.writes.length > 0) {
      const fresh = (await this.answers.findByGuid(answer.GUID)) ?? answer;

      changes.Fields = this.withFields(fresh.Fields, outcome.writes);
    }

    await this.answers.update(answer.ID!, changes);

    this.log(config.label, outcome.status ?? '(sin cambio)', outcome.reason);

    return outcome.status ?? null;
  }

  /** Cubrimientos de Diamante. */
  private async runCubrimientos(
    answer: SurveyAnswer,
    fields: readonly AnswerField[],
  ): Promise<string | null> {
    const outcome = cubrimientos(fields);

    this.message.set(outcome.message);

    this.log('Diamante · cubrimientos', outcome.status ?? '(sin cambio)', outcome.reason);

    if (!outcome.status) return null;

    await this.answers.update(answer.ID!, {
      Status: outcome.status,
      UpdatedOn: new Date().toISOString(),
      ...(outcome.completed ? { CompletedOn: new Date().toISOString() } : {}),
    });

    return outcome.status;
  }

  /**
   * Escribe campos sueltos entre las respuestas.
   *
   * Es lo que hace `updateFieldSurveyAnswer` en la app: un upsert por
   * identificador, conservando lo demás.
   */
  private withFields(raw: unknown, writes: readonly FieldWrite[]): string {
    const fields = parseAnswerFields(raw).map((entry) => ({ ...entry }));

    for (const write of writes) {
      const at = fields.findIndex((entry) => entry.id === write.id);

      if (at >= 0) fields[at] = { ...fields[at], ...write } as unknown as AnswerField;
      else fields.push(write as unknown as AnswerField);
    }

    return JSON.stringify(fields);
  }

  /**
   * Escribe los indicadores entre las respuestas.
   *
   * Van como campos numéricos visibles, igual que en la app: el formulario los
   * tiene declarados y espera encontrarlos ahí.
   */
  private withValues(raw: unknown, indicators: readonly Indicator[]): string {
    const fields = parseAnswerFields(raw).map((entry) => ({ ...entry }));

    for (const indicator of indicators) {
      const found = fields.findIndex((entry) => entry.id === indicator.id);
      const value = { id: indicator.id, val: indicator.val, fty: 'numeric', hid: false };

      if (found >= 0) fields[found] = { ...fields[found], ...value };
      else fields.push(value as unknown as AnswerField);
    }

    return JSON.stringify(fields);
  }

  /** Y entre los descriptivos, que es lo que se ve en el listado. */
  private withTitles(raw: unknown, indicators: readonly Indicator[]): string {
    let titles: { id?: string; lab?: string; val?: string }[] = [];

    try {
      const parsed = JSON.parse(String(raw ?? '[]'));
      if (Array.isArray(parsed)) titles = parsed;
    } catch {
      titles = [];
    }

    for (const indicator of indicators) {
      const found = titles.findIndex((entry) => entry.id === indicator.id);

      if (found >= 0) titles[found] = { ...titles[found], ...indicator };
      else titles.push({ ...indicator });
    }

    return JSON.stringify(titles);
  }

  /**
   * Deja constancia de qué regla actuó y por qué.
   *
   * En la app, si los identificadores de campo cambian, el `catch` se traga el
   * fallo y la actividad se queda con el estado que tuviera — sin que nadie se
   * entere. Esta línea es lo que permite mirar la consola y ver si la regla
   * sigue encontrando sus campos.
   */
  private log(rule: string, status: string, reason: string): void {
    console.info(`[Reglas] ${rule}: estado ${status} — ${reason}`);
  }
}
