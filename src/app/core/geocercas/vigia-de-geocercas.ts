/**
 * La vigía de las geocercas: porte fiel de `VigiaDeGeocercas` del móvil
 * (`GeocercasNativas.kt`).
 *
 * Los flujos llegan de cloud-gold ya compilados (`JSONMovil`, entidad 101):
 * reglas «al entrar», «al salir», «cerca de un punto» y «al quedarse», con el
 * polígono, los puntos y el horario de cada geocerca. Con cada lectura del GPS
 * [VigiaDeGeocercas.evaluar] decide qué se disparó.
 *
 * Es código puro —sin Angular, sin navegador— para poder probarlo con lecturas
 * inventadas y un reloj que se mueve a mano. Quien lee el GPS, guarda los
 * eventos y hace las acciones es `GeocercasService`.
 *
 * ## Por qué tanto cuidado con el ruido
 *
 * El GPS salta. Parado en la puerta de una sede, una lectura cae dentro y la
 * siguiente fuera, y sin freno cada salto sería un «entró» y un «salió», con
 * su correo y su alerta. Por eso, igual que en el teléfono:
 *
 * - un cambio dentro/fuera solo cuenta tras **dos lecturas seguidas** que lo
 *   confirmen;
 * - «cerca» tiene histéresis: se entra a menos de N metros y se sale a más de
 *   N × 1,25 + 15;
 * - la primera vez que se ve una geocerca **no dispara**: se aprende dónde
 *   está la persona. Si no, cada recarga de la pestaña sería una llegada.
 *
 * ## Lo único que cambia frente al móvil
 *
 * La distancia: Android usa `Location.distanceBetween` (elipsoide WGS84) y aquí
 * se usa la fórmula del haversine sobre una esfera. A las distancias de una
 * geocerca (decenas o cientos de metros) la diferencia es de centímetros.
 */

/** Lo que pasó, listo para guardar y contar. */
export interface Disparo {
  flujoId: number;
  reglaId: string;
  geocercaId: number;
  geocercaNombre: string;
  /** Clave del punto (`L:<locationId>`, `A:<assetId>`, `C:<nombre>`) o `null`. */
  punto: string | null;
  puntoNombre: string;
  tipo: 'ENTRAR' | 'SALIR' | 'PERMANECER' | 'CERCA' | 'MOMENTO';
  /** Solo `MOMENTO`: el `cuando` de la regla («actividad-guardar», «sesion-iniciar»…). */
  momento?: string;
  /** Solo `MOMENTO`: de qué actividad se trata (`null` en los de sesión). */
  contexto?: ContextoDeMomento | null;
  lat: number;
  lng: number;
  /** Milisegundos desde la época. */
  en: number;
  acciones: AccionDeRegla[];
}

/** De qué actividad va un momento. */
export interface ContextoDeMomento {
  answerGuid: string;
  surveyId: number | string;
}

/** Una lectura del GPS ya filtrada por precisión. */
export interface Lectura {
  lat: number;
  lng: number;
}

/** Una acción de una regla, tal como viene en `JSONMovil`. */
export interface AccionDeRegla {
  accion?: string;
  [clave: string]: unknown;
}

/**
 * Un objeto leído de JSON. `any` a propósito: viene de fuera y cada campo se
 * lee con los lectores tolerantes de abajo, como `optInt`/`optString`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** El estado persistido de la vigía: un objeto plano, serializable a JSON. */
export type EstadoDeVigia = Record<string, Json>;

const LECTURAS_PARA_CAMBIAR = 2;

interface Presencia {
  dentro: boolean | null;
  desde: number;
  cambio: boolean;
  /** Se acaba de conocer: si ya estaba dentro, eso no es «entrar». */
  recienAprendida: boolean;
  punto: string | null;
  puntoNombre: string;
}

// ─── Lectores tolerantes, el equivalente de `optInt`/`optString` ─────────────

const obj = (v: unknown): Json | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;

const arr = (v: unknown): any[] | null => (Array.isArray(v) ? v : null);

const int = (v: unknown, def = 0): number => {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? def : Math.trunc(n);
};

const num = (v: unknown, def: number): number => {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? def : n;
};

const str = (v: unknown, def = ''): string =>
  v === null || v === undefined ? def : String(v);

const bool = (v: unknown, def: boolean): boolean =>
  v === undefined || v === null ? def : v === true || v === 1 || v === '1' || v === 'true';

/** `yyyy-MM-dd` en la hora local, como `SimpleDateFormat` en el teléfono. */
export function diaLocal(ms: number): string {
  const d = new Date(ms);
  const dd = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${dd(d.getMonth() + 1)}-${dd(d.getDate())}`;
}

export class VigiaDeGeocercas {
  private flujos: any[] = [];

  /**
   * @param estado el estado guardado de la vez anterior (se modifica en sitio).
   * @param guardar se llama al terminar cada evaluación, para persistirlo.
   */
  constructor(
    private estado: EstadoDeVigia = {},
    private readonly guardar: (estado: EstadoDeVigia) => void = () => {},
  ) {}

  /** Recibe los `JSONMovil` de los flujos (texto o ya leídos). */
  cargar(flujos: readonly (string | object)[]): void {
    const salida: any[] = [];
    for (const f of flujos) {
      try {
        const leido = typeof f === 'string' ? JSON.parse(f) : f;
        if (obj(leido)) salida.push(leido);
      } catch {
        // Un flujo ilegible no vigila nada; los demás siguen.
      }
    }
    this.flujos = salida;
  }

  hayAlgo(): boolean {
    return this.flujos.length > 0;
  }

  /** Los flujos cargados, ya leídos: los usa también [MomentosDeGeocerca]. */
  get flujosCargados(): readonly Json[] {
    return this.flujos;
  }

  /** El estado, para pruebas y diagnóstico. */
  get estadoActual(): EstadoDeVigia {
    return this.estado;
  }

  /** Evalúa una lectura del GPS contra todos los flujos. */
  evaluar(punto: Lectura, ahora: number = Date.now()): Disparo[] {
    const disparos: Disparo[] = [];
    const hoy = diaLocal(ahora);

    for (const flujo of this.flujos) {
      if (!bool(flujo.activo, false)) continue;
      const flujoId = int(flujo.id);

      const cercas = new Map<number, Json>();
      for (const g of arr(flujo.geocercas) ?? []) {
        const go = obj(g);
        if (go) cercas.set(int(go.id), go);
      }

      // Dentro o fuera de cada geocerca, una sola vez por lectura: varias
      // reglas pueden mirar la misma.
      const presencia = new Map<number, Presencia>();
      for (const [id, g] of cercas) {
        if (!bool(g.activa, true) || !vigente(g, hoy)) continue;
        presencia.set(id, this.presenciaEn(flujoId, g, punto, ahora));
      }

      for (const r of arr(flujo.reglas) ?? []) {
        const regla = obj(r);
        if (!regla) continue;
        if (!dentroDelHorario(obj(regla.horario), ahora)) continue;

        const ids = arr(regla.geocercas);
        const suyas = ids && ids.length > 0 ? ids.map((x) => int(x)) : [...cercas.keys()];

        for (const gid of suyas) {
          const g = cercas.get(gid);
          const p = presencia.get(gid);
          if (!g || !p) continue;
          // El horario de la geocerca también manda.
          if (!dentroDelHorario(obj(g.horario), ahora)) continue;

          disparos.push(...this.evaluarRegla(flujoId, regla, g, p, punto, ahora, hoy));
        }
      }
    }

    this.guardar(this.estado);
    return disparos;
  }

  // ─── Dentro / fuera ───────────────────────────────────────────────────────

  /**
   * Si está dentro, con la confirmación de dos lecturas.
   *
   * `dentro` es `null` mientras no se sepa (la primera vez). `cambio` dice si
   * en esta lectura se confirmó un cruce.
   */
  private presenciaEn(
    flujoId: number,
    g: Json,
    punto: Lectura,
    ahora: number,
  ): Presencia {
    const clave = `g:${flujoId}:${int(g.id)}`;
    const st: Json = obj(this.estado[clave]) ?? {};

    const { dentro: ahoraDentro, cercano } = medir(g, punto);

    const conocido = 'dentro' in st;
    const recienAprendida = !conocido;
    const dentro: boolean | null = conocido ? !!st['dentro'] : null;
    let cambio = false;

    if (!conocido) {
      // Primera vez: se aprende, no se dispara.
      st['dentro'] = ahoraDentro;
      st['desde'] = ahora;
      st['cuenta'] = 0;
    } else if (ahoraDentro !== dentro) {
      const cuenta = int(st['cuenta']) + 1;
      if (cuenta === 1) st['primeraVez'] = ahora;
      if (cuenta >= LECTURAS_PARA_CAMBIAR) {
        st['dentro'] = ahoraDentro;
        st['desde'] = num(st['primeraVez'], ahora);
        st['cuenta'] = 0;
        delete st['disparados'];
        cambio = true;
      } else {
        st['cuenta'] = cuenta;
      }
    } else {
      st['cuenta'] = 0;
    }

    if (ahoraDentro && cercano) {
      st['punto'] = str(cercano['clave']);
      st['puntoNombre'] = str(cercano['nombre']);
    }

    this.estado[clave] = st;

    return {
      dentro: 'dentro' in st ? !!st['dentro'] : null,
      desde: num(st['desde'], ahora),
      cambio,
      recienAprendida,
      punto: str(st['punto']) || null,
      puntoNombre: str(st['puntoNombre']),
    };
  }

  // ─── Reglas ───────────────────────────────────────────────────────────────

  private evaluarRegla(
    flujoId: number,
    regla: Json,
    g: Json,
    p: Presencia,
    punto: Lectura,
    ahora: number,
    hoy: string,
  ): Disparo[] {
    const reglaId = str(regla['id']);
    const gid = int(g['id']);
    const claveG = `g:${flujoId}:${gid}`;
    const estadoG: Json = obj(this.estado[claveG]) ?? {};
    const disparados: Json = obj(estadoG['disparados']) ?? {};

    const disparo = (tipo: Disparo['tipo'], clavePunto: string | null, nombrePunto: string): Disparo => ({
      flujoId,
      reglaId,
      geocercaId: gid,
      geocercaNombre: str(g['nombre']),
      punto: clavePunto,
      puntoNombre: nombrePunto,
      tipo,
      lat: punto.lat,
      lng: punto.lng,
      en: ahora,
      acciones: (arr(regla['acciones']) ?? []).filter((a) => obj(a)) as AccionDeRegla[],
    });

    const salida: Disparo[] = [];
    const claveRepetir = `${flujoId}:${reglaId}:${gid}`;

    switch (str(regla['cuando'])) {
      /*
       * Entrar dispara una vez por estancia, cuando lleva dentro la
       * permanencia mínima de la geocerca (cero si no tiene).
       */
      case 'entrar': {
        if (p.recienAprendida && p.dentro === true) disparados[reglaId] = ahora;
        const minimo = int(g['permanencia'], 0) * 60_000;
        if (p.dentro === true && ahora - p.desde >= minimo && !(reglaId in disparados)) {
          if (this.puedeRepetir(regla, claveRepetir, hoy)) {
            salida.push(disparo('ENTRAR', p.punto, p.puntoNombre));
          }
          disparados[reglaId] = ahora;
        }
        break;
      }

      case 'salir': {
        if (p.cambio && p.dentro === false && this.puedeRepetir(regla, claveRepetir, hoy)) {
          salida.push(disparo('SALIR', str(estadoG['punto']) || null, str(estadoG['puntoNombre'])));
        }
        break;
      }

      case 'permanecer': {
        const minutos = int(regla['minutos'], 10) * 60_000;
        if (p.dentro === true && ahora - p.desde >= minutos && !(reglaId in disparados)) {
          if (this.puedeRepetir(regla, claveRepetir, hoy)) {
            salida.push(disparo('PERMANECER', p.punto, p.puntoNombre));
          }
          disparados[reglaId] = ahora;
        }
        break;
      }

      case 'cerca':
        salida.push(...this.evaluarCerca(flujoId, regla, g, punto, hoy, disparo));
        break;
    }

    if (Object.keys(disparados).length > 0) {
      estadoG['disparados'] = disparados;
      this.estado[claveG] = estadoG;
    }

    return salida;
  }

  private evaluarCerca(
    flujoId: number,
    regla: Json,
    g: Json,
    punto: Lectura,
    hoy: string,
    disparo: (tipo: Disparo['tipo'], clave: string | null, nombre: string) => Disparo,
  ): Disparo[] {
    const salida: Disparo[] = [];
    const reglaId = str(regla['id']);
    const metros = num(regla['metros'], 100);
    const conf: Json = obj(regla['punto']) ?? {};
    const modo = str(conf['modo'], 'cualquiera') || 'cualquiera';

    for (const crudo of arr(g['puntos']) ?? []) {
      const p = obj(crudo);
      if (!p) continue;

      if (!coincidePunto(p, modo, conf)) continue;

      const clave = `c:${flujoId}:${reglaId}:${str(p['clave'])}`;
      const st = obj(this.estado[clave]);
      const d = metrosEntre(punto.lat, punto.lng, num(p['lat'], NaN), num(p['lng'], NaN));

      if (!st) {
        // Primera vez: se aprende si ya estaba cerca, sin disparar.
        this.estado[clave] = { cerca: d <= metros };
        continue;
      }

      const estaba = !!st['cerca'];
      if (!estaba && d <= metros) {
        st['cerca'] = true;
        if (this.puedeRepetir(regla, `${flujoId}:${reglaId}:${str(p['clave'])}`, hoy)) {
          salida.push(disparo('CERCA', str(p['clave']), str(p['nombre'])));
        }
      } else if (estaba && d > metros * 1.25 + 15) {
        st['cerca'] = false;
      }
      this.estado[clave] = st;
    }

    return salida;
  }

  /** «Una vez al día por persona»: la segunda del mismo día no se dispara. */
  private puedeRepetir(regla: Json, clave: string, hoy: string): boolean {
    if (str(regla['repetir']) !== 'una-vez-al-dia') return true;
    const llave = `dia:${clave}`;
    if (str(this.estado[llave]) === hoy) return false;
    this.estado[llave] = hoy;
    return true;
  }

}

// ─── Momentos de la app ───────────────────────────────────────────────────────

/** Los `cuando` que no son movimiento sino algo que pasó en la aplicación. */
export const MOMENTOS_DE_LA_APP = [
  'actividad-crear',
  'actividad-actualizar',
  'actividad-guardar',
  'actividad-eliminar',
  'sesion-iniciar',
  'sesion-cerrar',
  // En la web no hay recorrido: estas dos nunca llegan, pero se reconocen.
  'recorrido-empezar',
  'recorrido-terminar',
] as const;

export type MomentoDeLaApp = (typeof MOMENTOS_DE_LA_APP)[number];

/**
 * Reglas que se disparan por un **momento de la app** —crear, guardar,
 * actualizar o eliminar una actividad; iniciar o cerrar sesión— según dónde
 * esté la persona en ese instante.
 *
 * Contrato común con Module y el móvil:
 *
 * - Se evalúa con **una** lectura, en el momento: sin confirmación de dos
 *   lecturas y sin «la primera aprende». No hay cruce que confirmar: la
 *   pregunta es solo «¿dónde está ahora?».
 * - `donde`: `dentro` (por omisión) da un disparo por cada geocerca de la
 *   regla en la que está; `fuera`, uno por cada una en la que no está; `cerca`,
 *   uno por cada punto coincidente a ≤ `metros` (con `punto` como en «cerca»).
 * - `formularios` (SurveyID) filtra los de actividad; vacío es cualquiera.
 * - Valen la vigencia y el horario de la geocerca, el horario de la regla y
 *   `repetir` — este con su **propio** estado, separado del de la vigía de
 *   movimiento, para que un «una vez al día» de un momento no se coma el de
 *   una entrada ni al revés.
 */
export class MomentosDeGeocerca {
  constructor(
    private estado: EstadoDeVigia = {},
    private readonly guardar: (estado: EstadoDeVigia) => void = () => {},
  ) {}

  get estadoActual(): EstadoDeVigia {
    return this.estado;
  }

  /** ¿Algún flujo activo tiene una regla para este momento? Para no pedir el GPS en balde. */
  static hayReglaPara(flujos: readonly Json[], momento: string): boolean {
    return flujos.some(
      (f) =>
        bool(f?.activo, false) &&
        (arr(f?.reglas) ?? []).some((r) => cuandoIncluye(r?.cuando, momento)),
    );
  }

  evaluar(
    flujos: readonly Json[],
    momento: string,
    contexto: ContextoDeMomento | null,
    punto: Lectura,
    ahora: number = Date.now(),
  ): Disparo[] {
    const disparos: Disparo[] = [];
    const hoy = diaLocal(ahora);
    const deActividad = momento.startsWith('actividad-');

    for (const flujo of flujos) {
      if (!bool(flujo?.activo, false)) continue;
      const flujoId = int(flujo.id);

      const cercas = new Map<number, Json>();
      for (const g of arr(flujo.geocercas) ?? []) {
        const go = obj(g);
        if (go) cercas.set(int(go.id), go);
      }

      for (const r of arr(flujo.reglas) ?? []) {
        const regla = obj(r);
        if (!regla || !cuandoIncluye(regla['cuando'], momento)) continue;
        if (!dentroDelHorario(obj(regla['horario']), ahora)) continue;

        // Solo los formularios que diga la regla, si dice alguno.
        const formularios = (arr(regla['formularios']) ?? []).map((x) => int(x)).filter((x) => x > 0);
        if (deActividad && formularios.length > 0) {
          if (!contexto || !formularios.includes(int(contexto.surveyId))) continue;
        }

        const reglaId = str(regla['id']);
        const donde = str(regla['donde']) || 'dentro';
        const ids = arr(regla['geocercas']);
        const suyas = ids && ids.length > 0 ? ids.map((x) => int(x)) : [...cercas.keys()];

        const disparo = (g: Json, clave: string | null, nombre: string): Disparo => ({
          flujoId,
          reglaId,
          geocercaId: int(g['id']),
          geocercaNombre: str(g['nombre']),
          punto: clave,
          puntoNombre: nombre,
          tipo: 'MOMENTO',
          momento,
          contexto: contexto ?? null,
          lat: punto.lat,
          lng: punto.lng,
          en: ahora,
          acciones: (arr(regla['acciones']) ?? []).filter((a) => obj(a)) as AccionDeRegla[],
        });

        for (const gid of suyas) {
          const g = cercas.get(gid);
          if (!g) continue;
          if (!bool(g['activa'], true) || !vigente(g, hoy)) continue;
          if (!dentroDelHorario(obj(g['horario']), ahora)) continue;

          if (donde === 'cerca') {
            const metros = num(regla['metros'], 100);
            const conf: Json = obj(regla['punto']) ?? {};
            const modo = str(conf['modo'], 'cualquiera') || 'cualquiera';
            for (const crudo of arr(g['puntos']) ?? []) {
              const p = obj(crudo);
              if (!p || !coincidePunto(p, modo, conf)) continue;
              const d = metrosEntre(punto.lat, punto.lng, num(p['lat'], NaN), num(p['lng'], NaN));
              if (d > metros) continue;
              if (this.puedeRepetir(regla, `${flujoId}:${reglaId}:${momento}:${str(p['clave'])}`, hoy)) {
                disparos.push(disparo(g, str(p['clave']), str(p['nombre'])));
              }
            }
            continue;
          }

          const { dentro, cercano } = medir(g, punto);
          if (donde === 'fuera' ? dentro : !dentro) continue;
          if (!this.puedeRepetir(regla, `${flujoId}:${reglaId}:${momento}:${gid}`, hoy)) continue;

          disparos.push(
            dentro && cercano
              ? disparo(g, str(cercano['clave']) || null, str(cercano['nombre']))
              : disparo(g, null, ''),
          );
        }
      }
    }

    this.guardar(this.estado);
    return disparos;
  }

  private puedeRepetir(regla: Json, clave: string, hoy: string): boolean {
    if (str(regla['repetir']) !== 'una-vez-al-dia') return true;
    const llave = `dia:${clave}`;
    if (str(this.estado[llave]) === hoy) return false;
    this.estado[llave] = hoy;
    return true;
  }
}

/** `cuando` es texto en las reglas de geocerca; se acepta también una lista. */
function cuandoIncluye(cuando: unknown, momento: string): boolean {
  return Array.isArray(cuando) ? cuando.map(String).includes(momento) : str(cuando) === momento;
}

/** Si un punto es de los que pide la regla: uno concreto, de un tipo de ubicación, o cualquiera. */
function coincidePunto(p: Json, modo: string, conf: Json): boolean {
  switch (modo) {
    case 'punto':
      return str(p['clave']) === str(conf['clave']);
    case 'tipo':
      return (
        p['locationTypeId'] !== null &&
        p['locationTypeId'] !== undefined &&
        int(p['locationTypeId']) === int(conf['tipoUbicacion'])
      );
    default:
      return true;
  }
}

/**
 * Dentro o fuera de una geocerca, con una sola lectura. Polígono por el rayo;
 * por puntos, dentro del radio del más cercano (que es el que se informa).
 */
function medir(g: Json, punto: Lectura): { dentro: boolean; cercano: Json | null } {
  if (str(g['forma']) === 'POLYGON') {
    return { dentro: dentroDelPoligono(punto.lat, punto.lng, arr(g['poligono'])), cercano: null };
  }
  let mejor = Number.MAX_VALUE;
  let cercano: Json | null = null;
  for (const crudo of arr(g['puntos']) ?? []) {
    const p = obj(crudo);
    if (!p) continue;
    const d = metrosEntre(punto.lat, punto.lng, num(p['lat'], NaN), num(p['lng'], NaN));
    if (d <= num(p['radio'], 100) && d < mejor) {
      mejor = d;
      cercano = p;
    }
  }
  return { dentro: cercano !== null, cercano };
}

// ─── Horario y vigencia ───────────────────────────────────────────────────

export function vigente(g: Json, hoy: string): boolean {
  const v = obj(g['vigencia']);
  if (!v) return true;
  const desde = str(v['desde']);
  const hasta = str(v['hasta']);
  if (desde && hoy < desde) return false;
  if (hasta && hoy > hasta) return false;
  return true;
}

/** Días 1 = lunes … 7 = domingo, como los guarda Module. */
export function dentroDelHorario(h: Json | null, ahora: number): boolean {
  if (!h) return true;
  const fecha = new Date(ahora);
  // getDay: 0 = domingo … 6 = sábado → 1 = lunes … 7 = domingo.
  const dia = fecha.getDay() === 0 ? 7 : fecha.getDay();

  const dias = arr(h['dias']);
  if (dias && dias.length > 0 && !dias.some((d) => int(d) === dia)) return false;

  const desde = minutosDe(str(h['desde']));
  const hasta = minutosDe(str(h['hasta']));
  const ahoraMin = fecha.getHours() * 60 + fecha.getMinutes();
  if (desde !== null && hasta !== null) {
    // Un horario que cruza la medianoche (22:00 a 06:00) también vale.
    return desde <= hasta
      ? ahoraMin >= desde && ahoraMin <= hasta
      : ahoraMin >= desde || ahoraMin <= hasta;
  }
  if (desde !== null && ahoraMin < desde) return false;
  if (hasta !== null && ahoraMin > hasta) return false;
  return true;
}

function minutosDe(hhmm: string): number | null {
  const partes = hhmm.split(':');
  if (partes.length !== 2) return null;
  if (!/^\s*-?\d+\s*$/.test(partes[0]) || !/^\s*-?\d+\s*$/.test(partes[1])) return null;
  return parseInt(partes[0], 10) * 60 + parseInt(partes[1], 10);
}

// ─── Geometría ──────────────────────────────────────────────────────────────

/** Rayo hacia el este: cuenta cuántos lados cruza. Impar = dentro. Vértices `[lat, lng]`. */
export function dentroDelPoligono(lat: number, lng: number, poligono: any[] | null): boolean {
  if (!poligono || poligono.length < 3) return false;
  let dentro = false;
  let j = poligono.length - 1;
  for (let i = 0; i < poligono.length; i++) {
    const a = arr(poligono[i]);
    const b = arr(poligono[j]);
    if (a && b) {
      const ay = Number(a[0]);
      const ax = Number(a[1]);
      const by = Number(b[0]);
      const bx = Number(b[1]);
      if (ay > lat !== by > lat && lng < ((bx - ax) * (lat - ay)) / (by - ay) + ax) dentro = !dentro;
    }
    j = i;
  }
  return dentro;
}

/** Distancia en metros (haversine). Con coordenadas inválidas, infinita. */
export function metrosEntre(aLat: number, aLng: number, bLat: number, bLng: number): number {
  if (![aLat, aLng, bLat, bLng].every(Number.isFinite)) return Number.POSITIVE_INFINITY;
  const R = 6_371_008.8;
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
