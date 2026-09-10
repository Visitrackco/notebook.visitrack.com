import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { BaseRepository } from '../repositories/base.repository';
import { ApiService } from './api.service';

/** Un correo que pidió una regla y todavía no está en la cola del servidor. */
export interface CorreoPendiente {
  ID?: number;

  /** La actividad que lo disparó. Hasta que no suba, no se encola. */
  AnswerGUID: string;

  /**
   * Con qué se reconoce este correo. La calcula el motor: regla, destinatario,
   * asunto y programación. Ver `llaveDelCorreo` en `flujo-motor`.
   */
  Llave: string;

  Para: string;
  Copia: string;
  CopiaOculta: string;

  /**
   * Qué archivos van pegados, en el JSON que dejó el motor.
   *
   * Texto y no un arreglo: aquí no se interpreta nada. El motor deja **cuál**
   * archivo se quiere y con qué nombre; dónde vive cada uno lo sabe el
   * servidor, que es quien tiene los binarios de la actividad y quien le pide
   * el informe al generador.
   */
  Adjuntos: string;

  /**
   * Lo que la regla quiere que se lea en pantalla. Ver `CorreoDeFlujo`.
   *
   * No viajan al servidor: son de aquí, y el servidor no pinta nada.
   */
  MensajeEnviando: string;
  MensajeEnviado: string;

  Asunto: string;

  /** El HTML con las variables ya resueltas **y escapadas**. */
  Cuerpo: string;

  /**
   * Por dónde sale: el `ID` de un buzón, o el área cuyo predeterminado se usa.
   *
   * Nunca el servidor ni la contraseña — el flujo se descarga a todos los
   * equipos que sincronizan el formulario.
   */
  Proveedor: string;
  Area: string;

  /**
   * Cuándo sale (`aaaa-mm-dd hh:mm`), en hora local.
   *
   * Vacío es «ya». Se guarda en hora de pared, que es la que puso quien
   * configuró la regla, y se pasa a UTC justo antes de mandarla: ahí es donde se
   * conoce el reloj del equipo.
   */
  Programado: string;

  Regla: string;

  /** 0 pendiente, 1 en la cola del servidor. Número y no booleano: IndexedDB no indexa booleanos. */
  Encolado: number;

  Intentos: number;

  /** Por qué no se pudo encolar la última vez. Vacío mientras no haya fallado. */
  Error: string;

  CreatedOn: string;
}

/** La cola local de correos por encolar. */
@Injectable({ providedIn: 'root' })
export class CorreoRepository extends BaseRepository<CorreoPendiente> {
  protected readonly storeName = 'CorreosFlujo';

  /** Lo que queda por poner en la cola del servidor. */
  async pendientesDe(answerGuid: string): Promise<CorreoPendiente[]> {
    return this.query({
      index: 'byAnswerGUID',
      range: answerGuid,
      filter: (c) => !c.Encolado,
    });
  }

  /** Todo lo apuntado de una actividad, encolado o no. */
  async todosDe(answerGuid: string): Promise<CorreoPendiente[]> {
    return this.query({ index: 'byAnswerGUID', range: answerGuid });
  }
}

/**
 * Pone en la cola del servidor los correos que pidieron las reglas de flujo.
 *
 * ## Un solo camino, y este
 *
 * El correo **no se manda desde el navegador**. Se apunta, se manda al servidor
 * cuando la actividad ya está arriba, y es el servidor quien lo envía. Ni
 * siquiera cuando hay conexión de sobra: la variante «si hay internet manda ya,
 * si no encola» son dos caminos con dos formas de fallar y un problema de
 * duplicados entre ellos.
 *
 * Y hay una razón que aquí pesa igual que en el teléfono: las credenciales del
 * buzón no pueden bajar al cliente. Un flujo se descarga a **todos** los equipos
 * que sincronizan ese formulario.
 *
 * ## Cuándo se encola
 *
 * Cuando la actividad que lo disparó ya está en Visitrack **con sus archivos
 * confirmados**, no al pulsar guardar. Un correo que dice «se adjunta el informe
 * de la visita» y remite a una actividad que todavía no existe no le sirve a
 * quien lo recibe.
 *
 * Es el mismo diseño que en la app, y a propósito: las dos escriben en su cola
 * local, llaman al mismo endpoint y reintentan igual.
 */
@Injectable({ providedIn: 'root' })
export class CorreoService {
  private readonly repo = inject(CorreoRepository);
  private readonly api = inject(ApiService);

  /** Actividades que se están encolando ahora, para no hacerlo dos veces. */
  private readonly enCurso = new Set<string>();

  /**
   * Apunta un correo, sin repetir.
   *
   * ## La llave, y por qué no lleva el cuerpo
   *
   * Es la del motor: regla, a quién, con qué asunto y para cuándo. El **cuerpo
   * no entra**. Una actividad se reabre y se corrige —una tilde, un dato— y se
   * vuelve a guardar; si el cuerpo contara, esa corrección sería un correo
   * distinto y al mismo destinatario le llegarían dos avisos casi iguales. Quien
   * lo recibe no ve una corrección: ve dos correos.
   *
   * La comprobación va **aquí, donde se inserta**, y no antes de enviar: entre
   * una cosa y la otra hay reintentos, cierres de pestaña y guardados repetidos,
   * y cualquiera de esas pasadas vuelve a pedir el mismo correo.
   */
  async apuntar(
    correo: Omit<CorreoPendiente, 'ID' | 'Encolado' | 'Intentos' | 'Error' | 'CreatedOn'>,
  ): Promise<boolean> {
    /*
     * Devuelve si de verdad lo apuntó, o si ya estaba.
     *
     * La diferencia importa: quien pulsa un botón tiene que poder saber si su
     * correo se pidió ahora o si ya se había pedido y la regla manda una sola
     * vez. Sin esto, la pantalla contaba como puesto lo que no se puso y
     * parecía que el correo se disparaba otra vez.
     */
    try {
      const ya = await this.repo.todosDe(correo.AnswerGUID);

      if (ya.some((c) => String(c.Llave ?? '') === String(correo.Llave ?? ''))) return false;

      await this.repo.put({
        ...correo,
        Encolado: 0,
        Intentos: 0,
        Error: '',
        CreatedOn: new Date().toISOString(),
      });

      return true;
    } catch (error) {
      console.warn('[correo] no se pudo apuntar', error);

      // No se apuntó: quien llame no puede anunciar un correo que no existe.
      return false;
    }
  }

  /**
   * Manda al servidor lo que quede pendiente de una actividad.
   *
   * Nunca lanza. Un correo que no se encola se queda apuntado con un intento más
   * y su motivo, y vuelve a intentarse; lo que no puede es tumbar la subida de
   * la actividad, que es lo importante.
   *
   * Devuelve **cuántos aceptó el servidor** en esta pasada y el aviso que la
   * regla escribió, para poder decírselo a quien acaba de guardar. Se cuentan
   * los aceptados y no los apuntados: un correo que no llegó a la cola no se
   * puede anunciar, y es justo el caso que hay que ver —sin buzón, sin
   * destinatario— en vez de dar por hecho que salió.
   */
  async encolarPendientes(answerGuid: string): Promise<{ aceptados: number; mensaje: string }> {
    if (!answerGuid || this.enCurso.has(answerGuid)) return { aceptados: 0, mensaje: '' };

    let aceptados = 0;
    let mensaje = '';

    this.enCurso.add(answerGuid);

    try {
      for (const correo of await this.repo.pendientesDe(answerGuid)) {
        const salida = await this.mandar(answerGuid, correo);

        /*
         * Un rechazo que **no** es temporal cierra el asunto aquí.
         *
         * El servidor es quien lo sabe: distingue un tropiezo suyo —que se
         * arregla volviendo a intentarlo— de una petición que nunca va a
         * aceptar. Insistir con la segunda es reintentar para siempre en cada
         * guardado.
         *
         * Se marca conservando el motivo: es lo único que va a quedar de un
         * correo que no llegó a la cola, y sin él, desde fuera, se vería igual
         * que uno que sí salió.
         */
        await this.repo.put({
          ...correo,
          Encolado: salida.ok || !salida.reintentar ? 1 : 0,
          Intentos: correo.Intentos + (salida.ok ? 0 : 1),
          Error: salida.ok ? '' : salida.mensaje,
        });

        /*
         * Si no salió por algo temporal, se para aquí.
         *
         * Seguir con la conexión caída solo suma intentos fallidos. Vuelven
         * todos en la próxima confirmación de subida.
         *
         * Lo que **no** es temporal sí deja seguir: un correo que el servidor
         * rechaza por su cuenta —sin buzón, sin destinatario— no dice nada de
         * los demás, y pararse ahí retrasaría los que sí podían salir.
         */
        if (salida.ok) {
          aceptados++;

          // El primero que entra pone el texto: dos correos de la misma regla
          // traen el mismo, y anunciar los dos sería apilar avisos encima de
          // quien está guardando.
          if (!mensaje) mensaje = String(correo.MensajeEnviado ?? '');
        }

        if (!salida.ok && salida.reintentar) break;
      }
    } catch (error) {
      console.warn('[correo] no se pudieron encolar los de', answerGuid, error);
    } finally {
      this.enCurso.delete(answerGuid);
    }

    return { aceptados, mensaje };
  }

  private async mandar(
    answerGuid: string,
    correo: CorreoPendiente,
  ): Promise<{ ok: boolean; reintentar: boolean; mensaje: string }> {
    try {
      const res = await firstValueFrom(
        this.api.put<{ ok?: boolean; msg?: string; reintentar?: boolean }>(
          '/encolarCorreoDeFlujo',
          {
            answerGUID: answerGuid,
            llave: correo.Llave,
            para: correo.Para,
            copia: correo.Copia,
            copiaOculta: correo.CopiaOculta,
            adjuntos: correo.Adjuntos,
            asunto: correo.Asunto,
            cuerpo: correo.Cuerpo,
            proveedor: correo.Proveedor,
            area: correo.Area,
            regla: correo.Regla,
            programado: aUtc(correo.Programado),
          },
        ),
      );

      if (res?.ok === true) return { ok: true, reintentar: false, mensaje: '' };

      return {
        ok: false,
        reintentar: res?.reintentar === true,
        mensaje: res?.msg ?? 'No se pudo dejar el correo en cola.',
      };
    } catch (error) {
      /*
       * 409 es «la actividad todavía no está arriba»: se reintenta, no se
       * descarta. Cualquier otro fallo de red se trata igual, que es lo
       * prudente — dejar de intentarlo perdería el correo sin que nadie se
       * entere.
       */
      console.warn('[correo] no se encoló, se reintentará', error);

      return {
        ok: false,
        reintentar: true,
        mensaje: 'No se pudo llegar al servidor. Se volverá a intentar.',
      };
    }
  }
}

/**
 * Una hora de pared (`aaaa-mm-dd hh:mm`) pasada a UTC, en ISO-8601 con `Z`.
 *
 * El motor la deja en hora local a propósito —tiene que dar el mismo resultado
 * en el simulador, donde no hay ningún huso— y quien encola es el primero que
 * conoce el reloj del equipo. La plataforma entera trabaja en UTC; una hora
 * local guardada como si lo fuera es un correo que sale cinco horas antes o
 * después, y eso no se descubre hasta que alguien lo recibe de madrugada.
 *
 * Vacío se queda vacío: es «que salga ya». Lo que no se pueda leer también, por
 * lo mismo que en el motor — más vale que llegue de más a que se pierda
 * esperando una fecha que nadie supo leer.
 */
function aUtc(pared: string): string {
  const limpio = String(pared ?? '').trim();
  if (!limpio) return '';

  // Con la `T` y sin zona, el navegador lo lee como hora local, que es
  // exactamente lo que es: la que puso quien configuró la regla.
  const local = new Date(limpio.replace(' ', 'T'));

  return Number.isNaN(local.getTime()) ? '' : local.toISOString();
}
