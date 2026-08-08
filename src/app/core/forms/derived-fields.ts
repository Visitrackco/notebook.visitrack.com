import { CalculationElement, FieldValue, FormField, FormPage } from './form-schema';
import { readRows } from './master-detail';

/**
 * Campos cuyo valor no se escribe: se calcula.
 *
 * Son tres y comparten forma —solo lectura, resultado numérico, y dependen de
 * otros campos— pero cada uno saca el número de un sitio distinto.
 */
export const DERIVED_TYPES = new Set(['calculation', 'sumdetail', 'datediff']);

/** ¿Este campo se calcula solo? */
export function isDerived(fty: string): boolean {
  return DERIVED_TYPES.has(fty);
}

/** De dónde se lee el valor de otro campo. */
export type ValueReader = (fieldId: string) => FieldValue;

/**
 * Operaciones de un campo calculado.
 *
 * El código lo escribe el diseñador del formulario y viaja en el esquema; son
 * los mismos cuatro de la app.
 */
const OPERATIONS: Record<number, (before: number, after: number) => number> = {
  1: (before, after) => before + after,
  2: (before, after) => before - after,
  3: (before, after) => before * after,
  4: (before, after) => before / after,
};

/**
 * Resuelve un campo calculado (`calculation`).
 *
 * ## La fórmula
 *
 * Vive en `ele`: una lista de operandos donde uno lleva `isFirst` —el valor
 * base— y el resto se aplican sobre el acumulado. Cada operando es una
 * constante (`isk`) o el valor de otro campo (`fie`), y `ope` dice qué se hace
 * con él: 1 sumar, 2 restar, 3 multiplicar, 4 dividir.
 *
 * ## El orden no es el que parece
 *
 * Los operandos **no** se aplican en el orden en que están escritos, sino
 * ordenados por su código `ope` **de mayor a menor**: primero las divisiones,
 * luego las multiplicaciones, luego las restas y por último las sumas. Es una
 * precedencia propia del motor de Visitrack —ni la matemática ni la de
 * escritura— y replicarla importa: la misma fórmula tiene que dar el mismo
 * número en el teléfono y aquí.
 *
 * Un valor vacío o no numérico cuenta como cero. Conviene tenerlo presente al
 * dividir: dividir por un campo sin responder da infinito, y eso es lo que se
 * guardaría.
 */
export function computeCalculation(field: FormField, read: ValueReader): number {
  const elements = Array.isArray(field.ele) ? field.ele : [];
  if (elements.length === 0) return 0;

  const base = elements.find((element) => element.isFirst);
  const rest = elements.filter((element) => !element.isFirst);

  // Ascendente y luego invertido: es lo que hace la app, y con un orden estable
  // dos operandos del mismo `ope` conservan su orden original.
  const ordered = [...rest]
    .sort((a, b) => Number(a.ope ?? 0) - Number(b.ope ?? 0))
    .reverse();

  let total = base ? operandOf(base, read) : 0;

  for (const element of ordered) {
    const operation = OPERATIONS[Number(element.ope ?? 0)];
    if (!operation) continue;

    total = operation(total, operandOf(element, read));
  }

  return total;
}

/** El valor de un operando: su constante, o lo que valga el campo al que apunta. */
function operandOf(element: CalculationElement, read: ValueReader): number {
  if (element.isk) return toNumber(element.val);

  return toNumber(read(String(element.fie ?? '')));
}

/**
 * Suma una columna de una tabla de detalle (`sumdetail`).
 *
 * `mde` dice de qué tabla y `fid` qué campo de cada fila se acumula. Solo suma:
 * no hay operaciones que configurar. Para combinarla con otra cosa —un
 * impuesto, otra suma— se usa un campo calculado que la tome como operando.
 *
 * Las filas ocultas no se distinguen de las demás: en una tabla de detalle no
 * hay visibilidad condicionada de filas, solo de los campos de dentro.
 */
export function computeSumDetail(field: FormField, read: ValueReader): number {
  const rows = readRows(read(String(field.mde ?? '')));
  const target = String(field.fid ?? '');

  if (!target) return 0;

  let sum = 0;

  for (const row of rows) {
    const entry = (row.JSONValues ?? []).find((answer) => answer.id === target);
    if (entry) sum += toNumber(entry.val);
  }

  return sum;
}

/**
 * Días entre dos fechas (`datediff`).
 *
 * `dat1` es la inicial y `dat2` la final; el resultado es `dat2 - dat1` en
 * días. Las horas se descartan: la app compara las fechas ya recortadas a
 * `yyyy-MM-dd`, así que dos momentos del mismo día dan cero por muchas horas
 * que los separen.
 *
 * Devuelve cadena vacía —y no cero— si falta alguna de las dos o no se
 * entienden: cero significaría «el mismo día», que es una respuesta, y aquí no
 * hay ninguna.
 */
export function computeDateDiff(field: FormField, read: ValueReader): number | '' {
  const from = toDate(read(String(field.dat1 ?? '')));
  const to = toDate(read(String(field.dat2 ?? '')));

  if (!from || !to) return '';

  const DAY = 24 * 60 * 60 * 1000;
  return Math.round((to.getTime() - from.getTime()) / DAY);
}

/** El valor de un campo derivado, sea del tipo que sea. */
export function computeDerived(field: FormField, read: ValueReader): FieldValue {
  switch (field.fty) {
    case 'calculation':
      return numberToValue(computeCalculation(field, read));

    case 'sumdetail':
      return numberToValue(computeSumDetail(field, read));

    case 'datediff': {
      const days = computeDateDiff(field, read);
      return days === '' ? '' : String(days);
    }

    default:
      return '';
  }
}

/**
 * Los campos derivados de un formulario, en orden de dependencia.
 *
 * Uno puede alimentarse de otro —lo normal es un total que suma una tabla y un
 * segundo campo que le aplica el impuesto—, así que el orden importa: calcular
 * el impuesto antes que el total lo dejaría una vuelta por detrás. Se resuelve
 * en varias pasadas en vez de con un grafo, que para tres o cuatro campos sería
 * maquinaria de más.
 */
export function derivedFieldsOf(pages: readonly FormPage[]): FormField[] {
  const found: FormField[] = [];

  for (const page of pages) {
    for (const field of page.fie) {
      if (isDerived(field.fty)) found.push(field);
    }
  }

  return found;
}

/**
 * Un resultado numérico, como texto.
 *
 * Se guarda en texto porque es como lo escribe la app y como lo espera el
 * servidor. Los enteros van sin decimales —`3`, no `3.0`— y lo que no es un
 * número real (una división por cero) queda vacío en vez de escribir `Infinity`
 * en la respuesta.
 */
function numberToValue(value: number): string {
  if (!Number.isFinite(value)) return '';

  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

/** Lo que la app llama `_toDouble`: vacío, nulo o no numérico valen cero. */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;

  const parsed = Number(value.trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Interpreta el valor de un campo de fecha.
 *
 * Se construye con componentes y no con `new Date(texto)` porque esa forma lee
 * `2026-08-05` como UTC: al oeste de Greenwich saldría el día anterior, y una
 * diferencia de días saldría desplazada.
 */
function toDate(value: FieldValue): Date | null {
  if (typeof value !== 'string') return null;

  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;

  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}
