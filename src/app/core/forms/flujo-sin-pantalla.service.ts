/**
 * Evaluar el flujo de una actividad **sin abrirla**, y hacer lo que decida.
 *
 * Dos cosas pasan sin que nadie tenga la actividad delante: un hijo cambia y
 * el padre tiene que reaccionar (momento `hijo`), y el timer de una actividad
 * llega a un hito con la actividad cerrada (momento `timer`). Las dos montan
 * el motor a ciegas —con el flujo, las respuestas, la familia y el timer de la
 * actividad—, corren el momento, y escriben en la actividad lo que salió:
 * campos, estado, si se puede volver a entrar, el timer; y ejecutan **todo**
 * lo que pidió con `EncargosDelFlujoService`, guardar ahora mismo incluido.
 *
 * Aquí vive lo que las dos comparten; quién dispara cada momento está en
 * `ParientesService` y en `TimerGlobalService`.
 */
import { Injectable, Injector, inject } from '@angular/core';

import { ANSWER_STATE } from '../models/activity.model';
import { SurveyAnswer } from '../models/entities.model';
import { DispatchStatusRepository, SurveyRepository } from '../repositories/entity.repositories';
import { SurveyAnswerRepository } from '../repositories/survey-answer.repository';
import { ActivityService } from '../services/activity.service';
import { ActivityInheritsService } from './activity-inherits.service';
import { EncargosDelFlujoService } from './encargos.service';
import { EstadoDelTimer, Flujo, Momento } from './flujo-modelo';
import { FlujoService } from './flujo.service';
import { FormEngine, leerTimer } from './form-engine';
import { ParientesService } from './parientes.service';
import { TimerGlobalService } from './timer-global.service';

export interface LoQueDecidio {
  /** Qué cambió en la actividad: las claves escritas. */
  cambios: string[];
  /** El timer con el que quedó. */
  timer: EstadoDelTimer | null;
  /** Cuántos minutos faltan para el siguiente hito, si hay timer corriendo. */
  siguienteHito: number | null;
}

@Injectable({ providedIn: 'root' })
export class FlujoSinPantallaService {
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly surveys = inject(SurveyRepository);
  private readonly estados = inject(DispatchStatusRepository);
  private readonly activities = inject(ActivityService);
  private readonly flujos = inject(FlujoService);
  private readonly inherits = inject(ActivityInheritsService);
  private readonly injector = inject(Injector);

  /** Pedidos tarde: ellos dependen de esto y esto de ellos. */
  private parientes(): ParientesService {
    return this.injector.get(ParientesService);
  }

  private encargos(): EncargosDelFlujoService {
    return this.injector.get(EncargosDelFlujoService);
  }

  private timers(): TimerGlobalService {
    return this.injector.get(TimerGlobalService);
  }

  /** El flujo de la actividad, si tiene reglas de ese momento (o timers). */
  async flujoQueCorre(answer: SurveyAnswer, momento: Momento): Promise<Flujo | null> {
    const flujo = await this.flujos.paraFormulario(answer.SurveyID);
    if (!flujo) return null;

    const tiene = (flujo.reglas ?? []).some((r) => r.activa !== false && r.cuando?.includes(momento));
    return tiene ? flujo : null;
  }

  /**
   * Corre un momento sobre la actividad y escribe lo que decidió.
   *
   * `null` si no había nada que correr (sin flujo, o sin reglas del momento).
   */
  async evaluar(answer: SurveyAnswer, momento: 'hijo' | 'timer', extra: Partial<SurveyAnswer> = {}): Promise<LoQueDecidio | null> {
    if (answer.ID == null) return null;

    const flujo = await this.flujoQueCorre(answer, momento);
    if (!flujo) return null;

    const survey = await this.surveys.findBySurveyId(String(answer.SurveyID));
    if (!survey) return null;

    const inherits = await this.inherits.forAnswer(answer, survey.JSONQuestion);
    const deFuera = await this.parientes().deFuera(answer, survey);

    const engine = new FormEngine({
      questions: survey.JSONQuestion,
      answers: answer.Fields,
      inherits,
      flujo,
      primeraVez: false,
      valoresDeFuera: deFuera.valores,
      camposDeFuera: deFuera.campos,
      timer: leerTimer(answer.Timer),
    });

    engine.estadoActividad.set(String(answer.Status ?? ''));
    engine.otroTimerCorriendo = this.timers().otroCorre(answer.GUID);

    if (momento === 'hijo') engine.correrHijo();
    else engine.correrTimer();

    /*
     * Primero lo que es **estado** de la actividad: los campos que una regla
     * dejó, si se puede volver a entrar, el timer. Con eso escrito, lo que
     * se guarde y se envíe después ya lo lleva.
     */
    const cambios: Partial<SurveyAnswer> = { ...extra };

    const fields = JSON.stringify(engine.toAnswerFields());
    if (fields !== String(answer.Fields ?? '')) cambios.Fields = fields;

    const leyendas = engine.entradaBloqueada();
    if (leyendas.length) cambios.NoEntrar = leyendas.join(' · ');
    else if (engine.entradaPermitida() && String(answer.NoEntrar ?? '').trim()) cambios.NoEntrar = '';

    const timer = engine.timer();
    const timerTexto = timer ? JSON.stringify(timer) : '';
    if (timerTexto !== String(answer.Timer ?? '')) cambios.Timer = timerTexto;

    if (Object.keys(cambios).length > Object.keys(extra).length) cambios.UpdatedOn = new Date().toISOString();

    await this.answers.update(answer.ID, cambios);
    this.timers().apuntar(answer.GUID, timer);

    /*
     * Y los encargos **en el orden en que se escribieron las acciones**, uno
     * detrás de otro y esperando a cada uno.
     *
     * Es lo que hace que «cambiar el estado y guardar» guarde con el estado
     * ya puesto, y que «guardar y cambiar el estado» guarde primero. Lo que
     * no es ni estado ni guardar —crear actividades, consignas, correos,
     * avisos, hijos— corre junto, en el sitio del primero de ellos. Si el
     * estado cambia **después** de haber guardado, se vuelve a enviar para
     * que arriba quede el estado nuevo.
     */
    const actualizado: SurveyAnswer = { ...answer, ...cambios };
    const encargos = this.encargos();
    let restoHecho = false;
    let guardado = false;
    let estadoTrasGuardar = false;

    for (const encargo of engine.encargosDe(momento)) {
      if (encargo.que === 'cambiar-estado') {
        const estado = String(encargo.valor ?? '').trim();
        if (!estado || estado === String(actualizado.Status ?? '')) continue;
        if (!(await this.estados.findByDispatchId(Number(estado)))) continue;

        await this.answers.update(answer.ID, { Status: estado, UpdatedOn: new Date().toISOString() });
        actualizado.Status = estado;
        cambios.Status = estado;
        if (guardado) estadoTrasGuardar = true;
        continue;
      }

      if (encargo.que === 'guardar-actividad') {
        await encargos.guardarSinPantalla(engine, actualizado);
        guardado = true;
        estadoTrasGuardar = false;
        continue;
      }

      if (!restoHecho) {
        restoHecho = true;
        await encargos.ejecutarTodo(engine, actualizado, survey, { momento });
      }
    }

    engine.guardarAhora.set(false);

    /*
     * Un estado nuevo **sube**, aunque la regla no diga «guardar».
     *
     * Cambiar el estado sin subirlo dejaba el padre con un estado que solo
     * existía en este navegador. Si la actividad ya se había guardado alguna
     * vez, el cambio se envía como la actualización de siempre; una que aún
     * no se ha guardado no se sube por un estado: eso lo decide quien la
     * guarde.
     */
    const estadoCambio = String(actualizado.Status ?? '') !== String(answer.Status ?? '');
    const yaGuardada = Number(answer.isSaved ?? 0) !== ANSWER_STATE.UNSAVED;

    if (estadoCambio && yaGuardada && (!guardado || estadoTrasGuardar)) {
      await encargos.guardarSinPantalla(engine, actualizado);
    }

    console.log(`[flujo] ${momento} sin pantalla sobre ${answer.GUID}:`, {
      cambios: Object.keys(cambios),
      timer,
      siguienteHito: engine.siguienteHito(),
      timerRechazado: engine.timerRechazado(),
    });

    this.activities.notifyChanged();

    return { cambios: Object.keys(cambios), timer, siguienteHito: engine.siguienteHito() };
  }
}
