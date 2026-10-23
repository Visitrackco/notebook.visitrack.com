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
 * Lista de un JSON que puede venir como arreglo o envuelto en `{ fie: [...] }`.
 * Devuelve `[]` ante cualquier fallo.
 */
function parseJsonFields(raw: unknown): unknown[] {
  const text = (raw ?? '').toString().trim();
  if (!text) return [];

  try {
    let decoded: unknown = JSON.parse(text);
    if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
      decoded = (decoded as { fie?: unknown }).fie ?? [];
    }
    return Array.isArray(decoded) ? decoded : [];
  } catch {
    return [];
  }
}

/** El `id` de una entrada: `ftyId` (lo que escribe el editor) o `id`. */
function idOf(entry: Record<string, unknown>): string {
  return (entry['ftyId'] ?? entry['id'] ?? '').toString();
}

/**
 * Valor legible de una entrada que ya trae `val` (`JSONTitle` o un descriptor
 * con valor), sin depender de su `fty`: un desplegable o un radio guardado sin
 * tipo llega como `{id, txt}`, y una selección múltiple como lista.
 */
function ownValueOf(entry: Record<string, unknown>): string {
  const value = entry['val'];

  if (Array.isArray(value)) {
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

  if (value && typeof value === 'object') {
    return stripHtml(((value as { txt?: unknown }).txt ?? '').toString());
  }

  return stripHtml((value ?? '').toString());
}

/** Lo que hace falta de una ubicación o un activo para sacar sus descriptivos. */
export interface EntityDescriptorSource {
  /** Definición del tipo: `[{id, lab}]`, casi nunca con `val`. */
  jsonDescriptor?: unknown;
  /** Valores diligenciados, por `id` (lista o `{fie: [...]}`). */
  jsonValues?: unknown;
  /** Lo escrito localmente al editar: `[{ftyId|id, lab, val}]`. */
  JSONTitle?: unknown;
}

/**
 * Los descriptivos de una ubicación o un activo, listos para pintar, en el
 * orden de la definición. Es la misma regla que `descriptivosDe` del móvil.
 *
 * ## De dónde salen
 *
 * - `jsonDescriptor` es la **definición** del tipo: `id` del campo y `lab`. El
 *   valor vive en `jsonValues`, en la entrada con ese mismo `id`.
 * - `JSONTitle` es lo que se escribe al editar y lo que traen algunos activos
 *   viejos: ya trae `lab` y `val`. Los activos que bajan del servidor lo traen
 *   **vacío**, por eso no basta con leerlo a él solo.
 *
 * Si un `id` está en las dos, gana el valor escrito en `JSONTitle`, que es el
 * más reciente. Lo de `JSONTitle` que la definición no conoce (activos viejos,
 * o un tipo al que le quitaron el descriptivo) se muestra al final.
 */
export function entityDescriptors(source: EntityDescriptorSource): Descriptor[] {
  const valuesById = new Map<string, unknown>();
  for (const entry of parseJsonFields(source.jsonValues)) {
    if (!entry || typeof entry !== 'object') continue;
    const id = (entry as { id?: unknown }).id;
    if (id != null) valuesById.set(String(id), entry);
  }

  // Lo escrito en `JSONTitle`, por id; sin id, se guarda aparte para el final.
  const written = new Map<string, Record<string, unknown>>();
  const loose: Record<string, unknown>[] = [];
  for (const entry of parseJsonFields(source.JSONTitle)) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    if (item['lab'] === DEFAULT_LABEL) continue;

    const id = idOf(item);
    if (id) written.set(id, item);
    else loose.push(item);
  }

  const result: Descriptor[] = [];
  const seen = new Set<string>();

  for (const entry of parseJsonFields(source.jsonDescriptor)) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    if (item['lab'] === DEFAULT_LABEL) continue;

    const id = idOf(item);
    seen.add(id);

    const mine = written.get(id);
    let val = mine ? ownValueOf(mine) : '';
    if (!val) val = ownValueOf(item);
    if (!val) val = stripHtml(resolveDescriptorValue(valuesById.get(id)));

    const lab = (item['lab'] ?? mine?.['lab'] ?? '').toString().trim();
    if (!lab && !val) continue;
    result.push({ id, lab, val });
  }

  const extra = [...[...written].filter(([id]) => !seen.has(id)).map(([, item]) => item), ...loose];
  for (const item of extra) {
    const lab = (item['lab'] ?? '').toString().trim();
    const val = ownValueOf(item);
    if (!lab && !val) continue;
    result.push({ id: idOf(item) || undefined, lab, val });
  }

  return result;
}

/**
 * Descriptivos cruzando solo definición y valores (sin `JSONTitle`).
 *
 * @param jsonDescriptor Definición: qué campos se muestran y con qué etiqueta.
 * @param jsonValues     Valores diligenciados de esa entidad.
 */
export function parseEntityDescriptors(jsonDescriptor: unknown, jsonValues: unknown): Descriptor[] {
  return entityDescriptors({ jsonDescriptor, jsonValues });
}

/**
 * ¿La búsqueda cae en el nombre o en algún descriptivo (etiqueta o valor)?
 * Sin distinguir mayúsculas. Es `coincideConDescriptivos` del móvil.
 */
export function matchesEntity(name: unknown, descriptors: Descriptor[], needle: string): boolean {
  const term = needle.trim().toLowerCase();
  if (!term) return true;
  if ((name ?? '').toString().toLowerCase().includes(term)) return true;
  return descriptorsMatch(descriptors, term);
}

/** ¿Alguno de los descriptivos contiene [needle]? Sin distinguir mayúsculas. */
export function descriptorsMatch(descriptors: Descriptor[], needle: string): boolean {
  const term = needle.trim().toLowerCase();
  if (!term) return true;

  return descriptors.some(
    (d) => d.val.toLowerCase().includes(term) || d.lab.toLowerCase().includes(term),
  );
}
