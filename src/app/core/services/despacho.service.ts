import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { BaseRepository } from '../repositories/base.repository';
import { ApiService } from './api.service';
import { NotifyService } from './notify.service';
import { ReassignService } from './reassign.service';

/** Una consigna que pidió una regla y todavía no ha salido. */
export interface DespachoPendiente {
  ID?: number;

  /** La actividad que lo disparó. Hasta que no suba, no se manda. */
  AnswerGUID: string;

  /** Qué se despacha: `otro` crea una actividad nueva; `misma` reasigna esta. */
  Que: string;

  SurveyID: string;
  Destinatario: string;
  EstadoGUID: string;
  Aviso: string;
  Hija: boolean;
  Regla: string;

  /**
   * Cuándo tiene que llegar (`aaaa-mm-dd hh:mm`), en hora local.
   *
   * Vacío es «ya». Se guarda y se manda tal cual: la consigna dice la hora que
   * puso quien configuró la regla, sin convertir husos.
   */
  Programado: string;

  /** 0 pendiente, 1 enviado. Número y no booleano: IndexedDB no indexa booleanos. */
  Enviado: number;

  Intentos: number;
  CreatedOn: string;
}

/** La cola local de consignas por salir. */
@Injectable({ providedIn: 'root' })
export class DespachoRepository extends BaseRepository<DespachoPendiente> {
  protected readonly storeName = 'DespachosFlujo';

  /** Lo que queda por mandar de una actividad. */
  async pendientesDe(answerGuid: string): Promise<DespachoPendiente[]> {
    return this.query({
      index: 'byAnswerGUID',
      range: answerGuid,
      filter: (d) => !d.Enviado,
    });
  }

  /** Todo lo apuntado de una actividad, enviado o no. */
  async todosDe(answerGuid: string): Promise<DespachoPendiente[]> {
    return this.query({ index: 'byAnswerGUID', range: answerGuid });
  }
}

/**
 * Manda las consignas que pidieron las reglas de flujo.
 *
 * ## Cuándo sale una consigna
 *
 * Cuando la actividad que la disparó **ya está en Visitrack con sus archivos
 * confirmados**, no al pulsar guardar. La consigna remite a la actividad de
 * origen, y una que apunta a algo que todavía no existe no le sirve a quien la
 * recibe.
 *
 * ## Por qué se guardan y no se mandan de una
 *
 * Entre guardar y subir puede pasar de todo: quedarse sin conexión, cerrar la
 * pestaña, apagar el equipo. Una consigna que viva en memoria se pierde en
 * cualquiera de esos casos y nadie se entera de que no salió.
 *
 * Es el mismo diseño que en la app, y a propósito: las dos escriben en su cola
 * local, llaman al mismo endpoint y reintentan igual.
 */
@Injectable({ providedIn: 'root' })
export class DespachoService {
  private readonly repo = inject(DespachoRepository);
  private readonly api = inject(ApiService);
  private readonly reasignaciones = inject(ReassignService);
  private readonly notify = inject(NotifyService);

  /** Actividades que se están despachando ahora, para no hacerlo dos veces. */
  private readonly enCurso = new Set<string>();

  /**
   * Apunta una consigna, sin repetir.
   *
   * Guardar la misma actividad dos veces hace que la misma regla pida el mismo
   * despacho otra vez, y no hay que mandar dos consignas iguales.
   */
  async apuntar(
    despacho: Omit<DespachoPendiente, 'ID' | 'Enviado' | 'Intentos' | 'CreatedOn'>,
  ): Promise<void> {
    try {
      const ya = await this.repo.todosDe(despacho.AnswerGUID);

      /*
       * Repetida es la **misma** consigna, con su fecha y su regla.
       *
       * Una regla puede pedir dos despachos a la vez y programarlos distinto
       * —«uno mañana y otro dentro de una semana»—, y comparando solo
       * formulario, destinatario y tipo el segundo se descartaba por parecido.
       */
      const repetido = ya.some(
        (d) =>
          String(d.SurveyID) === String(despacho.SurveyID) &&
          String(d.Destinatario) === String(despacho.Destinatario) &&
          String(d.Que) === String(despacho.Que) &&
          String(d.Programado ?? '') === String(despacho.Programado ?? '') &&
          String(d.Regla ?? '') === String(despacho.Regla ?? ''),
      );

      if (repetido) return;

      await this.repo.put({
        ...despacho,
        Enviado: 0,
        Intentos: 0,
        CreatedOn: new Date().toISOString(),
      });
    } catch (error) {
      console.warn('[despacho] no se pudo apuntar', error);
    }
  }

  /**
   * Manda lo que quede pendiente de una actividad.
   *
   * Nunca lanza. Una consigna que no sale se queda apuntada con un intento más
   * y vuelve a intentarse; lo que no puede es tumbar la subida de la actividad,
   * que es lo importante.
   */
  async enviarPendientes(answerGuid: string): Promise<void> {
    if (!answerGuid || this.enCurso.has(answerGuid)) return;

    this.enCurso.add(answerGuid);

    try {
      for (const despacho of await this.repo.pendientesDe(answerGuid)) {
        /*
         * Una consigna nueva necesita formulario; la reasignación, no —lo que
         * se manda es esta misma actividad—. Sin formulario se saltaría en vez
         * de intentarlo a medias: crearía una actividad rota en Visitrack, y
         * eso lo sufre alguien de verdad.
         */
        if (despacho.Que === 'otro' && !String(despacho.SurveyID ?? '').trim()) {
          console.warn('[despacho] descartado: consigna nueva sin formulario', despacho);
          continue;
        }

        const salio = await this.mandar(answerGuid, despacho);

        await this.repo.put({
          ...despacho,
          Enviado: salio ? 1 : 0,
          Intentos: despacho.Intentos + (salio ? 0 : 1),
        });

        /*
         * Reasignada: la actividad ya es de otra persona en Visitrack, así que
         * se va de este equipo.
         *
         * Y se corta el bucle, aunque queden despachos apuntados: los demás
         * remiten a una actividad que aquí ya no está, y el resto de reglas de
         * esta actividad las resolverá quien la reciba.
         */
        if (salio && despacho.Que === 'misma') {
          await this.reasignaciones.retirarDelEquipo(answerGuid);

          // Y se dice. Una actividad que desaparece del listado sin explicación
          // se lee como un error o como trabajo perdido, no como una regla que
          // hizo lo que tenía que hacer.
          void this.notify.success(
            'Actividad despachada',
            'La regla del formulario la pasó a otra persona, así que ya no está en este equipo.',
          );

          break;
        }

        // Si no salió, se para: seguir con la conexión caída solo suma intentos
        // fallidos. Vuelven todos en la próxima confirmación de subida.
        if (!salio) break;
      }
    } catch (error) {
      console.warn('[despacho] no se pudieron enviar los de', answerGuid, error);
    } finally {
      this.enCurso.delete(answerGuid);
    }
  }

  private async mandar(answerGuid: string, despacho: DespachoPendiente): Promise<boolean> {
    try {
      const res = await firstValueFrom(
        this.api.put<{ ok?: boolean }>('/despacharDeFlujo', {
          answerGUID: answerGuid,
          surveyID: despacho.SurveyID,
          assignedToID: despacho.Destinatario,
          estadoGUID: despacho.EstadoGUID,
          aviso: despacho.Aviso,
          que: despacho.Que,
          hija: despacho.Hija === true,
          programado: despacho.Programado,
        }),
      );

      return res?.ok === true;
    } catch (error) {
      /*
       * 409 es «la actividad todavía no está arriba»: se reintenta, no se
       * descarta. Cualquier otro fallo se trata igual, que es lo prudente —
       * dejar de intentarlo perdería la consigna sin que nadie se entere.
       */
      console.warn('[despacho] no salió, se reintentará', error);
      return false;
    }
  }
}
