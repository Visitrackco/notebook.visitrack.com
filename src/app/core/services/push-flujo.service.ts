import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { BaseRepository } from '../repositories/base.repository';
import { ApiService } from './api.service';

/** Una notificación que pidió una regla y todavía no está en la cola del servidor. */
export interface PushPendiente {
  ID?: number;

  /** La actividad que la disparó. Hasta que no suba, no se encola. */
  AnswerGUID: string;

  /**
   * Con qué se reconoce este aviso. La calcula el motor: regla, a quién, con qué
   * título y para cuándo. Ver `llaveDelPush` en `flujo-motor`.
   */
  Llave: string;

  /**
   * A quién, en **personas**: identificadores, o las dos palabras.
   *
   * `@asignado` y `@creador` viajan tal cual y las resuelve el servidor contra
   * la actividad. Aquí no se pueden resolver: el motor tiene que dar el mismo
   * resultado en el simulador, donde no hay ninguna actividad, y el navegador
   * solo conoce a quien tiene el formulario delante.
   */
  Para: string;

  Titulo: string;
  Texto: string;

  /** La dirección de la imagen, ya resuelta por el motor. Vacía si no había. */
  Foto: string;

  Enlace: string;

  /**
   * Cuándo sale (`aaaa-mm-dd hh:mm`), en hora local.
   *
   * Vacío es «ya». Se guarda en hora de pared, que es la que puso quien
   * configuró la regla, y se pasa a UTC justo antes de mandarla.
   */
  Programado: string;

  Regla: string;

  /** Se disparó al guardar, o al pulsar un botón. */
  Disparo: string;

  /** 0 pendiente, 1 en la cola del servidor. Número: IndexedDB no indexa booleanos. */
  Encolado: number;

  Intentos: number;

  /** Por qué no se pudo encolar la última vez. Vacío mientras no haya fallado. */
  Error: string;

  CreatedOn: string;
}

/** La cola local de notificaciones por encolar. */
@Injectable({ providedIn: 'root' })
export class PushFlujoRepository extends BaseRepository<PushPendiente> {
  protected readonly storeName = 'PushFlujo';

  /** Lo que queda por poner en la cola del servidor. */
  async pendientesDe(answerGuid: string): Promise<PushPendiente[]> {
    return this.query({
      index: 'byAnswerGUID',
      range: answerGuid,
      filter: (p) => !p.Encolado,
    });
  }

  /** Todo lo apuntado de una actividad, encolado o no. */
  async todosDe(answerGuid: string): Promise<PushPendiente[]> {
    return this.query({ index: 'byAnswerGUID', range: answerGuid });
  }
}

/**
 * Pone en la cola del servidor las notificaciones que pidieron las reglas.
 *
 * **Gemelo de `CorreoService`**, hasta en los reintentos. Que se parezcan es lo
 * que permite que quien entienda uno entienda el otro, y que el día que haya
 * que cambiar el trato de la cola se cambie igual en los dos.
 *
 * ## Un solo camino, y este
 *
 * El aviso **no se manda desde el navegador**. Se apunta, se manda al servidor
 * cuando la actividad ya está arriba, y es el servidor quien lo envía.
 *
 * Aquí la razón es aún más fuerte que con el correo: el navegador **no puede**
 * mandarlo aunque quisiera. A qué aparatos llega un aviso depende de qué
 * sesiones tiene vivas esa persona, y eso solo lo sabe el servidor. Quien
 * diligencia no tiene —ni debe tener— la lista de teléfonos de sus compañeros.
 *
 * ## Cuándo se encola
 *
 * Cuando la actividad que lo disparó ya está en Visitrack. Antes no: el
 * servidor resuelve `@asignado` y `@creador` mirándola, así que sin ella no
 * sabría a quién mandarlo — y responde `409` pidiendo que se reintente, que es
 * justo lo que hace este servicio.
 */
@Injectable({ providedIn: 'root' })
export class PushFlujoService {
  private readonly repo = inject(PushFlujoRepository);
  private readonly api = inject(ApiService);

  /** Actividades que se están encolando ahora, para no hacerlo dos veces. */
  private readonly enCurso = new Set<string>();

  /**
   * Apunta un aviso, sin repetir.
   *
   * La llave es la del motor: regla, a quién, con qué título y para cuándo. El
   * **texto no entra**, por lo mismo que el cuerpo de un correo: una actividad
   * se reabre y se corrige, y si el texto contara esa corrección sería un aviso
   * distinto — al mismo destinatario le sonaría el teléfono dos veces.
   *
   * Devuelve si de verdad lo apuntó, o si ya estaba. La diferencia importa:
   * quien pulsa un botón tiene que poder saber si su aviso se pidió ahora o si
   * ya se había pedido y la regla manda una sola vez.
   */
  async apuntar(
    push: Omit<PushPendiente, 'ID' | 'Encolado' | 'Intentos' | 'Error' | 'CreatedOn'>,
  ): Promise<boolean> {
    try {
      const ya = await this.repo.todosDe(push.AnswerGUID);

      if (ya.some((p) => String(p.Llave ?? '') === String(push.Llave ?? ''))) return false;

      await this.repo.put({
        ...push,
        Encolado: 0,
        Intentos: 0,
        Error: '',
        CreatedOn: new Date().toISOString(),
      });

      return true;
    } catch (error) {
      console.warn('[push] no se pudo apuntar', error);

      // No se apuntó: quien llame no puede anunciar un aviso que no existe.
      return false;
    }
  }

  /**
   * Manda al servidor lo que quede pendiente de una actividad.
   *
   * Nunca lanza. Un aviso que no se encola se queda apuntado con un intento más
   * y su motivo, y vuelve a intentarse; lo que no puede es tumbar la subida de
   * la actividad, que es lo importante.
   *
   * Devuelve cuántos aceptó el servidor y, si alguno fue rechazado **para
   * siempre**, por qué.
   *
   * Los **aceptados** y no los apuntados: uno que no llegó a la cola no se puede
   * anunciar. Y el motivo hace falta porque antes esto no devolvía nada y un
   * aviso que el servidor rechazaba —sin destinatarios válidos, sin título—
   * moría en silencio: quien guardaba veía lo mismo que si hubiera salido.
   */
  async encolarPendientes(
    answerGuid: string,
  ): Promise<{ aceptados: number; motivo: string }> {
    if (!answerGuid || this.enCurso.has(answerGuid)) return { aceptados: 0, motivo: '' };

    let aceptados = 0;
    let motivo = '';

    this.enCurso.add(answerGuid);

    try {
      for (const push of await this.repo.pendientesDe(answerGuid)) {
        const salida = await this.mandar(answerGuid, push);

        /*
         * Un rechazo que **no** es temporal cierra el asunto aquí.
         *
         * El servidor distingue un tropiezo suyo —que se arregla volviendo a
         * intentarlo— de una petición que nunca va a aceptar: un aviso sin
         * título, o cuyos destinatarios ya no están en la compañía. Insistir
         * con la segunda es reintentar para siempre en cada guardado.
         *
         * Se marca conservando el motivo: es lo único que va a quedar de un
         * aviso que no llegó a la cola.
         */
        await this.repo.put({
          ...push,
          Encolado: salida.ok || !salida.reintentar ? 1 : 0,
          Intentos: push.Intentos + (salida.ok ? 0 : 1),
          Error: salida.ok ? '' : salida.mensaje,
        });

        if (salida.ok) {
          aceptados++;
        } else if ((!salida.reintentar || salida.avisar) && !motivo) {
          /*
           * Lo que no se va a reintentar, y lo que aunque se reintente no se
           * arregla solo.
           *
           * Un tropiezo de red vuelve en la próxima subida y anunciarlo sería
           * alarmar por algo que se resuelve sin que nadie haga nada. Pero lo
           * que el servidor rechaza para siempre —o una ruta que no existe
           * porque falta desplegar— no se arregla si nadie lo mira, y hasta
           * ahora no había forma de enterarse.
           */
          motivo = salida.mensaje;
        }

        /*
         * Si no salió por algo temporal, se para aquí.
         *
         * Seguir con la conexión caída solo suma intentos fallidos. Vuelven
         * todos en la próxima confirmación de subida. Lo que no es temporal sí
         * deja seguir: no dice nada de los demás.
         */
        if (!salida.ok && salida.reintentar) break;
      }
    } catch (error) {
      console.warn('[push] no se pudieron encolar los de', answerGuid, error);
    } finally {
      this.enCurso.delete(answerGuid);
    }

    return { aceptados, motivo };
  }

  private async mandar(
    answerGuid: string,
    push: PushPendiente,
  ): Promise<{ ok: boolean; reintentar: boolean; mensaje: string; avisar?: boolean }> {
    try {
      const res = await firstValueFrom(
        this.api.put<{ ok?: boolean; msg?: string; reintentar?: boolean }>(
          '/encolarPushDeFlujo',
          {
            answerGUID: answerGuid,
            llave: push.Llave,
            para: push.Para,
            titulo: push.Titulo,
            cuerpo: push.Texto,
            imagen: push.Foto,
            enlace: push.Enlace,
            regla: push.Regla,
            disparo: push.Disparo,
            programado: aUtc(push.Programado),
          },
        ),
      );

      if (res?.ok === true) return { ok: true, reintentar: false, mensaje: '' };

      return {
        ok: false,
        reintentar: res?.reintentar === true,
        mensaje: res?.msg ?? 'No se pudo dejar el aviso en cola.',
      };
    } catch (error) {
      /*
       * 409 es «la actividad todavía no está arriba»: se reintenta, no se
       * descarta. Cualquier otro fallo de red se trata igual, que es lo
       * prudente — dejar de intentarlo perdería el aviso sin que nadie se
       * entere.
       */
      console.warn('[push] no se encoló, se reintentará', error);

      /*
       * Un 404 es un caso aparte, y merece decirse con su nombre.
       *
       * Significa que **ese servidor no conoce esta ruta**: le falta el
       * despliegue. No es un tropiezo de red y no se arregla esperando, pero
       * tampoco es definitivo —en cuanto se despliegue, los avisos apuntados
       * salen solos—, así que se sigue reintentando.
       *
       * Se distingue porque, sin esto, un backend sin actualizar se ve
       * exactamente igual que estar sin cobertura: los avisos se quedan
       * apuntados para siempre y nadie sabe por qué. Es justo lo que pasó la
       * primera vez que se probó esto.
       */
      const status = (error as { status?: number })?.status;

      return {
        ok: false,
        reintentar: true,
        mensaje:
          status === 404
            ? 'El servidor todavía no tiene la ruta de notificaciones: falta actualizarlo.'
            : 'No se pudo llegar al servidor. Se volverá a intentar.',

        // Un 404 se cuenta aunque se reintente: esperar no lo arregla, y quien
        // lo ve es quien puede pedir que se despliegue.
        avisar: status === 404,
      };
    }
  }
}

/**
 * Una hora de pared (`aaaa-mm-dd hh:mm`) pasada a UTC, en ISO-8601 con `Z`.
 *
 * La misma conversión que hace `correo.service.ts`, y por lo mismo: el motor la
 * deja en hora local a propósito —tiene que dar el mismo resultado en el
 * simulador, donde no hay ningún huso— y quien encola es el primero que conoce
 * el reloj del equipo.
 *
 * Vacío se queda vacío: es «que salga ya». Lo que no se pueda leer también.
 */
function aUtc(pared: string): string {
  const limpio = String(pared ?? '').trim();
  if (!limpio) return '';

  // Con la `T` y sin zona, el navegador lo lee como hora local, que es
  // exactamente lo que es: la que puso quien configuró la regla.
  const local = new Date(limpio.replace(' ', 'T'));

  return Number.isNaN(local.getTime()) ? '' : local.toISOString();
}
