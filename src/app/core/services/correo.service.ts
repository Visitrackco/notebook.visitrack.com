import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { BaseRepository } from '../repositories/base.repository';
import { ApiService } from './api.service';
import { esModoPublico } from '../config/modo-publico';

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

  /*
   * Lo que el servidor dice que pasó después de aceptarlo (IndexedDB v8).
   *
   * Hasta aquí la cola local solo sabía «lo puse en la cola». Lo que pasó luego
   * —si el job lo mandó, si se está reintentando, si se desistió— lo sabe el
   * servidor, y se pregunta con `POST /correosDeFlujo/estado`. Se guarda aquí
   * para que la lista de actividades pinte el sobre sin conexión con lo último
   * que se supo. Opcionales: las filas de antes de la v8 no los tienen.
   */

  /** Uno de [EstadoDeCorreo]. Vacío mientras no esté en la cola del servidor. */
  EstadoServidor?: EstadoDeCorreo | '';

  /** El motivo completo que dio el servidor: el fallo, o los avisos del envío. */
  ErrorServidor?: string;

  /** Intentos de envío del job (no los de encolar, que son `Intentos`). */
  IntentosServidor?: number;

  /** Cuándo salió, en UTC, si salió. */
  EnviadoEn?: string;

  /** Cuándo se supo por última vez el estado, en ISO. */
  EstadoEn?: string;
}

/**
 * En qué punto va un correo, tal como lo dice el servidor.
 *
 * La traducción de las columnas de la bandeja la hace cloud-server
 * (`model/Emails/estadoDeCorreo.js`) y no aquí, para que el móvil y la web no
 * tengan cada uno la suya. `pendiente` es solo de este lado: apuntado y todavía
 * sin entregar al servidor.
 */
export type EstadoDeCorreo =
  | 'pendiente'
  | 'en-cola'
  | 'enviando'
  | 'enviado'
  | 'enviado-con-avisos'
  | 'error'
  | 'reintentando';

/** Un correo de una actividad, para pintarlo. */
export interface CorreoConEstado {
  /** La llave del motor, si es uno que apuntó este navegador. */
  llave: string | null;
  regla: string | null;
  para: string;
  copia: string;
  asunto: string;
  estado: EstadoDeCorreo;
  intentos: number;
  ultimoError: string;
  creado: string | null;
  enviado: string | null;
}

/** Los correos de una actividad y el peor estado entre ellos. */
export interface ResumenDeCorreos {
  estado: EstadoDeCorreo | null;
  correos: CorreoConEstado[];
  /** Si lo dijo el servidor (y no solo la cola local de este navegador). */
  delServidor: boolean;
}

/**
 * Cómo se lee y de qué color va cada estado. Lo comparten el bloque de la
 * actividad y el sobre de la lista: el mismo estado, el mismo color.
 */
export const ESTADO_DE_CORREO: Readonly<
  Record<EstadoDeCorreo, { texto: string; tono: 'gris' | 'azul' | 'verde' | 'ambar' | 'rojo' }>
> = {
  pendiente: { texto: 'Por subir', tono: 'gris' },
  'en-cola': { texto: 'En cola', tono: 'gris' },
  enviando: { texto: 'Enviando', tono: 'azul' },
  reintentando: { texto: 'Reintentando', tono: 'ambar' },
  enviado: { texto: 'Enviado', tono: 'verde' },
  'enviado-con-avisos': { texto: 'Enviado con avisos', tono: 'verde' },
  error: { texto: 'Error', tono: 'rojo' },
};

/**
 * Lo peor de varios estados, para el sobre de la tarjeta. El mismo orden que
 * `peorEstado` de cloud-server: un error tapa todo, luego los avisos, luego lo
 * que todavía no salió y al final lo enviado.
 */
const GRAVEDAD: Readonly<Record<EstadoDeCorreo, number>> = {
  error: 6,
  'enviado-con-avisos': 5,
  reintentando: 4,
  pendiente: 3,
  'en-cola': 2,
  enviando: 1,
  enviado: 0,
};

export function peorEstadoDeCorreo(
  estados: readonly (EstadoDeCorreo | null | undefined)[],
): EstadoDeCorreo | null {
  let peor: EstadoDeCorreo | null = null;

  for (const uno of estados) {
    if (!uno || !(uno in GRAVEDAD)) continue;
    if (peor === null || GRAVEDAD[uno] > GRAVEDAD[peor]) peor = uno;
  }

  return peor;
}

/** Si ya no va a cambiar: no hace falta volver a preguntar por él. */
export function esFinal(estado: EstadoDeCorreo | '' | null | undefined): boolean {
  return estado === 'enviado' || estado === 'enviado-con-avisos' || estado === 'error';
}

/** Lo que responde `POST /correosDeFlujo/estado`. Ver cloud-server. */
interface RespuestaDeEstado {
  ok?: boolean;
  actividades?: {
    answerGUID: string;
    estado: EstadoDeCorreo | null;
    correos: {
      llave: string | null;
      regla: string | null;
      para: string;
      copia: string;
      asunto: string;
      estado: EstadoDeCorreo;
      intentos: number;
      ultimoError: string;
      creado: string | null;
      enviado: string | null;
    }[];
  }[];
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

  /**
   * Los que están en la cola del servidor y todavía pueden cambiar de estado.
   *
   * Son los únicos por los que vale la pena volver a preguntar: uno enviado o
   * desistido ya no se mueve.
   */
  async porSeguir(): Promise<CorreoPendiente[]> {
    return this.query({
      index: 'byEncolado',
      range: 1,
      filter: (c) => !esFinal(c.EstadoServidor),
    });
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
   * Los correos de cada actividad que ya se conocen, por GUID en minúsculas.
   *
   * Lo leen el bloque «Correos del flujo» de la actividad y el sobre de la
   * tarjeta en la lista: los dos se actualizan solos cuando llega un estado
   * nuevo —al abrir, al volver a la pestaña, al recibir el aviso—.
   */
  readonly resumenes = signal<ReadonlyMap<string, ResumenDeCorreos>>(new Map());

  constructor() {
    /*
     * Al volver a la pestaña se pregunta por lo que seguía en camino.
     *
     * Es el momento en que alguien mira: dejó el navegador mientras el job
     * trabajaba y vuelve a ver si salió. Preguntar cada minuto con la pestaña
     * escondida sería gastar peticiones que nadie lee.
     */
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void this.refrescarLosQueSiguen();
      });
    }
  }

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

          /*
           * Aceptado es «en cola»: a partir de aquí manda lo que diga el
           * servidor. Rechazado para siempre es un error con su motivo — nunca
           * va a salir, y hay que verlo en rojo, no en gris.
           */
          ...(salida.ok
            ? { EstadoServidor: 'en-cola' as const, ErrorServidor: '', EstadoEn: new Date().toISOString() }
            : !salida.reintentar
              ? {
                  EstadoServidor: 'error' as const,
                  ErrorServidor: salida.mensaje,
                  EstadoEn: new Date().toISOString(),
                }
              : {}),
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

    // Lo que se acaba de encolar ya se ve «en cola»; el servidor dirá el resto.
    await this.cargarLocales([answerGuid]);
    if (aceptados > 0) void this.refrescar([answerGuid]);

    return { aceptados, mensaje };
  }

  /**
   * Pinta lo que ya se sabe de unas actividades, sin red.
   *
   * Lee la cola local y deja el resumen en [resumenes]. Las actividades sin
   * correos apuntados en este navegador no entran: no tienen nada que pintar,
   * salvo que el servidor diga otra cosa al [refrescar].
   */
  async cargarLocales(guids: readonly string[]): Promise<void> {
    try {
      const nuevos = new Map(this.resumenes());

      for (const tal of new Set(guids.filter(Boolean))) {
        const guid = tal.toLowerCase();

        // Si el servidor ya respondió por esta actividad, manda lo suyo: trae
        // también lo que pidieron otros aparatos.
        if (nuevos.get(guid)?.delServidor) continue;

        const filas = await this.repo.todosDe(tal);
        if (!filas.length) continue;

        const correos = filas.map((c) => this.desdeLocal(c));
        nuevos.set(guid, {
          estado: peorEstadoDeCorreo(correos.map((c) => c.estado)),
          correos,
          delServidor: false,
        });
      }

      this.resumenes.set(nuevos);
    } catch (error) {
      console.warn('[correo] no se pudo leer la cola local', error);
    }
  }

  /**
   * Pregunta al servidor en qué quedaron los correos de unas actividades.
   *
   * `POST /correosDeFlujo/estado` con las llaves que este navegador tiene
   * apuntadas: el servidor las hashea igual que al encolar y devuelve cada
   * correo con su `llave`, así se casa con la fila local sin calcular nada.
   * Actualiza la cola local y [resumenes].
   *
   * Nunca lanza. Sin red se queda lo último que se supo.
   */
  async refrescar(guids: readonly string[]): Promise<void> {
    // Por minúsculas para no repetir, pero con el GUID tal como se guardó: el
    // índice de IndexedDB distingue mayúsculas.
    const original = new Map<string, string>();
    for (const g of guids) if (g && !original.has(g.toLowerCase())) original.set(g.toLowerCase(), g);

    const unicos = [...original.keys()].slice(0, 50);

    // Un enlace público no tiene sesión, y el estado se pide con sesión: ahí se
    // queda lo que dice la cola local.
    if (!unicos.length || esModoPublico()) return;

    try {
      const actividades: { answerGUID: string; llaves: string[] }[] = [];

      for (const guid of unicos) {
        const locales = await this.repo.todosDe(original.get(guid) ?? guid);
        actividades.push({ answerGUID: guid, llaves: locales.map((c) => c.Llave).filter(Boolean) });
      }

      const res = await firstValueFrom(
        this.api.post<RespuestaDeEstado>('/correosDeFlujo/estado', { actividades }),
      );

      if (!res?.ok || !Array.isArray(res.actividades)) return;

      const nuevos = new Map(this.resumenes());

      for (const actividad of res.actividades) {
        const guid = String(actividad.answerGUID || '').toLowerCase();
        const locales = await this.repo.todosDe(original.get(guid) ?? guid);
        const casados = new Set<number>();

        for (const remoto of actividad.correos) {
          const local = remoto.llave ? locales.find((c) => c.Llave === remoto.llave) : undefined;
          if (!local || local.ID === undefined) continue;

          casados.add(local.ID);
          await this.repo.put({
            ...local,
            Encolado: 1,
            EstadoServidor: remoto.estado,
            ErrorServidor: remoto.ultimoError || '',
            IntentosServidor: remoto.intentos || 0,
            EnviadoEn: remoto.enviado || '',
            EstadoEn: new Date().toISOString(),
          });
        }

        /*
         * Lo del servidor, más lo que este navegador apuntó y el servidor no
         * tiene: lo que todavía no subió y lo que rechazó al encolar.
         *
         * Sin sumarlo, el bloque diría «todo enviado» con uno esperando.
         */
        const correos: CorreoConEstado[] = actividad.correos.map((r) => ({
          llave: r.llave,
          regla: r.regla,
          para: r.para,
          copia: r.copia,
          asunto: r.asunto,
          estado: r.estado,
          intentos: r.intentos || 0,
          ultimoError: r.ultimoError || '',
          creado: r.creado,
          enviado: r.enviado,
        }));

        for (const local of locales) {
          if (local.ID !== undefined && casados.has(local.ID)) continue;
          if (local.Encolado && local.EstadoServidor !== 'error') continue;
          correos.push(this.desdeLocal(local));
        }

        if (correos.length) {
          nuevos.set(guid, {
            estado: peorEstadoDeCorreo(correos.map((c) => c.estado)),
            correos,
            delServidor: true,
          });
        } else {
          nuevos.delete(guid);
        }
      }

      this.resumenes.set(nuevos);
    } catch (error) {
      console.warn('[correo] no se pudo leer el estado de los correos', error);
    }
  }

  /**
   * Vuelve a preguntar por todo lo que seguía en camino.
   *
   * Lo llaman volver a la pestaña, terminar una subida y un aviso de «correo
   * enviado». Solo las actividades con algún correo que todavía puede cambiar.
   */
  async refrescarLosQueSiguen(): Promise<void> {
    try {
      const siguen = await this.repo.porSeguir();
      await this.refrescar(siguen.map((c) => c.AnswerGUID));
    } catch (error) {
      console.warn('[correo] no se pudo refrescar lo pendiente', error);
    }
  }

  /** Una fila de la cola local, en la forma que se pinta. */
  private desdeLocal(c: CorreoPendiente): CorreoConEstado {
    const estado: EstadoDeCorreo = !c.Encolado ? 'pendiente' : c.EstadoServidor || 'en-cola';

    return {
      llave: c.Llave,
      regla: c.Regla || null,
      para: c.Para,
      copia: c.Copia,
      asunto: c.Asunto,
      estado,
      intentos: c.IntentosServidor ?? 0,
      // Sin subir, el motivo es el de encolar; ya en la cola, el del servidor.
      ultimoError: (c.Encolado ? c.ErrorServidor || c.Error : c.Error) || '',
      creado: c.CreatedOn || null,
      enviado: c.EnviadoEn || null,
    };
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
