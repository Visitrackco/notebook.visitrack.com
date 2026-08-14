import { AnswerField } from '../forms/form-schema';

/**
 * Reglas de estado por compañía.
 *
 * ## Qué son
 *
 * Algunas compañías deciden el **estado** de la actividad a partir de lo que se
 * respondió: si falta la firma queda «pendiente», si el trabajo se cerró queda
 * «terminado». En la app móvil esto vive en `Models/VisitrackForm/LogicExternal`,
 * una clase por empresa con un método por formulario.
 *
 * ## Por qué aquí son datos y no código
 *
 * Leído de cerca, ese código siempre hace lo mismo: mirar unos campos por su
 * identificador, comparar, y decidir un estado. Escribirlo como condiciones
 * hace tres cosas que la versión en código no puede:
 *
 * 1. **Se lee.** La regla de Inverpack cabe en doce líneas y se entiende sin
 *    seguir el hilo de un `if` anidado.
 * 2. **Se puede probar** sin base de datos ni pantalla.
 * 3. **Se puede mover al servidor** el día que se decida que estas reglas no
 *    deben vivir repartidas por los clientes. Una tabla de condiciones viaja;
 *    seis mil líneas de Dart, no.
 *
 * ## Fidelidad antes que corrección
 *
 * Se replica **lo que la app hace hoy**, incluidos sus bordes raros. Ver
 * [valueOf] para el caso más notable. Corregir aquí lo que allá sigue igual
 * produciría dos aplicaciones que ponen estados distintos a la misma actividad,
 * que es peor que el borde raro.
 */

/** Una comprobación sobre un campo, por su identificador. */
export type Check =
  | { field: string; is: 'vacío' }
  | { field: string; is: 'con valor' }
  | { field: string; is: 'igual a'; to: string }
  | { field: string; is: 'distinto de'; to: string };

/**
 * Un caso de la regla. Gana el primero que se cumpla.
 *
 * `all` exige todas; `any`, al menos una. Un caso sin ninguna de las dos es el
 * caso por omisión y siempre se cumple.
 */
export interface StatusCase {
  /** Por qué se aplicó. Se registra en consola: es lo que hace depurable esto. */
  reason: string;
  all?: Check[];
  any?: Check[];
  status: string;
}

export interface StatusRule {
  company: number;
  /** Formularios a los que aplica. Vacío o ausente: todos los de la compañía. */
  surveys?: string[];
  label: string;
  cases: StatusCase[];
}

/**
 * El valor de un campo, con la misma lectura que hace la app.
 *
 * `_getValue` en Dart devuelve, según el tipo:
 * - `radio` → el texto de la opción
 * - `signature` → el identificador del archivo
 * - `masterdetail` → el arreglo de filas
 * - **cualquier otro** → el campo entero si `val` no es nulo, y `''` si lo es
 *
 * Esa última rama tiene una consecuencia que conviene tener presente: un campo
 * cuyo valor es la cadena vacía **cuenta como lleno**, porque lo que se compara
 * es el objeto, no el texto. No se corrige aquí a propósito: la app hace eso
 * hoy, y arreglarlo solo de este lado pondría estados distintos según desde
 * dónde se guarde.
 */
export function valueOf(fields: readonly AnswerField[], id: string): unknown {
  const found = fields.find((entry) => entry.id === id);

  if (!found) return '';

  const value = found.val as Record<string, unknown> | unknown[] | string | null;

  if (found.fty === 'radio') {
    return (value as Record<string, unknown>)?.['txt'] ?? '';
  }

  if (found.fty === 'signature') {
    return (value as Record<string, unknown>)?.['bin'] ?? '';
  }

  if (found.fty === 'masterdetail') {
    return value ?? [];
  }

  return value != null ? found : '';
}

/** ¿Se cumple esta comprobación? */
function passes(fields: readonly AnswerField[], check: Check): boolean {
  const value = valueOf(fields, check.field);
  const empty = value === '' || value == null;

  switch (check.is) {
    case 'vacío':
      return empty;
    case 'con valor':
      return !empty;
    case 'igual a':
      return String(value) === check.to;
    case 'distinto de':
      return String(value) !== check.to;
  }
}

/**
 * El estado que corresponde, o `null` si ninguna regla aplica.
 *
 * Función pura: recibe los datos y devuelve una decisión. No escribe nada.
 */
export function statusFor(
  rules: readonly StatusRule[],
  companyId: number,
  surveyId: string,
  fields: readonly AnswerField[],
): { status: string; reason: string; rule: string } | null {
  const rule = rules.find(
    (entry) =>
      Number(entry.company) === Number(companyId) &&
      (!entry.surveys?.length || entry.surveys.includes(String(surveyId))),
  );

  if (!rule) return null;

  for (const item of rule.cases) {
    const all = item.all?.every((check) => passes(fields, check)) ?? true;
    const any = item.any ? item.any.some((check) => passes(fields, check)) : true;

    if (all && any) {
      return { status: item.status, reason: item.reason, rule: rule.label };
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Las reglas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inverpack — cierre de mantenimiento.
 *
 * Traducción de `Inverpack.mttoFinish()`. Los identificadores son los mismos
 * que allá, escritos a mano en el formulario; si el diseñador los cambia, la
 * regla deja de encontrarlos y **no hace nada** — igual que hoy, donde el
 * `catch` se lo traga en silencio. Por eso cada caso se registra en consola
 * cuando se aplica: es la única forma de notar que dejó de aplicarse.
 */
const INVERPACK: StatusRule = {
  company: 3596,
  surveys: ['19081'],
  label: 'Inverpack · cierre de mantenimiento',
  cases: [
    {
      reason: 'Falta la firma, la fecha o la hora',
      any: [
        { field: 'Rqk20rxjTT', is: 'vacío' },
        { field: 'F0GKilycSy', is: 'vacío' },
        { field: 'FgAUDxYWRc', is: 'vacío' },
      ],
      status: '24317',
    },
    {
      reason: 'Se respondió que el trabajo no quedó cerrado',
      all: [
        { field: '2eCwnRscDk', is: 'con valor' },
        { field: '2eCwnRscDk', is: 'distinto de', to: 'SI' },
      ],
      status: '24317',
    },
    {
      reason: 'Cerrado y firmado',
      status: '24318',
    },
  ],
};

/** Todas las reglas conocidas. */
export const STATUS_RULES: readonly StatusRule[] = [INVERPACK];
