import { AnswerField, FormField, FormPage } from '../forms/form-schema';
import { readRows } from '../forms/master-detail';

/**
 * Brillantex (compañía 2259) — evaluación al guardar.
 *
 * ## Por qué esto es código y no una tabla de condiciones
 *
 * Las reglas de Inverpack caben en `status-rules.ts` porque solo miran campos y
 * eligen un estado. Estas hacen tres cosas más que ninguna tabla puede
 * expresar:
 *
 * 1. Recorren las **filas** de varias tablas de detalle buscando un campo dentro.
 * 2. Siguen la **definición del formulario**: de una opción «NC» sacan la
 *    sección que activa, y dentro de ella buscan la pregunta cuyo nombre
 *    contiene «eficaz».
 * 3. **Calculan indicadores y los escriben de vuelta** en la actividad —ítems
 *    calificados, conformes y porcentaje de conformidad—.
 *
 * ## Fidelidad
 *
 * Se replica lo que la app hace hoy, paso por paso, incluido su modo de leer
 * los valores —que **no es el mismo** que el de Inverpack, aunque las dos
 * clases llamen `_getValue` a su lector—. Ver [readValue].
 *
 * Hay un desenlace que parece un descuido del original y que **se replicó tal
 * cual** en vez de corregirlo: está señalado más abajo con el comentario
 * `DIVERGENCIA`. Corregirlo solo aquí pondría estados distintos según desde
 * dónde se guarde la actividad.
 */

/** Estados que usa esta compañía. */
const FALTAN_DATOS = '21469';
const NO_CONFORME = '20170';
const TERMINADA = '19816';
const PENDIENTE_COMPROMISOS = '21468';

/**
 * Los ítems calificables. Los primeros diez son los de zonas verdes, los
 * diecisiete primeros los de aseo, y los veintiocho los de aseo hospitalario:
 * cada formulario es una ampliación del anterior.
 */
const ITEMS = [
  'TWp30sHFFq', 'PKzziKRGp4', 'uysjMonJHN', '6H3FJboobY', 'EymNR8TfxS',
  'OZv2WCati0', 'SnCGEfZ1NA', '3bEFgGX65d', 'q1GwtZyfZx', 'dSZ9qcZxSa',
  'AyIUCrE4py', 'LUc0TW0O2B', 'ZOgpHyqGL6', 'jOhJqNObsc', 'SCOQmzkaVc',
  'HdOLqFMwpd', 'z7uYDiy1uz', 'z7uYDiy1uE', 'z7uYDiy1ug', 'z7uYDiy1uS',
  'z7uYDiy1uN', 'z7uYDiy1uC', 'z7uYDiy1uB', 'z7uYDiy1uD', 'z7uYDiy1uQ',
  'z7uYDi51uz', 'z7uYDi21uz', 'z7uYLiy1uz',
];

/** Identificadores donde se escriben los indicadores. Los tres los comparten. */
const INDICADORES = {
  calificados: 'FzqyywOwnz',
  conformes: 'xUiEfOoHLR',
  porcentaje: 'X3TVAZnVTe',
};

/**
 * Una inspección con ítems calificables.
 *
 * Aseo, zonas verdes y aseo hospitalario son **el mismo procedimiento** con
 * distintos identificadores: validar, exigir eficacia en las no conformidades y
 * calcular los tres indicadores. Se describen como datos y se evalúan con una
 * sola función; tres copias del mismo algoritmo se habrían separado a la
 * primera corrección.
 */
interface Inspeccion {
  tipo: 'inspección';
  label: string;
  items: string[];
  extras: string[];
  nombresMd: string;
  nombreCampo: string;
  fotosMd: string[];
}

/**
 * Una visita que deja compromisos.
 *
 * Visita operativa y mantenimiento de aires: si alguna fila de su tabla quedó
 * sin resolver, la actividad se queda esperando en vez de darse por terminada.
 */
interface Compromisos {
  tipo: 'compromisos';
  label: string;
  /** Campos que tienen que estar respondidos. Vacío: no se valida nada. */
  values: string[];
  extras: string[];
  md: string;
  /** El campo de cada fila que dice si quedó resuelto. */
  campo: string;
}

type Regla = Inspeccion | Compromisos;

/** Qué formulario usa qué. */
const REGLAS: Record<string, Regla> = {
  // Inspección de aseo
  '15127': {
    tipo: 'inspección',
    label: 'Brillantex · inspección de aseo',
    items: ITEMS.slice(0, 17),
    extras: ['lYNbEvmZgu'],
    nombresMd: 'Wg71gEJd9K',
    nombreCampo: 'zy878x6SXf',
    fotosMd: ['gJIfVhHRG7', 'P8ixoLwEq1', 'YJryAqRijI'],
  },

  // Inspección de zonas verdes
  '21854': {
    tipo: 'inspección',
    label: 'Brillantex · zonas verdes',
    items: ITEMS.slice(0, 10),
    extras: ['uMayFzBYOs', 'lYNbEvmZgu'],
    nombresMd: '6Oa6nyVMbS',
    nombreCampo: 'zy878x6SXf',
    fotosMd: ['JFw5fW6A5v', '9r5VhtkLdz', '2zXFPhMFHN', 'NzLwZg0xAW'],
  },

  // Inspección de aseo hospitalario
  '23075': {
    tipo: 'inspección',
    label: 'Brillantex · aseo hospitalario',
    items: ITEMS,
    extras: ['lYNbEvmZgu'],
    nombresMd: 'Wg71gEJd9K',
    nombreCampo: 'zy878x6SXf',
    fotosMd: ['gJIfVhHRG7', 'P8ixoLwEq1', 'YJryAqRijI'],
  },

  // Visita operativa
  '15221': {
    tipo: 'compromisos',
    label: 'Brillantex · visita operativa',
    values: ['UivVDQQIkf', 'zTNG1ZUFM3'],
    extras: ['LRXr5eo0Hx', 'VDo6panG8i', 'UNu3gvzkjR', '9DuW0kfATt'],
    md: '5z44z60Ora',
    campo: 'YvmxVgSJlj',
  },

  // Mantenimiento de aires. No valida campos: en la app esa parte está
  // comentada, y se respeta.
  '22324': {
    tipo: 'compromisos',
    label: 'Brillantex · mantenimiento de aires',
    values: [],
    extras: [],
    md: 'LJAp3xs0XN',
    campo: 'h6Vh0Ot390',
  },
  '22756': {
    tipo: 'compromisos',
    label: 'Brillantex · mantenimiento de aires',
    values: [],
    extras: [],
    md: 'LJAp3xs0XN',
    campo: 'h6Vh0Ot390',
  },
};

/** Lo que hay que escribir en la actividad cuando la inspección queda completa. */
export interface Indicator {
  id: string;
  lab: string;
  val: string;
}

export interface BrillantexOutcome {
  status: string;
  /** La actividad queda cerrada, con su fecha de terminación. */
  completed: boolean;
  /** Indicadores calculados. Van al `Titles` y al `Fields` de la actividad. */
  indicators: Indicator[];
  /** Por qué salió así. Se registra: es lo único que hace esto depurable. */
  reason: string;
}

/**
 * El valor de un campo, con la lectura de **esta** clase.
 *
 * Ojo: no coincide con la de Inverpack. Aquí un `radio` devuelve **el campo
 * entero** cuando su opción tiene texto —no el texto—, y por eso el resto del
 * código escribe `element.val.txt` en lugar de comparar directamente. Se
 * conserva esa forma para que las comparaciones den exactamente lo mismo que
 * allá.
 *
 * @returns el campo, el arreglo de filas si es tabla de detalle, o `''`.
 */
export function readValue(fields: readonly AnswerField[], id: string): AnswerField | unknown[] | '' {
  const found = fields.find((entry) => entry.id === id);

  if (!found) return '';

  const value = found.val as Record<string, unknown> | null;

  if (found.fty === 'radio') {
    /**
     * Vale con que haya respuesta, sea de la forma que sea.
     *
     * La app exige `val.txt` porque en el teléfono un radio siempre se guarda
     * como `{id, txt}`. Aquí no siempre: una actividad **descargada del
     * servidor** trae lo que escribió quien la creó, y ahí un radio puede venir
     * como el texto suelto. Exigiendo `txt` esas respuestas se leían como
     * vacías, y con eso los diecisiete ítems contaban como sin calificar — de
     * donde salían el «0 calificados» y el porcentaje en `NaN`.
     */
    return optionTextOf(found.val) !== '' ? found : '';
  }

  if (found.fty === 'masterdetail') {
    return (found.val as unknown[]) ?? [];
  }

  return found.val != null ? found : '';
}

/**
 * El texto de una respuesta de selección, venga como venga.
 *
 * `{id, txt}` es lo que escriben esta aplicación y el teléfono. `Name` aparece
 * en respuestas que salen de una lista, y el texto suelto en las que llegan de
 * la plataforma. Las tres son la misma respuesta y tienen que compararse igual.
 */
export function optionTextOf(value: unknown): string {
  if (value == null) return '';

  if (typeof value === 'string') return value;

  if (typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;

    return String(record['txt'] ?? record['Name'] ?? record['val'] ?? '');
  }

  return '';
}

/** Lo mismo, para lo que devuelve [readValue]. */
function optionText(entry: AnswerField | unknown[] | ''): string {
  if (entry === '' || Array.isArray(entry)) return '';

  return optionTextOf(entry.val);
}

/**
 * ¿Está completa la tabla de nombres?
 *
 * Cada fila tiene que traer el campo de nombre con texto.
 */
function nombresIncompletos(rows: readonly unknown[], campo: string): boolean {
  for (const row of readRows(rows)) {
    const values = (row.JSONValues ?? []) as AnswerField[];

    if (values.length === 0) return true;

    const found = values.find((entry) => entry.id === campo);

    if (!found) return true;

    const val = found.val as Record<string, unknown> | null;

    // Sin valor, o con la opción vacía.
    if (!val || Object.keys(val).length === 0) return true;
    if (val['txt'] === '') return true;
  }

  return false;
}

/** ¿Alguna fila de fotos se quedó sin fotografía? */
function fotosIncompletas(rows: readonly unknown[]): boolean {
  for (const row of readRows(rows)) {
    const values = (row.JSONValues ?? []) as AnswerField[];

    if (values.length === 0) return true;

    const photo = values.find((entry) => entry.fty === 'picture');

    if (!photo) return true;
    if (photo.val === '') return true;
  }

  return false;
}

/**
 * De un ítem calificado «NC», ¿la acción quedó registrada como eficaz?
 *
 * El camino es el del original: se busca la pregunta en la **primera página**
 * del formulario, de ahí su opción «NC», de la opción la sección que activa, y
 * dentro de esa sección la pregunta cuyo nombre contiene «eficaz». Cualquier
 * eslabón que falte cuenta como no eficaz.
 */
function esEficaz(
  fields: readonly AnswerField[],
  page: FormPage | undefined,
  itemId: string,
): boolean {
  const definitions = (page?.fie ?? []) as FormField[];

  const field = definitions.find((entry) => entry.id === itemId);
  if (!field) return false;

  const option = (field.opt ?? []).find((opt) => opt.txt === 'NC') as
    | { act_data?: string }
    | undefined;

  if (!option) return false;

  const child = definitions.find(
    (entry) =>
      (entry as { sect?: string }).sect === option.act_data &&
      String(entry.lab ?? '').toLowerCase().includes('eficaz'),
  );

  if (!child) return false;

  const value = readValue(fields, child.id);

  return optionText(value) === 'EFICAZ';
}

/**
 * Una inspección con ítems calificables.
 *
 * Traducción de `inspeccionAseo`, `inspeccionZonasVerdes` e
 * `inspeccionAseoHosp`, que en la app son tres copias del mismo procedimiento.
 */
function inspeccion(
  regla: Inspeccion,
  fields: readonly AnswerField[],
  pages: readonly FormPage[],
): BrillantexOutcome {
  const values = regla.items.map((id) => readValue(fields, id));
  const extras = regla.extras.map((id) => readValue(fields, id));

  const nombres = readValue(fields, regla.nombresMd);
  const nombresRows = Array.isArray(nombres) ? nombres : [];

  if (nombresRows.length === 0) {
    return falta('No se registró ningún nombre');
  }

  /**
   * DIVERGENCIA CONOCIDA — se replica el original a propósito.
   *
   * En la app, una fila de nombres sin responder pone el estado en «faltan
   * datos» **pero no interrumpe**: el código sigue, y si todo lo demás está
   * bien acaba escribiendo «terminada» encima. El resultado es que ese caso
   * termina en 19816, no en 21469.
   *
   * Se conserva. Corregirlo solo aquí haría que la misma actividad quedara en
   * un estado distinto según se guardara desde el teléfono o desde el
   * navegador, que es peor que el fallo.
   */
  const nombresACorregir = nombresIncompletos(nombresRows, regla.nombreCampo);

  for (const id of regla.fotosMd) {
    const rows = readValue(fields, id);

    if (Array.isArray(rows) && rows.length > 0 && fotosIncompletas(rows)) {
      return falta('Una fila de fotografías se quedó sin foto');
    }
  }

  const sinResponder =
    values.some((entry) => entry === '') || extras.some((entry) => entry === '');

  if (sinResponder) {
    return falta('Hay ítems de la inspección sin calificar');
  }

  // Los ítems calificados «no conforme» exigen que su acción sea eficaz.
  const noConformes = values.filter((entry) => optionText(entry) === 'NC');

  if (noConformes.length > 0) {
    const algunaIneficaz = noConformes.some(
      (entry) => !esEficaz(fields, pages[0], (entry as AnswerField).id),
    );

    if (algunaIneficaz) {
      return {
        status: NO_CONFORME,
        completed: false,
        indicators: [],
        reason: 'Hay no conformidades sin acción eficaz',
      };
    }
  }

  /**
   * Qué se leyó de cada ítem.
   *
   * Un indicador equivocado no se nota hasta que alguien pide el informe, y
   * para entonces ya no hay forma de saber qué se leyó.
   */
  console.debug(
    `[Brillantex] ${regla.label} · ítems leídos:`,
    regla.items.map((id, index) => `${id}=${optionText(values[index]) || '(vacío)'}`).join(' '),
  );

  const calificados = values.filter((entry) => optionText(entry) !== 'NA').length;
  const conformes = values.filter((entry) => optionText(entry) === 'C').length;

  /**
   * Sin ítems calificados no hay porcentaje.
   *
   * Con todos en «NA» la cuenta es `0 * 100 / 0`, que da `NaN` — y eso acababa
   * escrito en el descriptivo y en el informe. Se deja **vacío** en vez de un
   * cero: un cero se lee como «cero por ciento de conformidad», que es una
   * acusación, y lo que pasó es que no había nada que calificar.
   */
  const porcentaje = calificados === 0 ? '' : String((conformes * 100) / calificados);

  return {
    status: TERMINADA,
    completed: true,
    indicators: [
      { id: INDICADORES.calificados, lab: 'No. Items Calificados', val: String(calificados) },
      { id: INDICADORES.conformes, lab: 'No. Items Conformes', val: String(conformes) },
      { id: INDICADORES.porcentaje, lab: 'Porcentaje de Conformidad', val: porcentaje },
    ],
    reason: nombresACorregir
      ? 'Completa (con filas de nombres sin responder: ver DIVERGENCIA)'
      : 'Inspección completa y conforme',
  };
}

/**
 * Una visita que deja compromisos.
 *
 * Traducción de `visitaOperativa` y `mttoAires`. La diferencia con una
 * inspección es lo que significa el resultado: aquí no se califica nada, se
 * comprueba si quedó algo por resolver. Si queda, la actividad no se cierra —
 * se queda en «pendiente de compromisos», que es un estado distinto de «faltan
 * datos» y por eso merece su propio código.
 */
function compromisos(regla: Compromisos, fields: readonly AnswerField[]): BrillantexOutcome {
  const values = regla.values.map((id) => readValue(fields, id));
  const extras = regla.extras.map((id) => readValue(fields, id));

  const sinResponder =
    values.some((entry) => entry === '') || extras.some((entry) => entry === '');

  if (sinResponder) {
    return falta('Faltan datos de la visita');
  }

  const rows = readValue(fields, regla.md);

  if (Array.isArray(rows) && rows.length > 0) {
    // Una fila sin el campo, o con algo distinto de «SI», deja la actividad
    // esperando. Que falte el campo cuenta como pendiente: no se puede dar por
    // resuelto lo que nadie respondió.
    const pendiente = readRows(rows).some((row) => {
      const valores = (row.JSONValues ?? []) as AnswerField[];
      const found = valores.find((entry) => entry.id === regla.campo);

      return !found || optionTextOf(found.val) !== 'SI';
    });

    if (pendiente) {
      return {
        status: PENDIENTE_COMPROMISOS,
        completed: false,
        indicators: [],
        reason: 'Quedaron compromisos sin resolver',
      };
    }
  }

  return {
    status: TERMINADA,
    completed: true,
    indicators: [],
    reason: 'Sin compromisos pendientes',
  };
}

/**
 * Evalúa la actividad si su formulario tiene regla.
 *
 * @returns `null` cuando el formulario no es de los que se procesan.
 */
export function evaluate(
  surveyId: string,
  fields: readonly AnswerField[],
  pages: readonly FormPage[],
): (BrillantexOutcome & { label: string }) | null {
  const regla = REGLAS[String(surveyId)];

  if (!regla) return null;

  const outcome =
    regla.tipo === 'inspección' ? inspeccion(regla, fields, pages) : compromisos(regla, fields);

  return { ...outcome, label: regla.label };
}

function falta(reason: string): BrillantexOutcome {
  return { status: FALTAN_DATOS, completed: false, indicators: [], reason };
}
