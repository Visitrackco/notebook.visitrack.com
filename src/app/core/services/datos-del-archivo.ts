/**
 * Hora y lugar de un archivo adjunto (foto, firma, video, audio, archivo).
 *
 * Gemelo de `UbicacionDelArchivo` del móvil. Es lo que va en el valor del campo
 * binario y en `BinariesResources`, y lo que luego sale como columnas en Mis
 * reportes:
 *
 * - `tim`: milisegundos epoch del momento de adjuntar.
 * - `tph`: milisegundos epoch de cuando se tomó la foto. En una foto de
 *   galería sale del EXIF (`DateTimeOriginal`); si no lo trae, y en cámara,
 *   firma, video y audio, es el mismo `tim`.
 * - `lat`, `lng`: grados decimales, o `''` si no hubo ubicación.
 * - `acc`: precisión en metros (0 si no se sabe).
 * - `pro`: de dónde salió la ubicación: `gps` (la del navegador), `exif` (la
 *   de la foto) o `''` sin ella.
 *
 * ## Sin hacer esperar
 *
 * La ubicación se empieza a pedir con `adelantarUbicacion()` en cuanto la
 * persona abre la cámara, la firma o el selector; al guardar normalmente ya
 * está. Si aún no, se espera como mucho lo que falte para 5 segundos desde que
 * empezó. Si el permiso está negado o no hay geolocalización, vuelve en el acto
 * sin ubicación.
 */

export interface DatosDelArchivo {
  lat: number | '';
  lng: number | '';
  acc: number;
  pro: string;
  tim: number;
  tph: number;
}

export interface ExifDeFoto {
  /** Milisegundos epoch de `DateTimeOriginal`. */
  tomada?: number;
  lat?: number;
  lng?: number;
  acc?: number;
}

interface Lectura {
  lat: number;
  lng: number;
  acc: number;
  en: number;
}

const VIGENCIA_MS = 2 * 60 * 1000;
const TOPE_MS = 5000;

let enCurso: Promise<Lectura | null> | null = null;
let inicio = 0;
let ultima: Lectura | null = null;

function ultimaVigente(): Lectura | null {
  return ultima && Date.now() - ultima.en < VIGENCIA_MS ? ultima : null;
}

async function permisoNegado(): Promise<boolean> {
  try {
    const estado = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
    return estado?.state === 'denied';
  } catch {
    return false;
  }
}

/** Empieza a pedir la ubicación ya, sin esperar el resultado. */
export function adelantarUbicacion(): void {
  if (enCurso || ultimaVigente()) return;
  if (typeof navigator === 'undefined' || !navigator.geolocation) return;

  inicio = Date.now();
  enCurso = (async () => {
    if (await permisoNegado()) return null;

    return new Promise<Lectura | null>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const lectura: Lectura = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            acc: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : 0,
            en: Date.now(),
          };
          ultima = lectura;
          resolve(lectura);
        },
        () => resolve(null),
        { enableHighAccuracy: true, timeout: TOPE_MS, maximumAge: VIGENCIA_MS },
      );
    });
  })()
    .catch(() => null)
    .finally(() => {
      enCurso = null;
    });
}

async function ubicacion(): Promise<Lectura | null> {
  const vigente = ultimaVigente();
  if (vigente) return vigente;

  adelantarUbicacion();
  const pendiente = enCurso;
  if (!pendiente) return null;

  const falta = TOPE_MS - (Date.now() - inicio);
  if (falta <= 0) return null;

  return Promise.race([
    pendiente,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), falta)),
  ]);
}

/**
 * La hora y el lugar del archivo que se adjunta ahora.
 *
 * `exif`: el de una foto de galería, leído con `leerExif` sobre el archivo
 * elegido **antes** de editarlo o reducirlo.
 */
export async function leerDatosDelArchivo(exif?: ExifDeFoto | null): Promise<DatosDelArchivo> {
  const tim = Date.now();
  const tph = exif?.tomada ?? tim;

  if (exif?.lat !== undefined && exif?.lng !== undefined) {
    return { lat: exif.lat, lng: exif.lng, acc: exif.acc ?? 0, pro: 'exif', tim, tph };
  }

  const lectura = await ubicacion();
  if (!lectura) return { lat: '', lng: '', acc: 0, pro: '', tim, tph };

  return { lat: lectura.lat, lng: lectura.lng, acc: lectura.acc, pro: 'gps', tim, tph };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXIF
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fecha de toma y GPS del EXIF de una foto JPEG, o `null` si no trae.
 *
 * Se lee a mano: solo hacen falta cinco etiquetas y el EXIF va al comienzo del
 * archivo, así que basta con los primeros 256 KB.
 */
export async function leerExif(blob: Blob): Promise<ExifDeFoto | null> {
  try {
    const buffer = await blob.slice(0, 256 * 1024).arrayBuffer();
    return exifDeJpeg(new DataView(buffer));
  } catch {
    return null;
  }
}

function exifDeJpeg(v: DataView): ExifDeFoto | null {
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;

  let p = 2;
  while (p + 4 <= v.byteLength) {
    if (v.getUint8(p) !== 0xff) return null;
    const marcador = v.getUint8(p + 1);
    if (marcador === 0xd9 || marcador === 0xda) return null;
    const largo = v.getUint16(p + 2);

    // APP1 con «Exif\0\0».
    if (marcador === 0xe1 && p + 10 <= v.byteLength && v.getUint32(p + 4) === 0x45786966) {
      return leerTiff(v, p + 10);
    }
    p += 2 + largo;
  }
  return null;
}

function leerTiff(v: DataView, base: number): ExifDeFoto | null {
  const orden = v.getUint16(base);
  const le = orden === 0x4949;
  if (!le && orden !== 0x4d4d) return null;

  const u16 = (o: number) => v.getUint16(base + o, le);
  const u32 = (o: number) => v.getUint32(base + o, le);

  type Entrada = { tipo: number; cuenta: number; valor: number };

  const entradas = (ifd: number): Map<number, Entrada> => {
    const mapa = new Map<number, Entrada>();
    if (!ifd || base + ifd + 2 > v.byteLength) return mapa;
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (base + e + 12 > v.byteLength) break;
      mapa.set(u16(e), { tipo: u16(e + 2), cuenta: u32(e + 4), valor: e + 8 });
    }
    return mapa;
  };

  const ascii = (e?: Entrada): string | undefined => {
    if (!e || e.tipo !== 2) return undefined;
    const desde = e.cuenta > 4 ? u32(e.valor) : e.valor;
    let s = '';
    for (let i = 0; i < e.cuenta && base + desde + i < v.byteLength; i++) {
      const c = v.getUint8(base + desde + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  };

  const racionales = (e?: Entrada): number[] | undefined => {
    if (!e || (e.tipo !== 5 && e.tipo !== 10)) return undefined;
    const desde = u32(e.valor);
    const r: number[] = [];
    for (let i = 0; i < e.cuenta; i++) {
      const o = desde + i * 8;
      if (base + o + 8 > v.byteLength) return undefined;
      const num = e.tipo === 10 ? v.getInt32(base + o, le) : u32(o);
      const den = e.tipo === 10 ? v.getInt32(base + o + 4, le) : u32(o + 4);
      r.push(den === 0 ? 0 : num / den);
    }
    return r;
  };

  const puntero = (e?: Entrada): number => (e ? u32(e.valor) : 0);

  if (u16(2) !== 42) return null;
  const ifd0 = entradas(u32(4));
  const exifIfd = entradas(puntero(ifd0.get(0x8769)));
  const gpsIfd = entradas(puntero(ifd0.get(0x8825)));

  const resultado: ExifDeFoto = {};

  const tomada = fechaExif(ascii(exifIfd.get(0x9003)) ?? ascii(ifd0.get(0x0132)), ascii(exifIfd.get(0x9011)));
  if (tomada !== undefined) resultado.tomada = tomada;

  const lat = grados(racionales(gpsIfd.get(0x0002)), ascii(gpsIfd.get(0x0001)));
  const lng = grados(racionales(gpsIfd.get(0x0004)), ascii(gpsIfd.get(0x0003)));
  // 0,0 es lo que dejan algunas apps cuando no hubo GPS.
  if (lat !== undefined && lng !== undefined && !(lat === 0 && lng === 0)) {
    resultado.lat = lat;
    resultado.lng = lng;
    const error = racionales(gpsIfd.get(0x001f));
    if (error?.length) resultado.acc = error[0];
  }

  return resultado.tomada === undefined && resultado.lat === undefined ? null : resultado;
}

/**
 * `2026:11:17 14:03:22` (hora local de la cámara), con su desfase `-05:00` si
 * lo trae; sin desfase se toma la zona del navegador.
 */
function fechaExif(texto?: string, zona?: string): number | undefined {
  const m = texto?.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return undefined;
  const [a, me, d, h, mi, s] = m.slice(1).map(Number);
  if (a < 1971 || me < 1 || me > 12 || d < 1) return undefined;

  const z = zona?.match(/^([+-])(\d{2}):?(\d{2})/);
  if (z) {
    const desfase = (Number(z[2]) * 60 + Number(z[3])) * 60000 * (z[1] === '-' ? -1 : 1);
    return Date.UTC(a, me - 1, d, h, mi, s) - desfase;
  }
  const local = new Date(a, me - 1, d, h, mi, s).getTime();
  return Number.isFinite(local) ? local : undefined;
}

/** Grados, minutos y segundos a grados decimales. */
function grados(valor?: number[], ref?: string): number | undefined {
  if (!valor?.length) return undefined;
  let g = valor[0] + (valor[1] ?? 0) / 60 + (valor[2] ?? 0) / 3600;
  if (!Number.isFinite(g)) return undefined;
  const r = (ref ?? '').toUpperCase();
  if (r.startsWith('S') || r.startsWith('W')) g = -g;
  return g;
}
