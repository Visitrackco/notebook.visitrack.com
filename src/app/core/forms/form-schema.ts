/**
 * Estructura de un formulario y de sus respuestas.
 *
 * Es la traducción del `JSONQuestion` que diseña Visitrack y del `Fields` que
 * guarda cada actividad. Los nombres de propiedad son los del servidor —`fty`,
 * `lab`, `req`, `sect`— y **no se renombran**: la app móvil y el backend hablan
 * ese idioma, y traducir aquí obligaría a destraducir al guardar, con un mapa
 * de nombres que se desincroniza a la primera propiedad nueva.
 */

/** Opción de un campo de selección. */
export interface FieldOption {
  id: string;
  txt: string;
  /**
   * Sección que esta opción activa.
   *
   * Es el mecanismo de visibilidad condicionada: al elegir esta opción, los
   * campos cuyo `sect` coincida pasan a mostrarse. Vacío = no activa nada.
   */
  act_data?: string;
}

/** Un campo del formulario. */
export interface FormField {
  id: string;
  /** Tipo de campo. Determina qué componente lo dibuja. */
  fty: string;
  /** Etiqueta visible. */
  lab: string;

  /** Oculto de entrada. Puede volverse visible por sección activa. */
  hid?: boolean;
  /** Solo lectura. */
  rea?: boolean;
  /** Obligatorio. */
  req?: boolean;

  /** Valor por defecto. */
  def?: string;
  /** Texto del párrafo o del título, según el tipo. */
  txt?: string;
  tit?: string;
  /** Marcador de posición. */
  pho?: string;
  /** Texto de ayuda bajo el campo. */
  hel?: string;

  /** Configuración propia del tipo: mínimos, máximos, formato. */
  key?: string;
  dat1?: string;
  dat2?: string;

  /**
   * Sección a la que pertenece.
   *
   * Con valor, el campo solo se muestra si esa sección está activa — la activa
   * la opción de un campo de selección.
   */
  sect?: string;

  /** Opciones, en los campos de selección. */
  opt?: FieldOption[];

  /** Distinto de 0 si el campo es descriptivo del listado. */
  pri?: number | boolean;

  /**
   * Dirección de la imagen o del enlace.
   *
   * En un hipervínculo es el destino; en un campo `image`, la fotografía de
   * referencia que se muestra dentro del formulario.
   */
  url?: string;

  /**
   * Impide elegir la fotografía de la galería.
   *
   * Con esto activado solo vale la cámara: es para las inspecciones donde la
   * evidencia tiene que tomarse en el sitio y no puede ser una imagen guardada
   * de antes. El nombre viene del servidor y no se traduce.
   *
   * Se lee con [blocksGallery], nunca directamente: el tipo depende de cómo lo
   * haya guardado el diseñador del formulario.
   */
  blockGallery?: boolean | string | number;
}

/** Una página del formulario. */
export interface FormPage {
  /** Título de la página. */
  lab?: string;
  hid?: boolean;
  /** Campos que contiene. */
  fie: FormField[];
}

/** Coordenadas capturadas por un campo GPS. */
export interface GeoValue {
  lat: number;
  lng: number;
  pro: string;
  tim: number;
  tph: number;
  alt: number;
  acc: number;
}

/**
 * Referencia al archivo de un campo binario.
 *
 * El contenido **no** va aquí: `bin` es el GUID del archivo, que vive aparte en
 * `BinariesData`. Es lo que permite que la actividad viaje al servidor sin
 * arrastrar los megabytes de una fotografía dentro de su JSON.
 *
 * Se declara en este módulo, y no se importa del servicio de almacenamiento,
 * para que el esquema del formulario siga sin depender de la capa de datos.
 */
export interface FileValue {
  bin: string;
  sig: string;
  lat: string;
  lng: string;
  acc: number;
  pro: string;
  tim: number;
  tph: number;
}

/** Valor de un campo, según su tipo. */
export type FieldValue =
  /** Texto, número, fecha, hora: todos se guardan como cadena. */
  | string
  /** Selección única: la opción elegida. */
  | { id: string; txt: string }
  /** Selección múltiple: las opciones marcadas. */
  | { id: string; txt: string }[]
  /** Ubicación: las coordenadas y su metadato. */
  | GeoValue
  /** Fotografía, firma, audio, video o documento. */
  | FileValue
  | null;

/** Una respuesta guardada, tal como vive en `SurveyAnswers.Fields`. */
export interface AnswerField {
  id: string;
  val: FieldValue;
  fty: string;
  /** Visibilidad en el momento de guardar. La usa la validación. */
  hid: boolean;
  /** Descriptivos resueltos, en los campos que los traen. */
  des?: unknown;

  /**
   * Ficha completa del archivo, en los tipos que la desdoblan.
   *
   * En `picture`, `audio` y `video` la app guarda el **GUID** en `val` y el
   * objeto entero aquí. En `signature` y `file` no: ahí `val` lleva ya el
   * objeto y esta propiedad no existe.
   *
   * Es incoherente, pero es lo que el backend recibe desde hace años y lo que
   * sabe leer. Uniformarlo por nuestra cuenta rompería las actividades que
   * llegan desde el móvil. Lo resuelven [fileValueOf] y [splitFileValue].
   */
  val1?: FileValue;
}

/**
 * Tipos que guardan el GUID en `val` y la ficha en `val1`.
 *
 * La lista es literal, no deducida: `signature` y `file` guardan el objeto
 * directamente en `val` aunque sean archivos igual que estos. Cualquier
 * intento de agrupar «los binarios» rompe uno de los dos grupos.
 */
const SPLIT_FILE_TYPES = new Set(['picture', 'audio', 'video']);

/**
 * Reparte el valor de un archivo entre `val` y `val1` como lo hace la app.
 *
 * @returns el par tal como debe quedar escrito en `Fields`.
 */
export function splitFileValue(
  fty: string,
  value: FileValue,
): { val: FieldValue; val1?: FileValue } {
  return SPLIT_FILE_TYPES.has(fty) ? { val: value.bin, val1: value } : { val: value };
}

/**
 * Lee el archivo de una respuesta guardada, venga en `val` o en `val1`.
 *
 * Contempla también el caso de un `val` que trae solo el GUID sin `val1`: pasa
 * con actividades guardadas por versiones antiguas, y devolver `null` ahí haría
 * desaparecer una fotografía que sí existe.
 */
export function fileValueOf(entry: AnswerField): FileValue | null {
  if (entry.val1?.bin) return entry.val1;

  const direct = asFile(entry.val);
  if (direct) return direct;

  if (typeof entry.val === 'string' && entry.val.trim() && isFileType(entry.fty)) {
    return { bin: entry.val, sig: '', lat: '', lng: '', acc: 0, pro: 'gps', tim: 0, tph: 0 };
  }

  return null;
}

/** ¿Este tipo de campo guarda un archivo? */
export function isFileType(fty: string): boolean {
  return SPLIT_FILE_TYPES.has(fty) || fty === 'signature' || fty === 'file';
}

/**
 * ¿Es este valor una opción elegida?
 *
 * Con el GPS, la unión de valores dejó de ser «cadena, opción o lista»: ahora
 * un objeto puede ser una opción **o** unas coordenadas. Este predicado es lo
 * que permite distinguirlos sin forzar el tipo, y hace que el compilador avise
 * si mañana se añade otro objeto a la unión y algún sitio se olvida de
 * contemplarlo.
 */
export function asOption(value: FieldValue): { id: string; txt: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const candidate = value as { id?: unknown; txt?: unknown };
  return typeof candidate.id === 'string' && typeof candidate.txt === 'string'
    ? (value as { id: string; txt: string })
    : null;
}

/**
 * ¿Es este valor una lectura de GPS?
 *
 * Se pide que `lat` y `lng` sean **números**, no solo que existan: un archivo
 * los lleva también, pero como cadenas. Sin esa distinción, una fotografía
 * pasaría por unas coordenadas.
 */
export function asGeo(value: FieldValue): GeoValue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const candidate = value as { lat?: unknown; lng?: unknown };
  return typeof candidate.lat === 'number' && typeof candidate.lng === 'number'
    ? (value as GeoValue)
    : null;
}

/** ¿Es este valor la referencia a un archivo? */
export function asFile(value: FieldValue): FileValue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const candidate = value as { bin?: unknown };
  return typeof candidate.bin === 'string' && candidate.bin !== ''
    ? (value as FileValue)
    : null;
}

/** Sección activada por la opción de un campo. */
export interface ActiveSection {
  /** Campo que la activó. Solo puede tener una activa a la vez. */
  id: string;
  sect: string;
}

// ─── Lectura del esquema ─────────────────────────────────────────────────────

/**
 * Interpreta el `JSONQuestion` de un formulario.
 *
 * Las páginas ocultas se descartan aquí y no en cada consulta: son parte de la
 * estructura y no cambian mientras el formulario está abierto, así que filtrar
 * una sola vez evita repetirlo en cada repintado.
 */
export function parseQuestions(raw: unknown): FormPage[] {
  if (!raw) return [];

  let decoded: unknown = raw;

  if (typeof raw === 'string') {
    if (!raw.trim()) return [];
    try {
      decoded = JSON.parse(raw);
    } catch {
      console.error('[Forms] JSONQuestion ilegible');
      return [];
    }
  }

  if (!Array.isArray(decoded)) return [];

  return decoded
    .filter((page): page is FormPage => Boolean(page) && typeof page === 'object')
    .filter((page) => !page.hid)
    .map((page) => ({
      lab: page.lab ?? '',
      hid: false,
      fie: Array.isArray(page.fie) ? page.fie : [],
    }));
}

/** Interpreta el `Fields` de una actividad. */
export function parseAnswerFields(raw: unknown): AnswerField[] {
  if (!raw) return [];

  const text = String(raw).trim();
  if (!text) return [];

  try {
    const decoded = JSON.parse(text);
    return Array.isArray(decoded) ? decoded : [];
  } catch {
    console.error('[Forms] Fields ilegible');
    return [];
  }
}

// ─── Reglas ──────────────────────────────────────────────────────────────────

/**
 * ¿Está el campo a la vista?
 *
 * Dos reglas, y el orden importa:
 *
 * 1. **Con `sect`**, manda la sección: el campo se muestra si esa sección está
 *    activa, aunque el esquema lo traiga `hid: true`. Así es como funciona la
 *    visibilidad condicionada — los campos de una rama nacen ocultos y los
 *    despierta la opción que los activa.
 * 2. **Sin `sect`**, manda su `hid` estático.
 */
export function isFieldVisible(field: FormField, activeSections: readonly ActiveSection[]): boolean {
  const sect = (field.sect ?? '').toString();

  if (sect) return activeSections.some((active) => active.sect === sect);

  return !field.hid;
}

/**
 * ¿Cuenta este valor como «sin diligenciar»?
 *
 * Un texto vacío, una selección sin elegir y una lista sin marcar son todos
 * «vacío», pero llegan como tipos distintos: cadena, `null` y arreglo. El cero
 * numérico **no** es vacío — es una respuesta legítima, y tratarlo como falta
 * obligaría a inventar un valor para poder guardar.
 *
 * Una lectura de GPS es un objeto con claves, así que cuenta como respondida.
 * Y unas coordenadas en el (0, 0) también: son un punto real del Atlántico, y
 * descartarlas por «parecer vacías» sería inventarse una regla.
 *
 * El archivo es la excepción: su objeto siempre trae las ocho claves, incluso
 * cuando `bin` está vacío, así que contarlo por «tener claves» daría por
 * respondida una foto que nadie tomó.
 */
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;

  if (typeof value === 'object') {
    if ('bin' in value) return !(value as { bin?: unknown }).bin;
    return Object.keys(value).length === 0;
  }

  return false;
}

/** Campos que hay que exigir: obligatorios, visibles y sin responder. */
export function findMissingRequired(
  pages: readonly FormPage[],
  values: ReadonlyMap<string, FieldValue>,
  activeSections: readonly ActiveSection[],
): { field: FormField; page: number }[] {
  const missing: { field: FormField; page: number }[] = [];

  pages.forEach((page, index) => {
    for (const field of page.fie) {
      if (!field.req) continue;

      // Un campo oculto no se exige: su control no llega a dibujarse, así que
      // el usuario no tendría forma de responderlo. Exigirlo dejaba el
      // formulario bloqueado sin nada que hacer al respecto.
      if (!isFieldVisible(field, activeSections)) continue;

      if (isEmptyValue(values.get(field.id) ?? null)) {
        missing.push({ field, page: index });
      }
    }
  });

  return missing;
}

/**
 * Tipos que no reciben datos: solo muestran algo.
 *
 * `image` está aquí y no entre los de archivo, aunque el nombre sugiera lo
 * contrario: en Visitrack un campo `image` es una **fotografía de referencia**
 * que el formulario enseña —un plano, un modelo de etiqueta, un ejemplo de lo
 * que hay que buscar—, no un sitio donde subir una. La que se toma en campo es
 * `picture`.
 */
const DISPLAY_ONLY = new Set(['title', 'paragraph', 'hyperlink', 'image']);

/**
 * ¿Este campo de fotografía prohíbe la galería?
 *
 * El valor llega tal como lo escribió el diseñador del formulario, y eso
 * significa `true`, `"true"`, `1` o `"1"` según por dónde haya pasado. Leerlo
 * como booleano a secas convertía `"false"` —una cadena, y por tanto
 * verdadera— en un bloqueo que nadie configuró.
 *
 * Ante un valor que no se reconoce se **permite** la galería: es lo que hace la
 * app, y bloquear por no entender un dato le quita al usuario una forma de
 * responder sin que nadie lo haya pedido.
 */
export function blocksGallery(field: FormField): boolean {
  const raw = field.blockGallery;

  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw === 1;
  if (typeof raw === 'string') return raw.trim().toLowerCase() === 'true' || raw.trim() === '1';

  return false;
}

/** ¿El campo solo muestra información? */
export function isDisplayOnly(fty: string): boolean {
  return DISPLAY_ONLY.has(fty);
}

/**
 * Tipos que este motor todavía no dibuja.
 *
 * Se declaran para poder avisar al usuario en su sitio, con el nombre del
 * campo. Un hueco silencioso haría creer que el formulario está completo
 * cuando le falta justo la foto que se pedía.
 */
const PENDING_TYPES: Record<string, string> = {
  masterdetail: 'Tabla de detalle',
  sumdetail: 'Suma de detalle',
  calculation: 'Campo calculado',
  datediff: 'Diferencia de fechas',
  form: 'Formulario vinculado',
};

/** Nombre legible de un tipo aún no implementado. Vacío si sí lo está. */
export function pendingTypeName(fty: string): string {
  return PENDING_TYPES[fty] ?? '';
}

/** Texto legible de un valor, para descriptivos y resúmenes. */
export function valueToText(value: FieldValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;

  if (Array.isArray(value)) {
    return value.map((option) => option.txt).filter(Boolean).join(', ');
  }

  const option = asOption(value);
  if (option) return option.txt;

  // Un campo de ubicación puede ser descriptivo del listado: se resume con las
  // coordenadas recortadas, que a seis decimales ya distinguen un portal de
  // otro y caben en una línea.
  const geo = asGeo(value);
  if (geo) return `${geo.lat.toFixed(6)}, ${geo.lng.toFixed(6)}`;

  // Un archivo no tiene texto propio salvo el que lo acompaña —el nombre de
  // quien firmó, el del documento—. Cuando no lo hay, se dice que existe: un
  // vacío en el listado se lee como «sin responder», y sí se respondió.
  const file = asFile(value);
  if (file) return file.sig || 'Archivo adjunto';

  return '';
}
