import { DefaultRef, FormField } from './form-schema';

/**
 * El registro del que un formulario hereda datos.
 *
 * En una actividad son su ubicación y su activo; en una fila de tabla de
 * detalle, el ítem del que nació esa fila. Los nombres son los que usa la app
 * y no se traducen: viajan dentro del propio esquema del formulario.
 */
export interface InheritedSource {
  LocationInfo?: unknown;
  AssetInfo?: unknown;
  itemsInfo?: unknown;
}

/**
 * Campos que se leen directamente del registro, sin pasar por su `jsonValues`.
 *
 * Son los de la propia tabla —el nombre de la ubicación, su dirección, el
 * precio del ítem—, que existen para toda ubicación o todo ítem. Lo demás es
 * configurable por tipo y vive en `jsonValues`.
 */
const DIRECT: Record<string, { from: keyof InheritedSource; key: string }> = {
  LOC_NAME: { from: 'LocationInfo', key: 'Name' },
  LOC_CONTACTNAME: { from: 'LocationInfo', key: 'ContactName' },
  LOC_STREET: { from: 'LocationInfo', key: 'Street' },
  LOC_POSTALCODE: { from: 'LocationInfo', key: 'PostalCode' },
  LOC_STATE: { from: 'LocationInfo', key: 'State' },
  LOC_CITY: { from: 'LocationInfo', key: 'City' },
  LOC_PHONE: { from: 'LocationInfo', key: 'Phone' },

  AST_NAME: { from: 'AssetInfo', key: 'Name' },

  LST_NAME: { from: 'itemsInfo', key: 'Name' },
  ITE_NAME: { from: 'itemsInfo', key: 'Name' },
  ITE_PRICE: { from: 'itemsInfo', key: 'Price' },
  ITE_COST: { from: 'itemsInfo', key: 'Cost' },
};

/**
 * Datos del activo que se piden con el prefijo `ASS_`.
 *
 * Es la familia nueva del diseñador: un `def` que empieza por `ASS_` hereda del
 * activo de la actividad sin necesidad de ninguna bandera. Trae la marca, el
 * modelo y el serial, que son las tres cosas que un formulario de mantenimiento
 * vuelve a pedir siempre.
 *
 * Se admiten varios nombres para lo mismo porque el identificador lo escribe
 * quien diseña el formulario, y `ASS_MARKE`, `ASS_MARCA` o `ASS_MAKE` quieren
 * decir lo mismo. Un sufijo que no esté aquí se busca en los campos propios del
 * activo, igual que cualquier otro heredado.
 */
const ASSET_COLUMNS: Record<string, string> = {
  MARKE: 'Make',
  MARCA: 'Make',
  MAKE: 'Make',
  MARK: 'Make',
  BRAND: 'Make',

  MODEL: 'Model',
  MODELO: 'Model',

  SERIAL: 'SerialNumber',
  SERIE: 'SerialNumber',
  SERIALNUMBER: 'SerialNumber',
  SERIALNO: 'SerialNumber',
  NUMEROSERIE: 'SerialNumber',
  NUMERODESERIE: 'SerialNumber',
  NROSERIE: 'SerialNumber',
  SN: 'SerialNumber',

  NAME: 'Name',
  NOMBRE: 'Name',
  TAG: 'TagUID',
  TAGUID: 'TagUID',
  DESCRIPTION: 'Description',
  DESCRIPCION: 'Description',
};

/**
 * El sufijo de un `ASS_…`, sin lo que no distingue.
 *
 * Mayúsculas, sin tildes y sin guiones ni espacios: `ASS_MARKE`, `ass_marca`,
 * `ASS_Nro_Serie` y `ASS_NÚMERO DE SERIE` apuntan al mismo sitio. El
 * identificador lo escribe a mano quien diseña el formulario, y una letra de
 * más dejaba el campo vacío sin decir por qué.
 */
function normalizar(sufijo: string): string {
  return sufijo
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * ¿El valor por defecto de este campo se hereda de otro registro?
 *
 * Se decide por las banderas del esquema y no por la forma del `def`: el
 * diseñador de formularios las escribe justamente para eso, y un `def` de
 * texto que casualmente parezca un objeto no debe tratarse como referencia.
 */
export function inheritsDefault(field: FormField): boolean {
  return Boolean(
    field.defaultIsLocationField ||
      field.defaultIsAssetField ||
      field.defaultIsListField ||
      field.defaultIsItemField ||
      assetTokenOf(field.def),
  );
}

/**
 * Resuelve el valor que un campo hereda de la ubicación, el activo o el ítem.
 *
 * ## Por qué existe
 *
 * Un formulario de inspección no vuelve a preguntar la dirección de la sede ni
 * el código del equipo: los trae ya escritos del registro que se está
 * inspeccionando. En una tabla de detalle eso es aún más visible — cada fila
 * nace de un ítem y arrastra sus datos al sub-formulario.
 *
 * ## De dónde sale cada cosa
 *
 * Las banderas del campo dicen **de qué registro** se lee, y el `def` dice
 * **qué dato**. Las claves conocidas (`LOC_NAME`, `ITE_PRICE`…) apuntan a
 * columnas de la tabla; cualquier otro identificador se busca en el
 * `jsonValues` del registro, que es donde van los campos que cada tipo define
 * por su cuenta.
 *
 * Devuelve cadena vacía cuando el registro no está o no tiene ese dato: un
 * campo sin heredar se deja para que lo llene quien responde, no se rompe.
 */
export function resolveInheritedDefault(field: FormField, source: InheritedSource): string {
  // Los `ASS_` van primero y por su cuenta: se reconocen por el prefijo, no por
  // las banderas, y leen del activo aunque el campo no venga marcado.
  const asset = assetTokenOf(field.def);
  if (asset) return fromAsset(asset, source.AssetInfo);

  const ref = refOf(field.def);
  if (!ref) return '';

  const direct = DIRECT[ref];

  if (direct) {
    const record = asRecord(source[direct.from]);
    return record ? text(record[direct.key]) : '';
  }

  const origen = originOf(field);
  const record = asRecord(source[origen]);
  if (!record) return '';

  /*
   * Un campo del activo marcado con la bandera, pero cuyo identificador es el
   * de una **columna**: `MAKE`, `MODELO`, `SERIAL`.
   *
   * Aquí solo se miraba dentro de `jsonValues`, así que la marca —que vive en
   * su propia columna— no se encontraba nunca y el campo nacía vacío. Los
   * `ASS_…` ya salen por arriba; esto cubre a los que el diseñador nombró sin
   * el prefijo.
   */
  if (origen === 'AssetInfo') {
    const deColumna = fromAsset(`ASS_${ref.toUpperCase()}`, record);
    if (deColumna) return deColumna;
  }

  // Un identificador cualquiera: es un campo del propio registro, guardado en
  // su `jsonValues`.

  const entry = fieldsOf(record['jsonValues']).find(
    (item) => String(item?.['id'] ?? '') === ref,
  );

  return entry ? text(entry['val']) : '';
}

/**
 * El identificador `ASS_…` de un `def`, si lo es.
 *
 * Acepta las dos formas en que llega el `def` —el objeto con `id` y el texto
 * suelto— porque el diseñador escribe una u otra según por dónde se creó el
 * campo. Devuelve cadena vacía cuando no es de esta familia, y así quien
 * pregunta sigue con el camino de siempre.
 */
function assetTokenOf(def: string | DefaultRef | undefined): string {
  if (!def) return '';

  const crudo = typeof def === 'string' ? def.trim() : String(def.id ?? '').trim();

  // Un texto que en realidad es el objeto serializado: se mira dentro.
  if (crudo.startsWith('{')) {
    const dentro = refOf(crudo);
    return /^ASS_/i.test(dentro) ? dentro.toUpperCase() : '';
  }

  return /^ASS_/i.test(crudo) ? crudo.toUpperCase() : '';
}

/**
 * El dato del activo al que apunta un `ASS_…`.
 *
 * **Sin activo no hay herencia**: si la actividad no cuelga de ningún equipo el
 * campo se queda vacío para que lo llene quien responde. Escribir ahí el nombre
 * del identificador, o el de otro registro, sería peor que dejarlo en blanco.
 */
function fromAsset(token: string, assetInfo: unknown): string {
  const asset = asRecord(assetInfo);
  if (!asset) return '';

  /*
   * La columna primero; si está vacía, los campos del tipo.
   *
   * `Make`, `Model` y `SerialNumber` son columnas del activo, pero un equipo
   * dado de alta antes de que existieran las trae en blanco, y su marca vive
   * donde vivía entonces: en los campos propios del tipo. Darlo por perdido al
   * ver la columna vacía dejaba el campo heredado sin valor teniéndolo al lado.
   */
  const columna = ASSET_COLUMNS[normalizar(token.slice(4))];

  if (columna) {
    const deLaTabla = text(asset[columna]).trim();
    if (deLaTabla) return deLaTabla;
  }

  // Vale el identificador tal cual, el sufijo suelto o el nombre de la columna:
  // el diseñador de tipos pudo nombrarlo de cualquiera de las tres formas.
  const acepta = new Set(
    [token, token.slice(4), columna ?? ''].filter(Boolean).map(normalizar),
  );

  const entry = fieldsOf(asset['jsonValues']).find((item) =>
    acepta.has(normalizar(String(item?.['id'] ?? ''))),
  );

  return entry ? text(entry['val']) : '';
}

/** De qué registro lee este campo. */
function originOf(field: FormField): keyof InheritedSource {
  if (field.defaultIsLocationField) return 'LocationInfo';
  if (field.defaultIsAssetField) return 'AssetInfo';

  return 'itemsInfo';
}

/** El identificador del dato al que apunta el `def`. */
function refOf(def: string | DefaultRef | undefined): string {
  if (!def) return '';
  if (typeof def === 'string') {
    // Puede llegar sin interpretar cuando el esquema viajó como texto.
    try {
      const parsed: unknown = JSON.parse(def);
      return typeof parsed === 'object' && parsed !== null
        ? String((parsed as DefaultRef).id ?? '')
        : '';
    } catch {
      return '';
    }
  }

  return String(def.id ?? '');
}

/**
 * Los campos guardados en un `jsonValues`.
 *
 * Llega de dos formas según de qué tabla venga el registro: un arreglo suelto o
 * un objeto con `fie` dentro. La app contempla las dos y aquí también, porque
 * un mismo formulario puede heredar de una ubicación y de un ítem a la vez.
 */
function fieldsOf(raw: unknown): Record<string, unknown>[] {
  if (!raw) return [];

  try {
    const decoded: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;

    if (Array.isArray(decoded)) return decoded as Record<string, unknown>[];

    const nested = (decoded as { fie?: unknown })?.fie;
    return Array.isArray(nested) ? (nested as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Los datos de la sede y del activo, por el nombre con que los llama un flujo.
 *
 * Un flujo puede preguntar por dónde se trabaja y sobre qué —«si la sede es la
 * de Bogotá», «si el equipo es de tal marca»— y esos valores no están en las
 * respuestas del formulario: viven en el registro del que cuelga la actividad.
 * Aquí se sacan con los mismos prefijos que ya usan los valores heredados y las
 * plantillas de PDF, `LOC_` y `AST_`, para no tener dos nomenclaturas.
 *
 * Devuelve texto siempre: el motor compara textos y ya sabe convertir a número
 * o a fecha cuando la condición lo pide.
 */
export function valoresDelEntorno(source: InheritedSource): Record<string, string> {
  const salida: Record<string, string> = {};

  // Los de la propia tabla: nombre, ciudad, teléfono…
  for (const [clave, def] of Object.entries(DIRECT)) {
    const record = asRecord(source[def.from]);
    if (record) salida[clave] = text(record[def.key]);
  }

  // Y los que cada compañía define en el tipo de sede o de activo, que viven
  // en `jsonValues` con su propio `apiId`.
  const propios = (origen: keyof InheritedSource, prefijo: string) => {
    const record = asRecord(source[origen]);
    if (!record) return;

    // El `apiId` está en la definición del tipo, no en el valor: se cruza por
    // `id`, que es lo que ambos comparten.
    const definiciones = new Map<string, string>();

    for (const pagina of fieldsOf(record['jsonQuestion'])) {
      for (const campo of fieldsOf((pagina as Record<string, unknown>)?.['fie'])) {
        const c = campo as Record<string, unknown>;
        const apiId = String(c['apiId'] ?? '').trim();
        if (apiId) definiciones.set(String(c['id'] ?? ''), apiId);
      }
    }

    for (const item of fieldsOf(record['jsonValues'])) {
      const apiId = definiciones.get(String(item?.['id'] ?? ''));
      if (apiId) salida[prefijo + apiId.toUpperCase()] = text(item['val']);
    }
  };

  propios('LocationInfo', 'LOC_');
  propios('AssetInfo', 'AST_');

  return salida;
}
