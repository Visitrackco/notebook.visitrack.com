/**
 * Estados de una actividad y cómo se le explican al usuario.
 *
 * El estado no es decorativo: determina qué se puede hacer con la actividad
 * —una que espera archivos no se puede reasignar, una sin guardar no ha salido
 * del navegador— y es lo primero que alguien mira cuando algo no llegó a
 * Visitrack. Por eso cada estado lleva su propia explicación, y no solo una
 * etiqueta.
 */

import { SurveyAnswer } from './entities.model';

/** Valores de `SurveyAnswers.isSaved`. */
export const ANSWER_STATE = {
  /** Creada o modificada, pero el usuario todavía no pulsó Guardar. */
  UNSAVED: 0,
  /** Guardada localmente; falta subirla. */
  PENDING: 1,
  /** Confirmada en Visitrack. */
  SYNCED: 2,
  /**
   * Guardada, pero retenida hasta que sus archivos estén en el bucket.
   *
   * Sin esta espera la actividad llegaría a Visitrack con las fotos rotas: el
   * servidor procesa los binarios en tandas y puede tardar más que el envío.
   */
  WAITING_BINARIES: 3,
} as const;

/** Tono visual de un estado. Se traduce a color en la hoja de estilos. */
export type StateTone = 'neutral' | 'draft' | 'pending' | 'success' | 'waiting';

/** Cómo se presenta un estado en la interfaz. */
export interface AnswerStateInfo {
  /** Identificador estable, para clases CSS y filtros. */
  key: string;
  label: string;
  /** Qué significa, en una frase. Se muestra en la ayuda y en los tooltips. */
  description: string;
  /** Nombre del icono en `vt-icon`. */
  icon: string;
  tone: StateTone;
}

/**
 * Filtro de estado del listado.
 *
 * El borrador no es un valor de `isSaved` sino la columna `eraser`, así que se
 * representa con -1 para que quepa en el mismo selector.
 */
export const DRAFT_FILTER = -1;

/** Catálogo de estados, en el orden en que se ofrecen al filtrar. */
export const ANSWER_STATES: readonly AnswerStateInfo[] = [
  {
    key: 'draft',
    label: 'Borrador',
    description:
      'Se abrió el formulario pero nunca se guardó. Se elimina sola pasado el tiempo de la regla de borrado.',
    icon: 'clipboard',
    tone: 'draft',
  },
  {
    key: 'unsaved',
    label: 'Sin guardar',
    description: 'Tiene cambios que todavía no se han guardado con el botón del formulario.',
    icon: 'alert',
    tone: 'neutral',
  },
  {
    key: 'pending',
    label: 'Pendiente',
    description: 'Guardada en este navegador pero aún sin subir a Visitrack.',
    icon: 'refresh',
    tone: 'pending',
  },
  {
    key: 'synced',
    label: 'Sincronizada',
    description: 'Confirmada en Visitrack. No queda nada por enviar.',
    icon: 'check',
    tone: 'success',
  },
  {
    key: 'waiting',
    label: 'Esperando archivos',
    description:
      'Lista para enviarse, retenida hasta que sus fotos y documentos estén confirmados en el servidor. Se enviará sola.',
    icon: 'image',
    tone: 'waiting',
  },
];

const BY_KEY = new Map(ANSWER_STATES.map((state) => [state.key, state]));

/** El estado en que se encuentra una actividad. */
export function describeAnswer(answer: Pick<SurveyAnswer, 'isSaved' | 'eraser'>): AnswerStateInfo {
  // El borrador manda sobre `isSaved`: una actividad recién creada tiene
  // isSaved = 0 y eraser = 1, y lo que importa contarle al usuario es que no
  // ha guardado nada todavía.
  if (answer.eraser === 1) return BY_KEY.get('draft')!;

  switch (answer.isSaved) {
    case ANSWER_STATE.PENDING:
      return BY_KEY.get('pending')!;
    case ANSWER_STATE.SYNCED:
      return BY_KEY.get('synced')!;
    case ANSWER_STATE.WAITING_BINARIES:
      return BY_KEY.get('waiting')!;
    default:
      return BY_KEY.get('unsaved')!;
  }
}

/** ¿Coincide la actividad con el filtro de estado elegido? */
export function matchesStateFilter(
  answer: Pick<SurveyAnswer, 'isSaved' | 'eraser'>,
  filter: number | null,
): boolean {
  if (filter === null) return true;
  if (filter === DRAFT_FILTER) return answer.eraser === 1;
  return answer.eraser !== 1 && answer.isSaved === filter;
}

// ─── Regla de borrado ────────────────────────────────────────────────────────

/**
 * Unidades de `Surveys.DeviceMaintType`.
 *
 * Es la política que define cuánto sobrevive una actividad completada en el
 * dispositivo antes de limpiarse sola. La configura quien diseña el formulario,
 * y el usuario tiene derecho a consultarla: de ella depende cuánto tiempo puede
 * trabajar sin conexión antes de perder lo que no subió.
 */
export const DELETE_RULE_UNITS: Record<number, string> = {
  1: 'minutos',
  2: 'horas',
  3: 'días',
};

/** Regla de borrado de un formulario, ya interpretada. */
export interface DeleteRule {
  /** false cuando el formulario no borra nada automáticamente. */
  enabled: boolean;
  /** 'minutos' | 'horas' | 'días'. Vacío si no aplica. */
  unit: string;
  value: number;
  /** Frase completa, lista para mostrar. */
  summary: string;
}

/** Interpreta `DeviceMaintType` / `DeviceMaintValue` de un formulario. */
export function describeDeleteRule(type: unknown, value: unknown): DeleteRule {
  // El tipo puede llegar como número o como texto según de dónde salga el
  // registro (sincronización o creación local), así que se normaliza.
  const typeNumber = Number(type ?? 0) || 0;
  const valueNumber = Number(value ?? 0) || 0;
  const unit = DELETE_RULE_UNITS[typeNumber] ?? '';

  if (!unit || valueNumber <= 0) {
    return {
      enabled: false,
      unit: '',
      value: 0,
      summary: 'Este formulario no borra actividades automáticamente.',
    };
  }

  return {
    enabled: true,
    unit,
    value: valueNumber,
    summary: `Las actividades completadas se eliminan de este equipo ${valueNumber} ${unit} después de terminarse.`,
  };
}
