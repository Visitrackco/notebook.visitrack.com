/**
 * La familia de una actividad, para el motor de flujos.
 *
 * Una actividad hija —la que nace de un campo vinculado— puede mirar a su
 * padre, y el padre puede mirar y tocar a cada hijo. El motor no sabe nada de
 * padres ni de hijos: le llegan como valores más, con `PADRE:` y
 * `HIJO:VINCULADO:` delante, igual que una fila ve el formulario de arriba
 * con `FORMULARIO:`. Aquí se arma eso desde lo que hay en IndexedDB, y aquí se
 * ejecutan los encargos que escriben en un hijo.
 *
 * Lo que se mira es lo que hay **en este navegador**: padre e hijo viven en la
 * misma base local, como hoy. Lo que otro aparato cambie llega con la
 * sincronización y se ve al abrir.
 */
import { Injectable, inject } from '@angular/core';

import { Survey, SurveyAnswer } from '../models/entities.model';
import { SurveyRepository } from '../repositories/entity.repositories';
import { SurveyAnswerRepository } from '../repositories/survey-answer.repository';
import { ActivityService } from '../services/activity.service';
import { Campo, Encargo, EncargoDeHijo, PREFIJO_HIJO, PREFIJO_PADRE } from './flujo-modelo';
import { Injector } from '@angular/core';
import { FlujoSinPantallaService } from './flujo-sin-pantalla.service';
import { FormField, parseAnswerFields, parseQuestions } from './form-schema';

export interface LoDeFuera {
  valores: Record<string, unknown>;
  campos: Record<string, Campo>;
}

@Injectable({ providedIn: 'root' })
export class ParientesService {
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly surveys = inject(SurveyRepository);
  private readonly activities = inject(ActivityService);
  private readonly injector = inject(Injector);

  /**
   * Cómo están los hijos ahora, en una línea: qué hija cuelga de cada
   * vinculado, en qué estado, si se guardó y cuándo se tocó. Se compara con
   * `HijosVistos` para saber si algo cambió desde que el padre los miró.
   */
  async huellaDeHijos(answer: SurveyAnswer, survey: Survey): Promise<string> {
    const vinculados = camposPlanos(survey).filter((f) => esVinculado(f.fty));
    if (!vinculados.length) return '';

    const respuestas = parseAnswerFields(answer.Fields);
    const partes: string[] = [];

    for (const v of vinculados) {
      const apiId = (v.apiId ?? '').toString().trim() || v.id;
      const guardado = respuestas.find((r) => r.id === v.id);
      const gui = String((guardado?.val as { gui?: unknown })?.gui ?? '').trim();
      const hijo = gui ? await this.answers.findByGuid(gui) : null;

      // Con lo respondido dentro (resumido): un hijo que cambia un campo
      // mientras se diligencia también cuenta, porque el padre puede estar
      // mirando ese campo.
      partes.push(
        hijo
          ? `${apiId}=${gui}|${hijo.Status ?? ''}|${Number(hijo.isSaved ?? 0)}|${hijo.IsDelete ?? ''}|${resumen(hijo.Fields)}`
          : `${apiId}=`,
      );
    }

    return partes.join(';');
  }

  /** Apunta en el padre cómo están sus hijos ahora mismo. */
  async apuntarHijosVistos(answer: SurveyAnswer, survey: Survey): Promise<void> {
    if (answer.ID == null) return;
    const huella = await this.huellaDeHijos(answer, survey);
    if (huella === String(answer.HijosVistos ?? '')) return;
    await this.answers.update(answer.ID, { HijosVistos: huella });
  }

  /**
   * Un hijo acaba de guardarse: el padre se entera **sin abrirse**.
   *
   * Se monta el motor del padre a ciegas —sin pantalla— con su flujo, lo de
   * su familia y su timer, corre el momento «cuando cambia un hijo», y lo
   * que decidió se escribe en la actividad: los campos que una regla dejó,
   * el estado que pidió, si se puede volver a entrar, el timer, y lo que
   * pidió sobre otros hijos. Y se apunta que los hijos ya se vieron, para
   * que abrir el padre después no lo repita.
   *
   * Sin reglas de ese momento no se monta nada: solo se apunta la huella.
   */
  async avisarAlPadre(hijo: SurveyAnswer): Promise<void> {
    const guid = String(hijo.ParentGUID ?? '').trim();
    if (!guid) return;

    const padre = await this.answers.findByGuid(guid);
    if (!padre || padre.ID == null) return;

    const survey = await this.surveys.findBySurveyId(String(padre.SurveyID));
    if (!survey) return;

    const huella = await this.huellaDeHijos(padre, survey);

    // Nada cambió desde la última vez que el padre miró: no hay a qué
    // reaccionar. Es también lo que corta el ida y vuelta cuando el padre
    // le escribe al hijo y eso vuelve a avisarle.
    if (huella === String(padre.HijosVistos ?? '')) return;

    // Se evalúa sin pantalla y se hace todo lo que decida; la huella queda
    // apuntada en la misma escritura. Sin reglas de ese momento solo se
    // apunta la huella.
    try {
      const salida = await this.injector.get(FlujoSinPantallaService).evaluar(padre, 'hijo', { HijosVistos: huella });
      if (!salida) await this.answers.update(padre.ID, { HijosVistos: huella });
    } catch (error) {
      console.warn('[flujo] el padre no pudo reaccionar al hijo', error);
    }
  }

  /**
   * Lo que el flujo de esta actividad puede mirar de su familia.
   *
   * Del padre: todos sus campos y su estado. De cada hijo: si existe, si ya se
   * guardó, su estado y sus campos. Un hijo que todavía no se creó sale con
   * `@existe` en «No» y nada más, que es lo que una regla necesita para decir
   * «termina primero la orden».
   */
  async deFuera(answer: SurveyAnswer, survey: Survey): Promise<LoDeFuera> {
    const salida: LoDeFuera = { valores: {}, campos: {} };

    try {
      await this.delPadre(answer, salida);
    } catch (error) {
      console.warn('[flujo] no se pudo leer el padre', error);
    }

    try {
      await this.deLosHijos(answer, survey, salida);
    } catch (error) {
      console.warn('[flujo] no se pudieron leer los hijos', error);
    }

    return salida;
  }

  private async delPadre(answer: SurveyAnswer, salida: LoDeFuera): Promise<void> {
    const guid = String(answer.ParentGUID ?? '').trim();
    if (!guid) return;

    const padre = await this.answers.findByGuid(guid);
    if (!padre) return;

    const survey = await this.surveys.findBySurveyId(String(padre.SurveyID));
    this.volcar(padre, survey, PREFIJO_PADRE, salida);
  }

  private async deLosHijos(answer: SurveyAnswer, survey: Survey, salida: LoDeFuera): Promise<void> {
    const vinculados = camposPlanos(survey).filter((f) => esVinculado(f.fty));
    if (!vinculados.length) return;

    const respuestas = parseAnswerFields(answer.Fields);

    for (const v of vinculados) {
      const apiId = (v.apiId ?? '').toString().trim() || v.id;
      const prefijo = `${PREFIJO_HIJO}${apiId}`;

      const guardado = respuestas.find((r) => r.id === v.id);
      const gui = String((guardado?.val as { gui?: unknown })?.gui ?? '').trim();
      const hijo = gui ? await this.answers.findByGuid(gui) : null;

      salida.valores[`${prefijo}@existe`] = hijo ? 'Sí' : 'No';
      salida.campos[`${prefijo}@existe`] = { apiId: `${prefijo}@existe`, fty: 'text' };
      salida.valores[`${prefijo}@guardado`] = hijo && Number(hijo.isSaved ?? 0) !== 0 ? 'Sí' : 'No';
      salida.campos[`${prefijo}@guardado`] = { apiId: `${prefijo}@guardado`, fty: 'text' };

      if (!hijo) continue;

      const suyo = await this.surveys.findBySurveyId(String(hijo.SurveyID));
      this.volcar(hijo, suyo, `${prefijo}:`, salida);
    }
  }

  /** Los campos y el estado de una actividad, con el prefijo delante. */
  private volcar(actividad: SurveyAnswer, survey: Survey | null, prefijo: string, salida: LoDeFuera): void {
    salida.valores[`${prefijo}estado`] = String(actividad.Status ?? '');
    salida.campos[`${prefijo}estado`] = { apiId: `${prefijo}estado`, fty: 'estado' };

    if (!survey) return;

    const respuestas = new Map(parseAnswerFields(actividad.Fields).map((r) => [r.id, r]));

    for (const f of camposPlanos(survey)) {
      const apiId = (f.apiId ?? '').toString().trim() || f.id;
      const llave = `${prefijo}${apiId}`;
      const respuesta = respuestas.get(f.id);

      salida.campos[llave] = { apiId: llave, id: f.id, fty: f.fty, opt: f.opt ?? [] } as Campo;
      if (respuesta !== undefined) salida.valores[llave] = respuesta.val;
    }
  }

  /**
   * Ejecuta lo que el flujo del padre pidió sobre sus hijos.
   *
   * Escribir un campo y cambiar el estado, en la actividad hija que cuelga
   * del campo vinculado. Sin hijo todavía no hay dónde escribir, y el encargo
   * se descarta sin ruido: la regla se volverá a evaluar cuando el hijo
   * exista, porque crearlo cambia el campo vinculado.
   */
  async ejecutar(answer: SurveyAnswer, survey: Survey, encargos: readonly Encargo[]): Promise<boolean> {
    const deHijos = encargos.filter((e) => e.que === 'escribir-en-hijo' || e.que === 'cambiar-estado-hijo');
    if (!deHijos.length) return false;

    const respuestas = parseAnswerFields(answer.Fields);
    const vinculados = camposPlanos(survey).filter((f) => esVinculado(f.fty));
    let tocado = false;

    for (const encargo of deHijos) {
      const pedido = encargo.valor as EncargoDeHijo;
      if (!pedido?.vinculado) continue;

      const campoVinculado = vinculados.find(
        (f) => ((f.apiId ?? '').toString().trim() || f.id) === pedido.vinculado,
      );
      if (!campoVinculado) continue;

      const guardado = respuestas.find((r) => r.id === campoVinculado.id);
      const gui = String((guardado?.val as { gui?: unknown })?.gui ?? '').trim();
      if (!gui) continue;

      const hijo = await this.answers.findByGuid(gui);
      if (!hijo || hijo.ID == null) continue;

      try {
        if (encargo.que === 'cambiar-estado-hijo') {
          const estado = String(pedido.estado ?? '').trim();
          if (!estado || String(hijo.Status ?? '') === estado) continue;

          await this.answers.update(hijo.ID, { Status: estado, UpdatedOn: new Date().toISOString() });
          tocado = true;
          continue;
        }

        const suyo = await this.surveys.findBySurveyId(String(hijo.SurveyID));
        if (!suyo) continue;

        const campo = camposPlanos(suyo).find(
          (f) => ((f.apiId ?? '').toString().trim() || f.id) === pedido.campo,
        );
        if (!campo) continue;

        const fields = parseAnswerFields(hijo.Fields);
        const existente = fields.find((r) => r.id === campo.id);
        const valor = comoLoGuarda(campo, pedido.valor);

        if (existente) {
          if (JSON.stringify(existente.val) === JSON.stringify(valor)) continue;
          existente.val = valor as never;
        } else {
          fields.push({ id: campo.id, val: valor as never, fty: campo.fty, hid: !!campo.hid });
        }

        await this.answers.update(hijo.ID, {
          Fields: JSON.stringify(fields),
          UpdatedOn: new Date().toISOString(),
        });
        tocado = true;
      } catch (error) {
        console.warn('[flujo] no se pudo escribir en el hijo', error);
      }
    }

    if (tocado) this.activities.notifyChanged();
    return tocado;
  }
}

/** Todos los campos del formulario, de todas las páginas. */
function camposPlanos(survey: Survey): FormField[] {
  return parseQuestions(survey.JSONQuestion).flatMap((p) => p.fie ?? []);
}

/**
 * El valor con la forma en que ese campo lo guarda.
 *
 * Un radio o un desplegable guardan `{id, txt}`; si el texto coincide con una
 * opción se guarda la opción entera, y si no, lo escrito como texto. Un
 * número se guarda como número. El resto, tal cual.
 */
function comoLoGuarda(campo: FormField, valor: unknown): unknown {
  const texto = String(valor ?? '').trim();
  const fty = (campo.fty ?? '').toLowerCase();

  if (fty === 'radio' || fty === 'dropdownlist') {
    const opcion = (campo.opt ?? []).find(
      (o) => String(o.txt ?? '').trim().toLowerCase() === texto.toLowerCase() || String(o.id) === texto,
    );
    return opcion ? { id: opcion.id, txt: opcion.txt } : { id: '', txt: texto };
  }

  if (fty === 'numeric') {
    const n = Number(texto);
    return Number.isFinite(n) ? n : texto;
  }

  return texto;
}

/**
 * ¿Es un campo vinculado (el que crea una actividad hija)? En el esquema el
 * tipo es `form`; `linkedform` es como lo llaman algunos catálogos.
 */
export function esVinculado(fty: unknown): boolean {
  const t = String(fty ?? '').toLowerCase();
  return t === 'form' || t === 'linkedform';
}

/**
 * Un resumen corto de lo respondido, para la huella de los hijos.
 *
 * No hace falta guardar las respuestas enteras del hijo en el padre: basta
 * con algo que cambie cuando cambien. Es el hash de siempre (djb2) sobre el
 * JSON, en base 36 para que quepa en una palabra.
 */
function resumen(fields: unknown): string {
  const texto = String(fields ?? '');
  let h = 5381;
  for (let i = 0; i < texto.length; i++) h = ((h * 33) ^ texto.charCodeAt(i)) >>> 0;
  return `${texto.length}:${h.toString(36)}`;
}
