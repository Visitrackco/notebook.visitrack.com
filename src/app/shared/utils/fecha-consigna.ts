/**
 * Para cuándo es una consigna, como `YYYY-MM-DD HH:mm`.
 *
 * Llega partida en dos columnas de `SurveysAnswers`: `DueDate` es una fecha
 * (`2026-11-02T00:00:00.000Z`) y `DueTime` una hora pegada al 1 de enero de
 * 1970 (`1970-01-01T08:00:00.000Z`). Las dos están en hora local de quien la
 * hace aunque traigan la `Z`: se toma el texto tal cual, sin convertir. Es lo
 * mismo que hace el móvil (`_fechaDeConsigna` en `Sync.dart`).
 *
 * Con ese formato se ordena comparando texto. Vacío si no trae fecha.
 */
export function fechaDeConsigna(r: Record<string, unknown>): string {
  const d = String(r['DueDate'] ?? '');
  if (d.length < 10 || d.startsWith('1900')) return '';

  const t = String(r['DueTime'] ?? '');
  const hora = t.includes('T') && t.length >= 16 ? t.substring(11, 16) : t.length >= 5 ? t.substring(0, 5) : '';

  return hora ? `${d.substring(0, 10)} ${hora}` : d.substring(0, 10);
}

const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/**
 * La fecha de la consigna para leerla: «lun 2 nov · 8:00 a. m.», con el año
 * solo si no es el corriente. Vacío si no hay fecha.
 */
export function etiquetaDeConsigna(due: string | undefined): string {
  const t = (due ?? '').trim();
  if (t.length < 10) return '';

  const [y, m, d] = t.substring(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '';

  // Mediodía: la fecha es local y no debe correrse de día por la zona horaria.
  const f = new Date(y, m - 1, d, 12);
  const delAnio = y === new Date().getFullYear() ? '' : ` ${y}`;
  const dia = `${DIAS[f.getDay()]} ${d} ${MESES[m - 1]}${delAnio}`;

  if (t.length < 16) return dia;

  const h = Number(t.substring(11, 13)) || 0;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${dia} · ${h12}:${t.substring(14, 16)} ${h < 12 ? 'a. m.' : 'p. m.'}`;
}
