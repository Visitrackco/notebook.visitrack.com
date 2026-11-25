/**
 * El perfil de inventario de un formulario y las líneas que pide una
 * actividad: copia de `perfil-inventario.ts` de cloud-gold (y gemela de
 * `PerfilInventario.dart` del móvil).
 *
 * Tiene que dar **lo mismo** que el servidor: el servidor mueve el stock, y la
 * web solo avisa o bloquea antes de guardar según el perfil. Si los dos
 * leyeran distinto una actividad, la web bloquearía lo que el servidor no
 * mueve, o al revés. Por eso es puro (sin base ni componentes) y sigue el
 * original función por función. Ver docs/inventario-listas.md de cloud-gold.
 */

export type TipoMovimiento = 'ENTRADA' | 'SALIDA' | 'AJUSTE' | 'TRASLADO';
export const TIPOS: readonly TipoMovimiento[] = ['ENTRADA', 'SALIDA', 'AJUSTE', 'TRASLADO'];

export interface PerfilInventario {
  cuando: { modo: 'guardar' | 'completar' | 'estados'; estados: number[] };
  tipo: {
    modo: 'fijo' | 'campo' | 'estado';
    valor?: TipoMovimiento;
    campo?: string;
    /** Valor del campo (id de la opción o su texto, en minúsculas) → tipo. */
    mapa: Record<string, TipoMovimiento>;
    /** ID del estado → tipo. */
    estados: Record<string, TipoMovimiento>;
  };
  lineas: { origen: 'tabla' | 'campos'; tabla?: string; producto?: string; cantidad: string };
  negativo: 'bloquear' | 'avisar' | 'permitir';
  /**
   * Si la actividad se vuelve a guardar después de mover: `una_vez` (no toca
   * más el inventario; por defecto) o `ajustar` (mueve la diferencia).
   */
  repetir: 'una_vez' | 'ajustar';
}

/** Una línea pedida: el item de la lista (GUID) y su cantidad. */
export interface LineaPedida {
  producto: string;
  cantidad: number;
}

export interface ResultadoDelPerfil {
  tipo: TipoMovimiento | null;
  lineas: LineaPedida[];
}

function leerJson(crudo: unknown): unknown {
  if (typeof crudo !== 'string') return crudo;
  try {
    return JSON.parse(crudo);
  } catch {
    return null;
  }
}

/**
 * Lo que manda Module ya viene saneado (`leerPerfil` del servidor), pero se
 * vuelve a sanear: un valor raro no puede tumbar el guardado.
 */
export function leerPerfil(crudo: unknown): PerfilInventario {
  const v = (leerJson(crudo) ?? {}) as any;
  const tipoValido = (t: unknown): TipoMovimiento | undefined => {
    const s = String(t ?? '').toUpperCase() as TipoMovimiento;
    return TIPOS.includes(s) ? s : undefined;
  };
  const mapaDeTipos = (m: unknown): Record<string, TipoMovimiento> => {
    const salida: Record<string, TipoMovimiento> = {};
    if (m && typeof m === 'object') {
      for (const [k, t] of Object.entries(m as Record<string, unknown>)) {
        const tv = tipoValido(t);
        if (tv && String(k).trim()) salida[String(k).trim().toLowerCase()] = tv;
      }
    }
    return salida;
  };
  const texto = (x: unknown) => (x === null || x === undefined ? undefined : String(x).trim() || undefined);

  return {
    cuando: {
      modo: ['guardar', 'completar', 'estados'].includes(v?.cuando?.modo) ? v.cuando.modo : 'completar',
      estados: Array.isArray(v?.cuando?.estados)
        ? v.cuando.estados.map(Number).filter((n: number) => Number.isFinite(n))
        : [],
    },
    tipo: {
      modo: ['fijo', 'campo', 'estado'].includes(v?.tipo?.modo) ? v.tipo.modo : 'fijo',
      valor: tipoValido(v?.tipo?.valor),
      campo: texto(v?.tipo?.campo),
      mapa: mapaDeTipos(v?.tipo?.mapa),
      estados: mapaDeTipos(v?.tipo?.estados),
    },
    lineas: {
      origen: v?.lineas?.origen === 'campos' ? 'campos' : 'tabla',
      tabla: texto(v?.lineas?.tabla),
      producto: texto(v?.lineas?.producto),
      cantidad: texto(v?.lineas?.cantidad) ?? '',
    },
    negativo: ['bloquear', 'avisar', 'permitir'].includes(v?.negativo) ? v.negativo : 'avisar',
    repetir: v?.repetir === 'ajustar' ? 'ajustar' : 'una_vez',
  };
}

/** Un número escrito como sea: `12`, `"12,5"`, `"1.234,5"`, `"1,234.5"`. */
export function numero(val: unknown): number | null {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  if (typeof val === 'object') {
    const o = val as any;
    if ('val' in o) return numero(o.val);
    if ('txt' in o) return numero(o.txt);
    return null;
  }
  let t = String(val).trim().replace(/\s/g, '').replace(/[^0-9.,-]/g, '');
  if (!t) return null;
  const coma = t.lastIndexOf(',');
  const punto = t.lastIndexOf('.');
  if (coma >= 0 && punto >= 0) {
    // El último separador es el decimal; el otro, de miles.
    t = coma > punto ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (coma >= 0) {
    // Solo comas: una sola es la coma decimal (12,5); varias, separadores de miles.
    const partes = t.split(',');
    t = partes.length === 2 ? `${partes[0]}.${partes[1]}` : partes.join('');
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** El GUID del item elegido en un desplegable: `{id, txt}` o el GUID a secas. */
export function itemElegido(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  if (Array.isArray(val)) return itemElegido(val[0]);
  if (typeof val === 'object') {
    const id = (val as any).id;
    return id !== null && id !== undefined && String(id).trim() ? String(id).trim() : null;
  }
  const t = String(val).trim();
  return t || null;
}

function clavesDeOpcion(val: unknown): string[] {
  if (val === null || val === undefined) return [];
  if (Array.isArray(val)) return val.flatMap(clavesDeOpcion);
  if (typeof val === 'object') {
    const o = val as any;
    return [o.id, o.txt, o.val]
      .filter((x) => x !== null && x !== undefined && String(x).trim())
      .map((x) => String(x).trim().toLowerCase());
  }
  const t = String(val).trim().toLowerCase();
  return t ? [t] : [];
}

/** Las respuestas por id, como `leerRespuestas` del servidor (arreglo o `{fie}`). */
function respuestasPorId(crudo: unknown): Map<string, any> {
  const v = leerJson(crudo);
  const lista = Array.isArray(v) ? v : Array.isArray((v as any)?.fie) ? (v as any).fie : [];
  const m = new Map<string, any>();
  for (const r of lista) {
    if (r && typeof r === 'object' && 'id' in r) m.set(String((r as any).id), (r as any).val);
  }
  return m;
}

/** ¿Toca mover según el momento configurado? */
export function tocaMover(p: PerfilInventario, completada: boolean, estadoID: number | null): boolean {
  if (p.cuando.modo === 'guardar') return true;
  if (p.cuando.modo === 'completar') return completada;
  return estadoID !== null && p.cuando.estados.includes(estadoID);
}

/**
 * El tipo y las líneas que pide una actividad (sus `Fields`), como
 * `calcularLineas` del servidor pero sin mirar el momento: eso lo decide
 * quien llama con [tocaMover].
 */
export function calcularLineas(p: PerfilInventario, campos: unknown, estadoID: number | null): ResultadoDelPerfil {
  const respuestas = respuestasPorId(campos);

  let tipo: TipoMovimiento | null = null;
  if (p.tipo.modo === 'fijo') tipo = p.tipo.valor ?? null;
  else if (p.tipo.modo === 'campo') {
    for (const k of clavesDeOpcion(respuestas.get(p.tipo.campo ?? ''))) {
      if (p.tipo.mapa[k]) {
        tipo = p.tipo.mapa[k];
        break;
      }
    }
  } else if (estadoID !== null) tipo = p.tipo.estados[String(estadoID)] ?? null;
  if (!tipo) return { tipo: null, lineas: [] };

  const linea = (valores: Map<string, any>, producto: string | null): LineaPedida | null => {
    if (!producto) return null;
    const cantidad = numero(valores.get(p.lineas.cantidad));
    if (cantidad === null || cantidad === 0) return null;
    // Entradas, salidas y traslados van en positivo; el signo lo pone el tipo. El ajuste lleva el suyo.
    if (tipo !== 'AJUSTE' && cantidad < 0) return null;
    return { producto, cantidad };
  };

  const lineas: LineaPedida[] = [];
  if (p.lineas.origen === 'campos') {
    const l = linea(respuestas, itemElegido(respuestas.get(p.lineas.producto ?? '')));
    if (l) lineas.push(l);
  } else {
    const filas = respuestas.get(p.lineas.tabla ?? '');
    for (const f of Array.isArray(filas) ? filas : []) {
      if (!f || typeof f !== 'object') continue;
      const valores = respuestasPorId((f as any).JSONValues);
      const producto = p.lineas.producto
        ? itemElegido(valores.get(p.lineas.producto))
        : String((f as any).ListDetGUID || (f as any).MasterListDetGUID || '').trim() || null;
      const l = linea(valores, producto);
      if (l) lineas.push(l);
    }
  }
  return { tipo, lineas };
}

/** Efecto en el stock de la lista de origen: + entra, − sale. */
export function efecto(tipo: TipoMovimiento, cantidad: number): number {
  if (tipo === 'ENTRADA') return Math.abs(cantidad);
  if (tipo === 'SALIDA' || tipo === 'TRASLADO') return -Math.abs(cantidad);
  return cantidad;
}
