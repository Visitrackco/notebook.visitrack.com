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
      field.defaultIsItemField,
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
  const ref = refOf(field.def);
  if (!ref) return '';

  const direct = DIRECT[ref];

  if (direct) {
    const record = asRecord(source[direct.from]);
    return record ? text(record[direct.key]) : '';
  }

  // Un identificador cualquiera: es un campo del propio registro, guardado en
  // su `jsonValues`.
  const record = asRecord(source[originOf(field)]);
  if (!record) return '';

  const entry = fieldsOf(record['jsonValues']).find(
    (item) => String(item?.['id'] ?? '') === ref,
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
