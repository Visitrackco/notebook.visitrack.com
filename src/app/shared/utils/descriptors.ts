/**
 * Descriptivos: los pocos campos que resumen una actividad, una ubicación o un
 * activo en el listado.
 *
 * Sin ellos, veinte actividades del mismo formulario se ven idénticas —mismo
 * título, misma fecha— y el usuario tiene que abrirlas una por una para saber
 * cuál es cuál. El descriptivo es lo que las distingue de un vistazo.
 *
 * ## Las dos formas en que llegan
 *
 * 1. **Actividades** (`SurveyAnswers.Titles`): ya vienen resueltas, con `lab` y
 *    `val` juntos, porque el motor de formularios las escribe al diligenciar.
 * 2. **Ubicaciones y activos** (`jsonDescriptor` + `jsonValues`): el descriptor
 *    es solo la *definición* —qué campo se muestra y con qué etiqueta— y el
 *    valor real vive aparte, en `jsonValues`, en la entrada con el mismo `id`.
 *    Hay que cruzarlos.
 *
 * La entrada `[DEF]` es el título del formulario, que ya se muestra en otro
 * lado; se descarta siempre para no repetirlo.
 */

/** Un descriptivo ya resuelto y listo para pintar. */
export interface Descriptor {
  /** Identificador del campo de origen. */
  id?: string;
  /** Etiqueta visible. */
  lab: string;
  /** Valor legible. */
  val: string;
}

/** Etiqueta reservada para el título del formulario. Nunca se muestra. */
const DEFAULT_LABEL = '[DEF]';

/**
 * Quita el marcado de un valor.
 *
 * Los campos de texto largo guardan HTML —negritas, saltos, listas— porque el
 * editor del formulario lo produce. En una ficha de listado ese marcado no se
 * puede renderizar (sería inyectar HTML ajeno en la página) ni mostrar en
 * crudo, que dejaría al usuario leyendo `<p>` y `&nbsp;`.
 *
 * Se usa `DOMParser` y no una expresión regular: interpretar HTML con regex
 * falla con atributos que contienen `>`, y además esto resuelve de paso las
 * entidades (`&aacute;` → `á`). El documento resultante nunca se adjunta a la
 * página, así que nada de lo que traiga llega a ejecutarse.
 */
export function stripHtml(value: string): string {
  if (!value || !value.includes('<')) return value.trim();

  try {
    const parsed = new DOMParser().parseFromString(value, 'text/html');
    return (parsed.body.textContent ?? '').replace(/\s+/g, ' ').trim();
  } catch {
    return value.trim();
  }
}

/** Interpreta un texto JSON como arreglo. Devuelve `[]` ante cualquier fallo. */
function parseJsonArray(raw: unknown): unknown[] {
  const text = (raw ?? '').toString().trim();
  if (!text) return [];

  try {
    const decoded = JSON.parse(text);
    return Array.isArray(decoded) ? decoded : [];
  } catch {
    // Un JSON corrupto en un registro no puede tumbar el listado entero: sin
    // descriptivos la fila se sigue viendo, con su nombre y su fecha.
    return [];
  }
}

/**
 * Texto legible del valor de un campo, según su tipo (`fty`).
 *
 * Los campos de selección no guardan una cadena sino el objeto de la opción
 * elegida: mostrar eso en crudo pintaría `[object Object]` en la ficha.
 */
export function resolveDescriptorValue(entry: unknown): string {
  if (!entry || typeof entry !== 'object') return '';

  const field = entry as { val?: unknown; fty?: unknown };
  const value = field.val;
  const fty = (field.fty ?? '').toString();

  if (fty === 'radio' || fty === 'dropdownlist') {
    if (value && typeof value === 'object') {
      return ((value as { txt?: unknown }).txt ?? '').toString().trim();
    }
    return (value ?? '').toString().trim();
  }

  // Selección múltiple: se unen las opciones marcadas en una sola línea.
  if (fty === 'checkbox') {
    if (!Array.isArray(value)) return '';
    return value
      .map((item) =>
        item && typeof item === 'object'
          ? ((item as { txt?: unknown }).txt ?? '').toString()
          : String(item),
      )
      .map((text) => text.trim())
      .filter(Boolean)
      .join(', ');
  }

  return value == null ? '' : String(value).trim();
}

/**
 * Descriptivos de una actividad, desde `SurveyAnswers.Titles`.
 *
 * Aquí no hay cruce que hacer: el motor de formularios ya dejó el valor junto
 * a la etiqueta.
 */
export function parseAnswerTitles(raw: unknown): Descriptor[] {
  const result: Descriptor[] = [];

  for (const entry of parseJsonArray(raw)) {
    if (!entry || typeof entry !== 'object') continue;

    const item = entry as { id?: unknown; lab?: unknown; val?: unknown };
    const lab = (item.lab ?? '').toString();
    if (lab === DEFAULT_LABEL) continue;

    const val = stripHtml((item.val ?? '').toString());
    if (!val) continue;

    result.push({ id: item.id?.toString(), lab, val });
  }

  return result;
}

/**
 * Descriptivos de una ubicación o un activo, cruzando definición y valores.
 *
 * @param jsonDescriptor Definición: qué campos se muestran y con qué etiqueta.
 * @param jsonValues     Valores diligenciados de esa entidad.
 */
export function parseEntityDescriptors(
  jsonDescriptor: unknown,
  jsonValues: unknown,
): Descriptor[] {
  const descriptors = parseJsonArray(jsonDescriptor);
  if (descriptors.length === 0) return [];

  // Índice por id para resolver cada descriptor en un paso y no recorrer la
  // lista de valores una vez por descriptor.
  const valuesById = new Map<string, unknown>();

  const rawValues = (jsonValues ?? '').toString().trim();
  if (rawValues) {
    try {
      let decoded: unknown = JSON.parse(rawValues);
      // Algunos registros envuelven los campos en `{ fie: [...] }`.
      if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
        decoded = (decoded as { fie?: unknown }).fie ?? [];
      }
      if (Array.isArray(decoded)) {
        for (const entry of decoded) {
          if (!entry || typeof entry !== 'object') continue;
          const id = (entry as { id?: unknown }).id;
          if (id != null) valuesById.set(String(id), entry);
        }
      }
    } catch {
      // Sin valores, los descriptivos que ya traigan `val` siguen sirviendo.
    }
  }

  const result: Descriptor[] = [];

  for (const entry of descriptors) {
    if (!entry || typeof entry !== 'object') continue;

    const item = entry as { id?: unknown; lab?: unknown; val?: unknown };
    const lab = (item.lab ?? '').toString();
    if (lab === DEFAULT_LABEL) continue;

    const id = (item.id ?? '').toString();

    // El descriptor puede traer el valor ya resuelto (así lo escribe el móvil);
    // solo si viene vacío hay que ir a buscarlo a los valores.
    let val = stripHtml((item.val ?? '').toString());
    if (!val) val = stripHtml(resolveDescriptorValue(valuesById.get(id)));

    result.push({ id, lab, val });
  }

  return result;
}

/** ¿Alguno de los descriptivos contiene [needle]? Sin distinguir mayúsculas. */
export function descriptorsMatch(descriptors: Descriptor[], needle: string): boolean {
  const term = needle.trim().toLowerCase();
  if (!term) return true;

  return descriptors.some(
    (d) => d.val.toLowerCase().includes(term) || d.lab.toLowerCase().includes(term),
  );
}
