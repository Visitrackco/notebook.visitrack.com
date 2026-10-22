/**
 * La vista de **un** evento de geocerca: lo que se enseña al tocar su alerta.
 *
 * Código puro —sin Angular, sin navegador— para poder probar las dos cosas que
 * deciden lo que se ve:
 *
 * - **De dónde salen los datos.** Lo que diga cloud-gold
 *   (`GET /geofence-flows/eventos/:clave`) manda: conoce el evento de cualquier
 *   persona, el nombre de todo y trae la foto del mapa. Lo local —el evento en
 *   `EventosGeocerca` y la geometría en `FlujosGeocerca`— es el respaldo para
 *   cuando no hay red o el servidor no responde, y además rellena lo que al
 *   servidor le falte (la geometría para el dibujo, por ejemplo).
 * - **Qué pasó, dicho en palabras.** Sin servidor, el «Entró a Casa» se arma
 *   aquí, con el mismo vocabulario que usan Module y el teléfono.
 */

import { dentroDelPoligono, metrosEntre } from './vigia-de-geocercas';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export type TipoDeEvento = 'ENTRAR' | 'SALIR' | 'PERMANECER' | 'CERCA' | 'MOMENTO';

/** Un punto de una geocerca por puntos, como viene en `JSONMovil`. */
export interface PuntoDeGeocerca {
  clave: string;
  nombre: string;
  lat: number;
  lng: number;
  radio: number;
}

/** La geometría de una geocerca, lo justo para medir y dibujar. */
export interface GeometriaDeGeocerca {
  id: number;
  nombre: string;
  forma: string;
  /** Vértices `[lat, lng]`; vacío si es por puntos. */
  poligono: [number, number][];
  puntos: PuntoDeGeocerca[];
}

/** Lo que pinta la pantalla, venga de donde venga. */
export interface VistaDeEvento {
  clave: string;
  origen: 'servidor' | 'local';
  tipo: TipoDeEvento | string;
  momento: string | null;
  /** «Entró a Casa», «Guardó una actividad estando dentro de Bodega»… */
  evento: string;
  /** ISO. */
  en: string;
  lat: number;
  lng: number;
  usuario: string;
  flujo: string;
  regla: string;
  geocerca: GeometriaDeGeocerca | null;
  punto: { clave: string; nombre: string } | null;
  /** `null` si no se pudo saber (sin geometría). */
  dentro: boolean | null;
  /** Metros al borde de la geocerca (o del radio del punto); `null` si no se sabe. */
  distanciaMetros: number | null;
  mapaUrl: string | null;
  contexto: { answerGuid: string; surveyId: number | null; formulario: string } | null;
}

/** El payload guardado en `EventosGeocerca` (ver `GeocercasService.guardarEvento`). */
export interface EventoLocal {
  clave: string;
  flujoId: number;
  reglaId: string;
  geocercaId: number;
  punto: string | null;
  tipo: string;
  lat: number;
  lng: number;
  en: string;
  momento?: string;
  contexto?: { answerGuid: string; surveyId: number | null } | null;
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

/** Lee una geocerca de `JSONMovil` o de la respuesta del servidor. */
export function leerGeometria(crudo: unknown): GeometriaDeGeocerca | null {
  const g = obj(crudo);
  if (!g) return null;
  const poligono = arr(g.poligono)
    .map((v) => (Array.isArray(v) ? [Number(v[0]), Number(v[1])] : null))
    .filter((v): v is [number, number] => !!v && v.every(Number.isFinite));
  const puntos = arr(g.puntos)
    .map((p) => obj(p))
    .filter((p): p is Json => !!p)
    .map((p) => ({
      clave: str(p.clave),
      nombre: str(p.nombre),
      lat: Number(p.lat),
      lng: Number(p.lng),
      radio: numero(p.radio) ?? 100,
    }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  return {
    id: Number(g.id) || 0,
    nombre: str(g.nombre),
    forma: str(g.forma) || (poligono.length >= 3 ? 'POLYGON' : 'CIRCLE'),
    poligono,
    puntos,
  };
}

// ─── El texto del evento ─────────────────────────────────────────────────────

/** Qué hizo la persona en cada momento de la app. */
const ACCION_DEL_MOMENTO: Record<string, string> = {
  'actividad-crear': 'Creó una actividad',
  'actividad-actualizar': 'Actualizó una actividad',
  'actividad-guardar': 'Guardó una actividad',
  'actividad-eliminar': 'Eliminó una actividad',
  'sesion-iniciar': 'Inició sesión',
  'sesion-cerrar': 'Cerró sesión',
  'recorrido-empezar': 'Empezó un recorrido',
  'recorrido-terminar': 'Terminó un recorrido',
};

export interface DatosDelTexto {
  tipo: string;
  momento?: string | null;
  geocerca: string;
  punto?: string | null;
  /** Solo momentos: `dentro`, `fuera` o `cerca`, como el `donde` de la regla. */
  donde?: string | null;
}

/**
 * «Entró a Casa», «Salió de Casa», «Pasó cerca de Punto 1», «Guardó una
 * actividad estando dentro de Bodega»… El mismo vocabulario que el servidor.
 */
export function textoDelEvento(d: DatosDelTexto): string {
  const geocerca = d.geocerca.trim() || 'la geocerca';
  const punto = (d.punto ?? '').trim();
  // En una geocerca por puntos, el punto dice más que el nombre de la cerca.
  const lugar = punto && punto !== geocerca ? `${geocerca} (${punto})` : geocerca;

  switch (d.tipo) {
    case 'ENTRAR':
      return `Entró a ${lugar}`;
    case 'SALIR':
      return `Salió de ${lugar}`;
    case 'PERMANECER':
      return `Se quedó en ${lugar}`;
    case 'CERCA':
      return `Pasó cerca de ${punto || geocerca}`;
    case 'MOMENTO': {
      const accion = ACCION_DEL_MOMENTO[d.momento ?? ''] ?? 'Hizo algo en la aplicación';
      switch (d.donde) {
        case 'fuera':
          return `${accion} estando fuera de ${geocerca}`;
        case 'cerca':
          return `${accion} cerca de ${punto || geocerca}`;
        default:
          return `${accion} estando dentro de ${lugar}`;
      }
    }
    default:
      return `Evento en ${lugar}`;
  }
}

// ─── Medir: dentro o fuera, y a cuánto del borde ─────────────────────────────

/** Proyección plana local en metros alrededor de `lat0`: sobra a escala de geocerca. */
function proyectar(lat: number, lng: number, lat0: number, lng0: number): [number, number] {
  const x = (lng - lng0) * Math.cos((lat0 * Math.PI) / 180) * 111_320;
  const y = (lat - lat0) * 110_540;
  return [x, y];
}

function distanciaASegmento(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const largo = dx * dx + dy * dy;
  const t = largo === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / largo));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Dentro o fuera, y la distancia al borde. En un polígono, al lado más cercano;
 * por puntos, al borde del radio del punto del evento —o del más cercano—.
 */
export function medirPosicion(
  g: GeometriaDeGeocerca,
  lat: number,
  lng: number,
  clavePunto: string | null = null,
): { dentro: boolean; distanciaMetros: number } | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  if (g.poligono.length >= 3 && (g.forma === 'POLYGON' || !g.puntos.length)) {
    const dentro = dentroDelPoligono(lat, lng, g.poligono);
    const p = proyectar(lat, lng, lat, lng);
    let minimo = Number.POSITIVE_INFINITY;
    for (let i = 0; i < g.poligono.length; i++) {
      const a = g.poligono[i];
      const b = g.poligono[(i + 1) % g.poligono.length];
      minimo = Math.min(
        minimo,
        distanciaASegmento(p, proyectar(a[0], a[1], lat, lng), proyectar(b[0], b[1], lat, lng)),
      );
    }
    return { dentro, distanciaMetros: Math.round(minimo) };
  }

  if (!g.puntos.length) return null;
  const elegido = clavePunto ? g.puntos.find((p) => p.clave === clavePunto) : undefined;
  const candidatos = elegido ? [elegido] : g.puntos;
  let mejor: { d: number; radio: number } | null = null;
  for (const p of candidatos) {
    const d = metrosEntre(lat, lng, p.lat, p.lng);
    // El que importa es el del borde más cercano, no el del centro más cercano.
    if (!mejor || d - p.radio < mejor.d - mejor.radio) mejor = { d, radio: p.radio };
  }
  if (!mejor || !Number.isFinite(mejor.d)) return null;
  return { dentro: mejor.d <= mejor.radio, distanciaMetros: Math.round(Math.abs(mejor.d - mejor.radio)) };
}

// ─── Armar la vista ──────────────────────────────────────────────────────────

/** De la respuesta del servidor. `null` si no trae lo mínimo. */
export function vistaDesdeServidor(r: unknown): VistaDeEvento | null {
  const o = obj(r);
  if (!o || !str(o.clave)) return null;
  const lat = numero(o.lat);
  const lng = numero(o.lng);
  if (lat === null || lng === null) return null;

  const punto = obj(o.punto);
  const ctx = obj(o.contexto);
  return {
    clave: str(o.clave),
    origen: 'servidor',
    tipo: str(o.tipo),
    momento: str(o.momento) || null,
    evento: str(o.evento),
    en: str(o.en),
    lat,
    lng,
    usuario: str(obj(o.usuario)?.nombre),
    flujo: str(obj(o.flujo)?.nombre),
    regla: str(obj(o.regla)?.nombre),
    geocerca: leerGeometria(o.geocerca),
    punto: punto ? { clave: str(punto.clave), nombre: str(punto.nombre) } : null,
    dentro: typeof o.dentro === 'boolean' ? o.dentro : null,
    distanciaMetros: numero(o.distanciaMetros),
    mapaUrl: str(o.mapaUrl) || null,
    contexto:
      ctx && str(ctx.answerGuid)
        ? {
            answerGuid: str(ctx.answerGuid),
            surveyId: numero(ctx.surveyId),
            formulario: str(ctx.formulario),
          }
        : null,
  };
}

/**
 * Del evento guardado en el navegador y el `JSONMovil` de su flujo (si sigue
 * descargado). Calcula dentro/fuera y el texto aquí mismo.
 */
export function vistaDesdeLocal(
  e: EventoLocal,
  flujoJson: unknown,
  usuario: string,
  formulario = '',
): VistaDeEvento {
  let flujo: Json = null;
  try {
    flujo = typeof flujoJson === 'string' ? JSON.parse(flujoJson) : flujoJson;
  } catch {
    flujo = null;
  }
  flujo = obj(flujo);

  const geocerca = leerGeometria(
    arr(flujo?.geocercas).find((g) => Number(obj(g)?.id) === Number(e.geocercaId)),
  );
  const regla = obj(arr(flujo?.reglas).find((r) => str(obj(r)?.id) === str(e.reglaId)));

  const clavePunto = e.punto || null;
  const puntoGeo = clavePunto ? geocerca?.puntos.find((p) => p.clave === clavePunto) : undefined;
  // Si el punto no está en la geometría, la clave `C:<nombre>` al menos dice el nombre.
  const nombrePunto =
    puntoGeo?.nombre || (clavePunto?.startsWith('C:') ? clavePunto.substring(2) : '');

  const medida = geocerca ? medirPosicion(geocerca, Number(e.lat), Number(e.lng), clavePunto) : null;

  // El `donde` de la regla; sin regla, lo que dice la medida.
  const dondeRegla = str(regla?.donde);
  const donde = dondeRegla || (medida ? (medida.dentro ? 'dentro' : 'fuera') : 'dentro');

  return {
    clave: e.clave,
    origen: 'local',
    tipo: e.tipo,
    momento: e.momento || null,
    evento: textoDelEvento({
      tipo: e.tipo,
      momento: e.momento,
      geocerca: geocerca?.nombre ?? '',
      punto: nombrePunto,
      donde,
    }),
    en: e.en,
    lat: Number(e.lat),
    lng: Number(e.lng),
    usuario,
    flujo: str(flujo?.nombre),
    regla: str(regla?.nombre),
    geocerca,
    punto: clavePunto ? { clave: clavePunto, nombre: nombrePunto } : null,
    dentro: medida?.dentro ?? null,
    distanciaMetros: medida?.distanciaMetros ?? null,
    mapaUrl: null,
    contexto:
      e.contexto && e.contexto.answerGuid
        ? {
            answerGuid: e.contexto.answerGuid,
            surveyId: numero(e.contexto.surveyId),
            formulario,
          }
        : null,
  };
}

/** Qué respondió el servidor. */
export type RespuestaDelServidor =
  | { estado: 'ok'; cuerpo: unknown }
  | { estado: 'no-existe' }
  | { estado: 'sin-respuesta' };

export type Eleccion =
  | { estado: 'listo'; vista: VistaDeEvento }
  | { estado: 'no-existe' }
  | { estado: 'sin-datos' };

/**
 * Servidor o local.
 *
 * - El servidor manda cuando responde con un evento legible; lo local solo
 *   rellena huecos (la geometría para el dibujo, el texto, quién y qué flujo).
 * - Sin servidor —sin red, caído, sin desplegar— o con una respuesta que no se
 *   entiende, lo local.
 * - Un 404 del servidor sin nada local es «no existe»; con algo local se
 *   enseña lo local: el evento pudo no haber subido todavía.
 * - Sin nada de nada, «sin datos».
 */
export function elegirVista(servidor: RespuestaDelServidor, local: VistaDeEvento | null): Eleccion {
  const remota = servidor.estado === 'ok' ? vistaDesdeServidor(servidor.cuerpo) : null;

  if (remota) {
    if (!local) return { estado: 'listo', vista: remota };
    return {
      estado: 'listo',
      vista: {
        ...remota,
        evento: remota.evento || local.evento,
        usuario: remota.usuario || local.usuario,
        flujo: remota.flujo || local.flujo,
        regla: remota.regla || local.regla,
        geocerca: remota.geocerca ?? local.geocerca,
        punto: remota.punto ?? local.punto,
        dentro: remota.dentro ?? local.dentro,
        distanciaMetros: remota.distanciaMetros ?? local.distanciaMetros,
        contexto: remota.contexto ?? local.contexto,
      },
    };
  }

  if (local) return { estado: 'listo', vista: local };
  return servidor.estado === 'no-existe' ? { estado: 'no-existe' } : { estado: 'sin-datos' };
}

// ─── El dibujo de respaldo ───────────────────────────────────────────────────

export interface DibujoDeGeocerca {
  ancho: number;
  alto: number;
  /** `points` de un `<polygon>`, o vacío. */
  poligono: string;
  circulos: { cx: number; cy: number; r: number }[];
  persona: { cx: number; cy: number };
}

/**
 * La geocerca y la persona, escaladas a un recuadro de `ancho × alto`. En
 * metros sobre un plano local, para que los círculos sean círculos.
 */
export function dibujarGeocerca(
  g: GeometriaDeGeocerca | null,
  lat: number,
  lng: number,
  ancho = 320,
  alto = 200,
  margen = 20,
): DibujoDeGeocerca | null {
  if (!g || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const usarPoligono = g.poligono.length >= 3 && (g.forma === 'POLYGON' || !g.puntos.length);
  if (!usarPoligono && !g.puntos.length) return null;

  const vertices = usarPoligono ? g.poligono.map(([a, b]) => proyectar(a, b, lat, lng)) : [];
  const circulos = usarPoligono
    ? []
    : g.puntos.map((p) => ({ c: proyectar(p.lat, p.lng, lat, lng), r: Math.max(1, p.radio) }));
  const persona: [number, number] = [0, 0];

  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  for (const [x, y] of vertices) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  for (const { c, r } of circulos) {
    minX = Math.min(minX, c[0] - r);
    maxX = Math.max(maxX, c[0] + r);
    minY = Math.min(minY, c[1] - r);
    maxY = Math.max(maxY, c[1] + r);
  }

  const escala = Math.min(
    (ancho - 2 * margen) / Math.max(maxX - minX, 1),
    (alto - 2 * margen) / Math.max(maxY - minY, 1),
  );
  // Centrado en el recuadro; la `y` crece hacia abajo en SVG.
  const offX = (ancho - (maxX - minX) * escala) / 2;
  const offY = (alto - (maxY - minY) * escala) / 2;
  const aPx = ([x, y]: [number, number]): [number, number] => [
    +(offX + (x - minX) * escala).toFixed(1),
    +(offY + (maxY - y) * escala).toFixed(1),
  ];

  const [px, py] = aPx(persona);
  return {
    ancho,
    alto,
    poligono: vertices.map((v) => aPx(v).join(',')).join(' '),
    circulos: circulos.map(({ c, r }) => {
      const [cx, cy] = aPx(c);
      return { cx, cy, r: +(r * escala).toFixed(1) };
    }),
    persona: { cx: px, cy: py },
  };
}

/** Enlace a Google Maps con el punto del evento. */
export function enlaceAGoogleMaps(lat: number, lng: number): string {
  return `https://maps.google.com/?q=${lat.toFixed(6)},${lng.toFixed(6)}`;
}
