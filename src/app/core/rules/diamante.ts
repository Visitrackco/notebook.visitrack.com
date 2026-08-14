import { AnswerField } from '../forms/form-schema';
import { readRows } from '../forms/master-detail';
import { readValue } from './brillantex';

/**
 * Diamante (2030) — cubrimientos.
 *
 * Formularios `14051`, `14319`–`14322`, `14328`, `14329`, `14330` y `14569`.
 *
 * ## Qué comprueba
 *
 * Que el número de cubrimientos **calificados** coincida con el total
 * solicitado. Cada fila de la tabla tiene que traer su calificación y su
 * observación; si falta cualquiera de las dos, la fila no cuenta y la actividad
 * no se cierra.
 *
 * ## Por qué casi todo termina en silencio
 *
 * En la app, salvo el total en cero, todos los desenlaces son `return false`
 * sin mensaje: la actividad se guarda y ya. Se replica igual — avisar aquí de
 * cosas de las que la app no avisa cambiaría lo que el usuario espera, y en un
 * formulario que se llena a diario eso se nota más que un mensaje de más.
 */

/** Total solicitado. */
const TOTAL = 'VldXXT91EH';

/** Tabla con una fila por cubrimiento. */
const CALIFICACION = '5WT9XJBdji';

/** La calificación de la fila, en cualquiera de sus dos formularios. */
const OPCION = ['7s3W23xXuJ', 'MUhYIn3I2i'];

/** Y su observación. */
const OBSERVACION = ['Ftl8T8urAk', 'mjZ8Ch7Y8u'];

/** Estado cuando todo está calificado. */
const COMPLETA = '16848';

export interface CubrimientosOutcome {
  status?: string;
  completed?: boolean;
  message: string;
  reason: string;
}

export function cubrimientos(fields: readonly AnswerField[]): CubrimientosOutcome {
  const totalField = readValue(fields, TOTAL);
  const total = Number.parseFloat(String(valorDe(totalField) ?? '0')) || 0;

  if (total === 0) {
    return {
      message: 'Debe tener una cantidad valida en total solicitado',
      reason: 'Total solicitado en cero',
    };
  }

  const rowsValue = readValue(fields, CALIFICACION);
  const rows = Array.isArray(rowsValue) ? readRows(rowsValue) : [];

  if (rows.length === 0) {
    return { message: '', reason: 'Sin cubrimientos calificados' };
  }

  // El número de filas tiene que cuadrar con lo solicitado: calificar de más o
  // de menos no es una calificación completa.
  if (rows.length !== total) {
    return {
      message: '',
      reason: `Hay ${rows.length} filas y se solicitaron ${total}`,
    };
  }

  let calificadas = 0;

  for (const row of rows) {
    const valores = (row.JSONValues ?? []) as AnswerField[];

    const opcion = valores.find((entry) => OPCION.includes(entry.id));
    const observacion = valores.find((entry) => OBSERVACION.includes(entry.id));

    if (!opcion || !observacion) {
      return { message: '', reason: 'Una fila no tiene calificación u observación' };
    }

    if (vacio(opcion.val) || vacio(observacion.val)) {
      return { message: '', reason: 'Una fila quedó sin responder' };
    }

    calificadas++;
  }

  if (calificadas === total) {
    return {
      status: COMPLETA,
      completed: true,
      message: '',
      reason: `${calificadas} cubrimientos calificados`,
    };
  }

  return { message: '', reason: 'Faltan cubrimientos por calificar' };
}

function valorDe(entry: unknown): unknown {
  if (entry === '' || entry == null || Array.isArray(entry)) return null;

  return (entry as AnswerField).val;
}

function vacio(value: unknown): boolean {
  return value === '' || value == null;
}
