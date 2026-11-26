import { DispatchStatus } from '../models/entities.model';

/**
 * El estado que recibe una actividad al guardarse completa.
 *
 * Gemela de `lib/Models/VisitrackForm/EstadoDeCompletada.dart` del móvil.
 *
 * ## Cuál es «el de completada»
 *
 * 1. Si el formulario tiene estados propios (`JSONStatuses` no vacío), se busca
 *    **solo entre ellos**, en el orden en que los configuró: primero el que
 *    tenga `IsCompleted = 1`; si ninguno, el primero de base «Completado»
 *    (`BaseStatusID = 3`). Si ninguno cumple, no se pone ninguno — nunca el de
 *    la compañía: el selector de ese formulario no lo ofrece.
 * 2. Si no tiene estados propios, el de la compañía con `IsCompleted = 1`; con
 *    varios, el de menor `DispatchID` (el mismo en todos los equipos).
 * 3. Si no hay ninguno, sin estado.
 *
 * ## Cuándo se pone
 *
 * Lo decide [queLeToca], que es lo que ya se hacía: una actividad con un
 * estado «cerrado» lo conserva, y Brillantex y 3502 pasan siempre a completada.
 */

/** La base «Completado» de los estados de despacho. */
export const BASE_COMPLETADO = 3;

/**
 * Bases de los estados «de trabajo»: la actividad todavía está en curso (1
 * Creado, 2 Asignado, 5 Abierto, 8 En progreso / Recibido). Una consigna llega
 * con uno de estos; al completarla pasa al de completada. Gemela de
 * `EstadoDeCompletada.basesDeTrabajo` del móvil.
 */
export const BASES_DE_TRABAJO: ReadonlySet<number> = new Set([1, 2, 5, 8]);

export function esDeTrabajo(baseStatusId: unknown): boolean {
  return BASES_DE_TRABAJO.has(Number(baseStatusId));
}

const BRILLANTEX = 2259;

/** Las que pasan **siempre** a completada aunque ya tuvieran otro estado. */
const COMPLETADA_SIEMPRE = [BRILLANTEX, 3502];

/** El planeador de Brillantex: su estado lo decide su propia regla. */
const PLANEADOR_SURVEY = '16681';

/**
 * Los `DispatchID` que admite un formulario, en su orden.
 *
 * `JSONStatuses` llega como `[1,2,3]`, `["1","2"]` o `[{"DispatchID":1}]` —a
 * veces con `id` o `ID`—. Vacío o ilegible es «todos los de la compañía».
 */
export function idsDelFormulario(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];

  try {
    const decoded = JSON.parse(raw);
    if (!Array.isArray(decoded)) return [];

    return decoded
      .map((entry) => {
        if (entry && typeof entry === 'object') {
          const record = entry as Record<string, unknown>;
          return String(record['DispatchID'] ?? record['id'] ?? record['ID'] ?? '').trim();
        }
        return String(entry ?? '').trim();
      })
      .filter(Boolean);
  } catch {
    console.error('[Estados] JSONStatuses ilegible');
    return [];
  }
}

type EstadoMinimo = Pick<DispatchStatus, 'DispatchID' | 'IsCompleted' | 'BaseStatusID'>;

/**
 * El estado de completada para un formulario, o `null`.
 *
 * [catalogo] son los estados de la compañía **sin los eliminados**.
 */
export function elegirEstadoDeCompletada<T extends EstadoMinimo>(
  catalogo: readonly T[],
  delFormulario: readonly string[],
): T | null {
  if (delFormulario.length) {
    const propios = delFormulario
      .map((id) => catalogo.find((s) => String(s.DispatchID) === id))
      .filter((s): s is T => !!s);

    return (
      propios.find((s) => Number(s.IsCompleted) === 1) ??
      propios.find((s) => Number(s.BaseStatusID) === BASE_COMPLETADO) ??
      null
    );
  }

  const completados = catalogo
    .filter((s) => Number(s.IsCompleted) === 1)
    .sort((a, b) => Number(a.DispatchID) - Number(b.DispatchID));

  return completados[0] ?? null;
}

/**
 * El estado con el que queda la actividad al completarse, o `null` si el
 * guardado no la toca. Puede ser el mismo que ya tenía.
 *
 * - `actual`: lo que tiene en `Status`, tal cual.
 * - `cerrado`: si ese estado está en el catálogo y no es de base «Completado».
 * - `meta`: el `DispatchID` que dio [elegirEstadoDeCompletada], o `null`.
 */
export function queLeToca(input: {
  actual: string;
  cerrado: boolean;
  meta: string | null;
  compania: number;
  formulario: string;
  /** El estado actual es de una base «de trabajo» ([BASES_DE_TRABAJO]). */
  deTrabajo?: boolean;
  /** El estado cambió mientras se llenaba (lo eligió el usuario o una regla). */
  elegidoAlEditar?: boolean;
}): string | null {
  const { actual, cerrado, meta, compania, formulario } = input;
  if (!meta) return null;

  // Un estado de trabajo que no se eligió al llenarla (el «Abierto» o
  // «Asignado» que traía la consigna) pasa al de completada.
  if (cerrado && input.deTrabajo && !input.elegidoAlEditar) return meta;

  if (!cerrado) {
    if (compania === BRILLANTEX && formulario === PLANEADOR_SURVEY && actual !== meta) return null;
    return actual.trim() ? actual : meta;
  }

  return COMPLETADA_SIEMPRE.includes(compania) ? meta : null;
}
