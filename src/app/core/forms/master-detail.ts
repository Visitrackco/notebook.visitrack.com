import { AnswerField, FormPage, parseQuestions } from './form-schema';

/**
 * Una fila de un campo MasterDetail.
 *
 * Los nombres son los que escribe la app y espera el backend, sin traducir. La
 * mayoría de las propiedades no las usa la web —vienen de casos que solo
 * existen en el móvil, como las filas ligadas a una ubicación— pero se
 * conservan al leer y al escribir: una actividad diligenciada aquí puede
 * abrirse allí, y perder un campo por el camino la rompe.
 */
export interface MasterDetailRow {
  /** Identificador de la fila. */
  GUID: string;
  /** Nombre del ítem que originó la fila. */
  Name: string;

  /** Las respuestas de esta fila. Es el sub-formulario diligenciado. */
  JSONValues: AnswerField[];

  /** Descriptivos de la fila, para el listado. */
  JSONTitle: { lab: string; val: string }[];

  /** Ítem de la lista del que salió. */
  ListDetGUID: string;
  ListDetName: string;
  MasterListDetGUID: string;

  /** Listas implicadas. */
  BaseListGUID: string;
  MasterListGUID: string;

  MetaSearch: unknown[];
  Updated: boolean;
  fty: string;
  /** Campo MasterDetail al que pertenece. */
  id: string;

  LocationGUID: string;
  AssetGUID: string;
  ReadOnly: boolean;
  ent: number;
  LinkedAnswerGUID: string;

  /** Datos del ítem de origen, cuando los trae. */
  itemsInfo?: unknown;
  LocationInfo?: unknown;
  AssetInfo?: unknown;
}

/** Lo que hace falta para crear una fila. */
export interface NewRowInput {
  /** Campo MasterDetail. */
  fieldId: string;
  /** Lista configurada en el campo. */
  masterListGuid: string;
  /** Ítem elegido. */
  itemGuid: string;
  itemName: string;
  /** Solo lectura, del esquema del campo. */
  readOnly: boolean;
  /** true si el campo trae `mobUpd`. */
  updated: boolean;
  ent: number;

  /**
   * El registro del ítem, tal como está en el dispositivo.
   *
   * La app lo copia en `itemsInfo`, `LocationInfo` y `AssetInfo` —los tres, sin
   * distinguir de qué era el ítem— y es de donde el servidor saca los datos del
   * origen al procesar la fila.
   */
  item?: unknown;

  /** Catálogo del que salió el ítem: la lista, el tipo de ubicación o el de activo. */
  baseListGuid?: string;

  /** El ítem **es** una ubicación o un activo. */
  isLocation?: boolean;
  isAsset?: boolean;

  /**
   * La ubicación de la que cuelga la fila, cuando no es el ítem mismo.
   *
   * Pasa en las listas de dos niveles: primero se elige una sede y después uno
   * de sus registros. La app la lleva aparte, en la navegación, y la pierde al
   * reabrir la actividad; guardarla en la fila es lo que permite que los
   * valores heredados de la sede sigan resolviéndose la segunda vez.
   */
  locationItem?: unknown;
}

/**
 * Crea una fila con la forma exacta que escribe la app.
 *
 * El primer valor de `JSONValues` es siempre el ítem elegido, con el
 * identificador literal `name`. No es un campo del sub-formulario: es la
 * cabecera de la fila, y la app la escribe así al crearla.
 */
export function createRow(input: NewRowInput): MasterDetailRow {
  return {
    GUID: crypto.randomUUID(),
    Name: input.itemName,

    JSONValues: [
      {
        id: 'name',
        fty: 'dropdownlist',
        val: { id: input.itemGuid, txt: input.itemName },
        hid: false,
      },
    ],

    JSONTitle: [{ lab: '[DEF]', val: input.itemName }],

    ListDetGUID: input.itemGuid,
    ListDetName: input.itemName,
    MasterListDetGUID: input.itemGuid,

    BaseListGUID: input.baseListGuid ?? '',
    MasterListGUID: input.masterListGuid,

    MetaSearch: [],
    Updated: input.updated,
    fty: 'masterdetail',
    id: input.fieldId,

    // Solo se llenan cuando el ítem **es** esa entidad. Una fila que salió de
    // una lista corriente los deja vacíos: escribir ahí el GUID del ítem haría
    // creer al servidor que la fila apunta a una ubicación que no existe.
    LocationGUID: input.isLocation ? input.itemGuid : '',
    AssetGUID: input.isAsset ? input.itemGuid : '',

    ReadOnly: input.readOnly,
    ent: input.ent,
    LinkedAnswerGUID: '',

    // Los tres con el mismo registro, como hace la app: cuál de ellos lee el
    // servidor depende de la entidad, y no cuesta nada dárselos todos. La
    // excepción es la ubicación de una lista de dos niveles, que es un registro
    // distinto del ítem y tiene que quedar en su sitio.
    itemsInfo: input.item,
    LocationInfo: input.locationItem ?? input.item,
    AssetInfo: input.item,
  };
}

/**
 * Una fila sin ítem detrás.
 *
 * Es el caso de las listas que no representan ningún registro: cada fila es
 * solo el formulario, repetido. La app la crea con `{'id':'','txt':''}`, así
 * que la cabecera queda con el valor vacío — y se conserva igual, porque es lo
 * que el backend espera encontrar en la primera posición de `JSONValues`.
 */
export function createBlankRow(input: {
  fieldId: string;
  masterListGuid: string;
  name: string;
  readOnly: boolean;
  updated: boolean;
}): MasterDetailRow {
  const row = createRow({
    fieldId: input.fieldId,
    masterListGuid: input.masterListGuid,
    itemGuid: '',
    itemName: '',
    readOnly: input.readOnly,
    updated: input.updated,
    ent: 0,
  });

  // El nombre lo pone el propio campo —«Registro 3»— porque no hay ítem del que
  // tomarlo, y una lista de filas sin nombre no se puede recorrer.
  return { ...row, Name: input.name, JSONTitle: [{ lab: '[DEF]', val: input.name }] };
}

/**
 * Las filas guardadas de un campo.
 *
 * El valor llega como arreglo, pero una actividad vieja o a medio migrar puede
 * traer cualquier cosa: se devuelve vacío en vez de dejar que el componente
 * reviente al recorrerlo.
 */
export function readRows(value: unknown): MasterDetailRow[] {
  if (!Array.isArray(value)) return [];

  return value.filter(
    (row): row is MasterDetailRow => Boolean(row) && typeof row === 'object' && 'GUID' in row,
  );
}

/**
 * El sub-formulario de cada fila.
 *
 * Sale de `jsonFields` de la **lista** configurada en el campo, no del
 * formulario que contiene el MasterDetail. Es la misma estructura de páginas y
 * campos que un formulario normal, así que la lee `parseQuestions` y la dibuja
 * el mismo motor.
 */
export function parseRowSchema(jsonFields: unknown): FormPage[] {
  return parseQuestions(jsonFields);
}

/**
 * Resumen de una fila para el listado.
 *
 * Se leen los descriptivos guardados —lo que el sub-formulario marcó como
 * `pri`— y se descarta el `[DEF]`, que es el nombre del ítem y ya se muestra
 * como título de la fila.
 */
export function rowSummary(row: MasterDetailRow): string {
  const parts = (row.JSONTitle ?? [])
    .filter((title) => title.lab !== '[DEF]')
    .map((title) => String(title.val ?? '').trim())
    .filter(Boolean);

  return parts.join(' · ');
}

/**
 * ¿Cuántas filas admite este campo?
 *
 * `0` o ausente significa sin límite. La app lo comprueba en dos sitios —la
 * interfaz y el guardado— y aquí se hace igual: el botón se desactiva, y quien
 * llame igualmente se encuentra la comprobación.
 */
export function rowLimit(limitRows: unknown): number {
  const limit = Number(limitRows ?? 0);
  return Number.isFinite(limit) && limit > 0 ? limit : 0;
}
