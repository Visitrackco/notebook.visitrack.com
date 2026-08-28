/**
 * El modelo de un flujo de trabajo.
 *
 * Un flujo es lo que hace que un formulario se comporte: *si este campo vale
 * esto, entonces haz aquello con este otro*. Se guarda como JSON en
 * `md_workflows.JSONFlow` y lo ejecutan tres sitios —el simulador del
 * diseñador, el formulario del web y el de la app— con el mismo resultado.
 *
 * ## Dos mitades que no se mezclan
 *
 * - `reglas` es **lo que se ejecuta**. Es lo único que mira el motor.
 * - `lienzo` es **dónde está dibujada** cada regla. Solo lo mira el diseñador.
 *
 * Separarlas tiene una consecuencia práctica: el día que el lienzo cambie de
 * forma —o que alguien escriba reglas desde otro sitio— las reglas siguen
 * valiendo tal cual.
 */

/** Los identificadores son siempre el `apiId` del campo, no su `id` interno. */
export type ApiId = string;

export interface Flujo {
  /** Sube cuando el formato cambie de manera que no se pueda leer al revés. */
  version: number;
  reglas: Regla[];
  lienzo?: Record<string, Punto>;
}

export interface Punto {
  x: number;
  y: number;
}

/** Cuándo se evalúa una regla. Puede pedir más de un momento. */
export type Momento = 'abrir' | 'cambia' | 'guardar';

export interface Regla {
  id: string;
  nombre: string;
  cuando: Momento[];
  si: Grupo;
  entonces: Accion[];

  /**
   * Los «si no, y además…» — el *else if* de toda la vida.
   *
   * Se prueban **en orden** y solo se ejecuta el primero que se cumpla. Lo que
   * viene después no se mira, igual que en cualquier lenguaje.
   *
   * ## Por qué dentro de la regla y no como reglas sueltas
   *
   * Tres tramos excluyentes escritos como tres reglas obligan a negar a mano
   * las condiciones anteriores en cada una —«no es A, y no es B, y es C»— y
   * cualquier cambio en la primera hay que repetirlo en las otras dos. Es la
   * forma más fácil de acabar con dos tramos disparándose a la vez sobre el
   * mismo campo, que es justo lo que el detector de conflictos avisa cuando ya
   * ha pasado.
   */
  sinoSi?: Tramo[];

  /** Lo que pasa cuando **nada** de lo anterior se cumple. Casi siempre, deshacer. */
  sino?: Accion[];

  /** Una regla apagada se conserva pero no se ejecuta. */
  activa?: boolean;

  /**
   * Una regla de cierre: se ejecuta al guardar y **después** de todas las
   * demás.
   *
   * Para lo que solo tiene sentido con el formulario ya diligenciado: sumar lo
   * respondido, dejar un total en un campo, decidir el estado con el que se
   * cierra la actividad. Corren en el orden en que están escritas, una detrás
   * de otra, y cada una ve lo que dejó la anterior.
   */
  general?: boolean;

  /**
   * No se evalúa hasta que **esta otra regla** se haya cumplido.
   *
   * Es el identificador de la regla que va antes. Sirve para escribir un
   * proceso por pasos sin repetir la condición de la primera dentro de la
   * segunda, que es lo que se olvidaba actualizar al cambiar la de arriba.
   */
  tras?: string;
}

/**
 * Cómo se puntúa un grupo de campos.
 *
 * Va como `valor` de la acción `puntuar`, y se guarda como objeto porque son
 * varias cosas que solo tienen sentido juntas.
 */
export interface Puntuacion {
  /** Los `apiId` de los campos que entran en la cuenta. */
  campos: ApiId[];

  /**
   * Cuánto vale cada respuesta, por su **texto**.
   *
   * Por el texto y no por el identificador de la opción porque el mismo juego
   * de respuestas —«Cumple», «No cumple»— se repite en treinta preguntas con
   * un identificador distinto en cada una, y habría que declararlas treinta
   * veces. Se compara sin distinguir mayúsculas ni tildes.
   */
  valores: Record<string, number>;

  /**
   * Respuestas que **no cuentan**, ni en la suma ni en el total.
   *
   * Lo normal es «NA» o «No aplica». Es la diferencia entre un promedio útil y
   * uno que castiga a quien tenía preguntas que no le tocaban.
   */
  excluye?: string[];

  /**
   * Qué se escribe en el campo:
   *
   * - `suma` — los puntos, tal cual.
   * - `promedio` — los puntos entre las preguntas que contaron.
   * - `porcentaje` — lo obtenido sobre lo máximo posible, de 0 a 100.
   * - `cuenta` — cuántas preguntas contaron.
   * - `excluidas` — cuántas quedaron fuera.
   */
  modo: 'suma' | 'promedio' | 'porcentaje' | 'cuenta' | 'excluidas';

  /** Decimales del resultado. Por defecto, ninguno. */
  decimales?: number;
}

/** Un «si no, y además…»: su condición y lo que hace si es la que se cumple. */
export interface Tramo {
  si: Grupo;
  entonces: Accion[];
}

/** Un grupo de condiciones unidas por «y» u «o». Puede anidar otros grupos. */
export interface Grupo {
  op: 'y' | 'o';
  cond: (Condicion | Grupo)[];
}

export type Comparador =
  | 'igual'
  | 'distinto'
  | 'contiene'
  | 'empieza'
  | 'termina'
  | 'vacio'
  | 'con-valor'
  | 'mayor'
  | 'menor'
  | 'mayor-igual'
  | 'menor-igual'
  | 'entre'
  | 'en-lista'
  | 'patron'
  /**
   * Para campos de GPS: a menos de X metros de un punto.
   *
   * `valor` son las coordenadas —«4.6543,-74.0721»— y `valor2` el radio en
   * metros. Comparar una posición con «es igual a» no sirve de nada: dos
   * lecturas del mismo sitio nunca dan los mismos decimales.
   */
  | 'cerca-de';

/**
 * Cómo se comparan los textos.
 *
 * - `insensible` — no importan mayúsculas ni minúsculas. Es lo normal.
 * - `sensible` — tal cual está escrito.
 * - `solo-valor` — ignora además tildes, espacios de sobra y signos. Es lo que
 *   se quiere cuando lo que importa es **el valor**, no cómo se escribió.
 */
export type ModoTexto = 'insensible' | 'sensible' | 'solo-valor';

export interface Condicion {
  campo: ApiId;
  cmp: Comparador;
  valor?: unknown;
  /** Solo para `entre`: el extremo de arriba. */
  valor2?: unknown;
  texto?: ModoTexto;
}

export type TipoAccion =
  | 'mostrar'
  | 'ocultar'
  | 'obligatorio'
  | 'opcional'
  | 'solo-lectura'
  | 'editable'
  | 'poner-valor'
  | 'limpiar'
  | 'copiar-de'
  /**
   * Calcular con los valores de otros campos.
   *
   * `valor` es la fórmula, escrita con los `apiId`: `CANTIDAD * PRECIO`,
   * `(NETO + IVA) * 1.05`, `redondear(TOTAL / DIAS, 2)`.
   *
   * Es lo que permite que un mismo campo se calcule de una manera u otra según
   * la condición de la regla: dos reglas sobre el mismo campo, cada una con su
   * fórmula.
   */
  | 'calcular'
  | 'color'
  | 'color-texto'
  | 'mensaje'
  | 'avisar'
  | 'poner-texto'
  | 'poner-imagen'
  | 'ir-a-pagina'
  | 'bloquear-guardado'

  /**
   * Crear otra actividad. `valor` es el formulario del que se crea.
   *
   * Es lo que permite encadenar trabajo: una inspección que sale mal abre la
   * orden de reparación sin que nadie tenga que acordarse.
   */
  | 'despachar'
  | 'crear-actividad'

  /** Cambiar el estado de la actividad. `valor` es el estado al que pasa. */
  | 'cambiar-estado'

  /**
   * Desde cuándo se puede elegir, en un campo de fecha o de hora.
   *
   * `valor` es la fecha (`2026-08-26`) o la hora (`08:00`), o la palabra `HOY`
   * —que se resuelve en el aparato— para «de hoy en adelante». Con las dos
   * juntas se acota un rango; con una sola, solo ese extremo.
   */
  | 'limitar-desde'

  /** Hasta cuándo se puede elegir. Ver [limitar-desde]. */
  | 'limitar-hasta'

  /**
   * Puntuar varios campos y escribir el resultado.
   *
   * Es lo que hace falta en una inspección o una encuesta: cada respuesta vale
   * unos puntos, y al final se quiere la suma, el promedio o el porcentaje de
   * cumplimiento. `valor` es una [Puntuacion].
   *
   * Lo que la distingue de una fórmula es **poder excluir**: en una lista de
   * treinta preguntas siempre hay unas cuantas que no aplican, y si cuentan
   * como cero hunden el promedio de un sitio que no tenía nada mal.
   */
  | 'puntuar'

  /**
   * Qué días de la semana se pueden elegir.
   *
   * `valor` son los números del 1 al 7 separados por comas, empezando en lunes:
   * `1,3,5` deja lunes, miércoles y viernes. Es lo que hace falta para «las
   * visitas solo son los lunes» sin que nadie tenga que acordarse.
   */
  | 'dias-permitidos';

export interface Accion {
  accion: TipoAccion;
  /** El campo sobre el que actúa. Vacío en las que son del formulario entero. */
  campo?: ApiId;
  /** El valor a poner, el color, el texto del mensaje o el número de página. */
  valor?: unknown;
  /** Para `copiar-de`: de qué campo se copia. */
  origen?: ApiId;
}

/**
 * Cómo queda un campo después de aplicar el flujo.
 *
 * Solo lleva lo que **alguna regla decidió**. Un campo del que ninguna regla
 * dijo nada no aparece en el resultado, y el formulario lo deja como estaba: el
 * motor no impone, corrige.
 */
export interface EstadoCampo {
  visible?: boolean;

  /**
   * Los límites de un campo de fecha o de hora.
   *
   * No son una condición sino una **restricción del editor**: el motor los
   * anota y el formulario los traduce a lo suyo —el `min` y el `max` de un
   * `input` en el navegador, la primera y la última fecha del calendario en el
   * teléfono—. Impedir elegir mal es mejor que avisar después de haberlo hecho.
   */
  desde?: string;
  hasta?: string;

  /** Días de la semana elegibles, del 1 (lunes) al 7. Ver `dias-permitidos`. */
  dias?: string;
  obligatorio?: boolean;
  soloLectura?: boolean;
  valor?: unknown;
  color?: string;
  colorTexto?: string;
  mensaje?: string;

  /**
   * Lo que el campo **dice**: el texto de un título, de un párrafo o de una
   * etiqueta. No es lo que vale, que eso es `valor`.
   */
  texto?: string;

  /** La dirección de la imagen que enseña un campo de tipo imagen. */
  imagen?: string;
}

/**
 * Algo que el formulario tiene que hacer, y que no es tocar un campo.
 *
 * El motor no las ejecuta: no sabe crear una actividad ni cambiarle el estado,
 * y no debe saberlo —tiene que dar el mismo resultado en el navegador, en el
 * teléfono y en el simulador, donde nada de eso existe—. Las **anota**, y quien
 * llama decide si las lleva a cabo.
 */
export interface Encargo {
  que: 'crear-actividad' | 'cambiar-estado' | 'despachar';
  valor: unknown;
  /** Qué regla lo pidió, para poder decirlo si algo sale mal. */
  regla: string;
}

export interface Resultado {
  /** Qué le pasa a cada campo, por `apiId`. */
  campos: Record<ApiId, EstadoCampo>;
  /** Página a la que ir, si alguna regla lo pidió. */
  irAPagina?: number;
  /** Motivos por los que no se puede guardar. Vacío significa que sí se puede. */
  bloqueos: string[];
  /** Qué reglas se dispararon. Es lo que enseña el simulador. */
  disparadas: string[];

  /**
   * Lo que hay que hacer con la actividad, más allá de sus campos.
   *
   * Se llenan sobre todo al guardar, que es el único momento en el que tiene
   * sentido crear otra actividad o cambiar el estado de esta.
   */
  encargos: Encargo[];

  /**
   * Reglas que quisieron escribir en el campo recién respondido y no pudieron.
   *
   * No es un error: es lo que hay que enseñarle a quien diseñó el flujo, que
   * casi seguro no quería que su regla le borrara a alguien lo que acaba de
   * contestar.
   */
  pisadas: string[];

  /** Avisos que hay que enseñar en pantalla. Ver la acción `avisar`. */
  avisos: string[];

  /**
   * Qué pasó con cada regla, cuando se pide.
   *
   * Vacía salvo que se evalúe con `traza`. No se construye siempre porque
   * hacerlo en cada tecla cuesta más que evaluar el flujo entero.
   */
  traza?: PasoDeRegla[];

  /**
   * Reglas que esperan a otra y todavía no les ha tocado. Ver `tras`.
   *
   * No es un error: es lo normal mientras la de arriba no se cumpla. Se apunta
   * para poder enseñarlo al diseñar el flujo, que es donde una cadena que no
   * avanza desconcierta.
   */
  enEspera: string[];

  /**
   * Qué regla le escribió un valor a qué campo, y cuál.
   *
   * Dos reglas peleándose por el mismo campo es el enredo más difícil de ver
   * desde fuera: el campo acaba con un valor que nadie escribió a mano y no hay
   * forma de saber quién fue.
   */
  escrituras?: Record<string, { regla: string; valor: string }[]>;

  /**
   * Con qué valores acabó la evaluación.
   *
   * No es lo mismo que con los que empezó: una regla puede escribirle encima a
   * un campo, y entonces lo que la siguiente decide ya no es lo que respondió
   * el usuario. Es para poder contarlo, no para decidir con ello.
   */
  valoresFinales?: Record<string, unknown>;
  /**
   * Se llegó al tope de pasadas sin que el estado se quedara quieto: el flujo
   * tiene un ciclo. Se avisa a quien diseña, no a quien diligencia.
   */
  ciclo: boolean;

  /**
   * Dos reglas le ponen valores distintos al mismo campo.
   *
   * No rompe nada —gana la última, y eso es predecible— pero casi siempre es un
   * error de quien diseñó el flujo: dos reglas peleándose por un campo. Es más
   * frecuente que un ciclo de verdad y se detecta mucho mejor.
   */
  conflictos: string[];
}

/** Lo que el motor necesita saber del formulario para evaluar. */
export interface Campo {
  apiId: ApiId;
  fty: string;
  /** Opciones de un radio o una casilla, para poder comparar por texto. */
  opt?: { id?: string; txt?: string; val?: string }[];
  pagina?: number;

  /**
   * Esto no es un campo: es una página entera del formulario.
   *
   * Se puede esconder o dejar en solo lectura como si fuera uno, y lo que se
   * decida sobre ella cae sobre **todos sus campos**.
   */
  esPagina?: boolean;
}

export interface Contexto {
  /** Lo respondido hasta ahora, por `apiId`. */
  valores: Record<ApiId, unknown>;
  /** Los campos del formulario, por `apiId`. */
  campos: Record<ApiId, Campo>;
  /** En qué momento se está evaluando. */
  momento: Momento;
  /** Qué campo acaba de cambiar, cuando el momento es `cambia`. */
  campoQueCambio?: ApiId;

  /**
   * Que cuente qué pasó con cada regla.
   *
   * Apagado por omisión, y a propósito: construir el relato en cada tecla
   * cuesta más que evaluar el flujo entero. Lo enciende quien va a enseñarlo —
   * el simulador y el registro de la actividad—, no el formulario mientras se
   * diligencia.
   */
  traza?: boolean;
}

/** Lo que se leyó y contra qué se comparó, en una condición. */
export interface PasoDeCondicion {
  campo: string;
  cmp: string;

  /** Lo que la regla esperaba encontrar. */
  esperaba: string;

  /** Lo que había de verdad en el campo. */
  leyo: string;

  cumple: boolean;
}

/**
 * Qué pasó con una regla, para poder explicarlo.
 *
 * Es lo que responde a «¿por qué no se disparó?». Sin esto, una regla que no
 * hace nada y una que no llegó a mirarse se ven exactamente igual desde fuera.
 */
export interface PasoDeRegla {
  regla: string;
  nombre: string;

  /** Si llegó a mirarse. Ver [motivo] cuando no. */
  evaluada: boolean;

  /** Por qué no se miró: espera a otra, o no es del campo que se respondió. */
  motivo: string;

  cumple: boolean;

  /** Qué rama corrió: la de cumplirse, un tramo, o la de «si no». */
  rama: string;

  condiciones: PasoDeCondicion[];
}

/**
 * Con qué nombre se pregunta por el estado de la actividad.
 *
 * No es un campo del formulario —no se responde, lo decide la plataforma o una
 * regla— pero sí se puede preguntar por él: «si quedó en Aprobado, despacha».
 * Lleva dos puntos por lo mismo que las páginas: ningún `apiId` de verdad los
 * tiene, así que no puede chocar con uno.
 *
 * Se compara por **identificador**, no por nombre: los nombres se editan y una
 * regla escrita con el nombre dejaría de funcionar el día que alguien lo cambie.
 */
export const ESTADO_DE_LA_ACTIVIDAD = 'ACTIVIDAD:estado';
