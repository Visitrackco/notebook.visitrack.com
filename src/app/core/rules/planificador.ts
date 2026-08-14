import { AnswerField } from '../forms/form-schema';
import { optionTextOf, readValue } from './brillantex';

/**
 * Los formularios que **planifican**: cronograma de ruta y Planeador.
 *
 * Diamante (2030, formulario 22814) y Brillantex (2259, formulario 16681) tienen
 * el mismo procedimiento con distintos identificadores y estados. No es una
 * inspección: es el paso previo, donde se decide **qué visitas se van a hacer**.
 *
 * ## Qué hace, en orden
 *
 * 1. Exige que estén el motivo y la fecha. Si faltan, avisa y no continúa.
 * 2. Si la visita ya tiene desenlace —aplazada, cancelada, realizada— pone su
 *    estado y termina. Es el segundo paso: la actividad ya se planificó antes.
 * 3. Si la fecha quedó en el pasado, lo dice y marca el estado de error.
 * 4. Si no, **habilita los formularios vinculados** de los motivos elegidos,
 *    limpia el campo de desenlace y deja la actividad planificada.
 *
 * ## Lo que en la web todavía no se ve
 *
 * El paso 4 escribe campos de tipo `form` —formularios vinculados—. La web aún
 * no los dibuja: `field-host` los deja en blanco a propósito. Los datos quedan
 * escritos y se sincronizan igual, así que el teléfono y la plataforma los ven;
 * lo que falta es la pantalla. Mientras eso no exista, planificar desde la web
 * funciona pero no se ve completo, y conviene saberlo antes de usarlo en serio.
 */

/** Un desenlace de la visita y el estado que le corresponde. */
interface Desenlace {
  txt: string;
  status: string;
  completa?: boolean;
}

export interface PlanConfig {
  label: string;
  /** Campo con los motivos: casillas en el cronograma, número en el Planeador. */
  motivos: string;
  /** Campo con el desenlace de la visita. */
  visita: string;
  /** Campo con la fecha de la visita. */
  fecha: string;

  desenlaces: Desenlace[];

  /** Estado cuando la fecha quedó en el pasado. */
  statusFechaPasada: string;
  /** Estado con el que queda una actividad ya planificada. */
  statusPlanificada: string;

  /** Cómo se traducen los motivos a los formularios que se habilitan. */
  habilitar:
    | { modo: 'por-texto'; mapa: Record<string, string> }
    | { modo: 'por-cantidad'; grupos: string[][]; ninguna: string };
}

/** Un campo que hay que escribir en la actividad. */
export interface FieldWrite {
  id: string;
  /**
   * Siempre un objeto vacío.
   *
   * Habilitar un formulario vinculado es dejarlo **presente y sin responder**,
   * que es lo que hace la app. Va como `unknown` porque `{}` no encaja en la
   * unión de valores del motor, y forzarlo allí sería mentirle al tipo para
   * escribir exactamente lo mismo.
   */
  val: unknown;
  fty: string;
  hid: boolean;
}

export interface PlanOutcome {
  /** Estado que queda, si cambia. */
  status?: string;
  completed?: boolean;
  /** Campos a escribir en la actividad. */
  writes: FieldWrite[];
  /** Lo que hay que decirle al usuario. Vacío: nada que decir. */
  message: string;
  reason: string;
}

// ─────────────────────────────────────────────────────────────────────────────

/** Cronograma de ruta — Diamante, formulario 22814. */
export const CRONOGRAMA: PlanConfig = {
  label: 'Diamante · cronograma de ruta',
  motivos: 'u42TAUKZta',
  visita: 'JySxkjpJKC',
  fecha: 'DV8M7yyfaj',
  desenlaces: [
    { txt: 'APLAZADA', status: '17226' },
    { txt: 'CANCELADA', status: '17535' },
    { txt: 'REALIZADA', status: '17225', completa: true },
  ],
  statusFechaPasada: '27587',
  statusPlanificada: '17223',
  habilitar: {
    modo: 'por-texto',
    mapa: {
      'Registro de visita Mantenimientos': 'JCdPQWv3oO',
      Encuesta: 'q5P28qdLwW',
      'Evaluación de mantenimientos': 'QrHeELcNLI',
      'Acta de entrega servicios especializados': 'hUQgpXq1l8',
      'Visita técnica de servicios complementarios': 'vI6gM7FKYC',
      'Visita técnica mantenimiento de lavado y desinfección': 'rBXs22MDND',
      'Seguimiento comportamiento EPP': 'CCPvCrMb9a',
      'Seguimiento equipos alto riesgo': '3TNNQLSFjy',
      'Inspección QEHS': 'kTZzLYFkKX',
      'Reunión mensual': '3m6kt1Mvsw',
      'Requerimiento del cliente': '3m6kt1Mvsw',
      'Seguimiento operativo': '3m6kt1Mvsw',
      Comite: '3m6kt1Mvsw',
      Capacitación: '3m6kt1Mvsw',
      Otros: '3m6kt1Mvsw',
    },
  },
};

/** Planeador — Brillantex, formulario 16681. */
export const PLANEADOR: PlanConfig = {
  label: 'Brillantex · planeador',
  motivos: 'RE8BjAGvlU',
  visita: 'JySxkjpJKC',
  fecha: 'DV8M7yyfaj',
  desenlaces: [
    { txt: 'APLAZADA', status: '20377' },
    { txt: 'CANCELADA', status: '20378' },
    { txt: 'REALIZADA', status: '20376', completa: true },
  ],
  statusFechaPasada: '26121',
  statusPlanificada: '20379',
  habilitar: {
    modo: 'por-cantidad',
    // Cuatro grupos en paralelo: se habilitan los primeros N de cada uno,
    // donde N es el número de visitas que se respondió.
    grupos: [
      ['3m6kt1Mvsw', 'A2w2UTl3Vn', 'f1BbFtjS0O', 'KoBupoXoGh', 'w5ELYmaKip',
       'owRXpJhqBx', 'mH8d0XO4nc', 'NokDuQkCIm', 'WKXbkXrR1b', '4069NAn7io'],
      ['bgJA0LLTKV', 'jk89PX5k0A', '4WbIe1paqy', 'Sk0UfgDwjt', '69Ush8cjXB',
       'IsbBQN2Mjn', 'lWRwYzN2Hm', 'V3vvGY1MZA', 'Kk2L9hDY72', 'dTyas7r13F'],
      ['1OnIJKJEy8', '5HASsCRAGN', 'uIQ8hEKQjh', 'tOloh0oAGu', '1h7tyzGHVv',
       'icMfrWWF74', 'NAYOoW0Stu', '7kFCzqRiwT', '5aZxFAulu3', 'OLMb4aCKKz'],
      ['0wINUpFRQZ', 'K14goQfhyd', 'N6SBBhuqCz', 'rLlMJVDyiD', 'TsCvqRdzhj',
       'Lr89DdoBkY', 'uEKZ7IU4rY', 'truaJ76QP4', 'zIk6rF4fvJ', 'BhBXU3U4lw'],
    ],
    ninguna: 'NINGUNA',
  },
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evalúa un formulario de planificación.
 *
 * @param status el estado que la actividad tiene ahora.
 */
export function planificar(
  config: PlanConfig,
  fields: readonly AnswerField[],
  status: string,
): PlanOutcome {
  const motivos = readValue(fields, config.motivos);
  const visita = readValue(fields, config.visita);
  const fecha = readValue(fields, config.fecha);

  // Sin motivo ni fecha no hay nada que planificar. Se avisa y se para: es lo
  // único de aquí que el usuario puede corregir en el momento.
  if (motivos === '' && fecha === '') {
    return {
      writes: [],
      message: 'Están sin datos los campos del cronograma de ruta',
      reason: 'Faltan motivo y fecha',
    };
  }

  const desenlace = config.desenlaces.find((item) => item.txt === optionTextOf(valOf(visita)));

  /**
   * La visita ya tiene desenlace: se registra y se acabó.
   *
   * Es el segundo paso del formulario —la actividad se planificó antes y ahora
   * se cierra— así que no se vuelve a habilitar nada.
   */
  if (desenlace) {
    return {
      status: desenlace.status,
      completed: desenlace.completa,
      writes: [],
      message: '',
      reason: `Visita ${desenlace.txt.toLowerCase()}`,
    };
  }

  const cuando = fechaDe(valOf(fecha));

  if (cuando && cuando.getTime() < Date.now()) {
    return {
      status: config.statusFechaPasada,
      writes: [],
      message: 'La fecha de visita no puede ser menor a la actual',
      reason: 'Fecha en el pasado',
    };
  }

  // Se planifica: se habilitan los formularios de los motivos elegidos y se
  // limpia el desenlace, que es lo que se responderá en la visita siguiente.
  const writes = habilitaciones(config, valOf(motivos));

  writes.push({ id: config.visita, val: {}, fty: 'radio', hid: false });

  return {
    status: config.statusPlanificada,
    writes,
    message: '',
    reason: `Planificada · ${writes.length - 1} formularios habilitados`,
  };
}

/** Qué campos hay que habilitar según los motivos elegidos. */
function habilitaciones(config: PlanConfig, motivos: unknown): FieldWrite[] {
  const writes: FieldWrite[] = [];

  if (config.habilitar.modo === 'por-texto') {
    // Casillas: una entrada por motivo marcado.
    const marcados = Array.isArray(motivos) ? motivos : [];

    for (const item of marcados) {
      const txt = optionTextOf(item);
      const field = config.habilitar.mapa[txt];

      if (field) writes.push({ id: field, val: {}, fty: 'form', hid: false });
    }

    return writes;
  }

  const texto = optionTextOf(motivos);

  // «Ninguna»: se ocultan los primeros de cada grupo en vez de habilitarlos.
  if (texto === config.habilitar.ninguna) {
    for (const grupo of config.habilitar.grupos) {
      writes.push({ id: grupo[0], val: {}, fty: 'form', hid: true });
    }

    return writes;
  }

  const cuantas = Number.parseInt(texto || '1', 10);

  for (let i = 0; i < cuantas; i++) {
    for (const grupo of config.habilitar.grupos) {
      if (grupo[i]) writes.push({ id: grupo[i], val: {}, fty: 'form', hid: false });
    }
  }

  return writes;
}

/** El valor crudo de lo que devuelve `readValue`. */
function valOf(entry: unknown): unknown {
  if (entry === '' || entry == null) return null;
  if (Array.isArray(entry)) return entry;

  return (entry as AnswerField).val;
}

/**
 * La fecha de la visita.
 *
 * La app la interpreta con un formato fijo; aquí se deja que el navegador lo
 * intente y, si no puede, **no se bloquea nada**. Una fecha ilegible no debería
 * impedir planificar: el usuario ya la ve escrita en su campo.
 */
function fechaDe(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;

  const date = new Date(value.replace(' ', 'T'));

  return Number.isNaN(date.getTime()) ? null : date;
}
