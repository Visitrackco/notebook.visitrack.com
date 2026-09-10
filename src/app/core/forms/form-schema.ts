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

/** Qué dato del ítem elegido se muestra bajo el desplegable. */
export interface DescriptorConfig {
  /** Campo del formulario de la lista del que sale el valor. */
  id: string;
  lab: string;
  /** Solo se muestran los marcados. */
  isSelected?: boolean;
}

/** Un dato del ítem elegido, ya resuelto. */
export interface ResolvedDescriptor {
  id: string;
  lab: string;
  val: string;
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

  /**
   * Valor por defecto.
   *
   * Puede ser un texto —lo que se escribe en el campo—, una palabra clave
   * temporal (`CURRENTDATE`), o una **referencia** a un dato del registro del
   * que cuelga el formulario. Ese último caso se reconoce por las banderas
   * `defaultIs*` y lo resuelve `inherited-defaults`.
   */
  def?: string | DefaultRef;

  /**
   * El valor por defecto se lee de otro registro.
   *
   * De la ubicación, del activo, del ítem de la lista o del de inventario. En
   * una tabla de detalle ese registro es el ítem del que nació la fila, y es lo
   * que permite que el sub-formulario llegue con la dirección de la sede o el
   * código del equipo ya escritos.
   */
  defaultIsLocationField?: boolean;
  defaultIsAssetField?: boolean;
  defaultIsListField?: boolean;
  defaultIsItemField?: boolean;
  /** Texto del párrafo o del título, según el tipo. */
  txt?: string;
  tit?: string;
  /** Marcador de posición. */
  pho?: string;
  /** Texto de ayuda bajo el campo. */
  hel?: string;

  /**
   * Identificador del campo en la plataforma.
   *
   * Casi nunca importa, con una excepción: si contiene `_star`, un campo de
   * selección única se dibuja como una **calificación por estrellas** en vez de
   * como una lista de opciones. Es una convención del diseñador de formularios
   * —el tipo sigue siendo `radio`— y así lo interpreta la app.
   */
  apiId?: string;

  /** Configuración propia del tipo: mínimos, máximos, formato. */
  key?: string;

  /**
   * Campos de fecha inicial y final de un `datediff`.
   *
   * El resultado es `dat2 - dat1` en días, con las horas descartadas.
   */
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

  /**
   * Lista de la que salen las opciones, cuando no vienen en `opt`.
   *
   * Es el `ListID` de la tabla de listas. Un desplegable puede tener sus
   * opciones escritas en el propio formulario —eso es `opt`— o apuntar a una
   * lista mantenida en Visitrack con miles de ítems.
   */
  lst?: string | number;

  /**
   * Entidad de la que salen los ítems.
   *
   * `0` es una lista normal. Otros valores apuntan a ubicaciones, activos,
   * usuarios o ítems de inventario, que esta versión todavía no resuelve.
   */
  ent?: string | number;

  /**
   * Campo del que depende: solo se muestran los ítems cuyo padre sea el
   * elegido allí. Es lo que encadena «departamento → ciudad».
   */
  parentId?: string;

  /**
   * Qué datos del ítem se enseñan al elegirlo.
   *
   * Cada entrada trae `id`, `lab` e `isSelected`; solo las marcadas se
   * muestran. Los valores salen del `jsonValues` del propio ítem.
   */
  des?: DescriptorConfig[];

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
   * Valor fijo que trae el propio esquema.
   *
   * En un hipervínculo es la **plantilla de la dirección**, con sus marcadores
   * sin resolver. Es donde la guarda el diseñador de formularios, y por eso se
   * lee antes que `url`.
   */
  val?: string;

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

  /**
   * Permisos sobre las filas de una tabla de detalle.
   *
   * `mobAdd` para agregar, `mobUpd` para abrir y editar, `mobDel` para
   * eliminar. Los valores por omisión son los de la app y no coinciden entre
   * sí: **agregar está cerrado salvo que el formulario lo abra**, mientras que
   * editar y eliminar están abiertos salvo que lo cierre.
   */
  mobAdd?: boolean;
  mobDel?: boolean;

  /**
   * ¿Las filas de la tabla de detalle viajan como novedad?
   *
   * Ausente es `true`, igual que en la app: lo normal es que una fila creada en
   * el dispositivo sea algo que el servidor todavía no tiene.
   */
  mobUpd?: boolean;

  /**
   * Fórmula de un campo calculado.
   *
   * Cada entrada es un operando con su operación. La interpreta
   * `derived-fields`, que documenta el orden en que se aplican — que no es el
   * de escritura.
   */
  ele?: CalculationElement[];

  /** Campo de tabla de detalle sobre el que suma un `sumdetail`. */
  mde?: string;

  /** Campo de cada fila que acumula un `sumdetail`. */
  fid?: string;

  /**
   * Tope de filas de una tabla de detalle.
   *
   * `0` o ausente es sin límite. Se lee con [rowLimit], que normaliza lo que
   * venga: el diseñador lo guarda unas veces como número y otras como texto.
   */
  limitRows?: number | string;
}

/**
 * Referencia a un dato del registro del que cuelga el formulario.
 *
 * `id` es una clave conocida (`LOC_NAME`, `ITE_PRICE`…) o el identificador de
 * un campo del `jsonValues` de ese registro. `lab` es lo que ve el diseñador
 * del formulario y aquí no se usa.
 */
export interface DefaultRef {
  id: string;
  lab?: string;
}

/**
 * Un operando de la fórmula de un campo calculado.
 *
 * Se declara aquí, con el resto del esquema, y lo interpreta `derived-fields`.
 */
export interface CalculationElement {
  /** Es el valor base sobre el que se aplica todo lo demás. */
  isFirst?: boolean;
  /** «Is konstante»: usa `val` en vez del valor de otro campo. */
  isk?: boolean;
  /** Campo del que se toma el valor. */
  fie?: string;
  /** Constante literal. */
  val?: string | number;
  /** 1 sumar · 2 restar · 3 multiplicar · 4 dividir. */
  ope?: number | string;
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

/**
 * Una fila de una tabla de detalle.
 *
 * Aquí solo se declara lo justo para distinguirla de las demás formas que puede
 * tomar un valor. La forma completa —con todo lo que el backend espera de una
 * fila— vive en `master-detail.ts`, que es quien las crea y las lee; ponerla
 * entera aquí obligaría al esquema a saber de un tipo de campo concreto.
 */
export interface DetailRowValue {
  GUID: string;
  Name: string;
  JSONValues: AnswerField[];
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
  /** Tabla de detalle: sus filas, cada una con su sub-formulario. */
  | DetailRowValue[]
  | null;

/** Una respuesta guardada, tal como vive en `SurveyAnswers.Fields`. */
export interface AnswerField {
  id: string;
  val: FieldValue;
  fty: string;
  /** Visibilidad en el momento de guardar. La usa la validación. */
  hid: boolean;
  /**
   * Descriptivos del ítem elegido, ya resueltos.
   *
   * Se guardan **con la respuesta** y no se recalculan al abrirla: el ítem
   * puede cambiar en Visitrack después, y lo que documenta la actividad es lo
   * que decía cuando se respondió.
   */
  des?: ResolvedDescriptor[];

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
 * Las opciones marcadas, en un valor de selección múltiple.
 *
 * Un valor en arreglo ya no es necesariamente una lista de opciones: una tabla
 * de detalle guarda así sus filas. Se filtra por forma en vez de dar por hecho
 * que todo arreglo es de opciones, que es lo que dejaba a un `map` leyendo
 * `txt` en una fila y devolviendo huecos.
 */
export function asOptions(value: FieldValue): { id: string; txt: string }[] {
  if (!Array.isArray(value)) return [];

  return value.filter(
    (entry): entry is { id: string; txt: string } =>
      typeof (entry as { txt?: unknown }).txt === 'string',
  );
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

/**
 * Interpreta las respuestas de un formulario.
 *
 * Llegan de dos sitios y en dos formas: de una actividad, como el texto JSON
 * que guarda `SurveyAnswers.Fields`; y de una fila de tabla de detalle, como el
 * arreglo que ya vive dentro de esa actividad, sin volver a serializar.
 *
 * Contemplar las dos no es una concesión: convertir el arreglo a texto para
 * volver a leerlo sería trabajo inventado, y hacerlo con `String()` lo dejaba
 * en `"[object Object]"` — que es exactamente lo que se veía como «Fields
 * ilegible» al abrir cualquier fila.
 */
export function parseAnswerFields(raw: unknown): AnswerField[] {
  if (!raw) return [];

  if (Array.isArray(raw)) return raw.filter(isAnswerField);

  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return [];

  try {
    const decoded: unknown = JSON.parse(text);
    return Array.isArray(decoded) ? decoded.filter(isAnswerField) : [];
  } catch {
    console.error('[Forms] Fields ilegible');
    return [];
  }
}

/** Una respuesta con forma reconocible. Descarta huecos y restos de versiones viejas. */
function isAnswerField(entry: unknown): entry is AnswerField {
  return Boolean(entry) && typeof entry === 'object' && 'id' in (entry as object);
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

    /*
     * Una ubicación borrada no queda en nada: queda en nada **escrito**.
     *
     * Al eliminar las coordenadas, lo que se guarda es `{lat: '', lng: ''}` —así
     * lo escribe la app, y así llega lo que se sincroniza—. El objeto sigue
     * teniendo sus dos claves, así que contando claves el campo pasaba por
     * respondido: en pantalla decía «Capturar ubicación» y al guardar no se
     * exigía, aunque fuera obligatorio. Lo que vale es si hay coordenadas, no
     * si hay objeto.
     */
    if ('lat' in value || 'lng' in value) {
      const punto = value as { lat?: unknown; lng?: unknown };

      return String(punto.lat ?? '').trim() === '' || String(punto.lng ?? '').trim() === '';
    }

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

      // Un campo que solo muestra algo no puede exigirse: no tiene dónde
      // responder. Pasa con los formularios vinculados, que en la web no se
      // dibujan — marcados como obligatorios dejarían la actividad imposible
      // de guardar.
      if (isDisplayOnly(field.fty)) continue;

      // Un campo oculto tampoco se exige: su control no llega a dibujarse, así
      // que el usuario no tendría forma de responderlo. Exigirlo dejaba el
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
const DISPLAY_ONLY = new Set([
  'title',
  'paragraph',
  'hyperlink',
  'image',
  // El formulario vinculado no se dibuja en la web. Van los dos nombres: la
  // app lo llama `form` y el diseñador web lo emite como `webform`.
  'form',
  'webform',
]);

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
 * Vacío: ya se dibujan todos. Se conserva el mecanismo porque el día que
 * Visitrack añada un tipo de campo, un hueco silencioso haría creer que el
 * formulario está completo cuando le falta justo lo que se pedía — y este es el
 * sitio donde declararlo para avisarlo con el nombre del campo.
 */
const PENDING_TYPES: Record<string, string> = {};

/** Nombre legible de un tipo aún no implementado. Vacío si sí lo está. */
export function pendingTypeName(fty: string): string {
  return PENDING_TYPES[fty] ?? '';
}

/** Texto legible de un valor, para descriptivos y resúmenes. */
export function valueToText(value: FieldValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;

  if (Array.isArray(value)) {
    const options = asOptions(value);

    // Un arreglo sin opciones dentro son las filas de una tabla de detalle.
    // Enumerarlas no diría nada útil —son formularios enteros—, así que se
    // resume con cuántas hay, que es lo que se quiere saber de un vistazo.
    if (options.length === 0) {
      return value.length === 0
        ? ''
        : `${value.length} ${value.length === 1 ? 'registro' : 'registros'}`;
    }

    return options
      .map((option) => option.txt)
      .filter(Boolean)
      .join(', ');
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
