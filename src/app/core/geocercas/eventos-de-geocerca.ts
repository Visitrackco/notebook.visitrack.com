/**
 * El historial de eventos de geocerca: la lista, no el detalle de uno.
 *
 * Código puro —sin Angular, sin navegador— para poder probar lo que decide lo
 * que se ve en cada fila:
 *
 * - **Con servidor**, las filas son lo que diga cloud-gold
 *   (`GET /geofence-flows/mis-eventos`), ya filtradas y paginadas allá.
 * - **Sin servidor** —sin red, caído, sin desplegar— se arman con lo guardado
 *   en `EventosGeocerca`, con el mismo texto y la misma medida de dentro/fuera
 *   que la pantalla del detalle ([vistaDesdeLocal]). El filtro y la página se
 *   hacen aquí.
 * - Lo que este navegador aún no subió no está en el servidor: se marca como
 *   «pendiente de enviar» y, con servidor, se suma arriba en la primera página.
 */

import { EventoLocal, vistaDesdeLocal } from './evento-de-geocerca';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/** Cuántos eventos por página, aquí y en el servidor. */
export const TAM_PAGINA = 25;

/** Una fila de la lista, venga de donde venga. */
export interface FilaDeEvento {
  clave: string;
  /** ISO. */
  en: string;
  tipo: string;
  momento: string | null;
  /** «Entró a Casa», «Guardó una actividad estando dentro de Bodega»… */
  evento: string;
  /** `null` si no se pudo saber. */
  dentro: boolean | null;
  distanciaMetros: number | null;
  geocerca: { id: number; nombre: string } | null;
  flujo: string;
  regla: string;
  formulario: string;
  /** Guardado en este navegador y todavía sin contar al servidor. */
  pendiente: boolean;
}

export interface GeocercaDelFiltro {
  id: number;
  nombre: string;
}

/** Los filtros de la pantalla. Fechas `YYYY-MM-DD`, ambas incluidas. */
export interface FiltroDeEventos {
  desde: string;
  hasta: string;
  /** `null`: todas. */
  geocerca: number | null;
}

export interface PaginaDeEventos {
  origen: 'servidor' | 'local';
  total: number;
  pagina: number;
  tam: number;
  filas: FilaDeEvento[];
  geocercas: GeocercaDelFiltro[];
}

/** Una fila de `EventosGeocerca`, como la guarda `GeocercasService`. */
export interface FilaGuardada {
  Clave?: string;
  Payload: EventoLocal;
  Enviado: 0 | 1;
}

// ─── Lectores tolerantes ─────────────────────────────────────────────────────

const obj = (v: unknown): Json | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const numero = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const geocercaDe = (v: unknown): GeocercaDelFiltro | null => {
  const g = obj(v);
  const id = numero(g?.id);
  return g && id !== null ? { id, nombre: str(g.nombre) } : null;
};

// ─── Fechas ──────────────────────────────────────────────────────────────────

/** `YYYY-MM-DD` de una fecha, en la hora de quien mira. */
export function diaLocal(fecha: Date): string {
  const dos = (n: number) => String(n).padStart(2, '0');
  return `${fecha.getFullYear()}-${dos(fecha.getMonth() + 1)}-${dos(fecha.getDate())}`;
}

/** Los últimos siete días, hoy incluido. */
export function rangoPorDefecto(hoy = new Date()): { desde: string; hasta: string } {
  const desde = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - 6);
  return { desde: diaLocal(desde), hasta: diaLocal(hoy) };
}

/** Si el evento cae en el rango, comparando por día local. */
export function enElRango(iso: string, desde: string, hasta: string): boolean {
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return false;
  const dia = diaLocal(fecha);
  return (!desde || dia >= desde) && (!hasta || dia <= hasta);
}

// ─── Del servidor ────────────────────────────────────────────────────────────

/** Un evento de `mis-eventos`. `null` si no trae ni la clave. */
export function filaDesdeServidor(crudo: unknown): FilaDeEvento | null {
  const e = obj(crudo);
  if (!e || !str(e.clave)) return null;
  return {
    clave: str(e.clave),
    en: str(e.en),
    tipo: str(e.tipo),
    momento: str(e.momento) || null,
    evento: str(e.evento),
    dentro: typeof e.dentro === 'boolean' ? e.dentro : null,
    distanciaMetros: numero(e.distanciaMetros),
    geocerca: geocercaDe(e.geocerca),
    flujo: str(obj(e.flujo)?.nombre),
    regla: str(obj(e.regla)?.nombre),
    formulario: str(e.formulario),
    pendiente: false,
  };
}

/** La respuesta entera. `null` si no se entiende: entonces cuenta como caído. */
export function paginaDesdeServidor(crudo: unknown): PaginaDeEventos | null {
  const r = obj(crudo);
  if (!r || !Array.isArray(r.eventos)) return null;
  const filas = r.eventos.map(filaDesdeServidor).filter((f: FilaDeEvento | null): f is FilaDeEvento => !!f);
  return {
    origen: 'servidor',
    total: numero(r.total) ?? filas.length,
    pagina: numero(r.pagina) ?? 1,
    tam: numero(r.tam) ?? TAM_PAGINA,
    filas,
    geocercas: arr(r.geocercas)
      .map(geocercaDe)
      .filter((g): g is GeocercaDelFiltro => !!g),
  };
}

// ─── De este navegador ───────────────────────────────────────────────────────

/** Busca el `JSONMovil` del flujo del evento entre los descargados. */
function flujoDelEvento(flujos: unknown[], flujoId: number): unknown {
  for (const f of flujos) {
    try {
      const leido = typeof f === 'string' ? JSON.parse(f) : f;
      if (Number(obj(leido)?.id) === Number(flujoId)) return leido;
    } catch {
      // Un flujo ilegible no es el que se busca.
    }
  }
  return null;
}

/**
 * Una fila de `EventosGeocerca` hecha fila de la lista: el texto y dentro/fuera
 * salen de [vistaDesdeLocal], como en el detalle. `flujos` son los `JSONMovil`
 * de `FlujosGeocerca` (texto o ya leídos).
 */
export function filaDesdeLocal(guardada: FilaGuardada, flujos: unknown[]): FilaDeEvento | null {
  const e = guardada?.Payload;
  if (!e || !str(e.clave || guardada.Clave)) return null;
  const evento: EventoLocal = { ...e, clave: str(e.clave || guardada.Clave) };
  const vista = vistaDesdeLocal(evento, flujoDelEvento(flujos, evento.flujoId), '');
  return {
    clave: vista.clave,
    en: vista.en,
    tipo: vista.tipo,
    momento: vista.momento,
    evento: vista.evento,
    dentro: vista.dentro,
    distanciaMetros: vista.distanciaMetros,
    // Sin el flujo descargado no hay nombre, pero el id sigue sirviendo para filtrar.
    geocerca: { id: Number(evento.geocercaId) || 0, nombre: vista.geocerca?.nombre ?? '' },
    flujo: vista.flujo,
    regla: vista.regla,
    formulario: '',
    pendiente: guardada.Enviado !== 1,
  };
}

const masRecientePrimero = (a: FilaDeEvento, b: FilaDeEvento) =>
  (Date.parse(b.en) || 0) - (Date.parse(a.en) || 0);

const pasaElFiltro = (f: FilaDeEvento, filtro: FiltroDeEventos) =>
  enElRango(f.en, filtro.desde, filtro.hasta) &&
  (filtro.geocerca === null || f.geocerca?.id === filtro.geocerca);

/** Las geocercas con nombre que aparecen en las filas, por nombre. */
export function geocercasDe(filas: FilaDeEvento[]): GeocercaDelFiltro[] {
  const vistas = new Map<number, string>();
  for (const f of filas) {
    if (f.geocerca && f.geocerca.nombre && !vistas.has(f.geocerca.id)) {
      vistas.set(f.geocerca.id, f.geocerca.nombre);
    }
  }
  return [...vistas]
    .map(([id, nombre]) => ({ id, nombre }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

/** Filtra, ordena (más reciente primero) y corta la página, todo aquí. */
export function paginaLocal(
  filas: FilaDeEvento[],
  filtro: FiltroDeEventos,
  pagina = 1,
  tam = TAM_PAGINA,
): PaginaDeEventos {
  const enRango = filas.filter((f) => enElRango(f.en, filtro.desde, filtro.hasta));
  const filtradas = enRango.filter((f) => pasaElFiltro(f, filtro)).sort(masRecientePrimero);
  const ultima = Math.max(1, Math.ceil(filtradas.length / tam));
  const p = Math.min(Math.max(1, pagina), ultima);
  return {
    origen: 'local',
    total: filtradas.length,
    pagina: p,
    tam,
    filas: filtradas.slice((p - 1) * tam, p * tam),
    // Las del rango y no solo las del filtro: si no, elegir una borraría las otras.
    geocercas: geocercasDe(enRango),
  };
}

/**
 * Con servidor, lo pendiente de este navegador no está allá todavía: se suma
 * arriba en la primera página, sin repetir lo que ya subió. El total sigue
 * siendo el del servidor, que es el que manda en la paginación.
 */
export function sumarPendientes(
  pagina: PaginaDeEventos,
  locales: FilaDeEvento[],
  filtro: FiltroDeEventos,
): PaginaDeEventos {
  const yaEstan = new Set(pagina.filas.map((f) => f.clave));
  const pendientes = locales
    .filter((f) => f.pendiente && !yaEstan.has(f.clave) && pasaElFiltro(f, filtro))
    .sort(masRecientePrimero);
  if (!pendientes.length) return pagina;

  const conocidas = new Map(pagina.geocercas.map((g) => [g.id, g]));
  for (const g of geocercasDe(pendientes)) if (!conocidas.has(g.id)) conocidas.set(g.id, g);

  return {
    ...pagina,
    filas: pagina.pagina === 1 ? [...pendientes, ...pagina.filas] : pagina.filas,
    geocercas: [...conocidas.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
  };
}
