/*
 * ⚠️  COPIA SINCRONIZADA. NO EDITAR AQUI.
 *
 * El original vive en `CloudGoldFront/src/app/core/flujos/motor.ts`, junto a su
 * batería de casos (`casos.json`, que se corre con `npm run flujos:casos`). La
 * app móvil tiene su gemelo en Dart.
 *
 * Los tres tienen que dar el mismo resultado: un flujo se dibuja y se prueba
 * **una vez**, en el simulador del Module, y a partir de ahí quien lo configuró
 * da por hecho que el formulario se comporta igual en el navegador que en el
 * teléfono. Un cambio aquí que no esté en los otros dos rompe esa promesa sin
 * que nada falle a la vista.
 *
 * Para cambiar el motor: se toca el original, se corre la batería, y se copia
 * a este archivo y al de Dart.
 */

import {
  Accion,
  ApiId,
  Campo,
  Encargo,
  Comparador,
  Condicion,
  Animacion,
  Aviso,
  TonoDeAviso,
  SonidoDeAviso,
  TONOS_DE_AVISO,
  SONIDOS_DE_AVISO,
  SONIDO_DEL_TONO,
  BinarioHeredado,
  BotonDeAccion,
  BotonPintado,
  CampoHeredado,
  AccionDeBoton,
  AdjuntoDeCorreo,
  CorreoDeFlujo,
  PushDeFlujo,
  PushPedido,
  CorreoPedido,
  ESTADO_DE_LA_ACTIVIDAD,
  PREFIJO_FORMULARIO,
  HerenciaDeActividad,
  TablaHeredada,
  Grafica,
  GraficaPintada,
  LadoDelCampo,
  DisparoDeLlamada,
  ModoDeLlamada,
  EntradaDeLlamada,
  LlamadaAServicio,
  LlamadaPintada,
  PREFIJO_INTEGRACION,
  PREFIJO_FALLO,
  PREFIJO_RESPUESTA,
  DATOS_DE_LA_RESPUESTA,
  Tramo as TramoDeRegla,
  SEGUNDOS_DE_LLAMADA,
  TOPE_DE_LINEAS,
  TOPE_DE_SEGUNDOS_DE_LLAMADA,
  Orientacion,
  SerieDeGrafica,
  Contexto,
  EstadoCampo,
  Flujo,
  Grupo,
  ModoTexto,
  Puntuacion,
  Regla,
  Resultado,
  Tramo, PasoDeCondicion, PasoDeRegla,
} from './flujo-modelo';

/**
 * El motor que ejecuta un flujo.
 *
 * ## Qué garantiza
 *
 * **Que el web y la app se comporten igual.** No se puede compartir código
 * entre Angular y Flutter, así que lo que se comparte es esto: la
 * especificación escrita como código, y una batería de casos (`casos.json`) que
 * las dos implementaciones tienen que pasar. Un caso que pase aquí y falle allá
 * es un fallo, no una diferencia de plataforma.
 *
 * ## Qué no hace
 *
 * No escribe en el formulario. Devuelve **qué debería pasarle a cada campo** y
 * quien lo llama decide cómo aplicarlo. Así el mismo motor sirve para el
 * simulador del diseñador —donde no hay formulario que tocar— y para el
 * formulario de verdad.
 */
const TOPE_DE_PASADAS = 5;

/**
 * Los tipos de campo en los que se escribe letra a letra.
 *
 * Un aviso emergente en uno de estos saltaría en cada tecla: escribir «no
 * enciende» son doce avisos. En los demás —marcar una opción, tomar una foto,
 * coger la ubicación, elegir una fecha— el cambio es uno y deliberado, que es
 * justo cuando un aviso sirve para algo.
 */
const SE_ESCRIBEN = new Set([
  'text',
  'textline',
  'textarea',
  'numeric',
  'email',
  'phone',
  'cellphone',
  'addressline',

  // Y los que se recalculan solos mientras se escribe en otro: cambian por
  // consecuencia, no porque nadie los haya tocado.
  'calculation',
  'sumdetail',
  'summasterdetail',
  'datediff',
]);

/**
 * El tono que pide la regla.
 *
 * Lo que no se reconoce cae en `info`, que es el neutro. Un flujo guardado con
 * un tono que ya no existe —o con una errata— tiene que seguir avisando: dejar
 * de enseñar el mensaje por no saber de qué color pintarlo sería perder la
 * información por cuidar la decoración.
 */
function tonoPedido(valor: unknown): TonoDeAviso {
  const pedido = String(valor ?? '')
    .trim()
    .toLowerCase();

  return (TONOS_DE_AVISO as readonly string[]).includes(pedido)
    ? (pedido as TonoDeAviso)
    : 'info';
}

/** El sonido que pide la regla; si no pide ninguno, el que le toca al tono. */
function sonidoPedido(valor: unknown, tono: TonoDeAviso): SonidoDeAviso {
  const pedido = String(valor ?? '')
    .trim()
    .toLowerCase();

  return (SONIDOS_DE_AVISO as readonly string[]).includes(pedido)
    ? (pedido as SonidoDeAviso)
    : SONIDO_DEL_TONO[tono];
}

/**
 * ¿Se pueden enseñar avisos en esta evaluación?
 *
 * Al guardar siempre: es un momento, no una tecla. Al abrir también, que ocurre
 * una sola vez. Y al responder, solo si lo que se respondió **no se escribe a
 * mano**: si no, el aviso saldría con cada letra.
 */
function sePuedeAvisar(
  momento: string,
  campoQueCambio: string | undefined,
  campos: Record<string, Campo>,
): boolean {
  if (momento !== 'cambia' || !campoQueCambio) return true;

  return !SE_ESCRIBEN.has((campos[campoQueCambio]?.fty ?? '').toLowerCase());
}

// -- Tablas de detalle -------------------------------------------------------

/**
 * Con qué nombre se refiere una regla a un campo de dentro de una tabla.
 *
 * `DETALLE:<tabla>:<campo>`, con los `apiId` de los dos. Lleva dos puntos por lo
 * mismo que las páginas y que el estado: ningún `apiId` de verdad los tiene, así
 * que no puede chocar con uno, y el motor sigue tratando el identificador como
 * una cadena opaca.
 *
 * El campo puede ser una respuesta del sub-formulario o **un dato del registro
 * del que nació la fila** —`LOC_NAME`, `AST_NAME`, `ITE_PRICE`, o cualquier
 * clave de su `jsonValues`—. Se busca primero en lo respondido: si alguien
 * contestó encima, manda lo contestado.
 */
export const PREFIJO_DETALLE = 'DETALLE:';

/** Lo que se le puede preguntar a un conjunto de filas. */
export const AGREGADOS = new Set([
  'suma',
  'cuenta',
  'promedio',
  'maximo',
  'minimo',
  'filas',

  /*
   * Cuántas filas están terminadas, y cuántas a medias.
   *
   * Terminada es una fila con todos sus obligatorios respondidos. Es lo que
   * hace falta para «no se guarda hasta que todos los registros estén
   * diligenciados», que se escribe comparando `@amedias` con cero.
   */
  'completas',
  'amedias',
]);

/** Un identificador de detalle, ya desarmado. */
export interface ReferenciaDetalle {
  /** El `apiId` del campo `masterdetail`. */
  tabla: string;
  /** El `apiId` del campo de dentro, o vacío cuando se pregunta por las filas. */
  campo: string;
  /** `suma`, `cuenta`, `promedio`, `maximo`, `minimo`, `filas`; vacío si no hay. */
  agregado: string;
}

/** Desarma `DETALLE:TABLA:CAMPO@agregado`. `null` si no es uno de estos. */
export function referenciaDetalle(apiId: string): ReferenciaDetalle | null {
  if (!apiId.startsWith(PREFIJO_DETALLE)) return null;

  let resto = apiId.slice(PREFIJO_DETALLE.length);
  let agregado = '';

  const arroba = resto.lastIndexOf('@');

  if (arroba > 0) {
    const pedido = resto.slice(arroba + 1).toLowerCase();

    // Un `@` que no nombra un agregado conocido no se toca: puede formar parte
    // del identificador, y quedarse sin campo es peor que ignorar el sufijo.
    if (AGREGADOS.has(pedido)) {
      agregado = pedido;
      resto = resto.slice(0, arroba);
    }
  }

  const corte = resto.indexOf(':');

  if (corte < 0) {
    // `DETALLE:EQUIPOS@filas`: se pregunta por la tabla entera.
    return resto ? { tabla: resto, campo: '', agregado: agregado || 'filas' } : null;
  }

  const tabla = resto.slice(0, corte);
  const campo = resto.slice(corte + 1);

  if (!tabla || !campo) return null;

  return { tabla, campo, agregado };
}

/** Las filas de una tabla de detalle, tal como las guarda la actividad. */
export function filasDe(valor: unknown): Record<string, unknown>[] {
  if (!Array.isArray(valor)) return [];

  return valor.filter((f) => !!f && typeof f === 'object') as Record<string, unknown>[];
}

const COLUMNAS_DE_SEDE: Record<string, string> = {
  LOC_NAME: 'Name',
  LOC_CONTACTNAME: 'ContactName',
  LOC_STREET: 'Street',
  LOC_POSTALCODE: 'PostalCode',
  LOC_STATE: 'State',
  LOC_CITY: 'City',
  LOC_PHONE: 'Phone',
};

const COLUMNAS_DE_ITEM: Record<string, string> = {
  LST_NAME: 'Name',
  ITE_NAME: 'Name',
  ITE_PRICE: 'Price',
  ITE_COST: 'Cost',
};

/** Un campo propio del tipo, de los que viven en `jsonValues`. */
function delJsonValues(registro: Record<string, unknown>, apiId: string): unknown {
  const crudo = registro['jsonValues'] ?? registro['JSONValues'];

  let lista: unknown[] = [];

  if (typeof crudo === 'string') {
    try {
      const leido = JSON.parse(crudo);
      lista = Array.isArray(leido) ? leido : [];
    } catch {
      lista = [];
    }
  } else if (Array.isArray(crudo)) {
    lista = crudo;
  }

  for (const dato of lista) {
    if (!dato || typeof dato !== 'object') continue;

    const d = dato as Record<string, unknown>;

    if (String(d['id'] ?? '') === apiId || String(d['apiId'] ?? '') === apiId) {
      return d['val'] ?? d['value'];
    }
  }

  return null;
}

/**
 * Un dato del registro del que nació la fila.
 *
 * Cada fila de una tabla nace de algo —una sede, un equipo, un ítem de una
 * lista, un usuario— y arrastra ese registro consigo en `LocationInfo`,
 * `AssetInfo` o `itemsInfo`. Preguntar por él es lo que permite escribir «si la
 * ciudad de la sede de la fila es Bogotá» sin haber vuelto a pedir la ciudad
 * dentro del formulario.
 */
export function datoDelOrigen(fila: Record<string, unknown>, apiId: string): unknown {
  const clave = apiId.toUpperCase();

  const comoMapa = (x: unknown): Record<string, unknown> | null =>
    !!x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null;

  let registro: Record<string, unknown> | null = null;
  let columna: string | undefined;

  if (clave.startsWith('LOC_')) {
    registro = comoMapa(fila['LocationInfo']);
    columna = COLUMNAS_DE_SEDE[clave];
  } else if (clave.startsWith('AST_') || clave.startsWith('ASS_')) {
    registro = comoMapa(fila['AssetInfo']);
    columna = clave === 'AST_NAME' || clave === 'ASS_NAME' ? 'Name' : undefined;
  } else if (clave.startsWith('LST_') || clave.startsWith('ITE_')) {
    registro = comoMapa(fila['itemsInfo']);
    columna = COLUMNAS_DE_ITEM[clave];
  }

  /*
   * Sin prefijo conocido, se prueban los tres.
   *
   * La app copia el registro en `itemsInfo`, `LocationInfo` y `AssetInfo` sin
   * distinguir de qué era el ítem, así que buscar en los tres es lo que de
   * verdad encuentra el dato. Y el nombre de la fila siempre está.
   */
  if (!registro) {
    if (clave === 'NAME' || clave === 'NOMBRE') return fila['Name'];

    for (const donde of ['itemsInfo', 'LocationInfo', 'AssetInfo']) {
      const r = comoMapa(fila[donde]);
      if (!r) continue;

      const propio = delJsonValues(r, apiId);
      if (propio !== null && propio !== undefined) return propio;

      if (apiId in r) return r[apiId];
    }

    return null;
  }

  if (columna) return registro[columna];

  const propio = delJsonValues(registro, apiId);

  return propio !== null && propio !== undefined ? propio : registro[apiId];
}

/**
 * Lo que respondió **una fila** en uno de sus campos.
 *
 * Busca por `apiId` en el esquema del sub-formulario para dar con el `id` con el
 * que la fila lo guardó, y si no lo encuentra ahí, lo busca entre los datos del
 * registro del que nació la fila. Ese es el orden que hace falta: lo respondido
 * manda sobre lo heredado, porque responder es lo último que pasó.
 */
export function valorDeFila(
  fila: Record<string, unknown>,
  apiId: string,
  tabla?: Campo,
): unknown {
  const respuestas = Array.isArray(fila['JSONValues'])
    ? (fila['JSONValues'] as Record<string, unknown>[])
    : [];

  for (const campo of tabla?.detalle ?? []) {
    if (campo.apiId !== apiId) continue;

    // Por el `id` con el que la fila lo guardó, y si el campo no lo trae, por su
    // propio `apiId`: hay esquemas donde son el mismo.
    const buscado = campo.id || campo.apiId;

    for (const dato of respuestas) {
      if (String(dato?.['id'] ?? '') !== buscado) continue;
      return dato['val'];
    }
  }

  /*
   * Y si no, por el `id` literal.
   *
   * Una fila guarda por `id`, no por `apiId`, y el esquema de la tabla puede no
   * haber llegado. Probar el identificador tal cual cubre los dos casos.
   */
  for (const dato of respuestas) {
    if (String(dato?.['id'] ?? '') === apiId) return dato['val'];
  }

  return datoDelOrigen(fila, apiId);
}

/**
 * ¿Esta fila tiene respondido todo lo que su formulario pide?
 *
 * Solo cuentan los campos que el esquema marca obligatorios. Lo que una regla
 * exija o libere dentro de la fila no se mira aquí: eso se decide fila a fila
 * al diligenciarla, y esto se pregunta desde fuera, sobre las veinte a la vez.
 */
function filaCompleta(fila: Record<string, unknown>, tabla?: Campo): boolean {
  for (const campo of tabla?.detalle ?? []) {
    if (!campo.obligatorio) continue;

    if (!tieneRespuesta(valorDeFila(fila, campo.apiId, tabla))) return false;
  }

  return true;
}

/** El campo de dentro de la tabla, para poder comparar por texto. */
function campoDeDetalle(tabla: Campo | undefined, apiId: string): Campo | undefined {
  return (tabla?.detalle ?? []).find((c) => c.apiId === apiId);
}

/**
 * Cuenta, suma, promedia o busca el extremo de lo que respondieron las filas.
 *
 * Las filas sin responder **no cuentan**: ni suman cero ni hunden el promedio.
 * Una tabla a medio llenar tiene que dar el promedio de lo que hay, que es lo
 * que se lee en pantalla; contar los huecos como ceros da un número que no se
 * corresponde con nada y que cambia solo al añadir una fila vacía.
 *
 * Sin nada que contar, `cuenta` es cero y los demás devuelven `null`: escribir
 * un cero diría «cero», y lo cierto es «todavía nada que sumar».
 */
function agregar(
  agregado: string,
  crudos: unknown[],
  tabla: Campo | undefined,
  campo: string,
): unknown {
  const deDentro = campoDeDetalle(tabla, campo);

  const numeros: number[] = [];
  let respondidas = 0;

  for (const crudo of crudos) {
    if (!tieneRespuesta(crudo)) continue;

    respondidas++;

    const n = aNumero(comoTexto(crudo, deDentro));
    if (n !== null) numeros.push(n);
  }

  return cuentaDeNumeros(agregado, numeros, respondidas);
}

/**
 * Sumar, promediar, contar o quedarse con el extremo de unos números.
 *
 * Es la aritmética de los agregados, y **la única**: la usan las tablas de
 * detalle —`DETALLE:EQUIPOS:IMPORTE@suma`— y las rutas de una respuesta de un
 * servicio —`items[*].importe@suma`—. Dos cuentas separadas para la misma
 * palabra acabarían dando números distintos, y nadie sabría cuál mira.
 *
 * `cuantas` es cuántas cosas había de verdad, que no es lo mismo que cuántas
 * eran números: `cuenta` responde por lo primero.
 *
 * Sin nada que contar devuelve `null` y no cero: escribir un cero diría «cero»
 * cuando lo cierto es «todavía nada que sumar».
 */
export function cuentaDeNumeros(
  agregado: string,
  numeros: number[],
  cuantas: number,
): number | null {
  if (agregado === 'cuenta') return cuantas;
  if (!numeros.length) return null;

  switch (agregado) {
    case 'suma':
      return numeros.reduce((a, b) => a + b, 0);
    case 'promedio':
      return numeros.reduce((a, b) => a + b, 0) / numeros.length;
    case 'maximo':
      return Math.max(...numeros);
    case 'minimo':
      return Math.min(...numeros);
  }

  return null;
}

/**
 * El valor de un identificador, sea del formulario o de una tabla de detalle.
 *
 * Es el único sitio por el que se leen valores, y por eso todo lo que sabe leer
 * identificadores entiende los de detalle sin cambiar nada: las condiciones, las
 * fórmulas y el relato de lo que leyó cada regla.
 *
 * De un agregado devuelve un número; de un campo de detalle sin agregado, la
 * lista de lo que respondió cada fila —que es lo que necesita el cuantificador
 * para decidir si «alguna» o «todas»—.
 */
export function leerValor(
  apiId: string,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
): unknown {
  /*
   * Lo que respondió el servicio, dentro de los tramos de su llamada.
   *
   * Se resuelve aquí —el único sitio por el que se leen valores— para que
   * `RESPUESTA:titular.estado` sea **un identificador más**: así las condiciones,
   * las fórmulas y el relato de lo que leyó cada regla lo entienden sin cambiar
   * una línea, igual que pasó con los de detalle.
   *
   * El cajón donde vive el dato se lee tal cual: es donde el motor lo deja
   * mientras evalúa, no una ruta que nadie escriba.
   */
  if (apiId === DATOS_DE_LA_RESPUESTA) return valores[apiId];

  if (apiId.startsWith(PREFIJO_RESPUESTA)) {
    const datos = valores[DATOS_DE_LA_RESPUESTA];

    // Fuera de una llamada no hay ninguna respuesta de la que hablar, y una
    // condición sin valor no se cumple — que es lo prudente.
    if (datos === undefined) return undefined;

    return datoDeLaRuta(datos, apiId.slice(PREFIJO_RESPUESTA.length));
  }

  const ref = referenciaDetalle(apiId);

  if (!ref) {
    const respondido = valores[apiId];

    /*
     * Un campo de imagen no se responde: **su valor es la direccion que pinta**.
     *
     * No aparece en las respuestas de la actividad —se comprobo contra
     * actividades reales, no esta ni vacio— asi que `valores[apiId]` es siempre
     * `undefined`. Con eso, una condicion como «IMAGEN con-valor» **nunca se
     * cumplia**, y un boton colgado de ella no aparecia jamas.
     *
     * Devolviendo la direccion, todas las condiciones empiezan a decir lo que
     * cualquiera espera: tiene valor si esta ensenando algo, y se puede
     * comparar con `contiene` o `igual` como con cualquier otro campo.
     *
     * No hay riesgo de romper reglas de antes: hoy un campo de imagen se lee
     * siempre como vacio, asi que ninguna regla que lo mencione puede estar
     * funcionando.
     *
     * La direccion sale de `campos[x].url`, que es **la que el campo esta
     * ensenando ahora** —los clientes la reescriben con lo que haya puesto
     * `poner-imagen`—. Lo que una regla decida en **esta misma** pasada no se ve
     * aqui: para eso esta `decididos`, que solo llega a `direccionDeLaFoto`.
     */
    if (respondido === undefined || respondido === null || respondido === '') {
      const campo = campos[apiId];

      if (String(campo?.fty ?? '').toLowerCase() === 'image') {
        return String(campo?.url ?? '');
      }
    }

    return respondido;
  }

  const tabla = campos[ref.tabla];
  const filas = filasDe(valores[ref.tabla]);

  if (ref.agregado === 'filas') return filas.length;

  if (ref.agregado === 'completas' || ref.agregado === 'amedias') {
    const terminadas = filas.filter((f) => filaCompleta(f, tabla)).length;

    return ref.agregado === 'completas' ? terminadas : filas.length - terminadas;
  }

  const crudos = filas.map((fila) => valorDeFila(fila, ref.campo, tabla));

  if (!ref.agregado) return crudos;

  return agregar(ref.agregado, crudos, tabla, ref.campo);
}

/**
 * ¿Esta regla es del ámbito que se está evaluando?
 *
 * Una regla sin `ambito` es de la actividad: es como están escritas todas las
 * que ya existen, y cambiar eso dejaría de funcionar a los flujos en marcha. Una
 * de `fila` es de **su** tabla y de ninguna otra, porque dos tablas del mismo
 * formulario pueden tener campos que se llamen igual.
 *
 * Una regla de fila sin `md` vale para todas las tablas: es la forma de escribir
 * una vez lo que se quiere en todas.
 */
export function esDeAmbito(regla: Regla, ambito: string, tabla: string): boolean {
  const suyo = regla.ambito ?? 'actividad';

  if (suyo !== ambito) return false;
  if (ambito !== 'fila') return true;

  const suya = regla.md ?? '';

  return !suya || suya === tabla;
}

export function evaluar(flujo: Flujo, contexto: Contexto): Resultado {
  const resultado: Resultado = {
    campos: {},
    bloqueos: [],
    disparadas: [],
    evaluadas: [],
    encargos: [],
    pisadas: [],
    avisos: [],
    animaciones: [],
    botones: [],
    integraciones: [],
    edicionBloqueada: [],
    guardarOculto: false,
    guardarIgualBloqueado: false,
    descriptivos: [],
    enEspera: [],
    ciclo: false,
    conflictos: [],
  };

  const ambito = contexto.ambito ?? 'actividad';
  const tablaDeFila = contexto.tabla ?? '';
  const origen = contexto.origen ?? {};
  const enFila = ambito === 'fila';

  const vivas = (flujo?.reglas ?? [])
    .filter((r) => r.activa !== false)
    .filter((r) => esDeAmbito(r, ambito, tablaDeFila));

  /*
   * Las reglas generales van aparte, y al final.
   *
   * Son las del cierre: sumar lo diligenciado, dejar un total en un campo,
   * decidir el estado con el que se cierra. No compiten con las de los campos ni
   * se mezclan en el juego de pasadas — corren **después**, una detrás de otra y
   * en el orden en que están escritas, que es lo que permite encadenarlas: la
   * segunda cuenta con lo que dejó la primera.
   *
   * Solo al guardar: son reglas de cierre y antes no hay nada que cerrar.
   */
  // Las generales cierran **la actividad**: suman lo diligenciado y deciden con
  // qué estado se cierra. Una fila no se cierra con un estado, así que dentro de
  // una fila no hay reglas de cierre.
  const generales =
    contexto.momento === 'guardar' && !enFila ? vivas.filter((r) => r.general) : [];

  const reglas = vivas.filter((r) => !r.general && r.cuando?.includes(contexto.momento));

  /*
   * Cada campo dispara **sus** reglas, no todas.
   *
   * Al responder algo solo se evalúan las reglas que preguntan por ese campo.
   * Evaluándolas todas, responder una cosa disparaba la lógica de otra: la regla
   * de un campo le escribía encima a otro que nadie había tocado, y desde fuera
   * parecía que dos campos estuvieran «unidos» sin haberlo pedido.
   *
   * Pero la cadena no se corta ahí. Si una regla **le escribe un valor** a otro
   * campo, ese campo acaba de cambiar tanto como si lo hubiera respondido
   * alguien, así que sus reglas también tienen que correr: es lo que hace que
   * «si marco A, pon B en el desplegable» dispare a su vez la regla de ese
   * desplegable. Por eso los disparadores crecen dentro del bucle y el filtro se
   * rehace en cada pasada, en vez de fijarse una sola vez al principio.
   *
   * Una regla sin condiciones no es de nadie y se evalúa siempre: es
   * incondicional, y dejarla fuera sería no ejecutarla nunca.
   *
   * Al abrir y al guardar no hay campo que haya cambiado, así que van todas.
   */
  const disparadores = new Set<string>(
    contexto.campoQueCambio ? [contexto.campoQueCambio] : [],
  );

  const puedeAvisar = sePuedeAvisar(contexto.momento, contexto.campoQueCambio, contexto.campos);

  const esSuya = (regla: Regla): boolean => {
    if (!contexto.campoQueCambio) return true;

    const suyos = camposDeLaRegla(regla);

    return suyos.length === 0 || suyos.some((c) => disparadores.has(c));
  };

  if (!reglas.length && !generales.length) return resultado;

  /*
   * Se evalúa por pasadas hasta que nada cambie.
   *
   * Una regla puede poner un valor, y ese valor puede hacer que otra regla se
   * cumpla. Evaluar una sola vez dejaría la segunda sin disparar y el
   * formulario a medio ajustar. Se repite hasta que el estado se queda quieto,
   * con un tope: si a la quinta sigue moviéndose, el flujo tiene un ciclo.
   */
  let valores = { ...contexto.valores };

  // Cómo estaba todo al empezar. Lo usa `calcular` para el campo que escribe:
  // ver el porqué en ese caso.
  const iniciales = { ...contexto.valores };

  for (let pasada = 0; pasada < TOPE_DE_PASADAS; pasada++) {
    const antes = huella(resultado, valores);

    /*
     * Cada pasada parte de cero, también en los campos.
     *
     * Se limpiaban los bloqueos, las reglas disparadas y los encargos, pero no
     * lo decidido sobre cada campo: eso se acumulaba pasada tras pasada. Una
     * regla que se cumplía en la primera y dejaba de cumplirse en la segunda
     * —porque otra le escribió encima el valor que miraba— dejaba su decisión
     * pegada para siempre, y el resultado salía diciendo que ninguna regla se
     * disparó pero que dos campos habían cambiado. Imposible de entender, y
     * distinto de lo que el flujo dice de verdad.
     */
    resultado.campos = {};
    resultado.bloqueos = [];
    resultado.disparadas = [];
    resultado.evaluadas = [];
    resultado.encargos = [];
    resultado.pisadas = [];
    resultado.avisos = [];
    resultado.animaciones = [];
    resultado.botones = [];
    resultado.integraciones = [];
    resultado.enEspera = [];

    /*
     * Quién le escribe a cada campo en esta pasada.
     *
     * Si dos reglas le ponen valores distintos al mismo campo, gana la última
     * —el orden es el de la lista, y eso es predecible— pero casi siempre es un
     * error de quien diseñó el flujo. Se apunta para poder decírselo.
     */
    const escrituras = new Map<ApiId, { regla: string; valor: string }[]>();

    /*
     * Y de paso se cuenta qué pasó con cada una, si alguien lo pidió.
     *
     * Se rehace en cada pasada como todo lo demás: la que vale es la de la
     * pasada en la que el estado se quedó quieto, que es la que explica el
     * resultado final.
     */
    if (contexto.traza) resultado.traza = [];

    for (const regla of reglas) {
      if (!esSuya(regla)) {
        resultado.traza?.push({
          regla: regla.id,
          nombre: regla.nombre ?? '',
          evaluada: false,
          motivo: 'No pregunta por el campo que se acaba de responder',
          cumple: false,
          rama: '',
          condiciones: [],
        });

        continue;
      }

      /*
       * Se apunta al mirarla, cumpla o no: ver `Resultado.evaluadas`.
       *
       * Y **antes** de la espera de `tras`, a propósito. Una regla encadenada
       * que todavía no le toca tampoco debe estar enseñando nada: contarla aquí
       * hace que lo que puso en su día se retire, que es lo correcto. Dejarla
       * fuera la volvería intocable mientras su predecesora no se cumpla.
       */
      if (!resultado.evaluadas.includes(regla.id)) resultado.evaluadas.push(regla.id);

      /*
       * Una regla encadenada espera a la suya.
       *
       * `tras` es el identificador de otra regla: esta no se evalúa hasta que
       * aquella se haya cumplido. Sirve para escribir un proceso por pasos —«si
       * es una garantía… y además la revisó el técnico…»— sin repetir la primera
       * condición dentro de la segunda, que es lo que había que hacer antes y lo
       * que se olvidaba actualizar al cambiar la de arriba.
       *
       * Se mira contra lo disparado **en esta pasada**, y por eso el orden en el
       * que están escritas importa: si la de abajo va primero, se queda esperando
       * y entra en la pasada siguiente. Como el motor repite hasta que nada se
       * mueve, la cadena acaba resolviéndose igual.
       */
      if (regla.tras && !resultado.disparadas.includes(regla.tras)) {
        resultado.enEspera.push(regla.id);

        resultado.traza?.push({
          regla: regla.id,
          nombre: regla.nombre ?? '',
          evaluada: false,
          motivo: `Espera a que se cumpla «${regla.tras}»`,
          cumple: false,
          rama: '',
          condiciones: [],
        });

        continue;
      }

      /*
       * El primero que se cumpla, y se para.
       *
       * `si`, luego los `sinoSi` en orden, y `sino` solo si no cumplió
       * ninguno. Parar en el primero es lo que hace que los tramos sean
       * **excluyentes**: sin eso, dos tramos que se solapan escribirían los
       * dos en el mismo campo y ganaría el último, que es justo lo que un
       * «si no» pretende evitar.
       */
      let acciones: Accion[] = regla.sino ?? [];
      let cumple = false;
      let rama = 'si no';

      const apuntes: PasoDeCondicion[] | undefined = contexto.traza ? [] : undefined;

      if (evaluarGrupo(regla.si, valores, contexto.campos, apuntes)) {
        acciones = regla.entonces;
        cumple = true;
        rama = 'entonces';
      } else {
        let cual = 0;

        for (const tramo of regla.sinoSi ?? []) {
          cual++;

          if (!evaluarGrupo(tramo.si, valores, contexto.campos, apuntes)) continue;

          acciones = tramo.entonces ?? [];
          cumple = true;
          rama = `si no, y además ${cual}`;
          break;
        }
      }

      resultado.traza?.push({
        regla: regla.id,
        nombre: regla.nombre ?? '',
        evaluada: true,
        motivo: '',
        cumple,
        rama: cumple ? rama : acciones.length ? 'si no' : 'ninguna: no hace nada',
        condiciones: apuntes ?? [],
      });

      if (cumple) resultado.disparadas.push(regla.id);

      for (const accion of acciones) {
        /*
         * Lo que se acaba de responder no se pisa.
         *
         * Una regla puede escribirle un valor a un campo, y eso está bien —
         * salvo cuando el campo es justo el que la persona acaba de contestar.
         * Ahí la respuesta desaparecía delante de sus ojos y, peor, la regla que
         * preguntaba por esa respuesta dejaba de cumplirse en la pasada
         * siguiente: se marcaba «Llamada comercial», otra regla escribía
         * «Capacitación Presencial» encima, y la regla de «Llamada comercial» ya
         * no se disparaba nunca.
         *
         * Se bloquea solo el valor. Ocultarlo, exigirlo o pintarlo sí se
         * permite: eso no contradice lo que acaba de escribir.
         */
        if (
          contexto.campoQueCambio &&
          accion.campo === contexto.campoQueCambio &&
          ESCRIBEN_VALOR.has(accion.accion)
        ) {
          resultado.pisadas.push(
            `${regla.nombre || regla.id} quiso escribir en ${contexto.campoQueCambio}, ` +
              'que es lo que se acaba de responder',
          );

          continue;
        }

        aplicar(accion, resultado, valores, contexto.campos, regla.id, puedeAvisar, iniciales, String(contexto.ahora ?? ''), origen, contexto.campoQueCambio ?? '', String(contexto.urlDeBinarios ?? ''));

        /*
         * Un campo que llenó una llamada cuenta como cambiado, igual que uno al
         * que una regla le puso valor: sus propias reglas se evalúan en la
         * pasada siguiente. Va aparte porque esta acción no tiene un `campo`
         * —llena varios— y el reparto de abajo mira solo uno.
         */
        if (accion.accion === 'llamar-servicio') {
          for (const apiId of camposQueLlenaLaLlamada(accion.valor)) {
            // Solo los que de verdad se escribieron: una respuesta a medias
            // —o que todavía no ha llegado— no toca nada, y anotar un campo
            // que nadie escribió despertaría reglas sin motivo.
            if (resultado.campos[apiId]?.valor === undefined) continue;

            disparadores.add(apiId);

            const previas = escrituras.get(apiId) ?? [];
            previas.push({ regla: regla.id, valor: JSON.stringify(valores[apiId]) });
            escrituras.set(apiId, previas);
          }
        }

        if (accion.campo && ESCRIBEN_VALOR.has(accion.accion)) {
          // Un campo al que el flujo le acaba de escribir cuenta como cambiado:
          // sus propias reglas se evalúan en la pasada siguiente.
          disparadores.add(accion.campo);

          const previas = escrituras.get(accion.campo) ?? [];
          previas.push({ regla: regla.id, valor: JSON.stringify(valores[accion.campo]) });
          escrituras.set(accion.campo, previas);
        }
      }
    }

    resultado.conflictos = [...conflictosDe(escrituras), ...estadosEnDisputa(resultado.encargos)];

    // Con qué valores acabó. No es lo mismo que con los que empezó: una regla
    // puede escribirle encima a un campo, y entonces lo que decide la siguiente
    // ya no es lo que respondió el usuario. Sin esto no hay forma de verlo.
    resultado.valoresFinales = valores;
    resultado.escrituras = Object.fromEntries(escrituras);

    if (huella(resultado, valores) === antes) {
      cerrar(generales, resultado, valores, contexto.campos, puedeAvisar, String(contexto.ahora ?? ''), origen, String(contexto.urlDeBinarios ?? ''));
      expandirPaginas(resultado.campos, contexto.campos);
      resultado.campos = limpiar(resultado.campos);
      return resultado;
    }
  }

  resultado.ciclo = true;
  cerrar(generales, resultado, valores, contexto.campos, puedeAvisar, String(contexto.ahora ?? ''), origen, String(contexto.urlDeBinarios ?? ''));
  expandirPaginas(resultado.campos, contexto.campos);
  resultado.campos = limpiar(resultado.campos);
  return resultado;
}

/**
 * Lo decidido sobre una página cae sobre todos sus campos.
 *
 * Esconder una página es esconder lo que tiene dentro, y dejarla en solo lectura
 * es que no se pueda tocar ninguno de sus campos: eso es lo que significa para
 * quien la está diligenciando. Se hace aquí, al final, y no en cada aplicación,
 * porque las páginas no participan en el juego de pasadas — nadie pregunta por
 * el valor de una página.
 *
 * **Lo que decida el propio campo manda.** Una página en solo lectura con un
 * campo que una regla dejó editable respeta al campo: lo concreto gana a lo
 * general, que es como se espera que funcione cualquier cosa que se hereda.
 */
function expandirPaginas(
  decidido: Record<ApiId, EstadoCampo>,
  campos: Record<ApiId, Campo>,
): void {
  const paginas = Object.keys(decidido).filter((k) => campos[k]?.esPagina);
  if (!paginas.length) return;

  for (const apiIdPagina of paginas) {
    const numero = campos[apiIdPagina]?.pagina;
    if (numero === undefined) continue;

    const loDeLaPagina = decidido[apiIdPagina];

    for (const campo of Object.values(campos)) {
      if (campo.esPagina || campo.pagina !== numero) continue;

      const suyo = (decidido[campo.apiId] ??= {});

      if (suyo.visible === undefined) suyo.visible = loDeLaPagina.visible;
      if (suyo.soloLectura === undefined) suyo.soloLectura = loDeLaPagina.soloLectura;
    }
  }
}

/**
 * Ejecuta las reglas generales, en orden y una sola vez cada una.
 *
 * Sin pasadas: el orden en que están escritas **es** el orden en que se
 * ejecutan, y repetirlas lo emborronaría. Cada una ve lo que dejó la anterior,
 * que es justo lo que hace falta para encadenar «suma esto», «guarda el total
 * ahí», «y con ese total decide el estado».
 */
function cerrar(
  generales: Regla[],
  resultado: Resultado,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
  puedeAvisar: boolean,
  ahoraDelCierre: string,
  origen: Record<string, unknown> = {},
  urlDeBinarios = '',
): void {
  for (const regla of generales) {
    // También aquí: una general puede esperar a otra general anterior.
    if (regla.tras && !resultado.disparadas.includes(regla.tras)) continue;

    const cumple = evaluarGrupo(regla.si, valores, campos);
    const acciones = (cumple ? regla.entonces : regla.sino) ?? [];

    // Igual que arriba: mirada, cumpla o no.
    if (!resultado.evaluadas.includes(regla.id)) resultado.evaluadas.push(regla.id);

    if (cumple) resultado.disparadas.push(regla.id);

    for (const accion of acciones) {
      /*
       * Las generales sí leen el valor vivo, también para el campo que escriben:
       * una que acumula sobre lo que dejó la anterior es el caso normal aquí, y
       * como corren una sola vez no hay nada que se dispare.
       */
      aplicar(accion, resultado, valores, campos, regla.id, puedeAvisar, valores, ahoraDelCierre, origen, '', urlDeBinarios);
    }
  }
}

/** Las acciones que dejan un valor en el campo. */
const ESCRIBEN_VALOR = new Set([
  'poner-valor',
  'limpiar',
  'copiar-de',
  'calcular',
  'puntuar',
  'puntuar-tabla',
  'heredar',
]);

/**
 * Dos reglas que dejan la actividad en estados distintos.
 *
 * No se puede estar en dos estados a la vez: se aplican en orden y **gana el
 * último**, que es predecible pero casi nunca es lo que se quiso. Se avisa
 * diciendo cuál queda, que es la pregunta que se hace quien lo lee.
 */
function estadosEnDisputa(encargos: Encargo[]): string[] {
  const cambios = encargos.filter((e) => e.que === 'cambiar-estado');
  if (cambios.length < 2) return [];

  const reglas = [...new Set(cambios.map((c) => c.regla))].join(', ');
  const ultimo = cambios[cambios.length - 1];

  return [
    `Las reglas ${reglas} dejan la actividad en estados distintos: ` +
      `quedará el que ponga la última en ejecutarse (ahora, el de «${ultimo.regla}»).`,
  ];
}

/** Los campos que recibieron valores distintos de reglas distintas. */
function conflictosDe(escrituras: Map<ApiId, { regla: string; valor: string }[]>): string[] {
  const avisos: string[] = [];

  for (const [campo, lista] of escrituras) {
    const distintos = new Set(lista.map((e) => e.valor));
    if (distintos.size < 2) continue;

    const reglas = [...new Set(lista.map((e) => e.regla))].join(', ');
    avisos.push(`«${campo}»: las reglas ${reglas} le ponen valores distintos`);
  }

  return avisos;
}

/**
 * Un campo oculto no se exige.
 *
 * Es la regla que ya nos mordió una vez en la app: un obligatorio que nadie ve
 * impide guardar sin decir por qué. Se corrige al final, cuando ya se sabe cómo
 * quedó cada campo, y no al aplicar cada acción — el orden de las reglas no
 * debería cambiar esto.
 */
function limpiar(campos: Record<ApiId, EstadoCampo>): Record<ApiId, EstadoCampo> {
  for (const [apiId, estado] of Object.entries(campos)) {
    if (estado.visible === false) estado.obligatorio = false;

    /*
     * Un campo del que al final no se decidió nada, fuera.
     *
     * Aplicar una acción reserva su sitio en el resultado antes de saber si va
     * a escribir algo, y hay acciones que pueden no escribir: una fórmula que
     * no se puede calcular, un «copiar de» sin origen. Dejar la entrada vacía
     * hace que el formulario crea que el flujo dijo algo de ese campo cuando
     * no dijo nada, y en el simulador aparece una línea que no significa nada.
     */
    if (!Object.keys(estado).length) delete campos[apiId];
  }

  return campos;
}

/** Para saber si una pasada cambió algo. */
function huella(resultado: Resultado, valores: Record<ApiId, unknown>): string {
  return JSON.stringify([resultado.campos, valores, resultado.bloqueos, resultado.irAPagina]);
}

// ── Condiciones ─────────────────────────────────────────────────────────────

function esGrupo(x: Condicion | Grupo): x is Grupo {
  return (x as Grupo).op !== undefined;
}

function evaluarGrupo(
  grupo: Grupo | undefined,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
  apuntes?: PasoDeCondicion[],
): boolean {
  // Un grupo sin condiciones se cumple: es una regla que aplica siempre, y eso
  // es útil para dejar un campo oculto de entrada.
  if (!grupo?.cond?.length) return true;

  const resultados = grupo.cond.map((c) => {
    if (esGrupo(c)) return evaluarGrupo(c, valores, campos, apuntes);

    const cumple = evaluarCondicion(c, valores, campos);

    /*
     * Se apunta qué leyó y contra qué comparaba.
     *
     * Solo cuando alguien lo pide: construir esto en cada tecla desharía justo
     * el trabajo de no evaluar el flujo dos veces. La comprobación de que no hay
     * lista es lo único que paga el camino normal.
     */
    apuntes?.push({
      campo: c.campo,
      cmp: c.cmp,
      esperaba: loQueEsperaba(c, valores, campos),
      leyo: comoTexto(valores[c.campo], campos[c.campo]),
      cumple,
    });

    return cumple;
  });

  return grupo.op === 'o' ? resultados.some(Boolean) : resultados.every(Boolean);
}

function evaluarCondicion(
  cond: Condicion,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
): boolean {
  const ref = referenciaDetalle(cond.campo);

  /*
   * Una condición sobre una tabla se responde **fila a fila**.
   *
   * Preguntarle a la tabla entera no significa nada: cada fila tiene su propia
   * respuesta, y lo que se quiere saber es si alguna, ninguna o todas cumplen.
   * Por eso la condición se evalúa una vez por fila y el cuantificador decide
   * qué hacer con el montón.
   *
   * Un agregado no pasa por aquí: ya es un número —la suma, el promedio— y se
   * compara como cualquier otro.
   */
  if (ref && !ref.agregado) {
    const tabla = campos[ref.tabla];
    const deDentro = campoDeDetalle(tabla, ref.campo);
    const filas = filasDe(valores[ref.tabla]);

    /*
     * Sin filas no se cumple nada, ni siquiera «ninguna cumple».
     *
     * «Ninguna fila quedó en No cumple» sobre una tabla vacía es cierto en
     * lógica y falso en la práctica: quien escribe esa regla está pensando en
     * una tabla llena, y disparar con la tabla vacía deja pasar actividades sin
     * revisar. Para preguntar por la tabla vacía está `DETALLE:TABLA@filas`.
     */
    if (!filas.length) return false;

    /*
     * La referencia se resuelve **dentro de cada fila**.
     *
     * «Si la cantidad recibida es menor que la pedida» se pregunta fila a fila,
     * y las dos cantidades son las de esa misma fila. Resolviéndola una vez
     * fuera, `DETALLE:EQUIPOS:PEDIDA` valdría la lista entera de las veinte
     * filas y la comparación no significaría nada.
     */
    const cumplen = filas.map((fila) => {
      const suya = conLaReferenciaResuelta(cond, valores, campos, fila, ref.tabla);

      return suya !== null && comparar(suya, valorDeFila(fila, ref.campo, tabla), deDentro);
    });

    switch (cond.filas ?? 'alguna') {
      case 'ninguna':
        return !cumplen.some((x) => x);
      case 'todas':
        return cumplen.every((x) => x);
      default:
        return cumplen.some((x) => x);
    }
  }

  const resuelta = conLaReferenciaResuelta(cond, valores, campos);
  if (resuelta === null) return false;

  return comparar(resuelta, leerValor(cond.campo, valores, campos), campos[cond.campo]);
}

/**
 * Contra qué comparaba, para contarlo en la traza.
 *
 * Con una referencia no basta con enseñar el literal —que ya no manda, y que
 * suele estar vacío—: hay que decir de qué campo salió y qué valía. La traza es
 * la herramienta de «¿por qué no se disparó mi regla?», y con una comparación
 * campo contra campo la respuesta es casi siempre que el otro campo estaba sin
 * responder. Enseñar un hueco ahí no lo explica; decirlo, sí.
 */
function loQueEsperaba(
  cond: Condicion,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
): string {
  const referido = String(cond.valorCampo ?? '').trim();

  if (!referido) return cond.valor === undefined ? '' : String(cond.valor);

  const texto = textoDelCampoReferido(referido, valores, campos);

  return `${referido} (${texto ?? 'sin respuesta'})`;
}

/**
 * La condición con su valor ya resuelto: el literal, o lo que valga otro campo.
 *
 * ## Por qué un solo punto y no un comparador nuevo
 *
 * Porque comparar contra otro campo no es una forma nueva de comparar: es el
 * mismo «es igual a», «es menor que» o «contiene» de siempre con el valor
 * sacado de otro sitio. Resolviéndolo **antes** de comparar, los quince
 * comparadores que ya existen empiezan a funcionar campo contra campo sin
 * tocarles una línea, y el que se añada mañana lo hará también. Si esto
 * acabara necesitando un caso especial por comparador, sería la señal de que el
 * punto de resolución está en el sitio equivocado.
 *
 * ## Y si el campo apuntado está sin responder
 *
 * Devuelve `null`, y quien llama lo lee como **no se cumple**. Es lo único
 * seguro: resolverlo a cadena vacía haría que «es distinto de» se cumpliera
 * siempre, que «contiene» se cumpliera siempre —toda cadena contiene la vacía—
 * y que «es igual a» se cumpliera con cualquier otro campo también en blanco.
 * Son reglas fantasma que se disparan al abrir el formulario, antes de que
 * nadie haya escrito nada, y que nadie sabe explicar después.
 *
 * Vale igual para un campo que ya no existe: sin respuesta y sin comparación.
 *
 * ## Con qué tipo se comparan
 *
 * Con el del campo de la izquierda, que es el que ya decidía. Lo que se lee de
 * la derecha es **su texto** —el mismo que se sacaría para enseñarlo— y desde
 * ahí `compararOrden` lo pasa a fecha o a número según la familia del campo que
 * la regla está mirando. La izquierda es el sujeto de la regla, y dejar que el
 * tipo dependiera de cuál de los dos lados parece más específico sería una
 * decisión que los tres motores tendrían que acertar igual cada uno por su
 * lado.
 */
function conLaReferenciaResuelta(
  cond: Condicion,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
  fila?: Record<string, unknown>,
  tablaDeLaFila = '',
): Condicion | null {
  const uno = String(cond.valorCampo ?? '').trim();
  const dos = String(cond.valor2Campo ?? '').trim();

  // El camino de siempre, que es el de todos los flujos que ya corren: sin
  // referencia no hay nada que resolver ni objeto nuevo que armar.
  if (!uno && !dos) return cond;

  const resuelta: Condicion = { ...cond };

  if (uno) {
    const texto = textoDelCampoReferido(uno, valores, campos, fila, tablaDeLaFila);
    if (texto === null) return null;

    // La referencia manda sobre el literal. Ver `Condicion.valorCampo`.
    resuelta.valor = texto;
  }

  if (dos) {
    const texto = textoDelCampoReferido(dos, valores, campos, fila, tablaDeLaFila);
    if (texto === null) return null;

    resuelta.valor2 = texto;
  }

  return resuelta;
}

/**
 * Lo que vale el campo contra el que se compara, como texto. `null` si no vale
 * nada todavía.
 *
 * Se lee **su texto** y no el valor crudo por lo mismo que se lee el de la
 * izquierda: una respuesta de Visitrack no es una cadena —un radio guarda
 * `{txt, val}`, una casilla una lista, un GPS unas coordenadas— y `comoTexto`
 * es el único sitio que sabe sacar de cada una lo que se ve en el formulario.
 * Los dos lados pasan por el mismo sitio, así que se comparan como se leen.
 */
function textoDelCampoReferido(
  apiId: string,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
  fila?: Record<string, unknown>,
  tablaDeLaFila = '',
): string | null {
  const ref = referenciaDetalle(apiId);

  let crudo: unknown;
  let campo: Campo | undefined;

  if (ref && !ref.agregado) {
    /*
     * Un campo de tabla sin agregado solo vale algo **dentro de una fila**.
     *
     * Y de la misma tabla: dentro de la fila 3 de EQUIPOS no hay ninguna fila 3
     * de REPUESTOS con la que compararla, así que apuntar a otra tabla no es una
     * comparación posible y la condición no se cumple. Para preguntarle algo a
     * otra tabla entera está el agregado —`DETALLE:REPUESTOS:IMPORTE@suma`—, que
     * sí es un número y sí pasa por el camino de abajo.
     */
    if (!fila || ref.tabla !== tablaDeLaFila) return null;

    const esquema = campos[ref.tabla];

    crudo = valorDeFila(fila, ref.campo, esquema);
    campo = campoDeDetalle(esquema, ref.campo);
  } else {
    crudo = leerValor(apiId, valores, campos);
    campo = campos[apiId];
  }

  if (!tieneRespuesta(crudo)) return null;

  return comoTexto(crudo, campo);
}

/**
 * Compara un valor concreto con lo que pide la condición.
 *
 * Separado de [evaluarCondicion] porque una condición sobre una tabla lo llama
 * una vez por fila: lo que cambia es de dónde sale el valor, no cómo se compara.
 */
function comparar(cond: Condicion, crudo: unknown, campo?: Campo): boolean {
  const texto = comoTexto(crudo, campo);
  const modo = cond.texto ?? 'insensible';

  switch (cond.cmp) {
    case 'vacio':
      return !tieneRespuesta(crudo);

    case 'con-valor':
      return tieneRespuesta(crudo);

    case 'igual':
      return normalizar(texto, modo) === normalizar(comoTextoLlano(cond.valor), modo);

    case 'distinto':
      return normalizar(texto, modo) !== normalizar(comoTextoLlano(cond.valor), modo);

    case 'contiene':
      return normalizar(texto, modo).includes(normalizar(comoTextoLlano(cond.valor), modo));

    case 'empieza':
      return normalizar(texto, modo).startsWith(normalizar(comoTextoLlano(cond.valor), modo));

    case 'termina':
      return normalizar(texto, modo).endsWith(normalizar(comoTextoLlano(cond.valor), modo));

    case 'en-lista': {
      const lista = Array.isArray(cond.valor) ? cond.valor : String(cond.valor ?? '').split(',');
      return lista.some((v) => normalizar(comoTextoLlano(v), modo) === normalizar(texto, modo));
    }

    /*
     * Una casilla con varias marcadas vale «Avería, Ruido»: hay que buscar cada
     * opción **dentro** de la respuesta, no comparar el conjunto entero.
     *
     * Los vacíos se descartan antes de decidir: escribir «A,,B» —o dejar la
     * lista sin nada— colaba una cadena vacía, que `includes` siempre encuentra,
     * y entonces la condición se cumplía con cualquier respuesta.
     */
    case 'contiene-alguna':
    case 'contiene-todas': {
      const buscados = (Array.isArray(cond.valor) ? cond.valor : String(cond.valor ?? '').split(','))
        .map((v) => normalizar(comoTextoLlano(v), modo))
        .filter((v) => v !== '');

      if (!buscados.length) return false;

      const donde = normalizar(texto, modo);

      return cond.cmp === 'contiene-todas'
        ? buscados.every((v) => donde.includes(v))
        : buscados.some((v) => donde.includes(v));
    }

    case 'patron':
      try {
        return new RegExp(String(cond.valor ?? ''), modo === 'sensible' ? '' : 'i').test(texto);
      } catch {
        // Una expresión mal escrita no cumple, y no tumba el formulario.
        return false;
      }

    case 'mayor':
    case 'menor':
    case 'mayor-igual':
    case 'menor-igual':
    case 'entre':
      return compararOrden(cond.cmp, texto, cond.valor, cond.valor2, campo);

    case 'cerca-de':
      return cercaDe(crudo, cond.valor, cond.valor2);

    default:
      return false;
  }
}

/**
 * La hora de una programacion, o las ocho de la manana.
 *
 * Una consigna programada a las 00:00 aparece «para hoy» pero al final de la
 * noche anterior en cuanto alguien cruza un huso, y nadie empieza a trabajar a
 * esa hora. Las ocho es la hora a la que se abre.
 */
export function horaDelDespacho(valor: unknown): string {
  const texto = String(valor ?? '').trim();
  const parte = texto.match(/^(\d{1,2}):(\d{2})$/);

  if (!parte) return '08:00';

  const h = Number(parte[1]);
  const m = Number(parte[2]);

  if (h > 23 || m > 59) return '08:00';

  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Una fecha escrita como sea, en `aaaa-mm-dd hh:mm`.
 *
 * Es hora **de pared**, no UTC: el motor no sabe en qué huso está el aparato
 * —tiene que dar el mismo resultado en el simulador que en un telefono sin
 * conexion— asi que la deja tal cual y quien despacha la pasa a UTC, que si
 * conoce su reloj.
 *
 * Devuelve cadena vacia si no hay fecha que entender. Una hora suelta tampoco
 * sirve: sin dia no hay cuando.
 */
export function comoMomentoLocal(texto: string, fty = '', horaPorDefecto = '08:00'): string {
  const limpio = String(texto ?? '').trim();
  if (!limpio || fty === 'time') return '';

  const iso = limpio.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
  const barras = limpio.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2}))?/);

  let a = 0;
  let mes = 0;
  let dia = 0;
  let hora = '';

  if (iso) {
    a = Number(iso[1]);
    mes = Number(iso[2]);
    dia = Number(iso[3]);
    hora = iso[4] === undefined ? '' : `${iso[4]}:${iso[5]}`;
  } else if (barras) {
    dia = Number(barras[1]);
    mes = Number(barras[2]);
    a = Number(barras[3]);
    hora = barras[4] === undefined ? '' : `${barras[4]}:${barras[5]}`;
  } else {
    return '';
  }

  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return '';

  const fecha =
    `${String(a).padStart(4, '0')}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;

  return `${fecha} ${horaDelDespacho(hora || horaPorDefecto)}`;
}

/**
 * Una fecha de pared armada por piezas, en `aaaa-mm-dd hh:mm`.
 *
 * Se construye con el constructor de fechas y no a mano para que los
 * desbordamientos salgan bien solos: el 31 de enero + 1 día es el 1 de febrero,
 * y el 30 de febrero es el 1 o el 2 de marzo según el año. Escribirlo a mano es
 * la forma habitual de programar una consigna para un día que no existe.
 */
function armarMomento(a: number, mes: number, dia: number, hora: string): string {
  const fecha = new Date(a, mes - 1, dia, 12);
  if (Number.isNaN(fecha.getTime())) return '';

  const dos = (n: number) => String(n).padStart(2, '0');

  return (
    `${fecha.getFullYear()}-${dos(fecha.getMonth() + 1)}-${dos(fecha.getDate())} ` +
    `${horaDelDespacho(hora)}`
  );
}

/**
 * Cuándo se despacha, resuelto contra el reloj de quien diligencia.
 *
 * ## Por qué ninguna es una fecha fija
 *
 * Un flujo se dibuja una vez y se ejecuta durante meses. Una fecha escrita en
 * la regla —«el 15 de septiembre»— vale para el primer despacho y a partir de
 * ahí programa consignas en el pasado, que es peor que no programarlas: nacen
 * vencidas y nadie se entera. Por eso se dice **en relativo** y se resuelve en
 * el momento de despachar.
 *
 * ## Las formas
 *
 * - `dias` — «dentro de N días, a tal hora». N puede ser 0: hoy a esa hora.
 * - `mesdia` — «el día X del mes». El **próximo** día X: el de este mes si
 *   todavía no ha pasado, y si ya pasó, el del mes que viene. Sin año, que es
 *   lo que la hace dinámica. Es una sola consigna, no una repetición.
 * - `campo` — el día que se respondió en un campo de fecha del formulario.
 * - `fecha` — una fecha exacta. Ya no se ofrece en el lienzo, pero se sigue
 *   entendiendo: hay flujos guardados con ella.
 *
 * Lo que no se entienda devuelve cadena vacía, y entonces la consigna sale ya:
 * es preferible que llegue de más a que se pierda esperando una fecha que nadie
 * supo leer.
 */
export function momentoDelDespacho(
  config: Record<string, unknown>,
  valores: Record<string, unknown>,
  campos: Record<string, Campo>,
  ahora: string,
): string {
  const cuando = String(config['cuando'] ?? 'ya');
  const hora = horaDelDespacho(config['hora']);

  if (cuando === 'fecha') {
    return comoMomentoLocal(String(config['fecha'] ?? ''), '', hora);
  }

  if (cuando === 'campo') {
    const id = String(config['campoFecha'] ?? '');
    return comoMomentoLocal(comoTexto(valores[id], campos[id]), (campos[id]?.fty ?? '').toLowerCase(), hora);
  }

  // Las relativas necesitan saber qué día es hoy. Sin reloj no se inventan.
  const hoy = comoMomentoLocal(ahora, '', hora);
  if (!hoy) return '';

  const [a, mes, dia] = hoy.slice(0, 10).split('-').map(Number);

  if (cuando === 'dias') {
    // En blanco no es cero. `Number('')` da 0, así que una regla a la que
    // todavía no le han escrito los días programaba para hoy en vez de salir
    // ya, y en la app —que lee con `int.tryParse`— hacía lo contrario. Dos
    // motores, dos respuestas.
    const escrito = String(config['dias'] ?? '').trim();
    if (!escrito) return '';

    const cuantos = Math.trunc(Number(escrito));
    if (!Number.isFinite(cuantos) || cuantos < 0) return '';

    return armarMomento(a, mes, dia + cuantos, hora);
  }

  if (cuando === 'mesdia') {
    const escrito = String(config['dia'] ?? '').trim();
    if (!escrito) return '';

    const elegido = Math.trunc(Number(escrito));
    if (!Number.isFinite(elegido) || elegido < 1 || elegido > 31) return '';

    /*
     * El próximo, no el de este mes a secas.
     *
     * Si hoy es 20 y la regla dice «el 5», el 5 de este mes ya pasó: la
     * consigna nacería vencida. Y si es hoy mismo, cuenta hoy —a la hora que
     * diga—, que es lo que espera quien la configuró.
     */
    const esteMes = armarMomento(a, mes, elegido, hora);
    const yaPaso = elegido < dia || (esteMes && esteMes < comoMomentoLocal(ahora, '', horaDelDespacho(ahora.slice(11, 16))));

    return yaPaso ? armarMomento(a, mes + 1, elegido, hora) : esteMes;
  }

  return '';
}

/** Los tipos de campo que llevan una fecha, una hora, o las dos. */
const DE_FECHA = new Set(['date', 'datetime', 'time', 'datediff']);

/**
 * Comparar «mayor», «menor» o «entre», sepa el campo de números o de fechas.
 *
 * Una fecha comparada como número no funciona: `Number('2026-08-26')` es
 * `NaN`, así que **toda** condición de «posterior a» sobre una fecha era
 * silenciosamente falsa. Se mira el tipo del campo y se convierte a algo
 * ordenable: milisegundos para las fechas, el número para lo demás.
 */
function compararOrden(
  cmp: Comparador,
  texto: string,
  a: unknown,
  b: unknown,
  campo?: Campo,
): boolean {
  const esFecha = DE_FECHA.has((campo?.fty ?? '').toLowerCase());

  const aOrden = (valor: string): number | null =>
    esFecha ? aMomento(valor, (campo?.fty ?? '').toLowerCase()) : aNumero(valor);

  const n = aOrden(texto);
  const x = aOrden(comoTextoLlano(a));

  if (n === null || x === null) return false;

  switch (cmp) {
    case 'mayor': return n > x;
    case 'menor': return n < x;
    case 'mayor-igual': return n >= x;
    case 'menor-igual': return n <= x;
    case 'entre': {
      const y = aOrden(comoTextoLlano(b));
      return y === null ? false : n >= Math.min(x, y) && n <= Math.max(x, y);
    }
    default: return false;
  }
}

/**
 * Una fecha, una hora o ambas, como número ordenable.
 *
 * Se aceptan los formatos que de verdad llegan: el ISO que escribe el
 * navegador (`2026-08-26`, `2026-08-26T14:30`), el `dd/mm/aaaa` que usa la
 * plataforma en español, y una hora suelta (`14:30`). Lo que no se entienda
 * devuelve `null`, y la condición es falsa en vez de reventar.
 */
export function aMomento(texto: string, fty = ''): number | null {
  const limpio = texto.trim();
  if (!limpio) return null;

  // Una hora suelta: se ordena como minutos del día, no como fecha.
  if (fty === 'time' || /^\d{1,2}:\d{2}(:\d{2})?$/.test(limpio)) {
    const [h, m, sg] = limpio.split(':').map((n) => Number(n));
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h * 3600 + m * 60 + (Number.isFinite(sg) ? sg : 0);
  }

  /*
   * Un número suelto no es una fecha, aunque `Date.parse` diga que sí.
   *
   * `Date.parse('120')` devuelve el año 120 en el navegador, mientras que el
   * gemelo de Dart —`DateTime.tryParse('120')`— devuelve nulo. Es la clase de
   * diferencia que no se ve: la misma regla se cumplía en el navegador y no en
   * el teléfono, sin que nada fallara. Se descarta aquí, del lado permisivo,
   * para que los dos digan lo mismo.
   *
   * Se llega a esto comparando un campo de fecha contra un número, que es una
   * regla mal escrita — pero una regla mal escrita tiene que estar mal escrita
   * en los dos sitios.
   */
  if (/^[+-]?\d+([.,]\d+)?$/.test(limpio)) return null;

  // `dd/mm/aaaa`, con hora opcional. `Date` lo leería como mes/día.
  const conBarras = limpio.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2}))?/);

  if (conBarras) {
    const [, d, mes, a, h, mi] = conBarras;
    const t = Date.UTC(Number(a), Number(mes) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0));
    return Number.isFinite(t) ? t : null;
  }

  const t = Date.parse(limpio);
  return Number.isFinite(t) ? t : null;
}

/**
 * ¿Está esta posición a menos de X metros del punto de la regla?
 *
 * Se mide en línea recta con la fórmula del semiverseno, que a las distancias
 * de las que habla una regla —metros o pocos kilómetros— es exacta de sobra.
 */
function cercaDe(valor: unknown, punto: unknown, metros: unknown): boolean {
  const aqui = coordenadasDe(valor);
  const alli = coordenadasDe(punto);
  const radio = aNumero(comoTextoLlano(metros));

  if (!aqui || !alli || radio === null) return false;

  const R = 6371000;
  const rad = (g: number) => (g * Math.PI) / 180;

  const dLat = rad(alli.lat - aqui.lat);
  const dLng = rad(alli.lng - aqui.lng);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aqui.lat)) * Math.cos(rad(alli.lat)) * Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h))) <= radio;
}

/** Unas coordenadas, vengan como objeto de GPS o como «lat,lng» escrito. */
function coordenadasDe(valor: unknown): { lat: number; lng: number } | null {
  if (valor && typeof valor === 'object') {
    const o = valor as Record<string, unknown>;
    const lat = Number(o['lat']);
    const lng = Number(o['lng']);

    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    return null;
  }

  const partes = String(valor ?? '').split(',');
  if (partes.length !== 2) return null;

  const lat = Number(partes[0].trim());
  const lng = Number(partes[1].trim());

  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/**
 * Un número, o `null`.
 *
 * Si el campo no trae uno —está vacío, o alguien escribió «N/A»— la condición
 * acaba siendo **falsa**, no un error: un flujo no puede tumbar un formulario
 * por lo que alguien escribió en una casilla.
 */
export function aNumero(texto: string): number | null {
  const limpio = texto.trim().replace(',', '.');
  if (!limpio) return null;

  const n = Number(limpio);
  return Number.isFinite(n) ? n : null;
}

// ── Acciones ────────────────────────────────────────────────────────────────

/** Lee la configuración de una acción que la guarda como JSON. */
function leerJson(crudo: unknown): Record<string, unknown> | null {
  if (crudo && typeof crudo === 'object') return crudo as Record<string, unknown>;

  try {
    const leido = JSON.parse(String(crudo ?? ''));
    return leido && typeof leido === 'object' ? leido : null;
  } catch {
    return null;
  }
}

/**
 * Los dos extremos de un rango escrito en una acción, ya comprobados.
 *
 * Lo usan `limitar-numero` y `limitar-caracteres`, que son la misma decisión
 * tomada sobre parejas distintas: qué extremo se nombra —el que no viene se
 * queda como esté, igual que en `permisos-tabla`— y qué hacer cuando el rango
 * sale del revés. Escritas por separado, la segunda habría acabado sin el
 * arreglo que un día se le hiciera a la primera.
 *
 * Con [enteros] el extremo tiene además que ser un entero positivo: medio
 * carácter no existe, y un mínimo de cero no limita nada.
 *
 * `null` es «no hay nada que anotar», y un rango imposible —el mínimo por
 * encima del máximo— también lo es: dejaría el campo sin ninguna respuesta
 * válida, que desde fuera se lee como un formulario roto y no como una regla
 * mal escrita.
 */
function rangoDeLaAccion(
  crudo: unknown,
  enteros: boolean,
): { min?: number; max?: number } | null {
  const config = leerJson(crudo);
  if (!config) return null;

  const extremo = (valor: unknown): number | undefined => {
    const texto = String(valor ?? '').trim();
    if (!texto) return undefined;

    const n = Number(texto);
    if (!Number.isFinite(n)) return undefined;

    if (!enteros) return n;
    return n > 0 ? Math.floor(n) : undefined;
  };

  const min = extremo(config['min']);
  const max = extremo(config['max']);

  if (min === undefined && max === undefined) return null;
  if (min !== undefined && max !== undefined && min > max) return null;

  return { min, max };
}

/**
 * El patrón de `validar-patron`, o vacío cuando no se puede usar.
 *
 * Se comprueba que compile **aquí**, una vez, en vez de dejar que lo descubra
 * cada cliente: un corchete sin cerrar reventaría por separado en el navegador
 * y en el teléfono, y en el teléfono eso es una pantalla en blanco a mitad de
 * una visita.
 */
function patronQueCompila(patron: string): string {
  if (!patron) return '';

  try {
    // Construirla es la única forma de saber si el motor de expresiones la
    // acepta; lo que se devuelve sigue siendo el texto, que es lo que viaja.
    return new RegExp(patron) ? patron : '';
  } catch {
    return '';
  }
}

/**
 * ¿La regla pide que cumplir el patrón sea condición para guardar?
 *
 * **Sí mientras no diga que no.** Y no es una preferencia: un patrón que solo
 * avisa es un patrón que se ignora —se lee el aviso, el botón de guardar sigue
 * ahí, y se guarda—, así que el dato que la regla quería asegurar no llega y
 * nadie se entera hasta mucho después. Los flujos escritos antes de que esta
 * clave existiera no la traen y pasan a exigir, que es lo que quien escribió
 * «valida con esta expresión» creía estar pidiendo.
 *
 * Se admite `false` y también `"false"`: hay flujos que llegan con la
 * configuración serializada, y ahí los booleanos se vuelven texto.
 */
function quiereExigir(crudo: unknown): boolean {
  if (crudo === undefined || crudo === null) return true;

  return String(crudo).trim().toLowerCase() !== 'false';
}

/**
 * Lo que la actividad hija va a recibir escrito, ya resuelto contra el padre.
 *
 * Devuelve el identificador del formulario **a secas** cuando no se hereda
 * nada, que es como están escritas todas las reglas que ya corren y lo que
 * espera todo lo que hoy ejecuta este encargo. Solo cuando de verdad hay algo
 * que heredar sale un objeto, y así una regla vieja y una nueva sin herencia
 * producen exactamente el mismo encargo.
 *
 * `null` significa que no hay formulario y por tanto no hay actividad que
 * crear.
 *
 * ## Qué se resuelve aquí y qué no
 *
 * Los campos se leen del padre y se dejan **como texto**: es lo que sabe
 * convertir `comoLoGuarda` en la forma que guarda cada tipo del hijo —un radio
 * `{id, txt}`, una casilla una lista de eso—, y el motor no conoce el esquema
 * del formulario hijo para hacerlo él.
 *
 * Un campo del padre que vino en blanco **no se anota**. Escribir la cadena
 * vacía no es lo mismo que no escribir: borraría el valor por defecto que el
 * formulario hijo trae de fábrica, y entonces heredar dejaría el campo peor de
 * lo que estaba.
 */
export function herenciaDeActividad(
  crudo: unknown,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
): string | HerenciaDeActividad | null {
  if (crudo === null || crudo === undefined) return null;

  // Como siempre: el formulario a secas.
  if (typeof crudo !== 'object') {
    const id = String(crudo).trim();
    return id ? id : null;
  }

  const config = crudo as Record<string, unknown>;
  const formulario = String(config['formulario'] ?? '').trim();
  if (!formulario) return null;

  /*
   * Por campo, y gana el último.
   *
   * Dos entradas sobre el mismo campo del hijo son un error de quien lo
   * configuró, pero tienen que dar un resultado predecible: el mismo que en
   * todo lo demás del flujo —manda lo último que se ejecuta— y en el sitio
   * donde se escribió primero, para que la lista no baile al editarla.
   */
  const porCampo = new Map<string, { campo: ApiId; valor: string }>();

  for (const entrada of (config['campos'] as CampoHeredado[]) ?? []) {
    if (!entrada || typeof entrada !== 'object') continue;

    const campo = String(entrada.campo ?? '').trim();
    if (!campo) continue;

    const de = String(entrada.de ?? '').trim();

    // Con las dos escritas manda `de`: pedir un campo es más específico que
    // dejar una constante.
    const texto = de
      ? comoTexto(leerValor(de, valores, campos), campos[de])
      : comoTextoLlano(entrada.valor);

    // En blanco no se anota, y tampoco retira lo que dijera otra entrada
    // anterior sobre el mismo campo: manda la última que **resuelve a algo**.
    if (!texto.trim()) continue;

    porCampo.set(campo, { campo, valor: texto });
  }

  const tablas: TablaHeredada[] = [];

  for (const entrada of (config['tablas'] as TablaHeredada[]) ?? []) {
    if (!entrada || typeof entrada !== 'object') continue;

    const tabla = String(entrada.tabla ?? '').trim();
    if (!tabla) continue;

    const de = String(entrada.de ?? '').trim();

    // Mismo saneado que en `llenar-tabla`, y a propósito: es el mismo dato.
    const items = (entrada.items ?? [])
      .filter((i) => !!i && typeof i === 'object')
      .map((i) => ({ id: String(i.id ?? ''), txt: String(i.txt ?? '') }))
      .filter((i) => i.id || i.txt);

    // Una tabla que ni copia del padre ni nombra registros no llena nada.
    if (!de && !items.length) continue;

    tablas.push({ tabla, ...(de ? { de } : {}), ...(items.length ? { items } : {}) });
  }

  const binarios: BinarioHeredado[] = [];

  for (const entrada of (config['binarios'] as BinarioHeredado[]) ?? []) {
    if (!entrada || typeof entrada !== 'object') continue;

    const campo = String(entrada.campo ?? '').trim();
    if (!campo) continue;

    // Sin decir de dónde sale, del campo que se llame igual: es el caso normal
    // —la misma firma, el mismo nombre en los dos formularios— y obligar a
    // repetirlo solo daba una casilla más donde equivocarse.
    binarios.push({ campo, de: String(entrada.de ?? '').trim() || campo });
  }

  const campos2 = [...porCampo.values()];

  if (!campos2.length && !tablas.length && !binarios.length) return formulario;

  return {
    formulario,
    ...(campos2.length ? { campos: campos2 } : {}),
    ...(tablas.length ? { tablas } : {}),
    ...(binarios.length ? { binarios } : {}),
  };
}

/**
 * Ejecuta las acciones que una llamada trae para su desenlace.
 *
 * ## Por qué no puede haber una llamada dentro de otra
 *
 * Porque sería recursión sin fondo y con la red de por medio: una llamada que
 * al responder llama, y esa al responder llama otra vez. Los tres cerrojos que
 * paran el bucle —la llave es lo que se pide, quien ejecuta apunta antes de
 * marcar, y el tope por regla— cuentan llamadas de **una regla**, y aquí se
 * estarían creando llamadas que ninguna regla pidió. Se descarta y se calla:
 * el lienzo ni la ofrece, así que llegar aquí es un flujo escrito a mano.
 */
function correrLasDeLaLlamada(
  acciones: Accion[] | undefined,
  resultado: Resultado,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
  regla: string,
  puedeAvisar: boolean,
  iniciales: Record<ApiId, unknown>,
  ahora: string,
  origen: Record<string, unknown>,
  campoQueCambio: string,
): void {
  for (const accion of acciones ?? []) {
    if (!accion || typeof accion !== 'object') continue;
    if (accion.accion === 'llamar-servicio') continue;

    aplicar(
      accion,
      resultado,
      valores,
      campos,
      regla,
      puedeAvisar,
      iniciales,
      ahora,
      origen,
      campoQueCambio,
    );
  }
}

/**
 * Mete el motivo del fallo dentro de un texto.
 *
 * `{FALLO:mensaje}` y `{FALLO:codigo}` se cambian por lo que dijo el servicio.
 * Es lo que convierte «no se pudo consultar» en «no se pudo consultar: la cédula
 * no está en el padrón», que es la diferencia entre un aviso que sirve y uno que
 * obliga a llamar por teléfono.
 *
 * ## Por qué solo estos dos nombres
 *
 * Porque no es un lenguaje de plantillas y no debe llegar a serlo: dos motores
 * más un simulador teniendo que interpretar lo mismo es exactamente donde
 * empiezan a divergir. Se sustituye lo que existe bajo `FALLO:` y nada más, así
 * que unas llaves cualesquiera en un texto siguen siendo llaves.
 */
function conElMotivo(texto: string, valores: Record<ApiId, unknown>): string {
  if (!texto.includes('{' + PREFIJO_FALLO)) return texto;

  let salida = texto;

  for (const cual of ['mensaje', 'codigo', 'reintentable']) {
    const clave = PREFIJO_FALLO + cual;
    const valor = valores[clave];

    if (valor === undefined) continue;

    salida = salida.split(`{${clave}}`).join(String(valor));
  }

  return salida;
}

// ── Correos ─────────────────────────────────────────────────────────────────

/**
 * Lo que puede haber dentro de unas llaves y nombrar algo.
 *
 * Los mismos caracteres que admite un identificador en cualquier otro sitio del
 * flujo: letras, dígitos, `_`, y los dos puntos y la arroba de `DETALLE:` y de
 * los agregados. Se aceptan también `.` y `[*]` porque una ruta de respuesta
 * —`RESPUESTA:items[*].importe@suma`— se nombra así.
 */
const UNA_VARIABLE = /\{([A-Za-z0-9_.\-:@[\]*]+)\}/g;

/**
 * Deja un texto a salvo de meterse dentro de un HTML.
 *
 * ## Por qué esto no es opcional
 *
 * El cuerpo de un correo lo escribe una persona en el lienzo y los valores los
 * escribe **otra**, en campo, sin saber que van a acabar dentro de un HTML.
 * Basta con que alguien conteste `Bar & Cía <3` en un campo de texto para que la
 * maqueta se rompa; y basta con que conteste algo con `<script>` para que lo que
 * se rompa sea el correo de quien lo recibe.
 *
 * Se escapan los cinco de siempre, y el `&` primero: hacerlo después
 * convertiría el `&` que acaba de poner `<` en `&amp;lt;`.
 *
 * ## Y no hay forma de meter HTML a propósito
 *
 * A propósito. Un campo del que se fía el HTML es un campo que cualquiera puede
 * responder, y quien lo responde no tiene por qué saber que está escribiendo
 * marcado. El HTML se escribe en el lienzo, que es donde se ve lo que se está
 * haciendo; lo que viene del formulario es siempre texto.
 */
export function escaparHtml(texto: string): string {
  return texto
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;')
    .split("'").join('&#39;');
}

/**
 * Un texto en una sola línea.
 *
 * Para el asunto y para las direcciones, que viajan como **cabeceras** del
 * correo: un salto de línea metido en una cabecera no es un salto de línea, es
 * el principio de otra cabecera. Un campo de texto largo puesto en el asunto
 * bastaría para inyectar un destinatario más.
 */
function enUnaLinea(texto: string): string {
  return texto.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

/**
 * ¿Esto de dentro de las llaves nombra algo de verdad?
 *
 * ## Por qué se pregunta, en vez de sustituir todo lo que haya entre llaves
 *
 * Porque el cuerpo es HTML, y en un HTML las llaves ya significan algo: un
 * `<style>` lleva `p{color:red}` y `@media (max-width:600px){…}`. Sustituir a
 * ciegas todo `{…}` por el valor de un campo que no existe —o sea, por nada—
 * borraría el CSS del correo y dejaría la maqueta deshecha sin que nadie
 * entendiera por qué.
 *
 * Así que solo se toca lo que nombra un campo del formulario, una tabla de
 * detalle o el estado de la actividad. Lo demás se queda tal cual estaba, que es
 * lo mismo que hace `conElMotivo` con las llaves que no son suyas.
 */
/**
 * Los sufijos que puede llevar una variable, y a qué se refieren.
 *
 * `{SEDE.latitud}` saca un número de un GPS y `{FOTO.url}` la dirección de un
 * archivo. Sin sufijo, la variable sigue dando lo de siempre: el valor tal como
 * se lee en el formulario.
 *
 * Se admiten en español y en inglés porque quien escribe la plantilla teclea lo
 * que le sale, y un sufijo que no se reconoce no falla: se queda literal en el
 * correo, que es la peor forma de enterarse.
 */
const SUFIJOS_DE_GPS = ['latitud', 'latitude', 'lat', 'longitud', 'longitude', 'lng', 'lon'];
const SUFIJO_DE_URL = 'url';

/** De qué familia es el archivo de un campo, para pedirlo a la plataforma. */
/**
 * Si un campo guarda un archivo, y por tanto lo que vale de el es su direccion.
 *
 * `image` **no** entra: aquel no guarda ningun binario, ensena lo que haya en
 * una direccion escrita en el formulario, y `leerValor` ya devuelve esa
 * direccion tal cual. Meterlo aqui la envolveria en `WebResource` como si
 * fuera un GUID. Ver `direccionDeLaFoto`.
 */
function esDeArchivo(fty: string | undefined): boolean {
  const tipo = String(fty || '').toLowerCase();

  return (
    tipo === 'picture' ||
    tipo === 'signature' ||
    tipo === 'audio' ||
    tipo === 'video' ||
    tipo === 'file'
  );
}

function recursoDelCampo(fty: string): string {
  const tipo = String(fty || '').toLowerCase();

  if (tipo === 'video') return 'VIDEO';
  if (tipo === 'audio') return 'AUDIO';
  if (tipo === 'file') return 'FILE';

  return 'PICTURE';
}

/** El GUID del binario que guarda el valor de un campo de archivo. */
function guidDelBinario(valor: unknown): string {
  if (!valor) return '';

  if (typeof valor === 'string') return valor.trim();

  if (typeof valor === 'object') {
    const o = valor as Record<string, unknown>;

    for (const donde of ['bin', 'Value', 'val', 'val1']) {
      const dentro = o[donde];

      if (typeof dentro === 'string' && dentro.trim()) return dentro.trim();

      if (dentro && typeof dentro === 'object') {
        const bin = (dentro as Record<string, unknown>)['bin'];
        if (typeof bin === 'string' && bin.trim()) return bin.trim();
      }
    }
  }

  return '';
}

/**
 * Parte `NOMBRE.sufijo` en sus dos mitades, si el sufijo es de los que valen.
 *
 * Solo cuando la mitad de delante es **un campo del formulario**: así una ruta
 * de respuesta como `RESPUESTA:items[*].importe@suma` —que lleva puntos y no es
 * un campo— sigue resolviéndose por su camino de siempre.
 */
function conSufijo(
  nombre: string,
  campos: Record<ApiId, Campo>,
): { base: string; sufijo: string } | null {
  const punto = nombre.lastIndexOf('.');
  if (punto <= 0) return null;

  const base = nombre.slice(0, punto);
  const sufijo = nombre.slice(punto + 1).toLowerCase();

  if (!(base in campos)) return null;
  if (sufijo !== SUFIJO_DE_URL && !SUFIJOS_DE_GPS.includes(sufijo)) return null;

  return { base, sufijo };
}

/**
 * Lo que vale una variable con sufijo. Vacío si no se puede resolver.
 *
 * Vacío y no un texto de aviso: un correo que dice «Latitud: (sin GPS)» se lee
 * como un fallo de la aplicación, y lo que pasó es que nadie tomó la ubicación.
 * Es la misma decisión que con un campo sin responder.
 */
function valorDelSufijo(
  base: string,
  sufijo: string,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
  urlDeBinarios: string,
): string {
  const crudo = leerValor(base, valores, campos);

  if (sufijo === SUFIJO_DE_URL) {
    const guid = guidDelBinario(crudo);

    if (!guid) return '';

    /*
     * Si el campo ya trae una direccion, esa es la direccion.
     *
     * Un campo de imagen suele guardar el GUID del binario, y con el se arma la
     * direccion de abajo. Pero tambien puede venir ya resuelta —una foto que se
     * trajo de fuera, un valor heredado de otra actividad, una integracion que
     * escribio la URL en el campo— y entonces envolverla otra vez producia esto:
     *
     *     WebResource.aspx?e=PICTURE&id=https%3A%2F%2Fejemplo.com%2Ffoto.jpg
     *
     * Un enlace que no lleva a ninguna parte. Y el fallo no se ve: el correo
     * llega, el aviso suena, y lo unico que falta es la imagen — que es lo que
     * nadie mira hasta que hace falta.
     *
     * Va antes de mirar `urlDeBinarios` a proposito: una direccion ya hecha no
     * necesita ninguna base para funcionar.
     */
    if (/^https?:\/\//i.test(guid)) return guid;

    // Sin base no se inventa una dirección: mejor un hueco que un enlace roto
    // que quien reciba el correo va a pulsar.
    if (!urlDeBinarios) return '';

    const recurso = recursoDelCampo(String(campos[base]?.fty ?? ''));

    return `${urlDeBinarios}?e=${recurso}&id=${encodeURIComponent(guid)}`;
  }

  const punto = coordenadasDe(crudo);
  if (!punto) return '';

  return ['latitud', 'latitude', 'lat'].includes(sufijo)
    ? String(punto.lat)
    : String(punto.lng);
}

function esUnIdentificador(nombre: string, campos: Record<ApiId, Campo>): boolean {
  if (nombre in campos) return true;
  if (nombre === ESTADO_DE_LA_ACTIVIDAD) return true;
  if (nombre.startsWith(PREFIJO_DETALLE)) return referenciaDetalle(nombre) !== null;

  return nombre.startsWith(PREFIJO_FORMULARIO) || nombre.startsWith(PREFIJO_RESPUESTA);
}

/**
 * Mete lo respondido dentro de un texto escrito en el lienzo.
 *
 * Las variables se nombran **igual que en una condición** —`{CLIENTE}`,
 * `{DETALLE:EQUIPOS:IMPORTE@suma}`, `{ACTIVIDAD:estado}`, `{LOC_CITY}`— y se leen
 * por donde se lee todo lo demás, que es [leerValor]. No hay una segunda forma
 * de nombrar un campo, y no debe haberla: quien configura el flujo ya sabe una.
 *
 * Un identificador que existe pero no se respondió deja un hueco, no la palabra
 * «null»: un correo que dice «Cliente: null» se lee como un error de la
 * aplicación, y lo que pasó es que nadie contestó ese campo.
 *
 * [comoHtml] decide qué se hace con lo sustituido: escaparlo, para el cuerpo, o
 * dejarlo en una línea, para el asunto y las direcciones. Ver [escaparHtml].
 */
export function conLasVariables(
  texto: string,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
  comoHtml: boolean,
  urlDeBinarios = '',
): string {
  if (!texto.includes('{')) return texto;

  return texto.replace(UNA_VARIABLE, (entero, nombre: string) => {
    /*
     * Primero el nombre tal cual, y solo después el sufijo.
     *
     * Si algún día un `apiId` llevara un punto dentro, seguiría resolviéndose
     * como el campo que es en vez de partirse por la mitad.
     */
    if (esUnIdentificador(nombre, campos)) {
      const leido = comoTexto(leerValor(nombre, valores, campos), campos[nombre]);

      return comoHtml ? escaparHtml(leido) : enUnaLinea(leido);
    }

    const partido = conSufijo(nombre, campos);
    if (!partido) return entero;

    const leido = valorDelSufijo(
      partido.base,
      partido.sufijo,
      valores,
      campos,
      urlDeBinarios,
    );

    /*
     * Una URL **no se escapa como texto normal**… pero sí se escapa.
     *
     * Va dentro de un `href` o de un `src`, así que unas comillas sin escapar
     * cerrarían el atributo y lo de después se leería como marcado. Lo que la
     * hace utilizable es que `&` viaja como `&amp;`, que es lo correcto dentro
     * de un atributo HTML: el navegador lo lee como `&`.
     */
    return comoHtml ? escaparHtml(leido) : enUnaLinea(leido);
  });
}

/**
 * Con qué se separan unas direcciones de otras al escribirlas.
 *
 * La coma, el punto y coma **y los espacios**. No es tolerancia porque sí: en
 * el lienzo se escribe a mano y separar con espacios o con `;` —lo que hace
 * Outlook— es lo que sale natural. Partiendo solo por comas, «a@x.com b@x.com»
 * viajaba como **una sola dirección**, el servidor de correo la rechazaba o la
 * mandaba a una dirección que no existe, y desde fuera parecía que el correo
 * salió bien.
 *
 * Lo que no se puede arreglar aquí es lo que viene pegado sin ningún separador:
 * `a@x.comb@x.com` es una cadena sola y nadie puede saber dónde acaba una.
 */
const SEPARA_DIRECCIONES = /[,;\s]+/;

/**
 * Unas direcciones separadas por comas, sin espacios de más ni huecos.
 *
 * Se normaliza porque esta cadena entra en la llave que decide si un correo ya
 * estaba apuntado: escribir «a@x.com,b@x.com» y «a@x.com, b@x.com» es lo mismo
 * para cualquiera menos para una comparación de textos, y esa diferencia se
 * convertiría en dos correos iguales.
 */
function direcciones(texto: string): string {
  return enUnaLinea(texto)
    .split(SEPARA_DIRECCIONES)
    .map((una) => una.trim())
    // Las que no se pueden mandar no viajan: una direccion mal escrita hace que
    // el proveedor rechace la peticion entera, asi que una errata en la cuarta
    // dejaria sin correo a las otras tres. Ver `problemasDelCorreo`, que es
    // quien lo cuenta en pantalla en vez de tragarselo.
    .filter((una) => esCorreoValido(una))
    .join(', ');
}

/**
 * Lo que un nombre de archivo no puede llevar dentro.
 *
 * Solo lo que de verdad es una ruta o lo que un sistema de archivos rechaza.
 * **Los espacios se quedan**: `Informe Bar Pepe.pdf` es un nombre correcto, y
 * cambiarlos por guiones seria ensuciar un nombre que alguien escribio a
 * proposito.
 */
const NADA_DE_RUTAS = /[\/:*?"<>|]+/g;

/**
 * Cuánto puede medir el nombre de un adjunto.
 *
 * No es un límite del correo sino de quien lo recibe: un nombre larguísimo se
 * recorta en el visor, se rompe al guardarlo en algunos sistemas y no aporta
 * nada después de la primera línea.
 */
const TOPE_DEL_NOMBRE = 120;

/**
 * El nombre de un adjunto, ya escrito y a salvo.
 *
 * Se configura con variables —`Informe-{PLACA}.pdf`— y lo que responde alguien
 * en campo puede traer una barra, dos puntos o un salto de línea. En un nombre
 * de archivo eso no es texto: una barra es un cambio de carpeta y un salto
 * de linea parte el nombre en dos. Se cambian por guiones.
 *
 * **La extensión no se pone aquí.** Aquí no se sabe si la foto de un campo es un
 * `jpg` o un `png` —eso lo sabe quien tiene el archivo delante— y adivinarla
 * dejaría un `.jpg` sobre un PNG, que es peor que no ponerla. La pone el
 * servidor al adjuntar, que es donde se conoce el tipo de verdad.
 */
export function nombreDeAdjunto(texto: string): string {
  const limpio = enUnaLinea(texto)
    .replace(NADA_DE_RUTAS, '-')
    // Un nombre que empieza por punto se esconde en media plataforma.
    .replace(/^\.+/, '')
    .replace(/-{2,}/g, '-')
    .trim();

  return limpio.length > TOPE_DEL_NOMBRE ? limpio.slice(0, TOPE_DEL_NOMBRE).trim() : limpio;
}

/**
 * Los adjuntos de un correo, con su nombre resuelto.
 *
 * Lo único que se resuelve es el nombre: **el archivo no**. Ver
 * [AdjuntoDeCorreo], donde está el porqué —es la misma regla que ya sigue la
 * herencia de binarios de una actividad—.
 *
 * Los que no dicen de dónde sale el archivo se tiran aquí en vez de viajar:
 * un adjunto de tipo `campo` sin campo es una fila que el servidor tendría que
 * descartar sin poder explicar de dónde salió.
 */
function adjuntosDelCorreo(
  crudo: unknown,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
): AdjuntoDeCorreo[] {
  if (!Array.isArray(crudo)) return [];

  const salida: AdjuntoDeCorreo[] = [];

  for (const uno of crudo) {
    if (!uno || typeof uno !== 'object') continue;

    const cfg = uno as Record<string, unknown>;
    const tipo = String(cfg['tipo'] ?? '');

    if (tipo !== 'campo' && tipo !== 'tabla' && tipo !== 'fijo' && tipo !== 'informe') continue;

    const campo = String(cfg['campo'] ?? '').trim();
    const tabla = String(cfg['tabla'] ?? '').trim();
    const key = String(cfg['key'] ?? '').trim();

    // Sin de dónde sacarlo no hay adjunto que valga.
    if (tipo === 'campo' && !campo) continue;
    if (tipo === 'tabla' && (!tabla || !campo)) continue;
    if (tipo === 'fijo' && !key) continue;

    const nombre = nombreDeAdjunto(
      conLasVariables(String(cfg['nombre'] ?? ''), valores, campos, false),
    );

    const tope = Number(cfg['tope']);
    const mime = String(cfg['mime'] ?? '').trim();

    salida.push({
      tipo,
      ...(campo ? { campo } : {}),
      ...(tabla ? { tabla } : {}),
      ...(key ? { key } : {}),
      ...(mime ? { mime } : {}),
      ...(Number.isFinite(tope) && tope > 0 ? { tope: Math.floor(tope) } : {}),
      ...(tipo === 'informe' ? { formato: 'pdf' as const } : {}),
      ...(nombre ? { nombre } : {}),
    });
  }

  return salida;
}

/**
 * Qué se admite como dirección de correo.
 *
 * Permisiva a propósito, como los patrones que ofrece el lienzo: algo antes de
 * la arroba, algo después y un punto con al menos dos letras. Una expresión
 * estricta rechaza direcciones raras pero válidas, y eso deja a alguien en campo
 * sin poder mandar un correo que habría llegado perfectamente.
 *
 * Lo que sí caza son los errores de verdad: el que se dejó a medias, el que
 * lleva dos arrobas, y —sobre todo— **dos direcciones pegadas sin separador**,
 * que es el que de otro modo sale «bien» hacia una dirección que no existe.
 */
const CORREO_VALIDO = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;

/** Si una dirección suelta se puede mandar. */
export function esCorreoValido(direccion: string): boolean {
  return CORREO_VALIDO.test(direccion.trim());
}

/**
 * Por qué este correo no puede salir. Vacío si puede.
 *
 * ## Por qué lo calcula el motor y no la pantalla
 *
 * Porque tiene que responder **en cada cambio**: quien borra el campo del que
 * salía el destinatario deja el correo sin poder mandarse, y el botón tiene que
 * enterarse en ese momento, no al pulsarlo. El motor ya se reevalúa con cada
 * respuesta; la pantalla solo pinta lo que él decidió.
 *
 * Y así los dos clientes dicen exactamente lo mismo, que es la única forma de
 * que un caso de la batería pueda comprobarlo.
 */
export function problemasDelCorreo(
  crudo: unknown,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
): string[] {
  const config = leerJson(crudo);
  if (!config) return ['El correo no está configurado.'];

  const problemas: string[] = [];

  // Lo que la regla exige tener respondido, primero: es lo que quien está en
  // campo puede arreglar.
  const exige = Array.isArray(config['exige']) ? (config['exige'] as string[]) : [];

  for (const apiId of exige) {
    const nombre = String(apiId || '').trim();
    if (!nombre) continue;

    const leido = comoTexto(leerValor(nombre, valores, campos), campos[nombre]);

    if (!leido.trim()) {
      // Por su `apiId`: aqui no se conoce el rotulo que ve quien diligencia
      // —eso vive en el formulario, no en el motor— y es el mismo nombre con
      // el que la regla lo escribio, asi que quien configura lo reconoce.
      problemas.push(`Falta responder «${nombre}».`);
    }
  }

  // Y las direcciones, una a una.
  let hayAlguno = false;

  for (const parte of ['para', 'copia', 'copiaOculta']) {
    const escrito = conLasVariables(String(config[parte] ?? ''), valores, campos, false);

    for (const una of enUnaLinea(escrito).split(SEPARA_DIRECCIONES)) {
      const limpia = una.trim();
      if (!limpia) continue;

      if (esCorreoValido(limpia)) hayAlguno = true;
      else problemas.push(`«${limpia}» no es un correo válido.`);
    }
  }

  if (!hayAlguno) problemas.push('Falta a quién mandarlo.');

  const asunto = conLasVariables(String(config['asunto'] ?? ''), valores, campos, false);
  const cuerpo = conLasVariables(String(config['cuerpo'] ?? ''), valores, campos, true);

  if (!asunto.trim() && !cuerpo.trim()) problemas.push('El correo no dice nada.');

  return problemas;
}

/**
 * Las direcciones mal escritas del correo de un botón, vengan de donde vengan.
 *
 * A diferencia de [correosMalEscritosDelFormulario], aquí entran **también** las
 * escritas a mano en la regla. El motivo es que esto no bloquea el guardado:
 * solo se pinta junto al botón, y quien lo ve puede avisar a quien configuró el
 * flujo. Callarlas dejaría un botón que dice que avisa a tres y avisa a dos.
 */
export function correosMalEscritosDelBoton(
  hace: AccionDeBoton,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
): string[] {
  const config = leerJson(correoDeBoton(hace));
  if (!config) return [];

  const malas: string[] = [];

  for (const parte of ['para', 'copia', 'copiaOculta']) {
    const escrito = conLasVariables(String(config[parte] ?? ''), valores, campos, false);

    for (const una of enUnaLinea(escrito).split(SEPARA_DIRECCIONES)) {
      const limpia = una.trim();
      if (!limpia || esCorreoValido(limpia)) continue;

      if (!malas.includes(limpia)) malas.push(limpia);
    }
  }

  return malas;
}

/**
 * Las direcciones mal escritas que **salieron de un campo del formulario**.
 *
 * ## Por qué solo esas
 *
 * Porque son las únicas que quien está en campo puede arreglar. Una dirección
 * mal escrita a mano en la regla —`avisos@@empresa`— es un error de quien
 * configuró el flujo, y bloquear el guardado por ella dejaría a **todo el
 * mundo** sin poder cerrar sus actividades por algo que no está en su mano
 * corregir. Esa se descarta y se queda sin mandar, como hasta ahora.
 *
 * La que vino de un campo es otra cosa: alguien tecleó «dfgdfg» donde iba un
 * correo, lo tiene delante y puede corregirlo. Esa sí para el guardado.
 *
 * ## Cómo se distinguen
 *
 * Comparando lo escrito en la regla con lo resuelto: si la dirección mala
 * aparece tal cual en la plantilla, la escribió quien configuró; si no, salió de
 * una variable, o sea de una respuesta.
 */
export function correosMalEscritosDelFormulario(
  crudo: unknown,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
): string[] {
  const config = leerJson(crudo);
  if (!config) return [];

  const malas: string[] = [];

  for (const parte of ['para', 'copia', 'copiaOculta']) {
    const plantilla = String(config[parte] ?? '');
    if (!plantilla.trim()) continue;

    const resuelto = conLasVariables(plantilla, valores, campos, false);

    for (const una of enUnaLinea(resuelto).split(SEPARA_DIRECCIONES)) {
      const limpia = una.trim();
      if (!limpia || esCorreoValido(limpia)) continue;

      // Escrita a mano en la regla: no es de quien diligencia.
      if (plantilla.includes(limpia)) continue;

      if (!malas.includes(limpia)) malas.push(limpia);
    }
  }

  return malas;
}

/**
 * Con qué se reconoce un correo entre dos evaluaciones y entre dos guardados.
 *
 * ## Qué entra, y por qué no entra el cuerpo
 *
 * La regla, a quién va, con qué asunto y para cuándo. **El cuerpo no.** Una
 * actividad se reabre y se corrige —una tilde, un dato— y se vuelve a guardar; si
 * el cuerpo entrara en la llave, esa corrección sería un correo distinto y saldría
 * un segundo aviso al mismo destinatario diciendo casi lo mismo. Quien lo recibe
 * no ve una corrección: ve dos correos.
 *
 * Y sí entran el destinatario y el asunto porque **eso** sí distingue dos correos
 * a ojos de una persona: dos acciones en la misma regla que avisan a dos áreas
 * distintas son dos correos, y tienen razón las dos.
 *
 * Es la misma decisión que ya tomó `DespachosFlujo` con las consignas —formulario,
 * destinatario, programación y regla— traducida a lo que aquí distingue una cosa
 * de otra.
 */
export function llaveDelCorreo(
  regla: string,
  para: string,
  asunto: string,
  programado: string,
  marca = '',
): string {
  /*
   * La marca solo se añade cuando la hay.
   *
   * Concatenarla siempre metía un `|` al final de **todas** las llaves, y eso
   * habría cambiado la de cada correo ya apuntado: al día siguiente del
   * despliegue, cada uno de ellos habría salido una segunda vez a su
   * destinatario. Sin marca, la llave es byte a byte la de siempre.
   */
  const partes = [regla, para, asunto, programado];
  if (marca) partes.push(marca);

  return partes.join('|').toLowerCase();
}

/**
 * El correo que pide una regla, ya escrito.
 *
 * Devuelve `null` cuando no hay correo que mandar: sin destinatario, o sin nada
 * que decir. Se calla en vez de dejar un encargo a medias que quien lo ejecute
 * tendría que descartar sin poder explicar de dónde salió — es lo mismo que hace
 * `crear-actividad` sin formulario.
 *
 * Lo que **no** resuelve es por dónde sale. Ver `CorreoDeFlujo`: las credenciales
 * del buzón no bajan al aparato, así que viaja el identificador del proveedor —o
 * su área— y el servidor busca el resto.
 */
export function correoDeFlujo(
  crudo: unknown,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
  ahora: string,
  disparo: 'guardar' | 'boton',
  regla: string,
  urlDeBinarios = '',
): CorreoPedido | null {
  const config = leerJson(crudo);
  if (!config) return null;

  /*
   * Los campos que este correo exige, antes que nada.
   *
   * Si falta alguno no hay correo: ni se apunta ni se manda. Un aviso que dice
   * «se adjunta la foto del daño» y sale sin la foto es peor que no salir,
   * porque quien lo recibe da por hecho que no había daño.
   *
   * Se mira lo que se **lee** del campo, que es lo mismo que mira una
   * condición: así un campo respondido con espacios cuenta como vacío, igual
   * que en el resto del flujo.
   */
  const exige = Array.isArray(config['exige']) ? (config['exige'] as string[]) : [];

  for (const apiId of exige) {
    const nombre = String(apiId || '').trim();
    if (!nombre) continue;

    const leido = comoTexto(leerValor(nombre, valores, campos), campos[nombre]);

    if (!leido.trim()) return null;
  }

  const para = direcciones(
    conLasVariables(String(config['para'] ?? ''), valores, campos, false, urlDeBinarios),
  );
  const copia = direcciones(
    conLasVariables(String(config['copia'] ?? ''), valores, campos, false, urlDeBinarios),
  );
  const copiaOculta = direcciones(
    conLasVariables(String(config['copiaOculta'] ?? ''), valores, campos, false, urlDeBinarios),
  );

  // Sin nadie a quien mandárselo no hay correo. Encolarlo dejaría una fila en la
  // cola que el servidor no puede enviar y que nadie sabría explicar. La copia
  // oculta cuenta: un correo que va solo en oculto es un correo que va.
  if (!para && !copia && !copiaOculta) return null;

  const asunto = enUnaLinea(
    conLasVariables(String(config['asunto'] ?? ''), valores, campos, false, urlDeBinarios),
  );
  const cuerpo = conLasVariables(String(config['cuerpo'] ?? ''), valores, campos, true, urlDeBinarios);

  // Un correo sin asunto y sin cuerpo es un correo en blanco: quien lo reciba no
  // va a saber ni de qué le hablan.
  if (!asunto && !cuerpo.trim()) return null;

  const programado = momentoDelDespacho(config, valores, campos, ahora);
  const proveedor = String(config['proveedor'] ?? '').trim();
  const area = String(config['area'] ?? '').trim();
  const adjuntos = adjuntosDelCorreo(config['adjuntos'], valores, campos);

  /*
   * Los avisos de la pantalla, resueltos como el asunto.
   *
   * En una linea por lo mismo: lo que responda alguien en campo puede traer un
   * salto, y un aviso partido en dos se pinta a medias.
   */
  const enviando = enUnaLinea(
    conLasVariables(String(config['mensajeEnviando'] ?? ''), valores, campos, false, urlDeBinarios),
  );
  const enviado = enUnaLinea(
    conLasVariables(String(config['mensajeEnviado'] ?? ''), valores, campos, false, urlDeBinarios),
  );

  /*
   * Lo que distingue un envío del siguiente, cuando la regla admite repetirlo.
   *
   * El minuto en que se pidió. Sin esto la llave es siempre la misma y el
   * segundo envío se descarta por parecido, que es justo lo que `repetible`
   * quiere evitar; con un contador, en cambio, las cinco pasadas que da el
   * motor al evaluar contarían como cinco correos. El minuto deja pasar un
   * envío por vez que alguien lo pide y absorbe el doble toque.
   */
  const marca = config['repetible'] === true ? String(ahora ?? '') : '';

  return {
    llave: llaveDelCorreo(regla, para, asunto, programado, marca),
    para,
    ...(copia ? { copia } : {}),
    ...(copiaOculta ? { copiaOculta } : {}),
    ...(enviando ? { mensajeEnviando: enviando } : {}),
    ...(enviado ? { mensajeEnviado: enviado } : {}),

    /*
     * Solo viaja cuando se apaga.
     *
     * Ausente significa sincrono, que es lo que se hacia antes de que esto se
     * pudiera elegir. Emitirlo siempre habria cambiado la llave de todos los
     * correos ya apuntados, y cada uno de ellos habria salido una segunda vez.
     */
    ...(config['avisoSincrono'] === false ? { avisoSincrono: false } : {}),
    asunto,
    cuerpo,
    ...(proveedor ? { proveedor } : {}),
    ...(area ? { area } : {}),
    ...(adjuntos.length ? { adjuntos } : {}),
    ...(programado ? { programado } : {}),
    ...(config['soloCompleta'] === true ? { soloCompleta: true } : {}),
    disparo,
    regla,
  };
}

// ── La notificación que pide un flujo ───────────────────────────────────────

/**
 * Las dos palabras que el motor **no** puede resolver, y deja pasar tal cual.
 *
 * Quién es «el asignado» depende de la actividad, y el motor no sabe de cuál
 * cuelga: tiene que dar el mismo resultado en el simulador del diseñador, donde
 * no hay ninguna. Así que viajan como palabras hasta la cola y allí se cambian
 * por la persona de verdad. Es la misma decisión que toma `despachar` con
 * `quien: 'mismo'`.
 */
export const PERSONAS_DE_LA_ACTIVIDAD = ['@asignado', '@creador'];

/** Con qué se separan los destinatarios de un aviso. El mismo que el correo. */
const SEPARA_PERSONAS = /[,;\s]+/;

/**
 * Qué se admite como destinatario de un aviso.
 *
 * Un identificador de persona, o una de las dos palabras. Lo que no sea ninguna
 * de las dos cosas se descarta — un nombre escrito a mano («jefe») no sirve: la
 * cola necesita el número, y un texto ahí es un aviso que nunca sale y que
 * nadie sabría explicar.
 */
export function esPersonaValida(quien: string): boolean {
  const limpio = quien.trim().toLowerCase();
  if (!limpio) return false;

  if (PERSONAS_DE_LA_ACTIVIDAD.includes(limpio)) return true;

  return /^[0-9]+$/.test(limpio);
}

/**
 * Deja solo los destinatarios que se pueden usar.
 *
 * Se descartan los malos en vez de rechazar el aviso entero, igual que
 * `direcciones` con los correos: un campo que quedó vacío no puede dejar sin
 * aviso a las otras tres personas. Si no queda ninguno, quien llama se entera.
 */
export function personas(texto: string): string {
  return enUnaLinea(texto)
    .split(SEPARA_PERSONAS)
    .map((uno) => uno.trim())
    .filter((uno) => esPersonaValida(uno))
    .map((uno) => uno.toLowerCase())
    .join(', ');
}

/**
 * Los destinatarios que **salieron de un campo** y no valen.
 *
 * Solo esos, igual que `correosMalEscritosDelFormulario`: lo escrito a mano en
 * la regla es cosa de quien la configuró y se dice en pantalla, pero lo que sale
 * de un campo lo escribió alguien en el formulario y ahí sí hay que parar. Un
 * campo de supervisor con un nombre en vez de un identificador deja el aviso sin
 * salir y nadie se entera.
 */
export function personasMalEscritasDelFormulario(
  crudo: unknown,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
): string[] {
  const config = leerJson(crudo);
  if (!config) return [];

  const plantilla = String(config['para'] ?? '');
  if (!plantilla.includes('{')) return [];

  const puesto = conLasVariables(plantilla, valores, campos, false);
  const malas: string[] = [];

  for (const uno of enUnaLinea(puesto).split(SEPARA_PERSONAS)) {
    const limpia = uno.trim();
    if (!limpia) continue;

    // Lo que ya estaba escrito a mano en la regla no se cuenta aquí.
    if (plantilla.includes(limpia)) continue;

    if (!esPersonaValida(limpia) && !malas.includes(limpia)) malas.push(limpia);
  }

  return malas;
}

/**
 * Por qué el aviso de este botón no puede salir ahora mismo.
 *
 * Vacío significa que sí puede. Gemela de `problemasDelCorreo`: se recalcula en
 * cada evaluación, así que borrar el campo del que salía el destinatario apaga
 * el botón en ese momento y no al pulsarlo.
 */
export function problemasDelPush(
  crudo: unknown,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
): string[] {
  const config = leerJson(crudo);
  if (!config) return [];

  const problemas: string[] = [];

  const exige = Array.isArray(config['exige']) ? (config['exige'] as string[]) : [];

  for (const apiId of exige) {
    const nombre = String(apiId || '').trim();
    if (!nombre) continue;

    const leido = comoTexto(leerValor(nombre, valores, campos), campos[nombre]);

    if (!leido.trim()) {
      // Por su `apiId`, igual que en `problemasDelCorreo`: aqui no se conoce el
      // rotulo que ve quien diligencia —eso vive en el formulario, no en el
      // motor— y es el mismo nombre con el que la regla lo escribio.
      const motivo = `Falta responder «${nombre}».`;

      if (!problemas.includes(motivo)) problemas.push(motivo);
    }
  }

  const quienes = personas(
    conLasVariables(String(config['para'] ?? ''), valores, campos, false),
  );

  if (!quienes) problemas.push('El aviso no tiene a quién ir.');

  const titulo = enUnaLinea(
    conLasVariables(String(config['titulo'] ?? ''), valores, campos, false),
  );
  const texto = enUnaLinea(
    conLasVariables(String(config['texto'] ?? ''), valores, campos, false),
  );

  if (!titulo && !texto) problemas.push('El aviso no dice nada.');

  return problemas;
}

/**
 * Con qué se reconoce un aviso entre dos evaluaciones.
 *
 * Gemela de `llaveDelCorreo` y con la misma cautela: la marca solo se añade
 * cuando la hay, para no cambiar la llave de los avisos ya apuntados.
 */
export function llaveDelPush(
  regla: string,
  para: string,
  titulo: string,
  programado: string,
  marca = '',
): string {
  const partes = [regla, para, titulo, programado];
  if (marca) partes.push(marca);

  return partes.join('|').toLowerCase();
}

/**
 * La notificación que pide una regla, ya escrita.
 *
 * Gemela de `correoDeFlujo`, y en el mismo orden de decisiones: primero lo que
 * exige, luego a quién, luego qué dice. Devuelve `null` cuando no hay aviso que
 * mandar —sin destinatario, o sin nada que decir— en vez de dejar un encargo a
 * medias que quien lo ejecute tendría que descartar sin saber de dónde salió.
 */
export function pushDeFlujo(
  crudo: unknown,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
  ahora: string,
  disparo: 'guardar' | 'boton',
  regla: string,
  urlDeBinarios = '',

  /**
   * Lo que el flujo acaba de decidir sobre cada campo en **esta** pasada.
   *
   * Va al final y con valor por omisión porque no cabe un parámetro obligatorio
   * detrás de uno opcional. Eso significa que **omitirlo no da error** —es la
   * misma trampa que dejó sin foto los correos de un botón—, así que lo que
   * protege de verdad es la batería: hay casos que fallan si no se pasa.
   */
  decididos: Record<ApiId, EstadoCampo> = {},
): PushPedido | null {
  const config = leerJson(crudo);
  if (!config) return null;

  /*
   * Los campos que este aviso exige, antes que nada.
   *
   * Si falta alguno no hay aviso. Un push que dice «revisa la sede» con el
   * hueco de la sede vacío llega al teléfono de alguien que está en la calle y
   * no le sirve para nada.
   */
  const exige = Array.isArray(config['exige']) ? (config['exige'] as string[]) : [];

  for (const apiId of exige) {
    const nombre = String(apiId || '').trim();
    if (!nombre) continue;

    const leido = comoTexto(leerValor(nombre, valores, campos), campos[nombre]);

    if (!leido.trim()) return null;
  }

  const para = personas(
    conLasVariables(String(config['para'] ?? ''), valores, campos, false, urlDeBinarios),
  );

  // Sin nadie a quien mandárselo no hay aviso.
  if (!para) return null;

  /*
   * El título y el texto van los dos **en una línea y sin escapar**.
   *
   * Sin escapar porque una notificación no es HTML: ni Android ni el navegador
   * pintan etiquetas ahí, así que escapar un `&` lo dejaría escrito como
   * `&amp;` a la vista de quien lo recibe. Es justo al revés que el cuerpo de
   * un correo.
   *
   * Y en una línea porque un salto dentro de un título deja la notificación
   * cortada por donde el sistema decida.
   */
  const titulo = enUnaLinea(
    conLasVariables(String(config['titulo'] ?? ''), valores, campos, false, urlDeBinarios),
  );
  const texto = enUnaLinea(
    conLasVariables(String(config['texto'] ?? ''), valores, campos, false, urlDeBinarios),
  );

  // Uno sin título y sin texto es un aviso en blanco.
  if (!titulo && !texto) return null;

  /*
   * La foto, resuelta con la misma maquinaria que `{FOTO.url}`.
   *
   * Se guarda el nombre del campo y no la dirección porque la foto cambia con
   * cada actividad. Si el campo está vacío —o si no hay de dónde armar la
   * dirección— el aviso sale igual, sin imagen: uno sin foto sirve; uno que no
   * llega, no.
   */
  const foto = direccionDeLaFoto(
    String(config['foto'] ?? '').trim(),
    valores,
    campos,
    urlDeBinarios,
    decididos,
  );

  const enlace = enUnaLinea(
    conLasVariables(String(config['enlace'] ?? ''), valores, campos, false, urlDeBinarios),
  );

  const programado = momentoDelDespacho(config, valores, campos, ahora);

  // Ver la nota de `marca` en `correoDeFlujo`: el minuto deja pasar un envío por
  // vez que alguien lo pide y absorbe las cinco pasadas del motor.
  const marca = config['repetible'] === true ? String(ahora ?? '') : '';

  return {
    llave: llaveDelPush(regla, para, titulo, programado, marca),
    para,
    titulo,
    texto,
    ...(foto ? { foto } : {}),
    ...(enlace ? { enlace } : {}),
    ...(programado ? { programado } : {}),
    ...(config['soloCompleta'] === true ? { soloCompleta: true } : {}),
    disparo,
    regla,
  };
}

/**
 * La direccion de la foto que lleva un aviso, venga de donde venga.
 *
 * Hay tres formas de que un campo tenga imagen, y las tres se dan:
 *
 *  1. **Un campo de tipo `image`**, que no se responde: enseña lo que haya en
 *     una direccion escrita en el formulario. Sale de `campos[x].url`.
 *  2. **Un campo de foto o firma**, que guarda el GUID de un binario y con el se
 *     arma la direccion. Es lo que hace `valorDelSufijo`.
 *  3. **Un campo cuyo valor ya es una direccion**, porque lo escribio una
 *     integracion o se heredo de otra actividad.
 *
 * Se probaron las tres antes de escribir esto. La primera era la que fallaba en
 * silencio: el motor leia el valor respondido —vacio, porque un campo de imagen
 * no se responde— y el aviso salia sin foto sin que nada lo dijera.
 */
export function direccionDeLaFoto(
  campo: string,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
  urlDeBinarios: string,
  decididos: Record<ApiId, EstadoCampo> = {},
): string {
  if (!campo || !campos[campo]) return '';

  /*
   * Lo que el flujo **acaba de decidir**, antes que nada.
   *
   * `campos[x].url` es lo que el cliente dice que el campo está enseñando, y eso
   * es lo de **antes** de esta evaluación. Si una regla acaba de poner la imagen
   * con `poner-imagen`, el botón que se arma en esta misma pasada la leería
   * vacía y el aviso saldría sin foto: la recogería en la evaluación siguiente,
   * o sea que el primer cambio no llevaría foto y el segundo sí. Nadie entiende
   * eso mirando la pantalla.
   *
   * **Ojo con el orden de las reglas.** Cada pasada del motor parte de cero, así
   * que esto solo ve lo decidido por reglas que van **antes** en la lista. Una
   * que pone la imagen por debajo de la que arma el botón sigue llegando tarde.
   * Está en la batería, para que se vea que es así a propósito.
   */
  const puesta = String(decididos[campo]?.imagen ?? '').trim();
  if (/^https?:\/\//i.test(puesta)) return puesta;

  /*
   * Lo respondido manda, cuando hay algo.
   *
   * Cubre el binario y la direccion ya hecha, en ese orden, que es lo que
   * `valorDelSufijo` resuelve. Va primero porque en un campo que si se responde
   * es lo unico que importa.
   */
  const delValor = valorDelSufijo(campo, 'url', valores, campos, urlDeBinarios);
  if (delValor) return delValor;

  // Y si no, la del propio campo: es el caso del tipo `image`.
  const propia = String(campos[campo]?.url ?? '').trim();

  return /^https?:\/\//i.test(propia) ? propia : '';
}

/**
 * La configuración del aviso de un botón, sea de la forma nueva o de la vieja.
 *
 * Gemela de `correoDeBoton`. Antes de que el push se entregara, un botón lo
 * guardaba en las claves sueltas `para` y `texto` y no se mandaba nada. Esos
 * flujos siguen guardados y quien los abra tiene que encontrarse lo que dejó.
 *
 * Ojo con lo que **no** se hereda: el `para` de entonces era texto libre —se
 * escribía «jefe»— y ahora hace falta un identificador. Se lee igual y
 * `personas` lo descarta, así que el botón dirá que el aviso no tiene a quién ir
 * en vez de mandárselo a nadie en silencio. Es lo que se quiere: quien
 * configuró aquello tiene que volver a decir a quién.
 */
export function pushDeBoton(hace: AccionDeBoton): PushDeFlujo | null {
  if (hace.push && typeof hace.push === 'object') return hace.push;

  const para = String(hace.para ?? '').trim();
  const texto = String(hace.texto ?? '').trim();
  const titulo = String(hace.asunto ?? '').trim();

  if (!para && !titulo && !texto) return null;

  return { para, titulo, texto };
}

/**
 * Los campos que mira un aviso, para que su regla se despierte al responderlos.
 *
 * Gemela de `camposDelCorreo`. Sin esto, una regla de «al cambiar» con un push
 * dentro no se volvería a evaluar al rellenar el campo del que sale el
 * destinatario, y el aviso no saldría nunca.
 */
export function camposDelPush(push: PushDeFlujo | null | undefined): string[] {
  if (!push) return [];

  const vistos: string[] = [];

  const apuntar = (nombre: string) => {
    const limpio = nombre.trim();
    if (limpio && !vistos.includes(limpio)) vistos.push(limpio);
  };

  // Lo que nombran los textos. Se parte por el punto para quedarse con el campo
  // y no con el sufijo: de `{FOTO.url}` interesa `FOTO`.
  for (const texto of [push.para, push.titulo, push.texto, push.enlace]) {
    for (const encaje of String(texto ?? '').matchAll(UNA_VARIABLE)) {
      apuntar(String(encaje[1] ?? '').split('.')[0]);
    }
  }

  for (const apiId of Array.isArray(push.exige) ? push.exige : []) apuntar(String(apiId ?? ''));

  if (push.foto) apuntar(String(push.foto));
  if (push.campoFecha) apuntar(String(push.campoFecha));

  return vistos;
}

/**
 * La configuración del correo de un botón, sea de la forma nueva o de la vieja.
 *
 * Antes de que el correo se entregara, un botón lo guardaba en tres claves
 * sueltas —`para`, `asunto`, `texto`— y no se mandaba nada. Esos flujos siguen
 * guardados, y quien los abra tiene que encontrarse su configuración donde la
 * dejó: sin esto, la ficha saldría en blanco y el correo se perdería sin que
 * nadie tocara nada.
 *
 * El `texto` de entonces era plano; se convierte en un párrafo, que es lo que
 * hace que se lea igual dentro de un cuerpo HTML.
 */
export function correoDeBoton(hace: AccionDeBoton): CorreoDeFlujo | null {
  if (hace.correo && typeof hace.correo === 'object') return hace.correo;

  const para = String(hace.para ?? '').trim();
  const asunto = String(hace.asunto ?? '').trim();
  const texto = String(hace.texto ?? '').trim();

  if (!para && !asunto && !texto) return null;

  return { para, asunto, cuerpo: texto ? `<p>${texto}</p>` : '' };
}

function aplicar(
  accion: Accion,
  resultado: Resultado,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
  regla = '',
  puedeAvisar = true,
  iniciales: Record<ApiId, unknown> = {},
  ahora = '',

  /** El registro del que nacio la fila. Solo lo usa `heredar`. */
  origen: Record<string, unknown> = {},

  /**
   * Qué campo se acaba de responder, para no escribirle encima.
   *
   * El reparto de arriba ya protege al campo recién contestado en las acciones
   * que tienen `campo`, pero `llamar-servicio` no tiene uno —llena varios— y
   * ahí la protección hay que hacerla dentro. Vacío al abrir y al guardar,
   * donde no hay nada que proteger.
   *
   * Y al final, con qué se arma la dirección de un archivo: la necesita
   * `{FOTO.url}` dentro de un correo. Ver `Contexto.urlDeBinarios`.
   */
  campoQueCambio = '',
  urlDeBinarios = '',
): void {
  /*
   * Despachar una consigna a alguien.
   *
   * Es lo mismo que crear una actividad, con dos diferencias que lo cambian
   * todo: **es para otra persona** y **no se hace aquí**. Tiene que salir cuando
   * la actividad ya esté arriba y sus fotos en el bucket, o el que la reciba
   * abriría una consigna que remite a algo que todavía no existe.
   *
   * Por eso se anota con todo resuelto —a quién, de qué formulario, con qué
   * aviso— y quien la ejecute solo tiene que esperar el momento y enviarla.
   */
  if (accion.accion === 'despachar') {
    const config = leerJson(accion.valor);
    if (!config) return;

    /*
     * Qué se despacha: esta misma actividad, u otra nueva.
     *
     * Son dos cosas distintas y conviene no confundirlas:
     *
     * - `misma` — la actividad **se va**. Se termina aquí y pasa a ser de otra
     *   persona: la típica de «yo levanto el caso y tú lo atiendes».
     * - `otro` — la actividad se queda y **nace otra** de otro formulario. La
     *   típica de «además de esto, hay que hacer aquello».
     */
    const que = String(config['que'] ?? 'otro') === 'misma' ? 'misma' : 'otro';

    /*
     * A quién va, resuelto ya.
     *
     * Con «lo elige la persona», el destinatario sale de un campo del propio
     * formulario: quien lo diligencia elige el responsable y la consigna va a
     * ese. Se resuelve aquí para que quien la envíe no tenga que volver a leer
     * el formulario ni saber de dónde salía.
     */
    const destinatario =
      config['quien'] === 'campo'
        ? comoTexto(valores[String(config['campo'] ?? '')], campos[String(config['campo'] ?? '')])
        : config['quien'] === 'fijo'
          ? String(config['usuario'] ?? '')
          : '';

    /*
     * «Al mismo usuario» no se resuelve aquí.
     *
     * El motor no sabe quién está diligenciando —tiene que dar el mismo
     * resultado en el simulador, donde no hay nadie— así que se marca y lo
     * resuelve quien despacha, que sí lo sabe. No es lo mismo que quedarse sin
     * destinatario: aquí no hay nada que preguntar.
     */
    const alMismo = config['quien'] === 'mismo';

    /*
     * Cuando le llega.
     *
     * Por omision, ya: la consigna nace al despacharla. Programada, se anota el
     * momento como hora de pared y quien despacha la convierte a UTC — el motor
     * no sabe en que huso esta el aparato.
     *
     * Con `campo`, la fecha sale de una respuesta del propio formulario: «la
     * proxima visita, el dia que se puso ahi». Si ese campo vino en blanco o no
     * se entiende, la consigna sale ya: mejor que llegue de mas a que se pierda
     * esperando una fecha que nadie escribio.
     */
    const programado = momentoDelDespacho(config, valores, campos, ahora);

    const despacho = {
      que,
      ...(que === 'misma' ? {} : { formulario: config['formulario'] }),
      destinatario: destinatario.trim(),
      ...(alMismo ? { mismoUsuario: true } : {}),

      /*
       * Sin destinatario, se pregunta. No se calla.
       *
       * Una consigna sin dueño no la ve nadie, así que quedarse sin enviarla —o
       * peor, enviarla al vacío— es perder el trabajo. Pasa en dos casos: cuando
       * la regla dice «pregunta al guardar», y cuando dice «sácalo de este
       * campo» y el campo vino en blanco.
       */
      ...(!alMismo && !destinatario.trim() ? { preguntar: true } : {}),

      /*
       * Que cuelgue de la actividad que la creó.
       *
       * Solo tiene sentido con una actividad nueva: la misma actividad no puede
       * ser hija de sí misma. Lo que se hereda —sede, equipo— lo decide quien la
       * crea, que es el único que conoce los dos formularios y puede comprobar
       * que los tipos coinciden.
       */
      ...(que !== 'misma' && config['hija'] === true ? { hija: true } : {}),

      /*
       * Si sale con la actividad incompleta, o solo cuando está completa.
       *
       * Guardar deja pasar aunque falten obligatorios —se avisa y quien
       * diligencia decide—, y no siempre se quiere despachar en ese caso: una
       * consigna que nace de un informe a medias suele ser un error. Por omisión
       * sale igual, que es lo que se espera de una regla que dice «despacha»;
       * exigir completitud es la decisión explícita.
       */
      ...(config['soloCompleta'] === true ? { soloCompleta: true } : {}),

      /*
       * ¿Se puede cerrar la actividad sin resolver esto?
       *
       * Con `exigido`, **no**: la actividad no se guarda hasta que se diga a
       * quién se le despacha, y por tanto no sube nunca. Es para las consignas
       * que son el motivo de la visita —«si el equipo está dañado, avisa a
       * mantenimiento»—, donde cerrar sin avisar es peor que no cerrar.
       *
       * Sin la marca la actividad se guarda igual y lo que no sale es la
       * consigna. Es lo prudente por omisión: una regla mal configurada no debe
       * poder dejar a alguien en campo sin poder guardar su trabajo.
       */
      ...(config['exigido'] === true ? { exigido: true } : {}),

      ...(programado ? { programado } : {}),

      ...(config['estado'] === undefined ? {} : { estado: config['estado'] }),
      ...(config['aviso'] === undefined ? {} : { aviso: config['aviso'] }),
    };

    const yaEsta = resultado.encargos.some(
      (e) => e.que === 'despachar' && JSON.stringify(e.valor) === JSON.stringify(despacho),
    );

    if (!yaEsta) resultado.encargos.push({ que: 'despachar', valor: despacho, regla });

    return;
  }

  /*
   * Mandar un correo.
   *
   * Se anota, no se manda. El motor no habla con ningún servidor SMTP —ni podría:
   * las credenciales del buzón no bajan al aparato— y quien lo ejecuta tampoco.
   * Deja el correo apuntado, viaja con la actividad y **lo manda el servidor**.
   * Ver `CorreoDeFlujo`, donde está el porqué entero.
   *
   * Lo que sí se hace aquí es **escribirlo**: las variables se resuelven contra
   * lo respondido y se escapan. Ver `CorreoPedido`.
   *
   * Sin repetir, y por la misma llave que usa quien lo encola: dos reglas que
   * piden el mismo correo piden uno.
   */
  if (accion.accion === 'enviar-correo') {
    /*
     * Un correo mal escrito en un campo **impide guardar**.
     *
     * Las reglas se evalúan antes de escribir las respuestas, así que este es el
     * momento en que todavía se puede corregir. Después ya no: la actividad
     * sube, el correo sale sin ese destinatario y nadie se entera.
     *
     * Que la dirección **exista** no se comprueba aquí ni se puede: eso lo dirá
     * el proveedor al mandarlo. Lo que se exige es que sea una dirección, que es
     * lo que «dfgdfg» no es.
     */
    for (const mala of correosMalEscritosDelFormulario(accion.valor, valores, campos)) {
      const motivo = `«${mala}» no es un correo válido y una regla lo necesita para avisar.`;

      if (!resultado.bloqueos.includes(motivo)) resultado.bloqueos.push(motivo);
    }

    const correo = correoDeFlujo(
      accion.valor,
      valores,
      campos,
      ahora,
      'guardar',
      regla,
      urlDeBinarios,
    );
    if (!correo) return;

    const yaEsta = resultado.encargos.some(
      (e) => e.que === 'enviar-correo' && (e.valor as CorreoPedido).llave === correo.llave,
    );

    if (!yaEsta) resultado.encargos.push({ que: 'enviar-correo', valor: correo, regla });

    return;
  }

  /*
   * La notificación que pide una regla. Gemela de la de arriba.
   */
  if (accion.accion === 'enviar-push') {
    /*
     * Un destinatario mal escrito en un campo **impide guardar**.
     *
     * Mismo momento y mismo motivo que con el correo: las reglas se evalúan
     * antes de escribir las respuestas, así que este es el instante en que
     * todavía se puede corregir. Después la actividad sube, el aviso no sale y
     * nadie se entera.
     *
     * Aquí lo que se exige es un identificador de persona. Un nombre escrito en
     * el campo —«Pedro»— no sirve: la cola necesita el número, y con un texto
     * el aviso no llegaría a nadie.
     */
    for (const mala of personasMalEscritasDelFormulario(accion.valor, valores, campos)) {
      const motivo = `«${mala}» no identifica a una persona y una regla lo necesita para avisar.`;

      if (!resultado.bloqueos.includes(motivo)) resultado.bloqueos.push(motivo);
    }

    const push = pushDeFlujo(
      accion.valor,
      valores,
      campos,
      ahora,
      'guardar',
      regla,
      urlDeBinarios,
      resultado.campos,
    );
    if (!push) return;

    const yaEstaba = resultado.encargos.some(
      (e) => e.que === 'enviar-push' && (e.valor as PushPedido).llave === push.llave,
    );

    if (!yaEstaba) resultado.encargos.push({ que: 'enviar-push', valor: push, regla });

    return;
  }

  /*
   * Llenar una tabla con unos registros, sin que nadie los elija a mano.
   *
   * ## Por qué se anota y no se hace
   *
   * Crear una fila no es escribir un valor: hay que ir a la lista, encontrar el
   * ítem, traerse sus datos y armar la fila con la forma exacta que espera el
   * backend. El motor no puede —ni debe— saber nada de eso: tiene que dar el
   * mismo resultado en el simulador, donde no hay ninguna lista que consultar.
   *
   * Solo tiene sentido en tablas que sacan sus filas de algo —una lista, unas
   * sedes, unos equipos—: en una de filas en blanco no hay ítem que elegir.
   */
  if (accion.accion === 'llenar-tabla') {
    const config =
      typeof accion.valor === 'string' ? leerJson(accion.valor) : (accion.valor as any);

    if (!config) return;

    const tabla = String(config['tabla'] ?? '').trim();

    const items = ((config['items'] as any[]) ?? [])
      .filter((i) => !!i && typeof i === 'object')
      .map((i) => ({ id: String(i.id ?? ''), txt: String(i.txt ?? '') }))
      .filter((i) => i.id || i.txt);

    if (!tabla || !items.length) return;

    const encargo = {
      tabla,
      items,

      /*
       * Añadir o reemplazar.
       *
       * Por omisión se **añade**, y sin repetir lo que ya esté: una regla que
       * se evalúa en cada tecla y reemplaza la tabla borraría lo que alguien
       * acaba de responder en una fila. Reemplazar es la decisión explícita.
       */
      modo: String(config['modo'] ?? 'agregar') === 'reemplazar' ? 'reemplazar' : 'agregar',
    };

    const yaEsta = resultado.encargos.some(
      (e) => e.que === 'llenar-tabla' && JSON.stringify(e.valor) === JSON.stringify(encargo),
    );

    if (!yaEsta) resultado.encargos.push({ que: accion.accion, valor: encargo, regla });

    return;
  }

  if (accion.accion === 'crear-actividad' || accion.accion === 'cambiar-estado') {
    const valor =
      accion.accion === 'crear-actividad'
        ? herenciaDeActividad(accion.valor, valores, campos)
        : accion.valor;

    // Una actividad de un formulario que no se dice no se puede crear. Se
    // calla en vez de anotar un encargo roto que quien lo ejecute tendría que
    // descartar sin poder explicar de dónde salió.
    if (accion.accion === 'crear-actividad' && valor === null) return;

    const yaEsta = resultado.encargos.some(
      (e) => e.que === accion.accion && JSON.stringify(e.valor) === JSON.stringify(valor),
    );

    // Sin repetir: dos reglas que piden el mismo cambio de estado son un
    // cambio de estado, no dos.
    if (!yaEsta) {
      resultado.encargos.push({ que: accion.accion, valor, regla });
    }

    return;
  }

  /*
   * Un aviso en pantalla, sin más.
   *
   * No es de ningún campo: es información para quien está diligenciando —«esta
   * sede exige permiso de altura», «recuerda adjuntar la remisión»— y por eso va
   * antes de exigir que la acción tenga campo.
   *
   * Y no impide guardar, a diferencia de `bloquear-guardado`. Son dos cosas
   * distintas que se confundían todo el rato: una avisa y la otra para.
   */
  if (accion.accion === 'avisar') {
    // Se calla mientras se escribe. Ver `puedeAvisar`.
    if (!puedeAvisar) return;

    /*
     * Lo respondido, dentro del aviso.
     *
     * Se nombran los campos **igual que en todas partes** —`{CLIENTE}`,
     * `{LOC_CITY}`, `{ACTIVIDAD:estado}`— y se leen por donde se lee todo lo
     * demás. Un aviso que dice «Faltan 3 equipos por revisar en Sede Norte»
     * sirve; uno que dice «Faltan equipos por revisar» hay que ir a buscar de
     * qué habla.
     *
     * Y se recalcula solo: el flujo se evalúa con cada respuesta, así que si el
     * campo cambia, el texto cambia. Como el aviso se recuerda por su texto, el
     * de antes se olvida y el nuevo sale — que es justo lo que se quiere, porque
     * ya no dice lo mismo.
     *
     * En texto llano y no en HTML: esto acaba en un mensaje emergente, no en un
     * correo. Ver `conLasVariables`.
     */
    const texto = conLasVariables(
      conElMotivo(String(accion.valor ?? ''), valores),
      valores,
      campos,
      false,
      urlDeBinarios,
    ).trim();

    if (!texto) return;

    /*
     * Sin repetir: dos reglas que dicen lo mismo son un aviso, no dos.
     *
     * Se compara **por el texto**, no por el aviso entero. Si dos reglas dicen
     * lo mismo con tonos distintos siguen siendo un solo mensaje, y gana el
     * primero: comparar el objeto completo sacaría el mismo texto dos veces,
     * pintado de dos colores, que es peor que elegir mal el color.
     */
    if (resultado.avisos.some((otro) => otro.texto === texto)) return;

    const tono = tonoPedido(accion.tono);

    resultado.avisos.push({
      texto,
      tono,
      sonido: sonidoPedido(accion.sonido, tono),
      ...(regla ? { regla } : {}),
    });

    return;
  }

  /*
   * Caritas subiendo desde abajo.
   *
   * Es lo mismo que `avisar` en su naturaleza —no es de ningún campo, es para
   * quien está diligenciando— pero dice algo que un texto no dice: que la cosa
   * va bien, o que acaba de ir mal. En una inspección de cuarenta preguntas eso
   * es la diferencia entre saber cómo vas y enterarte al final.
   *
   * Se calla mientras se escribe, por lo mismo que los avisos y con más motivo:
   * una lluvia de emojis por cada letra tecleada no es una celebración, es un
   * formulario que no deja trabajar.
   */
  if (accion.accion === 'animar') {
    if (!puedeAvisar) return;

    const animacion = armarAnimacion(accion.valor);

    /*
     * Sin repetir, y comparando **sin la regla**.
     *
     * Dos reglas que lanzan la misma lluvia de caritas quieren una lluvia, no
     * dos superpuestas. La regla se guarda para que quien la aplique pueda
     * reconocerla entre evaluaciones, pero no distingue una animación de otra.
     */
    const yaEsta = resultado.animaciones.some(
      (a) => JSON.stringify({ ...a, regla: undefined }) ===
        JSON.stringify({ ...animacion, regla: undefined }),
    );

    if (!yaEsta) resultado.animaciones.push({ ...animacion, regla });

    return;
  }

  /*
   * Un botón debajo de los campos.
   *
   * Tampoco es de ningún campo, y va aquí por lo mismo que el aviso: es una
   * acción sobre la actividad entera —enseñar el resumen, avisar a alguien— y
   * su sitio es donde están las acciones, al final del formulario. Colgado de
   * un campo se leería como parte de la pregunta.
   *
   * ## Por qué se reemplaza por título
   *
   * Porque dos botones que dicen lo mismo son el mismo botón, y ofrecerlo dos
   * veces no da a elegir nada: da a dudar. Gana el último que se escriba, que
   * es lo que ya pasa con cualquier otra cosa que dos reglas decidan.
   */
  if (accion.accion === 'poner-boton') {
    const config = leerJson(accion.valor) as BotonDeAccion | null;
    if (!config) return;

    const boton = armarBoton(
      config,
      valores,
      campos,
      ahora,
      regla,
      urlDeBinarios,
      resultado.campos,
    );
    if (!boton) return;

    resultado.botones = [
      ...resultado.botones.filter((b) => b.titulo !== boton.titulo),
      boton,
    ];

    /*
     * Y sus llamadas van **tambien** a la lista de siempre.
     *
     * No en lugar del boton: ahi es donde viven el estado, la respuesta y el
     * reintento, y donde las busca quien las ejecuta. Repetirlas dentro del
     * boton solo sirve para saber cuales son suyas.
     *
     * Tiene ademas un efecto que se quiso a proposito: un cliente que no
     * conozca `que: 'llamar-servicio'` ignora esa parte del boton, pero
     * encuentra la llamada por aqui y le dibuja el suyo. Un telefono viejo
     * seguira pudiendo ejecutarla en vez de quedarse sin ella y sin aviso.
     */
    /*
     * Y sus llamadas se aplican **por la rama de siempre**.
     *
     * No se empujan a mano a `resultado.integraciones`: se vuelve a entrar aqui
     * con la accion `llamar-servicio` sintetizada, que es la que ademas escribe
     * las `salidas`, corre el `alResponder` y el `alFallar`, y bloquea si la
     * llamada era `exigida`. Empujarlas a mano dejaba la llamada saliendo y su
     * respuesta sin llegar a ningun campo — hecho a medias y sin dar ningun
     * error, que es la peor forma de romperse.
     *
     * Delegar en vez de repetir aquellas ciento treinta lineas hace que el
     * comportamiento sea identico **por construccion**: no hay dos sitios que
     * puedan separarse.
     *
     * `disparo: 'boton'` se fuerza por lo mismo que en `armarBoton`: la dispara
     * este boton, y `cambio` la lanzaria ademas sola.
     */
    for (const hace of config.hace ?? []) {
      if (hace?.que !== 'llamar-servicio' || !hace.servicio) continue;

      aplicar(
        { accion: 'llamar-servicio', valor: { ...hace.servicio, disparo: 'boton' } },
        resultado,
        valores,
        campos,
        regla,
        puedeAvisar,
        iniciales,
        ahora,
        origen,
        campoQueCambio,
        urlDeBinarios,
      );
    }

    return;
  }

  /*
   * Llamar a un servicio externo y llenar campos con lo que responda.
   *
   * Tampoco es de ningún campo —llena varios— y va aquí, con el aviso y el
   * botón, por lo mismo.
   *
   * ## Qué hace el motor y qué no
   *
   * No llama. Resuelve **qué** hay que pedir y **con qué** —las entradas,
   * leídas del formulario con las mismas reglas que todo lo demás— y lo deja
   * anotado; quien ejecuta marca el teléfono. La respuesta le vuelve por
   * `valores`, con `INTEGRACION:` delante, y entonces el motor escribe los
   * campos. Es el mismo reparto que en `crear-actividad` y `despachar`, y por
   * el mismo motivo: aquí no hay red, y en el simulador tampoco.
   *
   * ## Y por qué eso no se convierte en un bucle
   *
   * Porque la llamada se nombra por lo que pide. Ver [llaveDeLlamada], donde
   * está el porqué entero.
   */
  if (accion.accion === 'llamar-servicio') {
    const config = leerJson(accion.valor) as LlamadaAServicio | null;
    if (!config) return;

    const llamada = armarLlamada(config, valores, campos, regla, urlDeBinarios);
    if (!llamada) return;

    // Sin repetir: dos reglas que piden exactamente lo mismo al mismo servicio
    // piden **una** llamada, no dos. Es la misma llave que evita el bucle, y
    // aquí evita además marcar dos veces por lo mismo.
    if (!resultado.integraciones.some((i) => i.llave === llamada.llave)) {
      resultado.integraciones.push(llamada);
    }

    const bloquear = (motivo: string): void => {
      if (!resultado.bloqueos.includes(motivo)) resultado.bloqueos.push(motivo);
    };

    /*
     * Una llamada en vuelo **siempre** impide guardar, sea síncrona o
     * asíncrona.
     *
     * Es la diferencia entre las dos: la síncrona además para el formulario, y
     * eso lo hace quien pinta. Pero subir una actividad a la que le falta la
     * mitad de lo que iba a traer el servicio no se nota hasta que alguien echa
     * de menos el dato, y para entonces ya nadie sabe qué pasó. Es la misma
     * decisión que espera a que las fotos estén en el bucket.
     */
    if (llamada.estado === 'vuelo') {
      bloquear(`Esperando la respuesta de «${llamada.titulo}»`);
      return;
    }

    /*
     * Lo demás solo para si la regla lo pidió.
     *
     * Sin `exigida`, un servicio que falla deja la actividad sin ese dato pero
     * se guarda igual: una integración mal configurada —o un servicio caído—
     * no debe poder dejar a alguien en campo sin poder guardar su trabajo. Con
     * `exigida`, el dato **es** el motivo de la visita y cerrar sin él es peor
     * que no cerrar. Es exactamente lo que significa `exigido` en `despachar`.
     */
    if (config.exigida === true) {
      if (llamada.estado === 'falta') {
        bloquear(`«${llamada.titulo}» no se puede llamar todavía: ${llamada.mensaje}`);
        return;
      }

      if (llamada.estado === 'pendiente') {
        bloquear(`Hay que ejecutar «${llamada.titulo}» antes de guardar`);
      }

      if (llamada.estado === 'error') {
        bloquear(`«${llamada.titulo}» no respondió: ${llamada.mensaje}`);
      }
    }

    /*
     * Lo que falta por llamar se anota como encargo, y solo eso.
     *
     * En cuanto la respuesta está inyectada el encargo desaparece, así que la
     * lista de encargos es literalmente «lo que queda por hacer» y quien
     * ejecuta no tiene que llevar la cuenta de lo que ya hizo.
     */
    if (llamada.estado === 'pendiente') {
      const yaEsta = resultado.encargos.some(
        (e) => e.que === 'llamar-servicio' && (e.valor as LlamadaPintada)?.llave === llamada.llave,
      );

      if (!yaEsta) resultado.encargos.push({ que: 'llamar-servicio', valor: llamada, regla });
    }

    /*
     * Lo que la regla quiera hacer cuando falla, con el motivo a mano.
     *
     * `FALLO:mensaje`, `FALLO:codigo` y `FALLO:reintentable` valen aquí dentro y
     * en ningún otro sitio: fuera no hay ningún fallo del que hablar. Se ponen,
     * se corren las acciones y se quitan, para que no se cuelen en lo que el
     * motor cuenta de la evaluación ni sobrevivan a la llamada siguiente.
     */
    if (llamada.estado === 'error') {
      const antes = {
        mensaje: valores[PREFIJO_FALLO + 'mensaje'],
        codigo: valores[PREFIJO_FALLO + 'codigo'],
        reintentable: valores[PREFIJO_FALLO + 'reintentable'],
      };

      valores[PREFIJO_FALLO + 'mensaje'] = llamada.mensaje ?? '';
      valores[PREFIJO_FALLO + 'codigo'] = llamada.codigo ?? '';
      valores[PREFIJO_FALLO + 'reintentable'] = llamada.reintentable === true ? 'si' : 'no';

      correrLasDeLaLlamada(
        config.alFallar,
        resultado,
        valores,
        campos,
        regla,
        puedeAvisar,
        iniciales,
        ahora,
        origen,
        campoQueCambio,
      );

      valores[PREFIJO_FALLO + 'mensaje'] = antes.mensaje;
      valores[PREFIJO_FALLO + 'codigo'] = antes.codigo;
      valores[PREFIJO_FALLO + 'reintentable'] = antes.reintentable;
    }

    if (llamada.estado !== 'ok') return;

    // Y con lo que respondió, los campos.
    const datos = leerJson(valores[PREFIJO_INTEGRACION + llamada.llave])?.['datos'];

    for (const salida of config.salidas ?? []) {
      if (!salida || typeof salida !== 'object') continue;

      const apiId = String(salida.campo ?? '').trim();
      if (!apiId) continue;

      /*
       * Lo que se acaba de responder no se pisa, igual que con `poner-valor`.
       *
       * Aquí es más fácil de provocar: una regla que llama al escribir un campo
       * y que devuelve algo a ese mismo campo le borraría a alguien lo que
       * está tecleando, letra a letra.
       */
      if (campoQueCambio && apiId === campoQueCambio) {
        resultado.pisadas.push(
          `${regla || llamada.titulo} quiso escribir en ${campoQueCambio}, ` +
            'que es lo que se acaba de responder',
        );

        continue;
      }

      const texto = textoDeLaRespuesta(datoDeLaRuta(datos, String(salida.ruta ?? '')));

      // Un dato que no vino **no toca el campo**, como una fórmula que no se
      // puede calcular: escribir un vacío borraría lo que ya hubiera contestado
      // alguien.
      if (texto === null) continue;

      const suyo = (resultado.campos[apiId] ??= {});

      suyo.valor = texto;
      valores[apiId] = texto;
    }

    /*
     * Y lo que la regla quiera hacer con la respuesta ya escrita.
     *
     * **Después de las salidas, no antes.** Así una acción puede contar con lo
     * que la respuesta acaba de dejar en los campos —«tráete el importe y, con
     * él puesto, calcula el total»—; al revés operaría sobre el valor viejo y
     * el total saldría de la respuesta anterior, que es un fallo silencioso de
     * los que no se descubren hasta que alguien cuadra números.
     */
    correrLasDeLaLlamada(
      config.alResponder,
      resultado,
      valores,
      campos,
      regla,
      puedeAvisar,
      iniciales,
      ahora,
      origen,
      campoQueCambio,
    );

    /*
     * Y los tramos: «si la respuesta dice esto, entonces…».
     *
     * ## Por qué van los últimos
     *
     * Porque deciden **sobre los campos ya llenos**: las salidas escriben, luego
     * corre lo incondicional, y al final lo que mira lo que quedó. Al revés, un
     * tramo compararía contra el valor viejo — el de la respuesta anterior — y
     * eso es un fallo que no se ve hasta que alguien cuadra números.
     *
     * ## Y por qué solo el primero
     *
     * Son `Tramo` de los de siempre, con el mismo significado: se prueban en
     * orden y se para en el primero que se cumpla. Sin eso, dos tramos que se
     * solapan escribirían los dos en el mismo campo y ganaría el último, que es
     * justo lo que un «si no» pretende evitar.
     *
     * Mientras se evalúan, la respuesta vive en su cajón para que
     * `RESPUESTA:titular.estado` signifique algo. Se pone y se quita: fuera de
     * aquí no hay ninguna respuesta de la que hablar, y dos llamadas distintas
     * tienen dos respuestas distintas.
     */
    const tramos = (config.tramos ?? []).filter((t) => !!t && typeof t === 'object');

    if (tramos.length) {
      const antes = valores[DATOS_DE_LA_RESPUESTA];
      valores[DATOS_DE_LA_RESPUESTA] = datos;

      for (const tramo of tramos as TramoDeRegla[]) {
        if (!evaluarGrupo(tramo.si, valores, campos)) continue;

        correrLasDeLaLlamada(
          tramo.entonces,
          resultado,
          valores,
          campos,
          regla,
          puedeAvisar,
          iniciales,
          ahora,
          origen,
          campoQueCambio,
        );

        break;
      }

      if (antes === undefined) delete valores[DATOS_DE_LA_RESPUESTA];
      else valores[DATOS_DE_LA_RESPUESTA] = antes;
    }

    return;
  }

  // Las que no son de un campo concreto.
  if (accion.accion === 'bloquear-guardado') {
    const motivo = String(accion.valor ?? 'Falta algo por resolver');
    if (!resultado.bloqueos.includes(motivo)) resultado.bloqueos.push(motivo);
    return;
  }

  /*
   * Las tres que deciden sobre el formulario entero.
   *
   * El motor solo las **anota**, como los encargos: no sabe esconder un botón
   * ni dejar una pantalla en solo lectura, y no debe saberlo —tiene que dar el
   * mismo resultado aquí, en el navegador y en el simulador—. Quien llama las
   * aplica.
   */
  if (accion.accion === 'bloquear-edicion') {
    const motivo = String(accion.valor ?? 'Esta actividad no se puede editar');
    if (!resultado.edicionBloqueada.includes(motivo)) {
      resultado.edicionBloqueada.push(motivo);
    }
    return;
  }

  if (accion.accion === 'ocultar-guardar') {
    resultado.guardarOculto = true;
    return;
  }

  if (accion.accion === 'bloquear-guardar-igual') {
    resultado.guardarIgualBloqueado = true;
    return;
  }

  /*
   * Y las contrarias, para poder deshacer desde el `si no`.
   *
   * `permitir-edicion` vacía los motivos en vez de marcar una bandera aparte:
   * lo que se pregunta después es «¿hay algo que lo impida?», y dos fuentes de
   * verdad para esa pregunta es la forma segura de que un día no coincidan.
   */
  if (accion.accion === 'permitir-edicion') {
    resultado.edicionBloqueada = [];
    return;
  }

  if (accion.accion === 'mostrar-guardar') {
    resultado.guardarOculto = false;
    return;
  }

  if (accion.accion === 'permitir-guardar-igual') {
    resultado.guardarIgualBloqueado = false;
    return;
  }

  /*
   * Un campo que describe la actividad, o la fila.
   *
   * Se resuelve aquí y no en quien lo aplica porque el valor hay que leerlo con
   * las mismas reglas que todo lo demás —`comoTexto` sabe de opciones, de listas
   * y de casillas con varias marcadas—, y duplicar eso fuera es garantizar que
   * un día no coincidan.
   *
   * Sin respuesta no se anota: un descriptivo vacío ocupa sitio en el listado y
   * no dice nada.
   */
  if (accion.accion === 'usar-descriptivo') {
    const campo = accion.campo;
    if (!campo) return;

    const val = comoTexto(leerValor(campo, valores, campos), campos[campo]).trim();
    if (!val) return;

    const lab = String(accion.valor ?? '').trim();

    const yaEsta = resultado.descriptivos.some((d) => d.campo === campo && d.lab === lab);
    if (!yaEsta) resultado.descriptivos.push({ campo, lab, val });

    return;
  }

  if (accion.accion === 'ir-a-pagina') {
    resultado.irAPagina = Number(accion.valor) || undefined;
    return;
  }

  const apiId = accion.campo;
  if (!apiId) return;

  const estado = (resultado.campos[apiId] ??= {});

  switch (accion.accion) {
    case 'mostrar': estado.visible = true; break;
    case 'ocultar': estado.visible = false; break;
    case 'obligatorio': estado.obligatorio = true; break;
    case 'opcional': estado.obligatorio = false; break;
    case 'solo-lectura': estado.soloLectura = true; break;
    case 'editable': estado.soloLectura = false; break;
    case 'color': estado.color = String(accion.valor ?? ''); break;
    case 'color-texto': estado.colorTexto = String(accion.valor ?? ''); break;
    case 'mensaje': estado.mensaje = conElMotivo(String(accion.valor ?? ''), valores); break;

    /*
     * Cambiar lo que el campo **dice**, no lo que vale.
     *
     * Un título, un párrafo o la etiqueta de una pregunta son texto fijo del
     * formulario: no se responden, así que no tienen valor que escribir. Pero sí
     * hace falta cambiarlos —«si es una visita de garantía, que el aviso de
     * arriba diga otra cosa»— y hasta ahora no había forma.
     *
     * Va aparte de `poner-valor` justo por eso: aquello escribe la respuesta y
     * esto reescribe el enunciado. Confundirlos dejaría títulos guardados como
     * si alguien los hubiera contestado.
     */
    case 'poner-texto': estado.texto = conElMotivo(String(accion.valor ?? ''), valores); break;

    /*
     * La imagen que enseña un campo, por su dirección.
     *
     * Los campos de tipo imagen pintan lo que haya en una URL. Cambiarla desde
     * una regla permite que el formulario enseñe el plano, la ficha o el ejemplo
     * que toca según lo que se vaya respondiendo.
     */
    case 'poner-imagen': {
      const direccion = String(accion.valor ?? '');

      estado.imagen = direccion;

      /*
       * Y tambien en `campos`, que es de donde leen las condiciones.
       *
       * Sin esto, cambiar la imagen no despertaba a nadie. Una regla ponia la
       * foto al marcar un radio, y otra regla cuya condicion era «IMAGEN
       * con-valor» seguia sin cumplirse **para siempre**: el campo que se habia
       * respondido era el radio, no la imagen, y la unica copia de la direccion
       * vivia en `resultado.campos`, que las condiciones no miran.
       *
       * Escribiendola aqui, la imagen se comporta como cualquier otro valor que
       * pone una regla: la ven las reglas de mas abajo en esta misma pasada, y
       * las de mas arriba en la siguiente —el motor repite hasta que nada se
       * mueve—. Es exactamente lo que hace `poner-valor` con `valores`, y por lo
       * mismo.
       */
      if (accion.campo && campos[accion.campo]) {
        campos[accion.campo] = { ...campos[accion.campo], url: direccion };
      }

      break;
    }

    /*
     * Una gráfica que se mueve mientras se responde.
     *
     * ## Por qué cuelga de un campo
     *
     * Porque es lo que ya sabe hacer todo lo demás: el campo decide dónde se
     * pinta, si se ve, si la página que lo contiene está escondida. Una gráfica
     * suelta en el resultado habría necesitado su propio sitio en la pantalla,
     * sus propias reglas de visibilidad y su propio orden — tres cosas que el
     * formulario ya resuelve para los campos. Es la misma decisión que
     * `poner-imagen`: aquello dice qué enseña un campo de imagen y esto qué
     * enseña un campo cualquiera **debajo** de sí mismo.
     *
     * ## Qué se anota
     *
     * Los números, no el dibujo. `datos` sale ya contado y quien llama solo
     * pinta rectángulos. Si cada plataforma contara por su cuenta, un día la
     * barra del teléfono y la del navegador no medirían lo mismo y no habría
     * forma de saber cuál de las dos está mal.
     */
    case 'graficar': {
      const config = leerJson(accion.valor) as Grafica | null;
      if (!config) break;

      const pintada = armarGrafica(config, valores, campos);
      if (pintada) estado.grafica = pintada;

      break;
    }

    /*
     * Los límites se anotan tal cual, sin resolverlos.
     *
     * `HOY` se resuelve **en el aparato**, no aquí: un flujo se guarda una vez
     * y se ejecuta durante meses, así que una fecha calculada al guardarlo
     * estaría vencida al día siguiente. Y el motor tiene que dar el mismo
     * resultado en el simulador que en un teléfono sin conexión, donde lo
     * único de fiar es su propio reloj.
     */
    case 'limitar-desde': estado.desde = String(accion.valor ?? ''); break;
    case 'limitar-hasta': estado.hasta = String(accion.valor ?? ''); break;
    case 'dias-permitidos': estado.dias = String(accion.valor ?? ''); break;

    /*
     * La nota de ayuda que se lee debajo del campo.
     *
     * Se resuelve con `conElMotivo` como el mensaje y el enunciado: una ayuda
     * que no puede nombrar lo que acaba de pasar —«el servicio dijo:
     * {FALLO:mensaje}»— obliga a escribir una regla por cada cosa que pueda
     * decir.
     */
    case 'poner-ayuda': estado.ayuda = conElMotivo(String(accion.valor ?? ''), valores); break;

    /*
     * El alto de un campo de texto largo, en líneas.
     *
     * Un número que no se entiende no cambia el alto, igual que un tope de
     * filas mal escrito no limita la tabla: dejar el campo en cero líneas por
     * una errata sería peor que dejarlo como estaba. Y hay techo, porque un
     * campo más alto que la pantalla esconde las preguntas de debajo. Ver
     * [TOPE_DE_LINEAS].
     */
    case 'poner-lineas': {
      const alto = Number(String(accion.valor ?? '').trim());

      if (Number.isFinite(alto) && alto > 0) {
        estado.lineas = Math.min(Math.floor(alto), TOPE_DE_LINEAS);
      }

      break;
    }

    /*
     * Entre qué números, y entre cuántos caracteres, se puede responder.
     *
     * Las dos son restricciones del editor y no condiciones, igual que los
     * límites de una fecha: el motor las anota y el formulario las traduce a lo
     * suyo. Impedir escribir mal es mejor que avisar después de haberlo escrito.
     *
     * Cada extremo se escribe solo si la regla lo nombra —ver
     * `rangoDeLaAccion`— y así dos reglas pueden repartirse el rango del mismo
     * campo sin pisarse, como ya hacen con los permisos de una tabla.
     */
    case 'limitar-numero': {
      const rango = rangoDeLaAccion(accion.valor, false);
      if (!rango) break;

      if (rango.min !== undefined) estado.minimo = rango.min;
      if (rango.max !== undefined) estado.maximo = rango.max;

      break;
    }

    case 'limitar-caracteres': {
      const rango = rangoDeLaAccion(accion.valor, true);
      if (!rango) break;

      if (rango.min !== undefined) estado.minCaracteres = rango.min;
      if (rango.max !== undefined) estado.maxCaracteres = rango.max;

      break;
    }

    /*
     * El patrón con el que se valida, y qué se lee cuando no cuadra.
     *
     * Se admite escrito como `{patron, mensaje}` y también a secas, que es lo
     * que se teclea cuando el mensaje da igual: un patrón suelto es un patrón,
     * y obligar a envolverlo en un objeto para poder omitir lo opcional sería
     * pedir ceremonia por nada.
     *
     * Lo que no compila no se anota, igual que una fórmula que no se entiende
     * deja el campo como estaba: un campo que no acepta nada es peor que uno
     * sin validar, porque no hay forma de salir de él.
     */
    case 'validar-patron': {
      const config = leerJson(accion.valor) ?? { patron: accion.valor };

      const patron = patronQueCompila(String(config['patron'] ?? '').trim());
      if (!patron) break;

      estado.patron = patron;

      const aviso = conElMotivo(String(config['mensaje'] ?? '').trim(), valores);
      if (aviso) estado.patronMensaje = aviso;

      /*
       * Si además impide guardar, y si eso toca **ahora**.
       *
       * Dos cosas en una sola marca, y a propósito: lo que los clientes
       * necesitan saber es «¿bloqueo por esto?», no «¿qué pidió la regla?». Con
       * las dos por separado, cada uno de los tres tendría que combinarlas —y
       * acordarse de que un campo vacío no incumple nada— para responder a la
       * misma pregunta.
       *
       * El campo vacío es la parte que puede hacer daño. Sin esa comprobación,
       * un patrón sobre un campo opcional lo vuelve obligatorio de hecho: nadie
       * lo respondió, no cuadra con la expresión, y la actividad no se cierra
       * por una pregunta que nunca hubo que contestar. Que el campo se exija o
       * no lo sigue diciendo `obligatorio`.
       */
      const hayQueComprobar = comoTexto(
        leerValor(apiId, valores, campos),
        campos[apiId],
      ).trim();

      estado.patronExigido = !!hayQueComprobar && quiereExigir(config['exigir']);

      break;
    }

    case 'poner-valor':
      estado.valor = accion.valor;
      valores[apiId] = accion.valor;
      break;

    case 'limpiar':
      estado.valor = '';
      valores[apiId] = '';
      break;

    /*
     * Traer un dato del registro del que nacio la fila.
     *
     * Cada fila de una tabla nace de algo -una sede, un equipo, un item de una
     * lista, un usuario- y ese registro viaja con ella. `heredar` lo saca de
     * ahi: `LOC_CITY` es la ciudad de la sede, `ITE_PRICE` el precio del item, y
     * cualquier otro identificador se busca entre los campos propios de su tipo.
     *
     * Es lo que evita volver a preguntar lo que ya se sabe. Y va aparte de
     * `copiar-de` porque aquello copia **otra respuesta del formulario** y esto
     * trae un dato de fuera: confundirlos obligaria a tener el dato dos veces.
     *
     * Lo que no se encuentre **no toca el campo**: un registro sin ese dato deja
     * el campo para que lo llene quien responde, que es mejor que vaciarlo.
     */
    case 'heredar': {
      if (!origen || !Object.keys(origen).length) break;

      const heredado = datoDelOrigen(origen, String(accion.valor ?? ''));
      if (heredado === null || heredado === undefined) break;

      const comoTocaGuardarlo = comoLoGuarda(heredado, campos[apiId]);
      if (comoTocaGuardarlo === null || comoTocaGuardarlo === undefined) break;

      estado.valor = comoTocaGuardarlo;
      valores[apiId] = comoTocaGuardarlo;
      break;
    }

    case 'copiar-de': {
      if (!accion.origen) break;

      /*
       * Por `leerValor`, que es el único sitio que sabe leer identificadores.
       *
       * Antes leía el mapa a pelo, así que copiar de `DETALLE:tabla:campo` —o
       * ahora de `RESPUESTA:titular.nombre`— sacaba vacío sin decir nada. Para un
       * `apiId` normal devuelve exactamente lo mismo que antes.
       */
      const copiado = comoTexto(leerValor(accion.origen, valores, campos), campos[accion.origen]);
      estado.valor = copiado;
      valores[apiId] = copiado;
      break;
    }

    /*
     * Cuántas filas admite la tabla como mucho.
     *
     * Un tope que no se entiende no limita: dejar la tabla en cero filas por
     * una errata sería peor que no limitarla.
     */
    case 'limitar-filas': {
      const tope = Number(String(accion.valor ?? '').trim());

      if (Number.isFinite(tope) && tope > 0) estado.maxFilas = Math.floor(tope);
      break;
    }

    /*
     * Qué se puede hacer con las filas: añadir, editar, borrar.
     *
     * Cada permiso se escribe solo si la regla lo nombra. Lo que no viene se
     * queda como esté —puesto por otra regla, o sin decidir— y por eso dos
     * reglas pueden repartirse los permisos de la misma tabla sin pisarse.
     *
     * Se acepta el valor como objeto o como texto: en el lienzo se guarda igual
     * que las demás configuraciones, y hay flujos que lo mandan ya serializado.
     */
    case 'permisos-tabla': {
      const config = leerJson(accion.valor);
      if (!config) break;

      if (typeof config['agregar'] === 'boolean') estado.agregar = config['agregar'];
      if (typeof config['editar'] === 'boolean') estado.editar = config['editar'];
      if (typeof config['eliminar'] === 'boolean') estado.eliminar = config['eliminar'];

      break;
    }

    /*
     * Puntuar una columna de una tabla por lo que respondió cada fila.
     *
     * Resuelve lo que una fórmula no puede: una fórmula opera con números y
     * aquí lo que hay son respuestas de una lista, y la equivalencia entre una
     * y otra es justo lo que se quiere configurar.
     */
    case 'puntuar-tabla': {
      const config =
        typeof accion.valor === 'string' ? leerJson(accion.valor) : (accion.valor as any);

      if (!config) break;

      const nota = puntuarTabla(config, valores, campos);

      // Como con las fórmulas: lo que no se puede calcular no toca el campo.
      if (nota === null || nota === undefined) break;

      estado.valor = nota;
      valores[apiId] = nota;
      break;
    }

    case 'puntuar': {
      const config = typeof accion.valor === 'string'
        ? (() => { try { return JSON.parse(accion.valor as string); } catch { return null; } })()
        : accion.valor;

      const nota = config ? puntuar(config as Puntuacion, valores, campos) : null;

      // Como con las fórmulas: lo que no se puede calcular no toca el campo.
      if (nota === null) break;

      estado.valor = nota;
      valores[apiId] = nota;
      break;
    }

    case 'calcular': {
      /*
       * Un campo que se opera a sí mismo parte de lo que tenía, no de lo que
       * lleva calculado.
       *
       * «TOTAL = TOTAL + CANTIDAD» es una cuenta legítima, pero el motor evalúa
       * por pasadas hasta que nada se mueve, y una fórmula que se alimenta de su
       * propio resultado no se queda quieta nunca: sumaba una vez por pasada y
       * acababa dando cinco veces lo que debía, según dónde cortara el tope.
       *
       * Leyendo el campo destino de cómo estaba **al empezar la evaluación**, la
       * cuenta da lo mismo en todas las pasadas y converge a la primera. Los
       * demás campos sí se leen del estado vivo: eso es lo que permite que una
       * fórmula use el resultado de otra.
       */
      const paraLaCuenta = { ...valores, [apiId]: iniciales[apiId] };

      const resultado = calcular(String(accion.valor ?? ''), paraLaCuenta, campos);

      // Una fórmula que no se puede calcular **no toca el campo**. Escribir un
      // vacío borraría lo que ya hubiera contestado alguien.
      if (resultado === null) break;

      estado.valor = resultado;
      valores[apiId] = resultado;
      break;
    }
  }
}

// ── Valores ─────────────────────────────────────────────────────────────────

/**
 * ¿Este campo tiene respuesta?
 *
 * No es lo mismo que tener texto. Una tabla de detalle sin filas y una casilla
 * sin marcar valen «0» como texto —que es lo que hace falta para poder
 * preguntar «tiene más de dos filas»—, pero **no están respondidas**, y
 * preguntándoselo a `comoTexto` la comprobación más pedida sobre esos campos
 * decía justo lo contrario.
 */
export function tieneRespuesta(valor: unknown): boolean {
  if (valor === null || valor === undefined) return false;

  if (Array.isArray(valor)) return valor.length > 0;

  if (typeof valor === 'object') return comoTexto(valor) !== '';

  return String(valor).trim() !== '';
}

/**
 * El texto de una respuesta, sea del tipo que sea.
 *
 * Las respuestas de Visitrack no son cadenas: un radio guarda `{txt, val}`, un
 * desplegable `{txt}`, una firma `{bin, sig}`, un GPS `{lat, lng}`. Comparar
 * contra el objeto no sirve de nada; lo que alguien escribe en una regla es
 * **lo que se ve en el formulario**, y eso es lo que hay que sacar.
 */
export function comoTexto(valor: unknown, campo?: Campo): string {
  if (valor === null || valor === undefined) return '';

  /*
   * Un arreglo es dos cosas distintas según lo que lleve dentro.
   *
   * Una casilla de verificación guarda **las opciones marcadas**, cada una con
   * su texto, y ahí lo comparable es lo que dicen: «contiene Avería» tiene que
   * dispararse con dos casillas marcadas igual que con una. Una tabla de
   * detalle o un puñado de fotos guardan filas sin texto, y ahí lo único
   * comparable es cuántas hay.
   *
   * Contarlas también para la casilla era el fallo: una regla sobre un
   * `checkbox` comparaba contra «2» y no se disparaba nunca.
   *
   * Va antes del objeto porque en JavaScript un arreglo también es un objeto, y
   * cayendo ahí se devolvía vacío para diez fotos igual que para ninguna.
   */
  if (Array.isArray(valor)) {
    const textos = valor
      .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
      .filter((o) => o['txt'] !== undefined || o['val'] !== undefined)
      .map((o) => String(o['txt'] ?? o['val'] ?? ''));

    if (valor.length > 0 && textos.length === valor.length) return textos.join(', ');

    return String(valor.length);
  }

  if (typeof valor === 'object') {
    const o = valor as Record<string, unknown>;

    // Radio, casilla y desplegable.
    if (o['txt'] !== undefined) return String(o['txt'] ?? '');
    if (o['val'] !== undefined) return String(o['val'] ?? '');

    // Firma: el nombre de quien firmó es lo único comparable.
    if (o['sig']) return String(o['sig']);

    /*
     * Una foto, un audio, un vídeo, un archivo — y una firma sin nombre.
     *
     * Todos guardan el identificador del binario en `bin`, y eso es lo único
     * que hay que mirar: si está, el campo se diligenció. Sin esto, «tiene
     * valor» sobre una foto decía que no aunque hubiera una tomada, porque el
     * objeto no traía ni `txt` ni `val` ni `sig` y se devolvía vacío. Es la
     * comprobación más pedida sobre estos campos y era justo la que fallaba.
     */
    if (o['bin']) return String(o['bin']);

    /*
     * Un GPS: unas coordenadas cuentan como respuesta, pero solo si las trae.
     *
     * Se comprueba que no vengan en blanco y no solo que existan: una firma
     * borrada guarda `lat` y `lng` como cadena vacía, y con la comprobación
     * contra `undefined` se colaba como campo diligenciado.
     */
    const lat = String(o['lat'] ?? '').trim();
    const lng = String(o['lng'] ?? '').trim();
    if (lat !== '' && lng !== '') return `${lat}, ${lng}`;

    return '';
  }

  const texto = String(valor);

  /*
   * Un radio puede venir guardado como el `id` de la opción en vez de su texto.
   * Se traduce con las opciones del campo: quien escribe la regla eligió el
   * texto de una lista, no un identificador interno.
   */
  if (campo?.opt?.length) {
    const opcion = campo.opt.find((o) => o.id === texto || o.val === texto);
    if (opcion?.txt) return opcion.txt;
  }

  return texto;
}

function comoTextoLlano(valor: unknown): string {
  if (valor === null || valor === undefined) return '';
  if (typeof valor === 'object') return comoTexto(valor);

  return String(valor);
}

/** Deja un texto listo para comparar según el modo pedido. */
export function normalizar(texto: string, modo: ModoTexto): string {
  if (modo === 'sensible') return texto;

  const bajo = texto.toLowerCase();

  if (modo === 'insensible') return bajo.trim();

  // `solo-valor`: fuera tildes, signos y espacios de sobra. Queda el valor.
  return bajo
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Los campos por los que pregunta **una** regla.
 *
 * Es lo que decide de quién es la regla: la que pregunta por «Tipo de gestión»
 * es del campo «Tipo de gestión», y es ese campo el que la dispara.
 */
/**
 * Los campos que **lee** un correo del flujo.
 *
 * ## Por qué hace falta
 *
 * Porque el motor escribe el correo entero en cada evaluación —destinatarios,
 * asunto, cuerpo, nombres de los adjuntos— y también decide si puede salir. Si
 * la regla no se despierta al responder uno de esos campos, lo que queda es la
 * foto de la última vez que se miró:
 *
 * - El botón sigue diciendo que faltan los campos que el correo **exige**,
 *   aunque acaben de responderse. Es lo que se reportó.
 * - Y, más callado, el correo viajaría con el asunto y el cuerpo de antes.
 *
 * Se recogen los cuatro sitios de donde salen: las variables `{CAMPO}` de sus
 * textos, la lista de `exige`, los adjuntos que cuelgan de un campo o de una
 * tabla, y el campo del que sale su fecha de envío.
 */
export function camposDelCorreo(correo: CorreoDeFlujo | null | undefined): string[] {
  if (!correo) return [];

  const usados = new Set<string>();

  const deLosTextos = [
    correo.para,
    correo.copia,
    correo.copiaOculta,
    correo.asunto,
    correo.cuerpo,
    ...(correo.adjuntos ?? []).map((uno) => uno?.nombre),
  ];

  for (const texto of deLosTextos) {
    for (const [, nombre] of String(texto ?? '').matchAll(UNA_VARIABLE)) {
      /*
       * El nombre a secas, sin el sufijo.
       *
       * `{UBICACION.latitud}` y `{FOTO.url}` los lee el campo `UBICACION` y el
       * campo `FOTO`: quien tiene que despertar la regla es el campo, no la
       * forma en que se le pide el dato.
       */
      usados.add(String(nombre).split('.')[0]);
    }
  }

  for (const uno of correo.exige ?? []) usados.add(String(uno ?? '').trim());

  for (const adjunto of correo.adjuntos ?? []) {
    if (adjunto?.campo) usados.add(String(adjunto.campo).trim());
    if (adjunto?.tabla) usados.add(String(adjunto.tabla).trim());
  }

  if (correo.campoFecha) usados.add(String(correo.campoFecha).trim());

  return [...usados].filter(Boolean);
}

export function camposDeLaRegla(regla: Regla): string[] {
  const usados = new Set<string>();

  const mirar = (grupo: any): void => {
    for (const c of grupo?.cond ?? []) {
      if (c?.cond) {
        mirar(c);
        continue;
      }

      if (!c?.campo) continue;

      /*
       * Una regla que pregunta por una tabla es **de la tabla**.
       *
       * `DETALLE:EQUIPOS:ESTADO` no es el nombre de ningun campo del
       * formulario, asi que al responder no coincidia con nada y la regla no se
       * disparaba nunca: lo que cambia cuando se llena una fila es el campo
       * `EQUIPOS`, y es ese el que tiene que despertarla.
       */
      const anotar = (crudo: unknown): void => {
        const apiId = String(crudo ?? '').trim();
        if (!apiId) return;

        usados.add(apiId);

        const ref = referenciaDetalle(apiId);
        if (ref) usados.add(ref.tabla);
      };

      anotar(c.campo);

      /*
       * Y el campo **contra el que compara**, que también la despierta.
       *
       * «Si el peso de salida es menor que el de entrada» es tan de un campo
       * como del otro: responder la entrada tiene que volver a evaluarla igual
       * que responder la salida. Sin esto la regla se quedaba con la respuesta
       * que hubiera al escribir el primero de los dos, que es medio flujo que no
       * reacciona y ninguna forma de darse cuenta.
       */
      anotar(c.valorCampo);
      anotar(c.valor2Campo);
    }
  };

  mirar((regla as any).si);

  for (const tramo of (regla as any).sinoSi ?? []) mirar(tramo?.si);

  /*
   * Y lo que preguntan los botones que la regla pone.
   *
   * Un botón que se ve «solo si se cumple» lee campos igual que una condición
   * de la regla, y hay que despertar la regla cuando esos campos cambian. Sin
   * esto, el caso normal no funcionaba: la regla que pone el botón suele ser
   * incondicional —«al abrir, pon este botón»— así que no pregunta por nada, no
   * la despertaba nadie, y el botón se quedaba con la respuesta que dio su
   * condición al entrar al formulario.
   */
  /*
   * Y lo que preguntan las llamadas a un servicio.
   *
   * Una llamada lee campos para armar lo que le manda al servicio, así que
   * cambiar uno de ellos es cambiar **la llamada**: hay que despertar la regla
   * para que se dé cuenta. Sin esto, «al escribir la cédula, tráete el titular»
   * no se disparaba nunca, porque la regla que llama suele ser incondicional y
   * entonces no pregunta por nada.
   *
   * Y con la llamada, el nombre por el que le vuelve la respuesta: quien
   * ejecuta reevalúa diciendo que cambió `INTEGRACION:<integración>`, y esa es
   * la señal que hace que la regla mire otra vez y escriba los campos. Se
   * nombra por la integración y no por la llave porque esto se calcula sin
   * valores delante —no se sabe todavía qué se le va a pedir— y basta: quien
   * llama a esa integración es quien tiene que despertarse.
   */
  /** Apunta un campo y, si es de una tabla, también la tabla. */
  const anotarCampo = (apiId: string): void => {
    const limpio = String(apiId ?? '').trim();
    if (!limpio) return;

    usados.add(limpio);

    const ref = referenciaDetalle(limpio);
    if (ref) usados.add(ref.tabla);
  };

  const mirarAcciones = (acciones: any[]): void => {
    for (const a of acciones ?? []) {
      const config = typeof a?.valor === 'string' ? leerJson(a.valor) : a?.valor;

      if (a?.accion === 'poner-boton') {
        mirar((config as any)?.si);

        /*
         * Y lo que lee el servicio que el boton llama.
         *
         * Sin esto la regla no se despierta: ni al responder el campo del que
         * sale una entrada, ni cuando vuelve la respuesta por
         * `INTEGRACION:<id>`. El boton se quedaria llamando con lo que hubiera
         * cuando se armo, y su respuesta no reevaluaria nada.
         */
        for (const hace of ((config as any)?.hace ?? []) as AccionDeBoton[]) {
          if (hace?.que !== 'llamar-servicio' || !hace.servicio) continue;

          const suya = String(hace.servicio.id ?? '').trim();
          if (suya) usados.add(PREFIJO_INTEGRACION + suya);

          for (const entrada of hace.servicio.entradas ?? []) {
            anotarCampo(String(entrada?.de ?? ''));
          }
        }

        // Y lo que lee el correo del botón. Ver [camposDelCorreo].
        for (const hace of ((config as any)?.hace ?? []) as AccionDeBoton[]) {
          for (const uno of camposDelCorreo(correoDeBoton(hace))) anotarCampo(uno);
        }

        continue;
      }

      /*
       * Un correo de la propia regla lee campos igual que el de un botón.
       *
       * Suele estar en una regla de «al guardar», donde corren todas y esto no
       * hace falta; pero puesto en «al cambiar» tenía el mismo problema, y que
       * funcione o no según el momento en que se coloque es justo la clase de
       * diferencia que nadie relaciona con la causa.
       */
      if (a?.accion === 'enviar-correo') {
        for (const uno of camposDelCorreo(config as CorreoDeFlujo | null)) anotarCampo(uno);
        continue;
      }

      if (a?.accion !== 'llamar-servicio') continue;

      const suya = String((config as any)?.id ?? '').trim();
      if (suya) usados.add(PREFIJO_INTEGRACION + suya);

      for (const entrada of ((config as any)?.entradas ?? []) as EntradaDeLlamada[]) {
        const de = String(entrada?.de ?? '').trim();
        if (!de) continue;

        usados.add(de);

        const ref = referenciaDetalle(de);
        if (ref) usados.add(ref.tabla);
      }
    }
  };

  mirarAcciones((regla as any).entonces);
  mirarAcciones((regla as any).sino);

  for (const tramo of (regla as any).sinoSi ?? []) mirarAcciones(tramo?.entonces);

  return [...usados];
}

/**
 * Los campos sobre los que **decide** una regla.
 *
 * No los que lee —eso es [camposDeLaRegla]— sino los que toca: los de sus
 * acciones, las de los tramos y las del «si no». Hace falta para saber qué
 * decisiones suyas hay que olvidar cuando la regla se vuelve a evaluar.
 *
 * Una regla marcada «al abrir» y «al cambiar» decide dos veces sobre lo mismo,
 * y cada evaluación se guarda aparte —la de abrir, y la del campo que se
 * respondió—. Sin esto, lo que decidió al abrir se quedaba pegado: escondia un
 * campo al entrar y no volvia a salir aunque su condicion dejara de cumplirse,
 * porque la evaluacion nueva no escribe nada y la vieja seguia ahi.
 */
export function camposQueDecideLaRegla(regla: Regla): string[] {
  const tocados = new Set<string>();

  const mirar = (acciones: any[]): void => {
    for (const a of acciones ?? []) {
      if (a?.campo) tocados.add(String(a.campo));

      // «Ir a la página» y las que deciden sobre una página entera.
      if (a?.pagina) tocados.add(`PAGINA:${a.pagina}`);

      /*
       * Y los campos que llena una llamada a un servicio.
       *
       * No cuelgan de `campo` —una llamada llena varios— así que la cuenta de
       * arriba no los veía, y lo que decidiera la regla sobre ellos se quedaba
       * pegado de una pasada a la siguiente. Es el mismo fallo que arreglaba
       * `_olvidarLoViejoDe`, visto desde el otro lado.
       */
      if (a?.accion === 'llamar-servicio') {
        for (const apiId of camposQueLlenaLaLlamada(a.valor)) tocados.add(apiId);
      }
    }
  };

  mirar((regla as any).entonces);
  mirar((regla as any).sino);

  for (const tramo of (regla as any).sinoSi ?? []) mirar(tramo?.entonces);

  return [...tocados];
}

/**
 * Los campos por los que preguntan las condiciones de un flujo.
 *
 * No lo usa el motor: lo usan las pantallas para poder contar **qué valor leyó
 * de cada campo** cuando una regla no se dispara. Sin eso, la única salida es
 * adivinar si el problema es la condición, el valor o el tipo de campo.
 */
export function camposDeLasReglas(flujo: Flujo): string[] {
  const usados = new Set<string>();

  const mirar = (grupo: any): void => {
    for (const c of grupo?.cond ?? []) {
      if (c?.cond) {
        mirar(c);
        continue;
      }

      if (c?.campo) usados.add(String(c.campo));

      // También el campo contra el que compara: al contar qué leyó cada regla,
      // los dos lados de la comparación son lo que hay que enseñar.
      if (c?.valorCampo) usados.add(String(c.valorCampo));
      if (c?.valor2Campo) usados.add(String(c.valor2Campo));
    }
  };

  for (const regla of flujo?.reglas ?? []) {
    mirar((regla as any).si);

    for (const tramo of (regla as any).sinoSi ?? []) mirar(tramo?.si);
  }

  return [...usados];
}

/**
 * El valor con **la forma que ese campo guarda**.
 *
 * Una regla dice «pon "No enciende"», porque es lo que se eligió de una lista
 * de opciones al escribirla. Pero un radio no guarda un texto: guarda
 * `{id, txt}`, y una casilla guarda una lista de eso. Escribiendo el texto a
 * secas, el campo quedaba con algo que no sabe leer — no se marcaba ninguna
 * opción y, peor, cada evaluación lo daba por distinto de lo guardado y lo
 * volvía a escribir, así que el campo se rehacía sin parar.
 *
 * Devuelve `undefined` cuando el valor **no se puede escribir**: una regla que
 * nombra una opción que ya no existe. Se prefiere no tocar el campo a dejarlo
 * con una respuesta que no está entre sus opciones.
 */
export function comoLoGuarda(valor: unknown, campo?: Campo): unknown {
  const fty = (campo?.fty ?? '').toLowerCase();

  if (fty !== 'radio' && fty !== 'dropdownlist' && fty !== 'checkbox') return valor;

  const opciones = campo?.opt ?? [];
  const texto = comoTexto(valor);

  // Vacío es «sin responder», y cada tipo lo dice a su manera. Es lo que
  // escribe la acción de limpiar.
  if (!texto.trim()) return fty === 'checkbox' ? [] : {};

  const buscar = (uno: string): { id?: string; txt?: string } | undefined =>
    opciones.find(
      (o) =>
        normalizar(String(o.txt ?? ''), 'solo-valor') === normalizar(uno, 'solo-valor') ||
        String(o.id ?? '') === uno.trim() ||
        String(o.val ?? '') === uno.trim(),
    );

  if (fty === 'checkbox') {
    // Varias marcadas viajan separadas por coma, que es como las junta
    // `comoTexto` al leerlas.
    const marcadas = texto
      .split(',')
      .map((uno) => buscar(uno))
      .filter((o): o is { id?: string; txt?: string } => !!o)
      .map((o) => ({ id: o.id, txt: o.txt }));

    return marcadas.length ? marcadas : undefined;
  }

  const opcion = buscar(texto);

  return opcion ? { id: opcion.id, txt: opcion.txt } : undefined;
}

// ── Fórmulas ────────────────────────────────────────────────────────────────

/**
 * Calcula una fórmula escrita con los `apiId` del formulario.
 *
 * ## Por qué se escribe un evaluador en vez de usar `eval`
 *
 * Tres razones, y cualquiera bastaría:
 *
 * 1. **En Dart no existe `eval`.** El motor de la app tiene que dar el mismo
 *    resultado que este, y no puede si aquí se delega en el intérprete de
 *    JavaScript.
 * 2. **Es código que escribe un usuario** y que corre en el navegador de otro.
 *    Con `eval`, una fórmula es una vía para ejecutar lo que sea.
 * 3. Con un evaluador propio, lo que no se entiende **no calcula**, en vez de
 *    devolver `undefined` o `NaN` y escribirlo en la respuesta.
 *
 * Devuelve `null` cuando la fórmula no se puede calcular; quien llama decide,
 * y lo que decide es no tocar el campo.
 */
export function calcular(formula: string, valores: Record<ApiId, unknown>, campos: Record<ApiId, Campo>): number | null {
  const piezas = trocear(formula);
  if (!piezas) return null;

  const lector = (nombre: string): number => {
    const campo = campos[nombre];

    // Por `leerValor`, que es lo que hace que una formula pueda decir
    // `DETALLE:EQUIPOS:IMPORTE@suma` sin que el evaluador sepa nada de tablas.
    const texto = comoTexto(leerValor(nombre, valores, campos), campo);

    /*
     * Un campo vacío vale cero.
     *
     * Es lo que espera quien escribe `CANTIDAD * PRECIO` y todavía no ha
     * respondido ninguno de los dos: ver un cero mientras se llena, no un
     * hueco ni un error. Lo contrario —anular el cálculo entero— dejaría el
     * total en blanco hasta el último campo.
     */
    return aNumero(texto) ?? 0;
  };

  try {
    const lectura = new Lectura(piezas, lector);
    const valor = lectura.expresion();

    // Sobró algo: la fórmula está mal escrita y no se inventa un resultado.
    if (!lectura.terminada()) return null;

    return Number.isFinite(valor) ? valor : null;
  } catch {
    return null;
  }
}

/** Parte la fórmula en números, nombres, operadores y paréntesis. */
function trocear(formula: string): string[] | null {
  // Los dos puntos y la arroba entran en el nombre: `DETALLE:EQUIPOS:IMPORTE@suma`
  // es **un** identificador, y trocearlo dejaria una formula sin sentido.
  const piezas = (formula ?? '').match(/\d+\.?\d*|[A-Za-z_][A-Za-z0-9_:@]*|[+\-*/%(),]/g);
  if (!piezas) return null;

  // Lo que no encajó en ningún hueco es un carácter que no se entiende.
  const largo = piezas.join('').length;
  return largo === (formula ?? '').replace(/\s+/g, '').length ? piezas : null;
}

/** Las funciones que se pueden usar en una fórmula. */
const FUNCIONES: Record<string, (args: number[]) => number> = {
  abs: ([x]) => Math.abs(x),
  min: (a) => Math.min(...a),
  max: (a) => Math.max(...a),
  techo: ([x]) => Math.ceil(x),
  piso: ([x]) => Math.floor(x),
  redondear: ([x, n]) => {
    const d = Math.pow(10, Number.isFinite(n) ? n : 0);
    return Math.round(x * d) / d;
  },

  // ── Cuentas de varios campos a la vez ────────────────────────────────────
  //
  // Escribir `A + B + C + D` funciona, pero con seis o siete campos la fórmula
  // deja de leerse. Con nombre se entiende de un vistazo qué se está haciendo.
  suma: (a) => a.reduce((t, x) => t + x, 0),
  promedio: (a) => (a.length ? a.reduce((t, x) => t + x, 0) / a.length : 0),
  cuenta: (a) => a.filter((x) => x !== 0).length,

  // ── Porcentajes ──────────────────────────────────────────────────────────
  //
  // Se pueden escribir a mano —`PARTE / TOTAL * 100`— pero es donde más se
  // equivoca uno: se olvida el `* 100`, o se divide entre cero y la fórmula
  // entera se cae. Con nombre propio, además, el que lea la regla dentro de un
  // año sabe qué se quiso decir.
  porcentaje: ([parte, total]) => (!total ? 0 : (parte / total) * 100),

  /** `subir(1000, 19)` → 1190. El IVA, el recargo, el incremento pactado. */
  subir: ([x, n]) => (Number.isFinite(n) ? x * (1 + n / 100) : x),

  /** `bajar(1000, 10)` → 900. El descuento, la retención, la merma. */
  bajar: ([x, n]) => (Number.isFinite(n) ? x * (1 - n / 100) : x),

  /**
   * `parte(1000, 19)` → 190. Cuánto **es** ese porcentaje, no el resultado de
   * aplicarlo: es lo que hay que poner en la casilla del impuesto.
   */
  parte: ([x, n]) => (Number.isFinite(n) ? (x * n) / 100 : 0),

  // ── Y las de siempre ─────────────────────────────────────────────────────
  raiz: ([x]) => (x < 0 ? 0 : Math.sqrt(x)),
  potencia: ([x, n]) => (Number.isFinite(n) ? Math.pow(x, n) : x),
};

/**
 * La lectura de una fórmula, de izquierda a derecha y por precedencia.
 *
 * Descenso recursivo: `expresion` resuelve sumas y restas, `termino`
 * multiplicaciones y divisiones, y `factor` los números, los campos, los
 * paréntesis y el signo. Así `2 + 3 * 4` da 14 y no 20, sin tener que
 * escribir la tabla de precedencias en ningún sitio.
 */
class Lectura {
  private i = 0;

  constructor(
    private readonly piezas: string[],
    private readonly lector: (nombre: string) => number,
  ) {}

  terminada(): boolean {
    return this.i >= this.piezas.length;
  }

  private mira(): string | undefined {
    return this.piezas[this.i];
  }

  private come(que?: string): string {
    const pieza = this.piezas[this.i++];
    if (que !== undefined && pieza !== que) throw new Error('falta ' + que);
    return pieza;
  }

  expresion(): number {
    let valor = this.termino();

    while (this.mira() === '+' || this.mira() === '-') {
      valor = this.come() === '+' ? valor + this.termino() : valor - this.termino();
    }

    return valor;
  }

  private termino(): number {
    let valor = this.factor();

    while (this.mira() === '*' || this.mira() === '/' || this.mira() === '%') {
      const op = this.come();
      const otro = this.factor();

      // Dividir entre cero no es un resultado: es una fórmula que no se puede
      // calcular, y así lo dice el error que sube.
      if ((op === '/' || op === '%') && otro === 0) throw new Error('division por cero');

      valor = op === '*' ? valor * otro : op === '/' ? valor / otro : valor % otro;
    }

    return valor;
  }

  private factor(): number {
    const pieza = this.mira();
    if (pieza === undefined) throw new Error('formula incompleta');

    if (pieza === '-') { this.come(); return -this.factor(); }
    if (pieza === '+') { this.come(); return this.factor(); }

    if (pieza === '(') {
      this.come('(');
      const valor = this.expresion();
      this.come(')');
      return valor;
    }

    if (/^\d/.test(pieza)) return Number(this.come());

    const nombre = this.come();

    // Una función: `redondear(X, 2)`.
    if (this.mira() === '(') {
      const fn = FUNCIONES[nombre.toLowerCase()];
      if (!fn) throw new Error('funcion desconocida: ' + nombre);

      this.come('(');
      const args: number[] = [this.expresion()];

      while (this.mira() === ',') { this.come(','); args.push(this.expresion()); }
      this.come(')');

      return fn(args);
    }

    // Si no, es un campo del formulario.
    return this.lector(nombre);
  }
}

// ── Puntuaciones ────────────────────────────────────────────────────────────

/**
 * Puntúa un grupo de campos y devuelve el resultado, o `null`.
 *
 * ## Lo que resuelve, y por qué no vale una fórmula
 *
 * Una inspección de treinta preguntas con «Cumple / No cumple / No aplica» se
 * evalúa por el porcentaje de lo que cumple **sobre lo que aplicaba**. Con una
 * fórmula habría que escribir las treinta preguntas a mano y no habría forma de
 * sacar del total las que no aplican: contarían como cero y hundirían la nota
 * de un sitio que no tenía nada mal.
 *
 * Aquí las excluidas no cuentan ni arriba ni abajo, que es lo que hace que el
 * número signifique algo.
 *
 * Devuelve `null` cuando no queda ninguna pregunta que contar —todas sin
 * responder, o todas excluidas—: escribir un cero diría «cero puntos» cuando lo
 * cierto es «todavía nada que puntuar».
 */
/**
 * Puntúa lo que respondieron las filas de una tabla.
 *
 * Gemela de `puntuarTabla` en el motor de Dart. Devuelve `null` cuando no queda
 * nada que contar —ninguna fila respondió algo que esté en el cuadro de
 * puntos—: escribir un cero diría «cero puntos» cuando lo cierto es «todavía
 * nada que puntuar».
 */
export function puntuarTabla(
  config: Record<string, unknown>,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
): number | null {
  const nombreTabla = String(config['tabla'] ?? '').trim();
  const nombreCampo = String(config['campo'] ?? '').trim();

  if (!nombreTabla || !nombreCampo) return null;

  const tabla = campos[nombreTabla];
  const deDentro = campoDeDetalle(tabla, nombreCampo);
  const filas = filasDe(valores[nombreTabla]);

  if (!filas.length) return null;

  /*
   * Cuánto vale cada respuesta.
   *
   * Se compara ya normalizado —sin tildes, sin mayúsculas, sin espacios de
   * sobra— porque quien escribe la regla teclea la opción a mano y quien
   * responde la elige de una lista: pedir que coincidan carácter a carácter es
   * pedir que no funcione.
   */
  const puntos = new Map<string, number>();

  for (const entrada of (config['puntos'] as any[]) ?? []) {
    if (!entrada || typeof entrada !== 'object') continue;

    const texto = normalizar(String(entrada.txt ?? ''), 'solo-valor');
    const cuanto = aNumero(String(entrada.val ?? ''));

    if (texto && cuanto !== null) puntos.set(texto, cuanto);
  }

  if (!puntos.size) return null;

  const contadas: number[] = [];

  for (const fila of filas) {
    const respondido = valorDeFila(fila, nombreCampo, tabla);
    if (!tieneRespuesta(respondido)) continue;

    const cuanto = puntos.get(normalizar(comoTexto(respondido, deDentro), 'solo-valor'));

    // Una respuesta que no está en el cuadro no cuenta: es «no aplica».
    if (cuanto !== undefined) contadas.push(cuanto);
  }

  if (!contadas.length) return null;

  const total = contadas.reduce((a, b) => a + b, 0);

  switch (String(config['modo'] ?? 'suma')) {
    case 'promedio':
      return total / contadas.length;
    case 'maximo':
      return Math.max(...contadas);
    case 'minimo':
      return Math.min(...contadas);
    case 'cuenta':
      return contadas.length;

    /*
     * El porcentaje sobre lo máximo posible.
     *
     * Es lo que de verdad se pide en una inspección —«sacó el 85 %»— y a mano
     * obliga a saber cuánto vale la mejor opción y a rehacer la cuenta cada vez
     * que se añade una. Aquí sale del propio cuadro de puntos.
     */
    case 'porcentaje': {
      const mejor = Math.max(...puntos.values());
      if (mejor <= 0) return null;

      return (total / (mejor * contadas.length)) * 100;
    }
  }

  return total;
}

export function puntuar(
  config: Puntuacion,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
): number | null {
  if (!config?.campos?.length) return null;

  const tabla = new Map<string, number>();

  for (const [texto, puntos] of Object.entries(config.valores ?? {})) {
    tabla.set(normalizar(texto, 'solo-valor'), Number(puntos) || 0);
  }

  const fuera = new Set(
    (config.excluye ?? []).map((t) => normalizar(String(t), 'solo-valor')),
  );

  /*
   * De dónde salen los puntos de cada respuesta.
   *
   * Por omisión, del cuadro `valores` de la regla y de ningún otro sitio: es
   * como están escritas todas las puntuaciones que ya corren en producción, y
   * una respuesta que no figure en el cuadro no cuenta —eso es deliberado, no un
   * descuido—. Cambiarlo por las bravas le cambiaría la nota a flujos que llevan
   * meses funcionando.
   *
   * Con `segunOpcion`, además, las opciones que el cuadro no menciona valen lo
   * que ellas digan. Es lo que hace falta para promediar una encuesta de treinta
   * preguntas con las mismas cuatro opciones. Ver `puntosDeLaOpcion`.
   */
  const segunOpcion = config.segunOpcion === true;

  let suma = 0;
  let cuentan = 0;
  let excluidas = 0;

  for (const apiId of config.campos) {
    const campo = campos[apiId];
    const texto = comoTexto(valores[apiId], campo);
    const clave = normalizar(texto, 'solo-valor');

    // Sin responder no cuenta, pero tampoco es una exclusión: la pregunta
    // sigue estando y el promedio subirá o bajará cuando se conteste.
    if (!clave) continue;

    if (fuera.has(clave)) {
      excluidas++;
      continue;
    }

    /*
     * Una respuesta que no está en la tabla no cuenta.
     *
     * Es lo contrario de darle cero: cero es una nota, y esto es «no sé cuánto
     * vale». Si alguien escribe un texto libre donde se esperaba una opción, o
     * añade una opción nueva y olvida puntuarla, es mejor que no aparezca en el
     * promedio a que lo baje sin que nadie entienda por qué.
     */
    // El cuadro de la regla manda: es lo que alguien declaró a mano para esta
    // puntuación, y una opción no puede contradecirlo.
    const cuanto = tabla.has(clave)
      ? tabla.get(clave)!
      : (segunOpcion ? valorDeOpcion(campo, texto) : null);

    if (cuanto === null) continue;

    suma += cuanto;
    cuentan++;
  }

  if (config.modo === 'excluidas') return excluidas;
  if (config.modo === 'cuenta') return cuentan;

  if (!cuentan) return null;

  const decimales = Number.isFinite(config.decimales) ? Number(config.decimales) : 0;
  const redondear = (n: number) => {
    const d = Math.pow(10, decimales);
    return Math.round(n * d) / d;
  };

  if (config.modo === 'suma') return redondear(suma);
  if (config.modo === 'promedio') return redondear(suma / cuentan);

  // Porcentaje: lo obtenido sobre lo máximo posible en las que contaron. El
  // máximo sale de la propia tabla, así que no hay que declararlo aparte.
  const tope = topeDeLaPuntuacion(tabla, config.campos, campos, fuera, segunOpcion);
  if (!tope) return null;

  return redondear((suma / (cuentan * tope)) * 100);
}

/**
 * Cuánto vale la mejor respuesta posible, para poder sacar el porcentaje.
 *
 * Del cuadro de la regla, y con `segunOpcion` también de lo que valgan las
 * opciones de los campos puntuados: sin mirarlas, una puntuación que saca sus
 * números de las opciones no tendría tope y el porcentaje no se podría calcular
 * —que es justo lo que pasaba al no declarar el cuadro—.
 *
 * Las opciones excluidas no cuentan para el tope. «No aplica» no es la mejor
 * nota posible, y si alguien le puso un número, tomarlo como techo dejaría todo
 * el resto por debajo de lo que de verdad vale.
 */
function topeDeLaPuntuacion(
  tabla: Map<string, number>,
  listaCampos: ApiId[],
  campos: Record<ApiId, Campo>,
  fuera: Set<string>,
  segunOpcion: boolean,
): number {
  // Con el cuadro vacío, `Math.max()` da `-Infinity`, que no es «ningún tope»
  // sino un número con el que dividir da cero sin avisar.
  let tope = tabla.size ? Math.max(...tabla.values()) : 0;

  if (!segunOpcion) return tope;

  for (const apiId of listaCampos) {
    for (const o of campos[apiId]?.opt ?? []) {
      if (fuera.has(normalizar(String(o.txt ?? ''), 'solo-valor'))) continue;

      const n = puntosDeLaOpcion(o);
      if (n !== null && n > tope) tope = n;
    }
  }

  return tope;
}

// ── Gráficas ────────────────────────────────────────────────────────────────

/**
 * Las formas que sabe pintar una gráfica del flujo.
 *
 * Tres y no más, a propósito: son las que responden las tres preguntas que se
 * hacen sobre un formulario a medio llenar —cuánto hay de cada cosa (barras),
 * qué parte del total es cada cosa (circular) y cómo va evolucionando
 * (líneas)—. Cualquier otra se dibuja como barras antes que no dibujarse: una
 * errata en el tipo no debe dejar la pantalla en blanco.
 */
export const TIPOS_DE_GRAFICA = new Set(['barras', 'circular', 'lineas']);

/**
 * Cuánto vale una opción de un radio, de una casilla o de un desplegable.
 *
 * ## De dónde sale el número
 *
 * Una encuesta —«Malo, Regular, Bueno, Excelente»— se promedia si cada opción
 * vale un número, y ese número hay que sacarlo de algún sitio. Las opciones que
 * hay hoy guardan `id`, `txt` y a veces `val`, y **ninguna de las tres es un
 * peso**: `id` y `val` identifican y `txt` es lo que se lee. Así que se busca
 * por este orden, del más explícito al más cómodo:
 *
 * 1. **`puntos`**, si la opción lo trae. Es la clave que se declara para esto y
 *    la que ofrece el lienzo del diseñador. Es la única que no es una
 *    interpretación de otra cosa.
 * 2. **`val`**, si trae un número. Es opcional y está vacía en casi todos los
 *    formularios; donde alguien la puso con un número, era justamente para
 *    esto. Leerla no rompe nada porque el motor solo la usaba para reconocer
 *    una opción, y una opción que se llama «3» se sigue reconociendo igual.
 * 3. **el propio texto**, si es un número. Una escala de 1 a 5 se configura
 *    escribiendo «1», «2», «3»… y exigir que además se declare que el 3 vale 3
 *    es una ceremonia que nadie va a mantener.
 *
 * Sin número por ninguna de las tres, `null`: no es cero. Cero es una nota y
 * esto es «esta opción no dice cuánto vale», que es lo que hace que «No aplica»
 * salga del promedio en vez de hundirlo.
 */
export function puntosDeLaOpcion(
  opcion: { txt?: string; val?: string; puntos?: number | string },
): number | null {
  const declarado = aNumero(String(opcion.puntos ?? ''));
  if (declarado !== null) return declarado;

  const val = aNumero(String(opcion.val ?? ''));
  if (val !== null) return val;

  return aNumero(String(opcion.txt ?? ''));
}

/**
 * Cuánto vale lo que se respondió en un campo de opciones.
 *
 * Se busca la opción por su texto —normalizado, que es como se comparan todos
 * los textos aquí— y también por su `id`, porque hay respuestas guardadas que
 * solo llevan el identificador.
 */
export function valorDeOpcion(campo: Campo | undefined, texto: string): number | null {
  const opciones = campo?.opt ?? [];
  if (!opciones.length) return null;

  const buscado = normalizar(texto, 'solo-valor');
  if (!buscado) return null;

  for (const o of opciones) {
    const coincide = normalizar(String(o.txt ?? ''), 'solo-valor') === buscado
      || String(o.id ?? '') === texto.trim();

    if (coincide) return puntosDeLaOpcion(o);
  }

  return null;
}

/**
 * El número que aporta un campo a una serie de la gráfica.
 *
 * Con `segunOpcion` manda lo que vale la opción marcada; y si el campo no es de
 * opciones —o la suya no dice cuánto vale— se cae al número de la propia
 * respuesta, que es lo que permite mezclar en la misma gráfica preguntas de
 * escala y campos numéricos sin configurar nada aparte.
 */
function numeroDelCampo(
  apiId: ApiId,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
  segunOpcion: boolean,
): number | null {
  const leido = leerValor(apiId, valores, campos);

  // Sin responder no aporta. No suma cero: un cero es un dato y esto es un
  // hueco, y en un promedio la diferencia se ve.
  if (!tieneRespuesta(leido)) return null;

  const campo = campos[apiId];
  const texto = comoTexto(leido, campo);

  if (segunOpcion) {
    const punto = valorDeOpcion(campo, texto);
    if (punto !== null) return punto;
  }

  return aNumero(texto);
}

/**
 * Cuántos de estos campos cumplen la condición de la serie.
 *
 * La comparación es **la misma** que la de las condiciones de una regla: se le
 * arma a `comparar` una condición con lo que la serie trae —`cmp`, `valor`,
 * `valor2`, `texto`—. Así los comparadores que ya existen —«igual», «mayor»,
 * «contiene», «en-lista»— valen en una gráfica sin escribir ni una línea más, y
 * el día que se añada uno nuevo funcionará en los dos sitios a la vez.
 *
 * Un campo de una tabla se cuenta **fila a fila**: preguntarle a la tabla entera
 * no significa nada, igual que en una condición. Es lo que hace que «cuántos
 * equipos quedaron en Malo» pueda ser una barra.
 */
function cuantosCumplen(
  serie: SerieDeGrafica,
  lista: ApiId[],
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
): number {
  const cond = {
    campo: '',
    cmp: serie.cmp,
    valor: serie.valor,
    valor2: serie.valor2,
    texto: serie.texto,
  } as Condicion;

  let cuantos = 0;

  for (const apiId of lista) {
    const ref = referenciaDetalle(apiId);

    if (ref && !ref.agregado) {
      const tabla = campos[ref.tabla];
      const deDentro = campoDeDetalle(tabla, ref.campo);

      for (const fila of filasDe(valores[ref.tabla])) {
        if (comparar(cond, valorDeFila(fila, ref.campo, tabla), deDentro)) cuantos++;
      }

      continue;
    }

    if (comparar(cond, leerValor(apiId, valores, campos), campos[apiId])) cuantos++;
  }

  return cuantos;
}

/**
 * Qué se hace con los números de una serie.
 *
 * Se llaman igual que los agregados de una tabla —`suma`, `promedio`, `cuenta`,
 * `maximo`, `minimo`— y significan lo mismo. Dos vocabularios para la misma idea
 * es la forma segura de que quien configura tenga que aprenderla dos veces.
 *
 * **Sin nada respondido vale cero**, y aquí sí, al revés que en un agregado de
 * tabla. Un agregado escribe en un campo, y un cero diría «cero» cuando lo
 * cierto es «todavía nada»; una gráfica se mira, y una barra a ras de suelo dice
 * exactamente eso, mientras que un hueco en mitad de la serie rompe el dibujo y
 * no dice nada.
 */
function medidaDeLaSerie(modo: string, numeros: number[]): number {
  if (!numeros.length) return 0;

  switch (modo) {
    case 'promedio':
      return numeros.reduce((a, b) => a + b, 0) / numeros.length;
    case 'cuenta':
      return numeros.length;
    case 'maximo':
      return Math.max(...numeros);
    case 'minimo':
      return Math.min(...numeros);
    default:
      return numeros.reduce((a, b) => a + b, 0);
  }
}

/**
 * Los campos de los que se alimenta una serie.
 *
 * Se admite `campo` para uno solo y `campos` para varios porque una serie de un
 * campo es el caso corriente —«el voltaje»— y obligar a escribirlo como una
 * lista de uno se lee mal en el lienzo.
 */
function camposDeLaSerie(serie: SerieDeGrafica): ApiId[] {
  const lista: ApiId[] = [];

  const uno = String(serie.campo ?? '').trim();
  if (uno) lista.push(uno);

  for (const c of serie.campos ?? []) {
    const limpio = String(c ?? '').trim();
    if (limpio) lista.push(limpio);
  }

  return lista;
}

/**
 * Arma la gráfica que pide una regla, con los números ya contados.
 *
 * Gemela de `armarGrafica` en el motor de Dart.
 *
 * Cada dato sale de una de estas dos formas, que son las dos maneras de
 * preguntar por lo que se lleva respondido:
 *
 * - **Varios campos y una condición** — «de estas diez preguntas, cuántas
 *   quedaron en Cumple». La serie trae `campos` y un comparador, y el número es
 *   cuántos cumplen.
 * - **Unos campos y una medida** — «el promedio de las diez», «el voltaje». La
 *   serie trae `campos` sin comparador, y el número sale de sumarlos,
 *   promediarlos o quedarse con el mayor. Con `segunOpcion`, lo que vale cada
 *   respuesta lo dice su opción; ver `puntosDeLaOpcion`.
 *
 *     {"tipo":"barras","titulo":"Cumplimiento","series":[
 *       {"txt":"Cumple","campos":["P1","P2","P3"],
 *        "cmp":"igual","valor":"Cumple","color":"#2e7d32"},
 *       {"txt":"No cumple","campos":["P1","P2","P3"],
 *        "cmp":"igual","valor":"No cumple","color":"#c62828"}]}
 *
 * Devuelve `null` cuando no hay ni una serie que dibujar: una gráfica vacía
 * ocupa sitio y no dice nada, y es exactamente lo que deja una regla a medio
 * configurar.
 */
export function armarGrafica(
  config: Grafica,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
): GraficaPintada | null {
  let tipo = String(config.tipo ?? 'barras').toLowerCase();
  if (!TIPOS_DE_GRAFICA.has(tipo)) tipo = 'barras';

  // Puesto en la gráfica entera vale para todas sus series: una encuesta se
  // configura una vez, no pregunta por pregunta.
  const deTodas = config.segunOpcion === true;

  const datos: GraficaPintada['datos'] = [];

  for (const serie of config.series ?? []) {
    if (!serie || typeof serie !== 'object') continue;

    const lista = camposDeLaSerie(serie);

    // Una serie que no dice de dónde sale no se dibuja. Pintarla en cero diría
    // que la respuesta es cero, y lo cierto es que la regla está a medias.
    if (!lista.length) continue;

    let valor: number;

    if (serie.cmp) {
      // De una condición solo tiene sentido contar: cuántos la cumplen.
      valor = cuantosCumplen(serie, lista, valores, campos);
    } else {
      const segunOpcion = deTodas || serie.segunOpcion === true;

      const numeros: number[] = [];

      for (const apiId of lista) {
        const n = numeroDelCampo(apiId, valores, campos, segunOpcion);
        if (n !== null) numeros.push(n);
      }

      valor = medidaDeLaSerie(String(serie.medida ?? 'suma'), numeros);
    }

    const color = String(serie.color ?? '').trim();

    datos.push({ txt: String(serie.txt ?? ''), val: valor, ...(color ? { color } : {}) });
  }

  if (!datos.length) return null;

  const titulo = String(config.titulo ?? '').trim();
  const id = String(config.id ?? '').trim();

  /*
   * Lo que el tipo elegido ignora **no sale**.
   *
   * Una circular no tiene ejes y unas líneas no se tumban. Dejar pasar lo
   * configurado y que cada plataforma decidiera si aplica sería la misma
   * decisión tomada en tres sitios, y con tres resultados posibles el día que
   * una se despiste. Aquí se decide una vez y quien pinta dibuja lo que hay.
   */
  const conEjes = tipo !== 'circular';

  const ejeX = conEjes ? String(config.ejeX ?? '').trim() : '';
  const ejeY = conEjes ? String(config.ejeY ?? '').trim() : '';

  /*
   * Y la orientación solo cuando no es la de siempre.
   *
   * `horizontal` es lo que dibujan hoy el navegador y el teléfono, así que
   * anotarla sería anotar «como estaba» en todas las gráficas que ya existen.
   * Solo se dice lo que hay que cambiar, igual que en el resto del resultado.
   */
  const orientacion =
    tipo === 'barras' && String(config.orientacion ?? '') === 'vertical' ? 'vertical' : '';

  return {
    tipo: tipo as GraficaPintada['tipo'],
    ...(titulo ? { titulo } : {}),
    ...(id ? { id } : {}),

    // Sin nombre nadie podría destaparla: escondida se quedaría para siempre, y
    // desde fuera eso se lee igual que una regla que no se dispara.
    ...(id && config.oculta === true ? { oculta: true } : {}),
    ...(ejeX ? { ejeX } : {}),
    ...(ejeY ? { ejeY } : {}),
    ...(orientacion ? { orientacion: orientacion as Orientacion } : {}),
    datos,
  };
}

// ── Botones ─────────────────────────────────────────────────────────────────

/**
 * El botón que pide una regla, ya decidido si se ve y si se pulsa.
 *
 * Gemela de `armarBoton` en el motor de Dart.
 *
 * Devuelve `null` cuando **no hay que dibujarlo**: sin título, apagado a
 * propósito, o con una condición que ahora mismo no se cumple. Que la decisión
 * la tome el motor y no quien pinta es lo mismo de siempre: la condición se
 * escribe una vez y se responde igual en el navegador, en el teléfono y en el
 * simulador.
 *
 *     {"titulo":"Ver el resumen","estado":"si-cumple",
 *      "si":{"op":"y","cond":[{"campo":"TIPO","cmp":"igual","valor":"Cierre"}]},
 *      "hace":[{"que":"mostrar-graficas","graficas":["resumen"]}]}
 */
export function armarBoton(
  config: BotonDeAccion,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
  ahora = '',
  regla = '',
  urlDeBinarios = '',

  /** Lo decidido en esta pasada. Ver `pushDeFlujo` para por qué va al final. */
  decididos: Record<ApiId, EstadoCampo> = {},
): BotonPintado | null {
  const titulo = String(config.titulo ?? '').trim();

  // Un botón sin nada escrito dentro no se puede pulsar a ciegas: es una acción
  // a medio configurar, y dibujar un rectángulo en blanco lo esconde en vez de
  // delatarlo.
  if (!titulo) return null;

  const estado = String(config.estado ?? 'siempre');

  if (estado === 'oculto') return null;
  if (estado === 'si-cumple' && !evaluarGrupo(config.si, valores, campos)) return null;

  const graficas: string[] = [];

  /*
   * Por que su correo no puede salir, si es que no puede.
   *
   * Se junta aqui y viaja con el boton para que la pantalla no tenga que
   * recalcular nada: pulsarlo con esto lleno tiene que decir el motivo en vez
   * de no hacer nada, y quedarse apagado en cuanto alguien borre el dato del
   * que dependia.
   */
  const problemas: string[] = [];
  const correos: CorreoPedido[] = [];
  const pushes: PushPedido[] = [];
  const animaciones: Animacion[] = [];
  const llamadas: LlamadaPintada[] = [];

  let puntua: { campo: ApiId; valor: number } | undefined;
  const pendientes: ('correo' | 'push')[] = [];

  for (const hace of config.hace ?? []) {
    if (!hace || typeof hace !== 'object') continue;

    switch (String(hace.que ?? '')) {
      case 'mostrar-graficas':
        for (const g of hace.graficas ?? []) {
          const nombre = String(g ?? '').trim();
          if (nombre && !graficas.includes(nombre)) graficas.push(nombre);
        }
        break;

      /*
       * Las caritas, con la misma normalizacion que en una regla.
       *
       * `armarAnimacion` pone los topes —cuantas figuras y cuantos segundos— en
       * un solo sitio: son objetos moviendose en un telefono, y dos limites
       * distintos segun quien lance la lluvia acabarian separandose.
       */
      case 'animar': {
        const animacion = armarAnimacion(hace.animacion);

        // Sin repetir, comparando sin la regla: dos acciones que lanzan la misma
        // lluvia quieren una lluvia, no dos superpuestas. Igual que en `aplicar`.
        const yaEsta = animaciones.some(
          (a) => JSON.stringify({ ...a, regla: undefined }) ===
            JSON.stringify({ ...animacion, regla: undefined }),
        );

        if (!yaEsta) animaciones.push({ ...animacion, regla });

        break;
      }

      /*
       * La nota, calculada al armar el boton.
       *
       * Y no al pulsarlo, porque en el momento del toque no hay ninguna
       * evaluacion corriendo: quien pulsa esta en una pantalla. Como el boton se
       * rearma con cada cambio, la nota que lleva es siempre la de las
       * respuestas de ahora.
       *
       * Lo que no se puede calcular **no toca el campo**, igual que una formula
       * o que la accion `puntuar` de una regla: escribir un vacio borraria lo
       * que ya hubiera.
       */
      /*
       * Llamar a un servicio desde el boton.
       *
       * Se arma con `armarLlamada`, la misma que usa la accion de una regla:
       * asi el estado, la respuesta, el `alResponder` y el reintento son los de
       * siempre y no hay una segunda maquinaria que mantener.
       *
       * El `disparo` se fuerza a `boton` mire lo que mire la configuracion: la
       * dispara este boton, y dejar `cambio` la lanzaria sola ademas de al
       * pulsar — dos veces la misma consulta, y quien la pidio sin saber por
       * que salio antes de tocar nada.
       */
      case 'llamar-servicio': {
        if (!hace.servicio) break;

        const llamada = armarLlamada(
          { ...hace.servicio, disparo: 'boton' },
          valores,
          campos,
          regla,
          urlDeBinarios,
        );

        if (!llamada) break;

        // Sin repetir: dos acciones que llaman al mismo sitio con lo mismo son
        // una llamada, no dos. Es la misma llave con la que se reconoce fuera.
        if (!llamadas.some((otra) => otra.llave === llamada.llave)) {
          llamadas.push(llamada);
        }

        break;
      }

      case 'puntuar': {
        const destino = String(hace.campo ?? '').trim();
        if (!destino || !hace.puntuacion) break;

        const nota = puntuar(hace.puntuacion, valores, campos);
        if (nota === null) break;

        puntua = { campo: destino, valor: nota };

        break;
      }

      /*
       * El correo, ya escrito.
       *
       * Se resuelve aquí y no al pulsar por lo mismo que en una regla: quien
       * pinta el botón no sabe leer un formulario. Lo que hace al pulsarlo es
       * apuntar en la cola lo que ya viene resuelto.
       *
       * Uno que no llega a ser correo —sin destinatario, o sin nada que decir—
       * vuelve a la lista de pendientes: el botón sigue prometiendo un correo y
       * hay que decir que no va a salir, que es justo lo que pasaba antes con
       * todos.
       */
      case 'enviar-correo': {
        const correo = correoDeFlujo(
          correoDeBoton(hace),
          valores,
          campos,
          ahora,
          'boton',
          regla,

          /*
           * `urlDeBinarios` faltaba aquí, y era un fallo de verdad.
           *
           * Es el último parámetro y tiene valor por omisión, así que omitirlo
           * no da error: entra como cadena vacía. Y con la base vacía,
           * `{FOTO.url}` devuelve '' — o sea que la foto salía **en los correos
           * de regla y no en los de botón**, con la misma configuración escrita.
           *
           * De los que no se descubren probando: el correo llega, el texto está
           * bien, y lo único que falta es la imagen que nadie mira hasta que
           * hace falta. Los tres motores tenían el mismo despiste.
           */
          urlDeBinarios,
        );

        /*
         * Las direcciones mal escritas se dicen **siempre**, salga o no el correo.
         *
         * Antes solo se miraban cuando el correo no podia salir del todo, y ahi
         * habia un caso que se colaba en silencio: con una direccion buena y una
         * mala, la mala se descartaba, el correo salia a la buena y nadie se
         * enteraba de que faltaba un destinatario. Justo el aviso que hay que
         * dar, porque quien tecleo la mala la tiene delante.
         */
        for (const mala of correosMalEscritosDelBoton(hace, valores, campos)) {
          const motivo = `«${mala}» no es un correo válido.`;

          if (!problemas.includes(motivo)) problemas.push(motivo);
        }

        if (correo) {
          if (!correos.some((c) => c.llave === correo.llave)) correos.push(correo);
        } else {
          // Sin correo que mandar hay siempre un motivo, y decirlo es la
          // diferencia entre un boton roto y uno que explica que le falta.
          for (const uno of problemasDelCorreo(correoDeBoton(hace), valores, campos)) {
            if (!problemas.includes(uno)) problemas.push(uno);
          }

          if (!pendientes.includes('correo')) pendientes.push('correo');
        }

        break;
      }

      /*
       * El aviso del botón. Gemelo del correo de arriba, hasta en el reparto:
       * si sale, se apunta; si no, se dice por qué.
       *
       * Antes esto solo anotaba `'push'` como pendiente —se configuraba, se
       * guardaba, y el formulario confesaba que no lo mandaba—. Ahora se arma
       * de verdad, y `pendientes` se queda vacío salvo que no haya aviso que
       * armar.
       */
      case 'enviar-push': {
        const push = pushDeFlujo(
          pushDeBoton(hace),
          valores,
          campos,
          ahora,
          'boton',
          regla,
          urlDeBinarios,
          decididos,
        );

        if (push) {
          if (!pushes.some((p) => p.llave === push.llave)) pushes.push(push);
        } else {
          /*
           * Sin aviso que mandar hay siempre un motivo, y decirlo es la
           * diferencia entre un botón roto y uno que explica qué le falta.
           *
           * Y se sigue anotando como pendiente: el botón prometió avisar y no
           * va a hacerlo, así que tiene que confesarlo. Es el mismo trato que
           * recibe el correo cuando no puede salir.
           */
          for (const uno of problemasDelPush(pushDeBoton(hace), valores, campos)) {
            if (!problemas.includes(uno)) problemas.push(uno);
          }

          if (!pendientes.includes('push')) pendientes.push('push');
        }

        break;
      }
    }
  }

  /*
   * Dónde se dibuja.
   *
   * Sin campo va debajo de todos, que es el caso corriente y por eso el de por
   * omisión. `donde` solo se anota cuando vale `antes`: lo de siempre no se
   * dice, igual que con la orientación de una gráfica.
   */
  const campo = String(config.campo ?? '').trim();
  const antes = campo && String(config.donde ?? '') === 'antes';

  return {
    titulo,
    ...(regla ? { regla } : {}),
    ...(llamadas.length ? { llamadas } : {}),
    ...(campo ? { campo } : {}),
    ...(antes ? { donde: 'antes' as LadoDelCampo } : {}),
    ...(estado === 'solo-lectura' ? { soloLectura: true } : {}),
    graficas,

    // Solo cuando hay alguno, igual que el lado del campo: lo de siempre no se
    // anota, y la inmensa mayoría de los botones no mandan ningún correo.
    ...(correos.length ? { correos } : {}),
    ...(pushes.length ? { pushes } : {}),
    ...(animaciones.length ? { animaciones } : {}),
    ...(puntua ? { puntua } : {}),
    pendientes,
    ...(problemas.length ? { problemas } : {}),
  };
}

// ── Llamadas a un servicio externo ──────────────────────────────────────────

/**
 * Un paso de la ruta es **un índice** solo si son dígitos y nada más.
 *
 * Es la trampa que ya mordió dos veces, y aquí vuelve a estar: `parseInt('5.7')`
 * devuelve 5 en el navegador y `int.tryParse('5.7')` devuelve nulo en el
 * teléfono. Con esta comprobación delante, los dos dicen lo mismo —«esto no es
 * un índice»— y la ruta no se resuelve en ninguno de los dos, que es la
 * respuesta correcta: `saldos.5.7` no nombra nada.
 */
const ES_INDICE = /^\d+$/;

/**
 * El paso que dice «todos los elementos de esta lista».
 *
 * Se escribe `[*]` en la ruta y aquí se anda como un paso más. Un asterisco no
 * es una clave de ningún JSON de verdad, así que no puede chocar con una — es la
 * misma razón por la que `DETALLE:` lleva dos puntos.
 */
const TODOS = '*';

/**
 * Lo que se le puede pedir a una lista de valores, además de la lista.
 *
 * **Son las palabras que ya existen**: las mismas cinco que usan las series de
 * una gráfica y los agregados de una tabla de detalle, y significan exactamente
 * lo mismo. Dos vocabularios para la misma idea es la forma segura de que quien
 * configura tenga que aprenderla dos veces.
 *
 * Las de tabla que no están —`filas`, `completas`, `amedias`— es porque
 * preguntan por filas diligenciadas, y en la respuesta de un servicio no hay
 * nadie que diligencie nada.
 */
export const AGREGADOS_DE_RESPUESTA = new Set([
  'suma',
  'promedio',
  'cuenta',
  'maximo',
  'minimo',
]);

/** Una ruta ya separada de lo que se le pide. */
export interface RutaConAgregado {
  ruta: string;
  /** `suma`, `promedio`, `cuenta`, `maximo`, `minimo`; vacío si no hay. */
  agregado: string;
}

/**
 * Desarma `items[*].importe@suma`.
 *
 * Se escribe pegado con arroba por lo mismo que en una tabla —
 * `DETALLE:EQUIPOS:IMPORTE@suma`—: así el agregado es **un identificador más** y
 * todo lo que ya sabe leer rutas lo entiende sin cambiar nada.
 *
 * Una arroba que no nombra un agregado conocido **no se toca**: puede formar
 * parte de la ruta —un correo dentro de la respuesta, por ejemplo— y quedarse
 * sin dato es peor que ignorar el sufijo. Es la misma norma que en
 * `referenciaDetalle`.
 */
export function partirLaRuta(crudo: string): RutaConAgregado {
  const texto = String(crudo ?? '');
  const arroba = texto.lastIndexOf('@');

  if (arroba < 0) return { ruta: texto, agregado: '' };

  const pedido = texto.slice(arroba + 1).toLowerCase();

  if (!AGREGADOS_DE_RESPUESTA.has(pedido)) return { ruta: texto, agregado: '' };

  return { ruta: texto.slice(0, arroba), agregado: pedido };
}

/**
 * Los pasos de una ruta dentro de una respuesta.
 *
 * `cliente.nombre` son dos; `saldos[0].valor` son tres —el corchete se pasa a
 * punto antes de partir, para que haya una sola forma de andar la ruta y no dos
 * que puedan discrepar—. Los espacios de los extremos se quitan: quien escribe
 * `cliente. nombre` en el lienzo quiere lo mismo que quien escribe
 * `cliente.nombre`, y una ruta que falla por un espacio es una tarde perdida.
 */
export function pasosDeLaRuta(ruta: string): string[] {
  return String(ruta ?? '')
    .replace(/\[(\d+)\]/g, '.$1')

    // `items[*]` es «todos los elementos». Se pasa a punto igual que un índice
    // para que haya **una** forma de andar la ruta y no dos que discrepen.
    .replace(/\[\*\]/g, `.${TODOS}`)
    .split('.')
    .map((paso) => paso.trim())
    .filter((paso) => paso !== '');
}

/**
 * El dato que una ruta nombra dentro de la respuesta de un servicio.
 *
 * Gemela de `leerRuta` en el motor de Dart, y el sitio donde más fácil es que
 * los dos dejen de coincidir: son dos lenguajes leyendo el mismo JSON con dos
 * ideas distintas de lo que es un número y de lo que es un índice. Por eso cada
 * regla de aquí abajo tiene su caso en la batería.
 *
 * Las reglas, en orden:
 *
 * 1. **Una ruta vacía es la respuesta entera.** Es lo que se quiere cuando el
 *    servicio devuelve un número o un texto a secas.
 * 2. **En una lista solo se entra por índice**, y un índice es una ristra de
 *    dígitos. Fuera de rango, `null`.
 * 3. **En un objeto solo se entra por clave**, aunque la clave sean dígitos:
 *    `{"1":"uno"}` se lee por `1` como clave y no como posición.
 * 4. **Lo que no está, `null`.** No es lo mismo que estar en blanco: `null`
 *    quiere decir que ese dato no vino, y entonces el campo **no se toca**.
 */
export function leerRuta(datos: unknown, ruta: string): unknown {
  let nodo: unknown = datos;

  const pasos = pasosDeLaRuta(ruta);

  for (let i = 0; i < pasos.length; i++) {
    const paso = pasos[i];

    /*
     * `*` abre la lista entera: lo que queda de ruta se lee **en cada
     * elemento** y sale una lista de respuestas.
     *
     * Es lo que hace falta para llevarse «el importe de todas las líneas» en vez
     * del de la primera. Lo que no resuelve en un elemento no ocupa sitio: una
     * línea sin importe no cuenta, igual que una fila sin responder no hunde el
     * promedio de una tabla.
     *
     * Con dos `*` seguidos el resultado se aplana, que es lo que espera quien
     * pide un total: una suma de listas de listas no significa nada.
     */
    if (paso === TODOS) {
      if (!Array.isArray(nodo)) return null;

      const resto = pasos.slice(i + 1).join('.');
      const salida: unknown[] = [];

      for (const uno of nodo) {
        const suyo = resto ? leerRuta(uno, resto) : uno;

        if (suyo === null || suyo === undefined) continue;

        if (Array.isArray(suyo)) salida.push(...suyo);
        else salida.push(suyo);
      }

      return salida;
    }

    // El arreglo va antes que el objeto porque en JavaScript también es uno, y
    // cayendo en la rama del objeto se leería `0` como clave.
    if (Array.isArray(nodo)) {
      if (!ES_INDICE.test(paso)) return null;

      const i = Number(paso);
      if (i >= nodo.length) return null;

      nodo = nodo[i];
      continue;
    }

    if (nodo !== null && typeof nodo === 'object') {
      const mapa = nodo as Record<string, unknown>;
      if (!(paso in mapa)) return null;

      nodo = mapa[paso];
      continue;
    }

    // Se pide algo de dentro de un número o de un texto: no hay dentro.
    return null;
  }

  return nodo;
}

/**
 * El dato que pide una ruta, con su agregado ya resuelto si lo lleva.
 *
 * Es lo que usa la acción, y lo que tiene que usar cualquiera que quiera saber
 * **qué va a acabar en el campo**: `leerRuta` a secas devuelve la lista, y quien
 * escribió `@suma` no quiere la lista sino el total.
 *
 * Gemela de `datoDeLaRuta` en el motor de Dart.
 *
 *     titular.nombre          → «Ana Pérez»
 *     items[*].nombre         → ["Tornillo", "Tuerca"]  (y se escribe «Tornillo, Tuerca»)
 *     items[*].importe@suma   → 4500
 *     items[*]@cuenta         → 2
 *
 * Un agregado sobre algo que no es una lista se responde igual, tratándolo como
 * una lista de uno: `total@suma` sobre un número es ese número, que es lo menos
 * sorprendente. Lo que no se puede sumar —textos— devuelve `null`, y entonces el
 * campo **no se toca**.
 */
export function datoDeLaRuta(datos: unknown, ruta: string): unknown {
  const { ruta: camino, agregado } = partirLaRuta(ruta);

  const leido = leerRuta(datos, camino);
  if (!agregado) return leido;

  if (leido === null || leido === undefined) return null;

  const lista = Array.isArray(leido) ? leido : [leido];

  const numeros: number[] = [];

  for (const uno of lista) {
    /*
     * Se pasa por `textoDeLaRespuesta` y no por `comoTexto`.
     *
     * Aquí lo que hay es JSON crudo, y `comoTexto` lee respuestas de Visitrack:
     * de un `5.0` sacaría «5» en el navegador y «5.0» en el teléfono, que es
     * justo la diferencia que este archivo existe para evitar.
     */
    const texto = textoDeLaRespuesta(uno);
    if (texto === null) continue;

    const n = aNumero(texto);
    if (n !== null) numeros.push(n);
  }

  // Por la misma cuenta que un agregado de tabla: la aritmética vive en un solo
  // sitio, o un día `@suma` sumaría distinto según de dónde saliera la lista.
  return cuentaDeNumeros(agregado, numeros, lista.length);
}

/**
 * Un número de la respuesta, escrito igual aquí que en el teléfono.
 *
 * `5.0` en un JSON es un entero para el navegador —`String(5.0)` da `'5'`— y un
 * decimal para Dart, donde `5.0.toString()` da `'5.0'`. Escribir eso en un
 * campo numérico deja «5» en el navegador y «5.0» en el teléfono: el mismo
 * servicio, el mismo dato y dos respuestas distintas guardadas. El gemelo de
 * Dart le quita los decimales de más; aquí no hay nada que quitar, y la función
 * existe igual para que se vea que la decisión se tomó en los dos sitios.
 */
function numeroDeLaRespuesta(n: number): string {
  return String(n);
}

/**
 * Lo que un dato de la respuesta deja escrito en un campo, o `null`.
 *
 * `null` significa **no tocar el campo**, igual que una fórmula que no se puede
 * calcular: es lo que hay que hacer con un dato que no vino, porque escribir un
 * vacío borraría lo que ya hubiera contestado alguien.
 *
 * Lo que sí se escribe:
 *
 * - un texto, tal cual —y el vacío también: un servicio que responde «ninguno»
 *   está respondiendo, y limpiar el campo es lo correcto;
 * - un número, sin decimales de más. Ver [numeroDeLaRespuesta];
 * - un sí o un no, como `true` o `false`;
 * - **una lista de cosas sueltas**, unidas por coma. Es exactamente lo que lee
 *   `comoTexto` de unas casillas marcadas, así que una respuesta como
 *   `["Avería","Ruido"]` marca las dos sin que haya que configurar nada.
 *
 * Un objeto no se escribe, y una lista con objetos dentro tampoco: un campo
 * guarda una respuesta, no una estructura. Se deja el campo como estaba y el
 * lienzo lo avisa al configurarlo, que es cuando se puede arreglar.
 */
export function textoDeLaRespuesta(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;

  if (typeof valor === 'boolean') return valor ? 'true' : 'false';

  if (typeof valor === 'number') {
    return Number.isFinite(valor) ? numeroDeLaRespuesta(valor) : null;
  }

  if (typeof valor === 'string') return valor;

  if (Array.isArray(valor)) {
    const textos: string[] = [];

    for (const uno of valor) {
      const texto = textoDeLaRespuesta(uno);

      // Con una sola cosa que no se pueda escribir, no se escribe nada: media
      // lista es peor que ninguna, porque parece completa.
      if (texto === null || (uno !== null && typeof uno === 'object')) return null;

      textos.push(texto);
    }

    return textos.join(', ');
  }

  return null;
}

/**
 * Con qué se reconoce una llamada entre una evaluación y la siguiente.
 *
 * ## Es lo que pide, no cuándo se pidió
 *
 * Y aquí está lo que impide el bucle. Una regla que se dispara al cambiar un
 * campo y cuya respuesta **escribe** un campo podría volver a dispararse con su
 * propia escritura: el motor reevalúa en cada tecla, y cada evaluación pediría
 * otra llamada. Con llamadas de red eso no es una molestia, es un teléfono
 * marcando sin parar desde el campo.
 *
 * Nombrando la llamada por el identificador de la integración **más sus
 * entradas ya resueltas**, la segunda evaluación pide exactamente la misma
 * llamada: quien ejecuta ya tiene esa llave respondida, así que no marca otra
 * vez, y el motor —que ve la respuesta inyectada— deja de pedirla y se limita a
 * escribir lo mismo que escribió antes. El estado se queda quieto y las pasadas
 * terminan solas.
 *
 * Una llamada nueva sale **solo cuando cambia lo que se le pregunta**, que es
 * justo cuando tiene sentido volver a preguntar.
 *
 * Las claves se ordenan para que el mismo juego de entradas dé la misma llave
 * escrito en el orden que sea, y en los dos lenguajes: ordenar cadenas compara
 * unidades de código en los dos, así que no hay dónde discrepar.
 */
export function llaveDeLlamada(id: string, entradas: Record<string, string>): string {
  const partes = Object.keys(entradas)
    .sort()
    .map((clave) => `${clave}=${entradas[clave]}`);

  return [id, ...partes].join('|');
}

/** Lo que se le manda al servicio, ya leído del formulario. */
function entradasDeLaLlamada(
  config: LlamadaAServicio,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
  urlDeBinarios = '',
): Record<string, string> {
  const salida: Record<string, string> = {};

  for (const entrada of config.entradas ?? []) {
    if (!entrada || typeof entrada !== 'object') continue;

    const clave = String(entrada.clave ?? '').trim();
    if (!clave) continue;

    const de = String(entrada.de ?? '').trim();

    // Con las dos escritas manda `de`, igual que al heredar campos en una
    // actividad nueva: pedir un campo concreto es más específico que dejar una
    // constante, y la constante que sobrevive al lado suele ser el resto de lo
    // que había antes de cambiar de modo en el lienzo.
    /*
     * Un campo de archivo manda **su direccion**, no su identificador.
     *
     * Lo que guarda una foto o una firma es el GUID de su binario, y eso no le
     * sirve a nadie de fuera: un servicio no puede hacer nada con un
     * identificador de nuestra base. Lo que puede usar es la direccion, que es
     * la misma que ya viaja en un correo con `{FOTO.url}`.
     *
     * Sin esto, apuntar una entrada a un campo de fotografia mandaba el GUID
     * pelado y el servicio contestaba que eso no es una imagen — con un error
     * que hablaba de la imagen y no de que le hubieramos mandado otra cosa.
     */
    const suDireccion =
      de && esDeArchivo(campos[de]?.fty)
        ? valorDelSufijo(de, 'url', valores, campos, urlDeBinarios)
        : '';

    salida[clave] = suDireccion
      ? suDireccion
      : de
        ? comoTexto(leerValor(de, valores, campos), campos[de])
        : comoTextoLlano(entrada.valor);
  }

  return salida;
}

/**
 * Las entradas que salen de un campo y **todavía no tienen respuesta**.
 *
 * Sin ellas no se llama. No es prudencia de más: la llamada típica sale al
 * cambiar un campo —«al escribir la cédula, tráete el nombre»— y sin esto
 * saldría una llamada por cada letra tecleada, todas con la cédula a medias y
 * todas fallando. Se dice con palabras qué falta, que es lo que convierte un
 * botón que no hace nada en un botón que explica por qué todavía no.
 *
 * Una constante en blanco no cuenta: dejarla vacía es una decisión de quien
 * configuró la regla, no un campo sin responder.
 */
function loQueFaltaParaLlamar(
  config: LlamadaAServicio,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
): string[] {
  const faltan: string[] = [];

  for (const entrada of config.entradas ?? []) {
    if (!entrada || typeof entrada !== 'object') continue;

    const clave = String(entrada.clave ?? '').trim();
    const de = String(entrada.de ?? '').trim();

    if (!clave || !de) continue;

    if (!tieneRespuesta(leerValor(de, valores, campos)) && !faltan.includes(de)) {
      faltan.push(de);
    }
  }

  return faltan;
}

/**
 * La llamada que pide una regla, con todo resuelto y su estado a la vista.
 *
 * Gemela de `armarLlamada` en el motor de Dart.
 *
 * El estado sale de lo que haya inyectado bajo `INTEGRACION:<llave>` —ver
 * [PREFIJO_INTEGRACION]— y de nada más. El motor no llama a nadie: mira lo que
 * le entra por `valores`, igual que mira el estado de la actividad, y por eso
 * la batería puede probar una regla con la respuesta enlatada.
 *
 * Devuelve `null` cuando **no hay ninguna llamada que describir**: una regla a
 * la que no se le eligió integración. Callarla es mejor que anotar un encargo
 * que quien lo ejecute tendría que descartar sin poder explicar de dónde salió.
 *
 *     {"id":"padron","titulo":"Traer el titular","disparo":"cambio",
 *      "entradas":[{"clave":"documento","de":"CEDULA"}],
 *      "salidas":[{"campo":"NOMBRE","ruta":"titular.nombre"}]}
 */
export function armarLlamada(
  config: LlamadaAServicio,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
  regla = '',

  /** Con que se arma la direccion de un archivo. Ver `entradasDeLaLlamada`. */
  urlDeBinarios = '',
): LlamadaPintada | null {
  const integracion = String(config.id ?? '').trim();
  if (!integracion) return null;

  // Sin título se la nombra por su identificador. Es feo, y es mucho mejor que
  // un «esperando la integración» que no dice cuál.
  const titulo = String(config.titulo ?? '').trim() || integracion;

  const disparo: DisparoDeLlamada =
    String(config.disparo ?? 'boton') === 'cambio' ? 'cambio' : 'boton';

  const modo: ModoDeLlamada =
    String(config.modo ?? 'sincrona') === 'asincrona' ? 'asincrona' : 'sincrona';

  // Por el mismo `entre` que las caritas, y por el mismo motivo: exige un
  // entero entero, que es lo único que Dart y el navegador leen igual.
  const segundos = entre(config.segundos, SEGUNDOS_DE_LLAMADA, TOPE_DE_SEGUNDOS_DE_LLAMADA);

  const entradas = entradasDeLaLlamada(config, valores, campos, urlDeBinarios);
  const llave = llaveDeLlamada(integracion, entradas);

  // Dónde va el botón, si es de los que se pulsan. Se lee igual que en
  // `armarBoton`, y lo de siempre —debajo de todos, después del campo— no se
  // anota.
  const campo = String(config.campo ?? '').trim();
  const antes = campo !== '' && String(config.donde ?? '') === 'antes';

  const base = {
    llave,
    integracion,
    titulo,
    disparo,
    modo,
    segundos,
    entradas,
    ...(campo ? { campo } : {}),
    ...(antes ? { donde: 'antes' as LadoDelCampo } : {}),
    regla,
  };

  const faltan = loQueFaltaParaLlamar(config, valores, campos);

  if (faltan.length) {
    return {
      ...base,
      estado: 'falta',
      mensaje: `Falta por responder: ${faltan.join(', ')}`,
    };
  }

  const respuesta = leerJson(valores[PREFIJO_INTEGRACION + llave]);

  switch (String(respuesta?.['estado'] ?? '')) {
    case 'vuelo':
      return { ...base, estado: 'vuelo' };

    case 'ok':
      return { ...base, estado: 'ok' };

    case 'error':
      return {
        ...base,
        estado: 'error',

        // El contrato dice que `mensaje` es texto en español ya redactado para
        // enseñárselo a quien está diligenciando. Se deja pasar **tal cual**:
        // reescribirlo aquí daría dos redacciones distintas para el mismo fallo,
        // que es justo lo que confunde. Solo se pone algo cuando viene en
        // blanco, porque un fallo mudo es indistinguible de una app rota.
        mensaje: String(respuesta?.['mensaje'] ?? '').trim() || 'El servicio no pudo responder',

        // Y el código, para poder decidir: reintentar tiene sentido con un
        // «servicio-caido» y ninguno con un «no-encontrado».
        ...(String(respuesta?.['codigo'] ?? '').trim()
          ? { codigo: String(respuesta?.['codigo']).trim() }
          : {}),
        ...(respuesta?.['reintentable'] === true ? { reintentable: true } : {}),
      };
  }

  return { ...base, estado: 'pendiente' };
}

/**
 * Los campos que llena una llamada, sin llegar a resolverla.
 *
 * Hace falta en dos sitios que no tienen valores delante: para saber qué campos
 * quedan «recién cambiados» cuando una respuesta los escribe —y que se
 * disparen sus propias reglas, como con `poner-valor`— y para que quien guarda
 * lo decidido por momento sepa de qué campos habla esta regla.
 */
export function camposQueLlenaLaLlamada(valor: unknown): ApiId[] {
  const config = leerJson(valor) as LlamadaAServicio | null;
  const salida: ApiId[] = [];

  const anotar = (apiId: unknown): void => {
    const limpio = String(apiId ?? '').trim();
    if (limpio && !salida.includes(limpio)) salida.push(limpio);
  };

  for (const una of config?.salidas ?? []) anotar(una?.campo);

  /*
   * Y los que tocan sus acciones de desenlace.
   *
   * Cuentan igual que una salida: son campos que la llamada decide, así que sus
   * propias reglas tienen que evaluarse después y lo que la regla dejó dicho
   * sobre ellos tiene que olvidarse al reevaluar. Sin esto, un campo que solo
   * escribe un `alResponder` se quedaba fuera de las dos cuentas.
   */
  for (const lista of [config?.alResponder, config?.alFallar]) {
    for (const accion of lista ?? []) anotar(accion?.campo);
  }

  // Y los de los tramos, que deciden igual que los demás.
  for (const tramo of config?.tramos ?? []) {
    for (const accion of tramo?.entonces ?? []) anotar(accion?.campo);
  }

  return salida;
}

// ── Animaciones ─────────────────────────────────────────────────────────────

/**
 * Con qué se anima cuando la regla no lo dice.
 *
 * Escrito con el escape y no con el carácter porque este archivo viaja por
 * herramientas que no siempre respetan lo que no cabe en dos bytes, y un emoji
 * roto en el valor por defecto saldría en pantalla como un cuadrado.
 */
export const FIGURAS_POR_DEFECTO = '\u{1F389}';

/**
 * Cuántas caritas como mucho.
 *
 * El tope no es estético: son objetos moviéndose a la vez, y un cero de más en
 * la casilla dejaría el teléfono de quien está en campo sin poder responder
 * hasta que terminaran de subir.
 */
export const TOPE_DE_FIGURAS = 100;

/** Cuánto puede durar, en segundos. Ver `TOPE_DE_FIGURAS`. */
export const TOPE_DE_SEGUNDOS = 10;

/**
 * Deja un número dentro de sus límites, o el de por omisión si no es uno.
 *
 * Se exige un entero **entero**, no lo que `parseInt` sepa rescatar del
 * principio de la cadena. `parseInt('5.7')` da 5 y `parseInt('12caritas')` da
 * 12, mientras que el gemelo de Dart —`int.tryParse`— no acepta ninguno de los
 * dos y se queda con el valor por omisión. Esa diferencia haría que la misma
 * regla lanzara cinco caritas en el navegador y veinte en el teléfono.
 */
function entre(crudo: unknown, porDefecto: number, tope: number): number {
  const texto = String(crudo ?? '').trim();
  const bueno = /^[+-]?\d+$/.test(texto) ? Number(texto) : porDefecto;

  return Math.min(Math.max(bueno, 1), tope);
}

/**
 * Lo que hay que lanzar por la pantalla, ya limpio.
 *
 * Se admite la forma corta —`"valor": "🙂"`— además de la larga, porque el caso
 * corriente es una figura con lo de siempre y escribir un objeto entero para eso
 * sobra.
 */
function armarAnimacion(crudo: unknown): Animacion {
  const config = (leerJson(crudo) ?? { figuras: String(crudo ?? '') }) as Record<string, unknown>;

  const figuras = String(config['figuras'] ?? config['figura'] ?? '').trim();

  return {
    figuras: figuras || FIGURAS_POR_DEFECTO,
    cuantas: entre(config['cuantas'], 20, TOPE_DE_FIGURAS),
    segundos: entre(config['segundos'], 3, TOPE_DE_SEGUNDOS),

    /*
     * Desde dónde salen.
     *
     * Solo «abajo» por ahora, y se anota igualmente: quien pinta no tiene que
     * adivinarlo, y el día que haga falta que caigan desde arriba la regla ya
     * tiene dónde decirlo sin cambiar la forma de lo que se guardó.
     */
    desde: String(config['desde'] ?? 'abajo'),
  };
}
