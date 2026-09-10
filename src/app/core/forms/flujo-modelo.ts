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

  /**
   * Sobre qué decide esta regla: la actividad, o **una fila** de una tabla.
   *
   * Una fila es un formulario pequeño con su propio mundo. Sin ámbito la regla
   * es de la actividad —que es como están escritas todas las que ya existen— y
   * con `fila` corre una vez por cada fila, con los campos de dentro.
   */
  ambito?: Ambito;

  /**
   * La tabla cuyas filas decide, cuando [ambito] es `fila`.
   *
   * Es el `apiId` del campo `masterdetail`. Vacío significa **todas**: es la
   * forma de escribir una vez lo que se quiere en cualquier tabla.
   */
  md?: ApiId;
}

/**
 * Sobre qué decide una regla.
 *
 * - `actividad` — lo respondido en el formulario. Es lo normal.
 * - `fila` — cada fila de una tabla de detalle, por separado.
 * - `formulario` — **cómo llega** la actividad, no lo que se responde: en qué
 *   estado viene, quién la tiene asignada, de qué sede es. Se evalúa al abrir,
 *   antes de que nadie escriba nada, y es lo que permite decidir si esta
 *   actividad se puede editar o guardar siquiera.
 */
export type Ambito = 'actividad' | 'fila' | 'formulario';

/**
 * Cuántas filas tienen que cumplir una condición sobre una tabla.
 *
 * Preguntarle a la tabla entera no significa nada: cada fila tiene su propia
 * respuesta. Por omisión, `alguna`.
 */
export type Cuantificador = 'alguna' | 'ninguna' | 'todas';

/**
 * Lo que se le pregunta a un conjunto de filas cuando se pide un número.
 *
 * Se escribe pegado al identificador —`DETALLE:EQUIPOS:IMPORTE@suma`— para que
 * el agregado sea **un identificador más**: así lo entiende todo lo que ya sabe
 * leer identificadores, tanto en una condición como dentro de una fórmula.
 */
export type Agregado =
  | 'suma'
  | 'cuenta'
  | 'promedio'
  | 'maximo'
  | 'minimo'
  | 'filas'
  /** Filas con todos sus obligatorios respondidos. */
  | 'completas'
  /** Las que no: lo que falta por diligenciar. */
  | 'amedias';

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

  /**
   * Que las opciones que el cuadro no menciona valgan lo que ellas digan.
   *
   * Sin esto —que es como están escritas todas las puntuaciones que ya
   * corren— una respuesta que no figure en `valores` no cuenta, y eso es
   * deliberado: cero es una nota y «no sé cuánto vale» no lo es.
   *
   * Con esto, el número de cada respuesta sale de su propia opción. Es lo que
   * hace falta para promediar una encuesta de treinta preguntas con las mismas
   * cuatro opciones: el número ya está en la opción, y volver a teclearlo
   * pregunta por pregunta era el motivo real de que nadie usara esto. Ver
   * `puntosDeLaOpcion` en el motor para saber de dónde lo saca.
   *
   * El cuadro sigue mandando donde diga algo: es lo declarado a mano para esta
   * regla, y una opción no puede contradecirlo.
   */
  segunOpcion?: boolean;
}

/**
 * Cómo se tumban las barras.
 *
 * Solo lo miran las barras: en una circular no hay ejes que orientar, y en unas
 * líneas el tiempo va a lo ancho por definición.
 */
export type Orientacion = 'horizontal' | 'vertical';

/**
 * Una gráfica dibujada dentro del formulario, alimentada por lo respondido.
 *
 * Es lo que se escribe en la regla; lo que sale del motor es una
 * [GraficaPintada], con los números ya contados.
 */
export interface Grafica {
  /**
   * Barras, circular o líneas.
   *
   * Tres y no más, a propósito: son las que responden las tres preguntas que se
   * hacen sobre un formulario a medio llenar —cuánto hay de cada cosa, qué parte
   * del total es cada cosa y cómo va evolucionando—.
   */
  tipo: 'barras' | 'circular' | 'lineas';

  /** El rótulo de encima. Vacío, no se pinta ninguno. */
  titulo?: string;

  /**
   * El nombre con el que **un botón** se refiere a ella.
   *
   * Es opcional, y tiene que seguir siéndolo: hay flujos en producción con
   * gráficas escritas antes de que existieran los botones, y todas ellas se
   * dibujan siempre, sin que nadie las llame. Solo hace falta para lo que
   * necesita nombrarla desde fuera.
   *
   * Es un nombre y no un identificador generado a propósito: quien configura un
   * botón elige entre las gráficas del flujo por su nombre, y una ristra de
   * letras y números no se reconoce en un desplegable.
   */
  id?: string;

  /**
   * Nace escondida y no se ve hasta que un botón la muestre.
   *
   * Sin [id] no significa nada —nadie podría llamarla— y por eso el editor no
   * la deja marcar hasta que la gráfica tenga nombre: una gráfica escondida y
   * sin nombre es una que no se verá nunca, y desde fuera se lee igual que una
   * regla que no se dispara.
   */
  oculta?: boolean;

  /**
   * Los rótulos de los ejes. Vacíos, no se pinta ninguno.
   *
   * No los tienen todos los tipos: una circular no tiene ejes, y ofrecerlos ahí
   * sería ofrecer un dato que nadie va a usar. El motor los descarta cuando el
   * tipo elegido los ignora, para que lo que sale de él sea exactamente lo que
   * hay que dibujar y quien pinta no tenga que decidirlo otra vez.
   */
  ejeX?: string;
  ejeY?: string;

  /**
   * Barras tumbadas o de pie.
   *
   * Por omisión, `horizontal`: es como se dibujan las que ya existen, y
   * cambiarlo movería de sitio todas las gráficas que hoy están en producción
   * sin que nadie lo hubiera pedido.
   *
   * No es girar la imagen. Tumbadas, la etiqueta tiene todo el ancho de la
   * izquierda —«No cumple según la última revisión» se lee entero— y por eso es
   * lo que se pide en un teléfono. De pie caben más columnas y se comparan
   * mejor entre sí, pero la etiqueta se queda con lo ancho que sea la columna.
   * Solo significa algo en las barras.
   */
  orientacion?: Orientacion;

  /** De qué se alimenta cada barra, cada sector o cada punto. */
  series: SerieDeGrafica[];

  /**
   * Que el número de cada respuesta lo diga su opción, en todas las series.
   *
   * Una encuesta se configura una vez, no pregunta por pregunta. Ver
   * `Puntuacion.segunOpcion`, que significa exactamente lo mismo.
   */
  segunOpcion?: boolean;
}

/**
 * De dónde sale un dato de la gráfica.
 *
 * Hay dos formas, que son las dos maneras de preguntar por lo respondido:
 *
 * - **Varios campos y una condición** — «de estas diez preguntas, cuántas
 *   quedaron en Cumple». Se pone `campos` y un comparador, y el número es
 *   cuántos cumplen.
 * - **Unos campos y una medida** — «el promedio de las diez», «el voltaje». Se
 *   pone `campos` sin comparador, y el número sale de sumarlos, promediarlos o
 *   quedarse con el mayor.
 */
export interface SerieDeGrafica {
  /** Lo que se lee debajo de la barra o al lado del sector. */
  txt: string;

  /** El campo del que sale, cuando es uno solo. */
  campo?: ApiId;

  /** Los campos de los que sale. Se suman a `campo` si vienen los dos. */
  campos?: ApiId[];

  /**
   * El comparador, si la serie cuenta cuántos cumplen.
   *
   * Son **los mismos** de una condición, y no por parecido: al motor se le pasa
   * la serie entera al comparador de condiciones, así que los que ya existen
   * valen aquí sin escribir una línea, y el día que se añada uno nuevo
   * funcionará en los dos sitios a la vez.
   */
  cmp?: Comparador;
  valor?: unknown;
  valor2?: unknown;
  texto?: ModoTexto;

  /**
   * Qué se hace con los números, cuando no hay comparador.
   *
   * Se llaman igual que los agregados de una tabla y significan lo mismo: dos
   * vocabularios para la misma idea es la forma segura de que quien configura
   * tenga que aprenderla dos veces.
   */
  medida?: 'suma' | 'promedio' | 'cuenta' | 'maximo' | 'minimo';

  /** Solo para esta serie. Ver `Grafica.segunOpcion`. */
  segunOpcion?: boolean;

  /** El color con el que se pinta, en `#rrggbb`. */
  color?: string;
}

/**
 * La gráfica tal como sale del motor: con los números hechos.
 *
 * Lo que no lleva es porque **no hay que dibujarlo**. El motor descarta lo que
 * el tipo elegido ignora —los ejes de una circular, la orientación de unas
 * líneas— en vez de dejarlo pasar: así quien pinta no tiene que volver a
 * decidir qué aplica a qué tipo, que es la clase de decisión que las tres
 * plataformas acabarían tomando de tres maneras distintas.
 */
export interface GraficaPintada {
  tipo: 'barras' | 'circular' | 'lineas';
  titulo?: string;

  /** Su nombre, si lo tiene. Es por lo que un botón la llama. Ver `Grafica.id`. */
  id?: string;

  /** No se dibuja hasta que un botón la pida. Ver `Grafica.oculta`. */
  oculta?: boolean;

  /** Los rótulos de los ejes, cuando el tipo tiene ejes. */
  ejeX?: string;
  ejeY?: string;

  /** Solo en las barras, y solo cuando no es la de siempre. */
  orientacion?: Orientacion;

  datos: { txt: string; val: number; color?: string }[];
}

/**
 * Cuándo se ve un botón, y si se puede pulsar.
 *
 * - `siempre` — se ve y se pulsa. Es lo normal.
 * - `si-cumple` — se ve solo cuando su condición se cumple. La condición es
 *   **la misma** de una regla: los mismos campos, los mismos comparadores y el
 *   mismo editor. Un segundo lenguaje de condiciones para los botones sería un
 *   segundo sitio donde arreglar cada comparador nuevo.
 * - `solo-lectura` — se ve apagado. Es para decir «esto existe, pero no ahora»,
 *   que es distinto de esconderlo: escondido, quien diligencia no sabe que
 *   había algo.
 * - `oculto` — no se dibuja. Es la forma de dejar un botón configurado y
 *   apagado, igual que `Regla.activa` con una regla.
 */
export type EstadoDeBoton = 'siempre' | 'si-cumple' | 'solo-lectura' | 'oculto';

/**
 * De qué lado del campo se dibuja un botón.
 *
 * Por omisión, `despues`: lo normal es ofrecer la acción **después** de haber
 * leído la pregunta, no antes. `antes` existe para lo que hay que hacer primero
 * —«carga los equipos de la sede» encima de la tabla que va a llenar—, que
 * puesto debajo se encuentra cuando ya no sirve.
 */
export type LadoDelCampo = 'antes' | 'despues';

/**
 * Las formas de decir **cuándo** sale algo que no sale ya.
 *
 * Las mismas cuatro que programan una consigna, y a propósito: quien configura
 * un flujo aprende una vez a decir «dentro de tres días a las ocho» y le vale
 * para la consigna y para el correo. Un segundo vocabulario para la misma idea
 * es la forma segura de que la mitad de los flujos usen uno y la otra mitad el
 * otro.
 *
 * Ninguna es una fecha fija por lo mismo que allí: un flujo se dibuja una vez y
 * corre durante meses, así que «el 15 de septiembre» vale para el primer envío y
 * a partir de ahí programa correos en el pasado. `fecha` se sigue entendiendo
 * porque hay flujos guardados con ella.
 */
export type CuandoSale = 'ya' | 'dias' | 'mesdia' | 'campo' | 'fecha';

/**
 * Un correo que una regla quiere mandar.
 *
 * ## El correo se encola siempre; nunca sale del aparato
 *
 * Ni el teléfono ni el navegador hablan con ningún servidor SMTP. Dejan el
 * correo apuntado, viaja con la actividad y **lo manda el servidor**. Son tres
 * razones y valen las tres:
 *
 * - Quien está en campo pierde la conexión. Si el envío dependiera de haber red
 *   en el instante de guardar, el correo no saldría y nadie se enteraría hasta
 *   que alguien lo echara de menos.
 * - Las credenciales del buzón no pueden bajar al aparato: un flujo se descarga
 *   a **todos** los que sincronizan ese formulario. Por eso aquí viaja el
 *   identificador del proveedor —o su área— y jamás el servidor ni la
 *   contraseña. Es el mismo argumento que ya ganó `llamar-servicio`.
 * - La actividad ya viaja al servidor; el correo puede viajar con ella.
 *
 * Y por eso **no** hay una variante «si hay internet manda ya, si no encola»:
 * serían dos caminos, con dos formas de fallar y un problema de duplicados entre
 * ellos.
 *
 * ## Dónde se resuelven las variables
 *
 * **Aquí, en el aparato**, antes de encolar. Ver `CorreoPedido.cuerpo`.
 */
/**
 * Un archivo que va pegado al correo, **nombrado y no resuelto**.
 *
 * ## Por qué el motor no trae el archivo
 *
 * Es la misma regla que ya sigue `HerenciaDeActividad` con los binarios: copiar
 * un archivo es mover algo de un disco, y el motor tiene que dar el mismo
 * resultado en el simulador —donde no hay disco ni base— que en un teléfono.
 * Así que aquí se dice **cuál** archivo, y quien encola lo resuelve: el
 * servidor sabe dónde vive cada binario de una actividad y el generador de
 * informes vive en otro dominio.
 *
 * Lo único que el motor sí resuelve es el [nombre], porque eso es texto y es
 * exactamente lo que sabe hacer.
 */
export interface AdjuntoDeCorreo {
  /**
   * De dónde sale el archivo.
   *
   * - `campo` — un binario respondido en el formulario: una foto, una firma, un
   *   archivo. Se nombra por el `apiId` de su campo, como todo lo demás.
   * - `tabla` — el mismo binario pero dentro de una tabla de detalle: la foto de
   *   cada equipo revisado. Va fila a fila, con [tope] para no mandar cuarenta.
   * - `fijo` — un archivo que se sube una vez al configurar la regla y viaja
   *   igual en todos los correos que salgan de ella: un instructivo, un formato.
   * - `informe` — el PDF de la actividad, el mismo que enseña la plataforma. No
   *   existe todavía cuando el correo se encola: lo pide el servidor al enviar.
   */
  tipo: 'campo' | 'tabla' | 'fijo' | 'informe';

  /** Con `campo` y `tabla`: el `apiId` del campo que trae el archivo. */
  campo?: ApiId;

  /** Con `tabla`: el `apiId` de la tabla de detalle que se recorre. */
  tabla?: ApiId;

  /**
   * Con `tabla`: cuántas filas como mucho.
   *
   * Una inspección de cuarenta equipos con foto son cuarenta adjuntos y un
   * correo que ningún servidor acepta. Sin tope se manda lo que quepa en el
   * límite de tamaño y se dice cuántos se quedaron fuera.
   */
  tope?: number;

  /**
   * Con `fijo`: dónde quedó el archivo que se subió en el lienzo.
   *
   * Lo escribe la pantalla al subirlo, no se teclea. Viaja con el flujo, así
   * que es el mismo para todos los correos de esa regla.
   */
  key?: string;

  /** Con `fijo`: de qué tipo es, para que el cliente de correo sepa abrirlo. */
  mime?: string;

  /** Con `informe`: en qué formato. Hoy solo `pdf`. */
  formato?: 'pdf';

  /**
   * Cómo se va a llamar el archivo, **con variables**.
   *
   * `Informe-{PLACA}-{FECHA}.pdf`, con la misma lista de campos que el asunto y
   * el cuerpo. Es lo que pidió quien lo usa: un correo con tres adjuntos
   * llamados `descarga.pdf` obliga a abrirlos uno a uno para saber cuál es cuál.
   *
   * Vacío, se usa el nombre con el que el archivo ya viene.
   */
  nombre?: string;
}

export interface CorreoDeFlujo {
  /**
   * A quién va. Direcciones separadas por comas, y admite variables.
   *
   * Se admite escribir `{EMAILCLIENTE}` para sacarla de un campo: es lo que pide
   * la mitad de los casos —«mándaselo al correo que dejó el cliente»— y sin ello
   * habría que escribir un flujo por destinatario.
   */
  para?: string;

  /** Copia, con las mismas reglas que [para]. */
  copia?: string;

  /**
   * Copia oculta, con las mismas reglas que [para].
   *
   * Hace falta de verdad y no es un adorno del formulario: un aviso que va a
   * seis supervisores en copia le enseña a cada uno el correo de los otros
   * cinco, y eso son datos de personas repartidos sin que nadie lo decidiera.
   */
  copiaOculta?: string;

  /**
   * Los campos que **tienen que estar respondidos** para que el correo salga.
   *
   * Por su `apiId`, como todo lo demás. Si alguno está vacío, el correo no se
   * pide: ni se apunta ni se manda.
   *
   * ## Por qué hace falta, teniendo ya «solo si está completa»
   *
   * Porque aquello mira el formulario entero y esto mira lo que **este correo**
   * necesita. Un aviso que dice «se adjunta la foto del daño» y sale sin la
   * foto es peor que no salir: quien lo recibe da por hecho que no había daño.
   * Y exigir que la actividad entera esté completa para eso obligaría a hacer
   * obligatorios treinta campos que no tienen nada que ver.
   *
   * Lo natural es marcar aquí los que se nombran en el asunto, en el cuerpo o
   * en el destinatario — que es justo lo que ofrece el lienzo.
   */
  exige?: ApiId[];

  /**
   * Si este correo puede volver a salir, o se manda una sola vez.
   *
   * ## Lo que pasa hoy, y por qué
   *
   * Una sola vez. El correo se reconoce por regla, destinatario, asunto y
   * programación —ver `llaveDelCorreo`— y con esa llave ya apuntada no se vuelve
   * a pedir: guardar otra vez la misma actividad, o volver a pulsar el botón, no
   * manda un segundo aviso. Es lo correcto para el caso normal, porque una
   * actividad se reabre y se corrige, y quien recibe el correo no ve una
   * corrección sino dos correos.
   *
   * ## Cuándo hace falta lo contrario
   *
   * Cuando el correo **es** la acción y no el aviso de un hecho: «mándale la
   * ficha al cliente» pulsado tres veces son tres envíos queridos. Con
   * `repetible` en `true`, cada guardado o cada pulsación cuenta como uno nuevo.
   *
   * ## El detalle que importa
   *
   * Lo que distingue un envío del siguiente es **el minuto** en que se pidió, no
   * un contador. Dos pulsaciones dentro del mismo minuto siguen siendo una: no
   * es una limitación que haya que rodear, es lo que evita que un doble toque
   * —o las cinco pasadas que da el motor al evaluar— manden el correo dos veces.
   */
  repetible?: boolean;

  /**
   * Si al pulsar el boton se espera en pantalla o no.
   *
   * - **Sincrono** (lo que se hace si no se dice nada): sale un aviso de carga
   *   que tapa la pantalla hasta que el correo queda pedido. Es para cuando lo
   *   que sigue depende de que el correo salga y no tiene sentido seguir
   *   tocando el formulario mientras tanto.
   * - **Asincrono** (`false`): se avisa con un mensaje suelto y se sigue
   *   trabajando. Es para el correo que es un efecto secundario y no el motivo
   *   del boton.
   *
   * En cualquiera de los dos casos hay un tope de espera: bloquear la pantalla
   * sin limite deja a alguien en campo sin poder hacer nada si la red se cae a
   * mitad. Ver el tope en cada cliente.
   *
   * Solo cuenta al pulsar un boton. Cuando el correo sale al guardar no hay a
   * quien bloquear: la pantalla ya se cerro.
   */
  avisoSincrono?: boolean;

  /**
   * Lo que se lee mientras el correo se pide, y cuando ya esta pedido.
   *
   * Se configuran en la regla porque el aviso util no es el generico: «Enviando
   * el acta al cliente…» dice de que va esto, y «Correo en camino» no. Admiten
   * variables como el asunto, asi que pueden nombrar lo que se manda.
   *
   * Vacios, cada cliente pone el suyo. **No viajan al servidor**: son de la
   * pantalla, y el servidor no pinta nada.
   */
  mensajeEnviando?: string;
  mensajeEnviado?: string;

  /** El asunto. Admite variables, igual que el cuerpo. */
  asunto?: string;

  /**
   * El cuerpo, en HTML, tal como se armó en el lienzo.
   *
   * Con variables entre llaves —`{CLIENTE}`, `{DETALLE:EQUIPOS:IMPORTE@suma}`,
   * `{ACTIVIDAD:estado}`— nombradas **igual que en una condición**. No hay una
   * segunda forma de nombrar un campo.
   */
  cuerpo?: string;

  /**
   * Por qué buzón sale: el `ID` de un proveedor de `VTServicesEmailsConfig`.
   *
   * Vacío significa «el predeterminado de [area]», que es lo que se quiere casi
   * siempre: así cambiar de proveedor se hace una vez en Configuración y no
   * flujo por flujo.
   */
  proveedor?: number | string;

  /** El área cuyo buzón predeterminado se usa cuando no se dice [proveedor]. */
  area?: string;

  /** Los archivos que van pegados. Ver [AdjuntoDeCorreo]. */
  adjuntos?: AdjuntoDeCorreo[];

  /** Cuándo sale. Ver [CuandoSale]. */
  cuando?: CuandoSale;

  /** Con `cuando = 'dias'`: dentro de cuántos. Puede ser 0 —hoy a esa hora—. */
  dias?: number | string;

  /** Con `cuando = 'mesdia'`: qué día del mes, del 1 al 31. */
  dia?: number | string;

  /** Con `cuando = 'fecha'`: la fecha exacta. Ya no se ofrece en el lienzo. */
  fecha?: string;

  /** Con `cuando = 'campo'`: de qué campo de fecha sale el día. */
  campoFecha?: string;

  /** A qué hora, en `hh:mm`. Sin ella, las ocho. */
  hora?: string;

  /**
   * Solo si la actividad quedó completa.
   *
   * Guardar deja pasar aunque falten obligatorios —se avisa y quien diligencia
   * decide— y un correo que nace de un informe a medias suele ser un error. Por
   * omisión sale igual, que es lo que se espera de una regla que dice «manda un
   * correo»; exigir completitud es la decisión explícita.
   */
  soloCompleta?: boolean;
}

/**
 * El correo tal como sale del motor: **ya escrito**.
 *
 * ## Por qué el HTML se resuelve aquí y no en el servidor
 *
 * Porque el servidor no sabe leer un formulario, y enseñarle costaría un cuarto
 * motor: `leerValor`, `comoTexto`, los agregados de detalle, el registro del que
 * nació cada fila. Ya hay tres gemelos que solo se mantienen alineados a base de
 * una batería de casos compartida; un cuarto, escrito aparte y sin batería,
 * divergiría el primer día — y divergir aquí significa que el correo cuenta una
 * cosa distinta de la que se vio en pantalla.
 *
 * Y hay una segunda razón, más difícil de recuperar si se elige mal: **el correo
 * tiene que contar lo que hizo saltar la regla**. Una actividad se reabre y se
 * corrige; si el HTML se resolviera al enviarlo, el correo contaría el estado de
 * después, no el de entonces. Resuelto aquí es una foto del momento.
 *
 * Lo que **no** se resuelve aquí es por dónde sale: eso son credenciales, y no
 * bajan al aparato. Ver [CorreoDeFlujo].
 */
export interface CorreoPedido {
  /**
   * Con qué se reconoce este correo entre dos evaluaciones y entre dos
   * guardados. Ver `Resultado.correos`.
   */
  llave: string;

  para: string;
  copia?: string;
  copiaOculta?: string;

  /** Ver [CorreoDeFlujo.mensajeEnviando]. Ya resueltos y en una linea. */
  mensajeEnviando?: string;
  mensajeEnviado?: string;

  /**
   * Ver [CorreoDeFlujo.avisoSincrono].
   *
   * **Solo viaja cuando es `false`.** Ausente significa sincrono, que es lo que
   * se hace si la regla no dice nada: asi las reglas de siempre siguen
   * comportandose igual y su llave no cambia.
   */
  avisoSincrono?: boolean;

  asunto: string;

  /** El HTML con las variables ya puestas **y escapadas**. */
  cuerpo: string;

  proveedor?: number | string;
  area?: string;

  /**
   * Los adjuntos, con el nombre ya resuelto y **el archivo todavía no**.
   *
   * Ver [AdjuntoDeCorreo]: aquí llega lo mismo que se configuró, con [nombre]
   * sustituido y saneado. Quien encola resuelve dónde está cada archivo.
   */
  adjuntos?: AdjuntoDeCorreo[];

  /**
   * Cuándo sale, en `aaaa-mm-dd hh:mm`, y en **hora de pared**.
   *
   * Vacío es «ya». No es UTC a propósito: el motor no sabe en qué huso está el
   * aparato —tiene que dar el mismo resultado en el simulador— así que la deja
   * tal cual y quien encola la convierte, que sí conoce su reloj. Es la misma
   * regla que sigue `programado` en un despacho.
   */
  programado?: string;

  soloCompleta?: boolean;

  /** Se dispara al guardar, o al pulsar un botón. */
  disparo: 'guardar' | 'boton';

  /** Qué regla lo pidió, para poder decirlo si algo sale mal. */
  regla: string;
}

// ── La notificación que pide un flujo ───────────────────────────────────────

/**
 * Una notificación push que manda una regla, o un botón.
 *
 * Gemela de [CorreoDeFlujo] y escrita a propósito con su misma forma: quien ya
 * configuró un correo reconoce todo esto sin volver a aprenderlo, y el motor
 * resuelve las dos con las mismas piezas.
 *
 * ## En qué se diferencia de un correo, y por qué
 *
 * En una sola cosa de fondo: **un correo va a una dirección y un aviso va a una
 * persona**. A cuál de sus aparatos llega —el teléfono, el navegador, los dos—
 * lo decide el servidor mirando qué sesiones tiene vivas. Ni el diseñador ni el
 * formulario tienen por qué saber con qué equipos ha entrado un compañero, y de
 * hecho no pueden saberlo.
 *
 * De ahí salen las diferencias pequeñas: no hay copia ni copia oculta —no
 * significan nada cuando cada destinatario recibe el suyo—, no hay proveedor
 * —solo hay un canal— y no hay adjuntos, porque una notificación no lleva
 * archivos: lleva **una** imagen, y por dirección. Ver [foto].
 */
export interface PushDeFlujo {
  /**
   * A quién le llega.
   *
   * Se escribe igual que el `para` de un correo —separado por comas y
   * admitiendo `{VARIABLES}`— pero lo que va dentro son **personas**, en
   * cualquiera de estas tres formas mezcladas:
   *
   * | Lo que se escribe | A quién                                        |
   * |-------------------|------------------------------------------------|
   * | `@asignado`       | a quien está asignada la actividad             |
   * | `@creador`        | a quien la creó                                |
   * | `771295`          | a esa persona, por su identificador            |
   * | `{SUPERVISOR}`    | a quien diga ese campo, que ha de dar un id    |
   *
   * ## Por qué las dos palabras se resuelven en el servidor
   *
   * Porque el motor **no sabe de qué actividad cuelga**: tiene que dar el mismo
   * resultado en el simulador del diseñador, donde no hay ninguna. Y el aparato
   * solo conoce a quien tiene el formulario delante, que no siempre es el
   * asignado. Las dos palabras viajan tal cual hasta la cola y allí se cambian
   * por la persona de verdad. Es la misma decisión que toma `despachar` con
   * `quien: 'mismo'`.
   *
   * ## Por qué una cadena y no una lista de identificadores
   *
   * Para no inventar una segunda gramática de destinatarios. Con la misma que
   * el correo, el desplegable de variables del diseñador, la sustitución del
   * motor y el analizador del servidor sirven para los dos sin una sola línea
   * de traducción.
   */
  para?: string;

  /**
   * El renglón grueso del aviso. Admite variables.
   *
   * Se llama `titulo` y no `asunto` porque no lo es: en el teléfono es la línea
   * que se lee de un vistazo con el móvil bloqueado, y lo que no quepa ahí no
   * se lee nunca.
   */
  titulo?: string;

  /**
   * El texto del aviso. Admite variables.
   *
   * **Texto llano, no HTML.** Ni Android ni el navegador pintan etiquetas en
   * una notificación: lo que se escriba con `<b>` sale con los signos a la
   * vista. Por eso las variables aquí no se escapan como en el cuerpo de un
   * correo — no hay marcado que proteger — pero sí se dejan en una línea.
   */
  texto?: string;

  /**
   * El campo del que sale la imagen del aviso.
   *
   * Se guarda el **nombre del campo**, no la dirección: la foto cambia con cada
   * actividad y la dirección solo se conoce al diligenciarla. El motor la
   * resuelve con la misma maquinaria que `{FOTO.url}`.
   *
   * Una sola, y no una lista como los adjuntos de un correo: una notificación
   * enseña una imagen. Si el campo está vacío el aviso sale igual, sin ella —
   * un aviso sin foto sirve; uno que no llega, no.
   */
  foto?: ApiId;

  /**
   * A dónde lleva al tocarlo. Admite variables.
   *
   * Vacío deja el comportamiento de siempre: abre la aplicación por donde
   * estuviera.
   */
  enlace?: string;

  /**
   * Los campos que **tienen** que estar respondidos, o el aviso no sale.
   *
   * Mismo papel que en un correo: evita el aviso a medio escribir, con el hueco
   * de una variable vacío justo donde estaba el dato que importaba.
   */
  exige?: ApiId[];

  /** Sin esto, una sola vez. Ver [CorreoDeFlujo.repetible]. */
  repetible?: boolean;

  /** Solo si la actividad quedó completa. Ver [CorreoDeFlujo.soloCompleta]. */
  soloCompleta?: boolean;

  /** Cuándo sale. Las mismas cinco formas que un correo. */
  cuando?: CuandoSale;
  dias?: number | string;
  dia?: number | string;
  fecha?: string;
  campoFecha?: string;
  hora?: string;
}

/**
 * La notificación **ya escrita**, tal como sale del motor.
 *
 * Gemela de [CorreoPedido]. Aquí las variables ya están puestas, el
 * destinatario resuelto hasta donde el motor puede resolverlo —las dos palabras
 * siguen siendo palabras— y la foto convertida en dirección.
 */
export interface PushPedido {
  /** Con qué se reconoce este aviso entre dos evaluaciones. Ver `llaveDelPush`. */
  llave: string;

  para: string;
  titulo: string;
  texto: string;

  /** La dirección de la imagen, ya resuelta. Vacía si no había foto. */
  foto?: string;

  enlace?: string;

  /** Cuándo sale, en `aaaa-mm-dd hh:mm` y en **hora de pared**, no UTC. */
  programado?: string;

  soloCompleta?: boolean;

  /** Se dispara al guardar, o al pulsar un botón. */
  disparo: 'guardar' | 'boton';

  /** Qué regla lo pidió, para poder decirlo si algo sale mal. */
  regla: string;
}

/**
 * Lo que un botón dispara al pulsarlo.
 *
 * `enviar-push` **todavía no se entrega**. Se configura, se guarda y viaja hasta
 * el formulario, y ahí se dice como pendiente: un botón que anuncia que avisó a
 * alguien y no lo hizo es peor que un botón que no existe, porque quien lo pulsa
 * se va convencido. Ver `BotonPintado.pendientes`, que es como el motor se lo
 * cuenta a quien pinta.
 */
export interface AccionDeBoton {
  que:
    | 'mostrar-graficas'
    | 'enviar-correo'
    | 'enviar-push'
    | 'animar'
    | 'puntuar'
    | 'llamar-servicio';

  /**
   * El servicio que llama, con `que = 'llamar-servicio'`.
   *
   * Es **la misma** configuracion que la accion `llamar-servicio` de una regla,
   * igual que pasa con el correo, el aviso y la puntuacion: el lienzo ensena la
   * misma ficha en los dos sitios y el motor la resuelve con el mismo codigo.
   *
   * ## Por que existe, si una llamada ya puede tener su propio boton
   *
   * Porque aquel es **otro** boton. Una llamada con `disparo: 'boton'` dibuja el
   * suyo, y entonces quien diligencia se encuentra dos. Dentro de un boton, una
   * consulta puede convivir con lo demas que ese boton hace —mandar el correo,
   * ensenar el resumen— en un solo gesto, que es como se piensa desde fuera:
   * «pulso Verificar y pasa todo».
   *
   * ## Y que pasa en un telefono que no conozca esto
   *
   * La llamada **se emite igual** en `Resultado.integraciones`, asi que un
   * cliente viejo la encuentra ahi y le dibuja su propio boton: seguira
   * pudiendo ejecutarla, solo que desde otro sitio. Es a proposito — una accion
   * que un APK antiguo no entiende se ignora en silencio, y eso es lo peor que
   * puede pasarle a una regla.
   */
  servicio?: LlamadaAServicio;

  /** Los nombres de las gráficas que destapa. Ver `Grafica.id`. */
  graficas?: string[];

  /**
   * Las caritas que lanza, con `que = 'animar'`.
   *
   * Es **la misma** configuración que la acción `animar` de una regla, igual que
   * pasa con el correo y el aviso: el lienzo enseña la misma ficha en los dos
   * sitios y el motor la resuelve con el mismo código.
   *
   * ## Por qué tiene sentido en un botón
   *
   * Una regla celebra cuando algo se cumple, y eso está bien al guardar. Pero
   * una calificación se pide: se pulsa «Calificar» y **entonces** se ve el
   * resultado. Celebrar mientras alguien todavía está respondiendo delata la
   * nota antes de tiempo y quita el sentido al acto de pedirla.
   */
  animacion?: Animacion;

  /**
   * La nota que calcula, con `que = 'puntuar'`.
   *
   * La misma [Puntuacion] que usa una regla. Lo que cambia es cuándo se calcula:
   * una regla la recalcula con cada respuesta —y quien diligencia ve la nota
   * moverse mientras contesta, que a veces es justo lo que no se quiere— y un
   * botón la calcula cuando alguien la pide.
   *
   * El campo donde se escribe va en [campo], porque una acción de botón no
   * cuelga de ninguno.
   */
  puntuacion?: Puntuacion;

  /**
   * En qué campo se escribe la nota, con `que = 'puntuar'`.
   *
   * Hace falta aquí y no fuera: el botón se dibuja debajo de los campos, no
   * dentro de uno, así que no hay ningún campo del que colgar la escritura como
   * sí lo hay en una regla.
   */
  campo?: ApiId;

  /**
   * El correo que manda, con `que = 'enviar-correo'`.
   *
   * Es **la misma** configuración que la acción `enviar-correo` de una regla, y
   * a propósito: el lienzo enseña la misma ficha en los dos sitios y el motor lo
   * resuelve con el mismo código. Lo único que cambia es qué lo dispara.
   */
  correo?: CorreoDeFlujo;

  /**
   * La notificación que manda, con `que = 'enviar-push'`.
   *
   * Sub-objeto propio, como [correo], y **no** las tres claves sueltas de
   * abajo: esas las tiene tomadas la forma antigua del correo, y un mismo botón
   * puede llevar las dos acciones. `pushDeBoton`, en el motor, lee las dos
   * formas para que los flujos configurados antes sigan valiendo.
   */
  push?: PushDeFlujo;

  /**
   * A quién va el aviso, en la forma antigua. Ver [push].
   *
   * Los correos guardados con esta forma antigua —`para`, `asunto`, `texto`
   * sueltos— se siguen leyendo: ver `correoDeBoton` en el motor. Sin eso, un
   * flujo configurado antes de que el correo existiera se quedaría mudo al
   * abrirlo.
   */
  para?: string;
  asunto?: string;
  texto?: string;
}

/**
 * Un botón que el flujo dibuja debajo de los campos del formulario.
 *
 * Es la acción `poner-boton`, y **pone uno**. Varios botones son varias
 * acciones, que es como se escribe cualquier otra cosa que se repite en el
 * lienzo; una acción que trajera la lista entera habría necesitado su propio
 * editor anidado para decir lo mismo.
 */
export interface BotonDeAccion {
  /** Lo que se lee dentro del botón. */
  titulo: string;

  estado?: EstadoDeBoton;

  /**
   * Junto a qué campo se dibuja. Vacío, **debajo de todos**.
   *
   * Vacío es el caso corriente y por eso es el de por omisión: un botón suele
   * ser una acción sobre la actividad entera y su sitio es el final, junto a
   * guardar. Elegir un campo es para cuando la acción va **con** una pregunta
   * —«ver el detalle de lo que acabas de responder»— y al final del formulario
   * quedaría a media pantalla de distancia de aquello de lo que habla.
   *
   * Es el `apiId` del campo, igual que en todo lo demás.
   */
  campo?: ApiId;

  /** De qué lado de ese campo. Se ignora sin [campo]. */
  donde?: LadoDelCampo;

  /** La condición de `si-cumple`. Se ignora en los otros tres estados. */
  si?: Grupo;

  /** Lo que dispara al pulsarlo, en orden. */
  hace?: AccionDeBoton[];
}

/**
 * El botón tal como sale del motor: ya decidido si se ve y si se pulsa.
 *
 * El que no se ve **no sale**, igual que una regla que no se cumple no deja
 * rastro: quien pinta dibuja lo que hay, sin volver a preguntar por condiciones.
 */
export interface BotonPintado {
  titulo: string;

  /**
   * La regla que lo puso, para saber cuándo deja de ponerlo.
   *
   * Dos reglas que ponen el mismo título ponen **el mismo** botón y gana la
   * última, así que esta es la de esa última: es la que hay que mirar para
   * saber si el botón sigue pedido.
   */
  regla?: string;

  /**
   * Las llamadas que el botón dispara al pulsarlo.
   *
   * Van **también** en `Resultado.integraciones`, no en su lugar: de ahí salen
   * su estado, su respuesta y su reintento, con la maquinaria de siempre. Aquí
   * se repiten para que quien pinta el botón sepa cuáles son suyas sin tener
   * que cruzar dos listas — y para que un cliente que no las conozca siga
   * encontrándolas por el otro lado.
   */
  llamadas?: LlamadaPintada[];

  /**
   * Junto a qué campo va, y de qué lado. Sin `campo`, debajo de todos.
   *
   * El sitio lo decide el motor y no quien pinta —aunque quien pinta sea el
   * único que sabe dónde acaba un campo— por lo mismo que el resto: es una
   * decisión de la regla, y tomada en cada plataforma acabaría con el botón en
   * un sitio en el teléfono y en otro en el navegador.
   *
   * `donde` solo sale cuando vale `antes`, que es lo que hay que cambiar: como
   * la orientación de una gráfica, lo de siempre no se anota.
   */
  campo?: ApiId;
  donde?: LadoDelCampo;

  /** Se ve pero no se pulsa. */
  soloLectura?: boolean;

  /** Las gráficas que destapa, por su nombre. */
  graficas: string[];

  /**
   * Los correos que encola al pulsarlo, **ya escritos**.
   *
   * Salen resueltos del motor —con las variables puestas y escapadas— por lo
   * mismo que los de una regla: ver [CorreoPedido]. Quien pinta el botón solo
   * tiene que apuntarlos en la cola; no sabe leer un formulario ni tiene por qué.
   *
   * No sale cuando está vacía —que es lo normal, casi ningún botón manda un
   * correo— por lo mismo que `donde`: solo se anota lo que hay que cambiar.
   */
  correos?: CorreoPedido[];

  /**
   * Las caritas que este botón lanza al pulsarlo, ya normalizadas.
   *
   * Mismo trato que [graficas]: el motor decide **qué** se lanza y quien pinta
   * solo lo lanza. Así el navegador y el teléfono celebran igual, y un caso de
   * la batería puede comprobarlo sin tocar una pantalla.
   */
  animaciones?: Animacion[];

  /**
   * La nota que este botón escribe al pulsarlo, y en qué campo.
   *
   * **Ya calculada.** El motor la resuelve al armar el botón —y lo rehace en
   * cada evaluación, así que siempre es la de las respuestas de ahora—; quien
   * pinta solo la escribe cuando alguien pulsa.
   *
   * Se calcula al armar y no al pulsar porque el motor no corre en el momento
   * del toque: quien pulsa está en una pantalla, no en una evaluación. Y como el
   * botón se rearma con cada cambio, la nota nunca está vieja.
   *
   * Ausente cuando la puntuación no se pudo calcular, que es lo mismo que hace
   * una regla: lo que no se puede calcular no toca el campo.
   */
  puntua?: { campo: ApiId; valor: number };

  /**
   * Las notificaciones que este botón manda, ya escritas.
   *
   * Gemela de [correos] y con el mismo trato: quien pinta el botón solo tiene
   * que apuntarlas en la cola. Ver [PushPedido].
   */
  pushes?: PushPedido[];

  /**
   * Lo que el botón dice que hace y **todavía no se hace**.
   *
   * Sale del motor y no lo decide quien pinta, para que el navegador y el
   * teléfono lo digan igual y el día que el aviso se entregue de verdad baste
   * con dejar de anotarlo aquí.
   *
   * El correo salió de esta lista cuando se entregó: ahora va en [correos]. El
   * aviso, después: ahora va en [pushes].
   *
   * La lista se queda —vacía casi siempre— porque es el sitio donde anotar la
   * siguiente promesa que se configure antes de poder cumplirla. Un botón que
   * anuncia algo, no lo hace y no lo confiesa es peor que uno que no existe.
   */
  pendientes: ('correo' | 'push')[];

  /**
   * Por qué el correo de este botón no puede salir ahora mismo.
   *
   * Vacío significa que sí puede. Se recalcula **en cada evaluación**, así que
   * borrar el campo del que salía el destinatario apaga el botón en ese momento
   * y no al pulsarlo — que es lo que se pedía.
   *
   * Lo cuenta el motor y no la pantalla para que el teléfono y el navegador
   * digan exactamente lo mismo, y para que un caso de la batería pueda
   * comprobarlo. Ver `problemasDelCorreo`.
   */
  problemas?: string[];

}

// ── Llamadas a un servicio externo ──────────────────────────────────────────

/**
 * Cuándo sale la llamada.
 *
 * Los mismos dos disparos que tiene un botón, y a propósito: no hay un tercer
 * vocabulario que aprender.
 *
 * - `boton` — sale cuando alguien lo pulsa. Es lo normal para lo que cuesta
 *   dinero o tarda: consultar un padrón, pedir un cupo.
 * - `cambio` — sale cuando la regla se cumple, o sea cuando cambia algo de lo
 *   que la regla mira. Es lo que se quiere para «al escribir la cédula, tráete
 *   el nombre».
 *
 * Quién decide **si** hay que llamar es la condición de la regla, que es la de
 * siempre: aquí solo se dice quién aprieta el gatillo.
 */
export type DisparoDeLlamada = 'boton' | 'cambio';

/**
 * Si hay que esperarla antes de seguir.
 *
 * - `sincrona` — el formulario espera. Se usa cuando lo que responda decide lo
 *   siguiente que hay que contestar, y dejar seguir sería dejar responder
 *   encima de lo que va a llegar.
 * - `asincrona` — se sigue diligenciando mientras tanto.
 *
 * **Para guardar, las dos tienen que haber terminado.** Una actividad que sube
 * con la mitad de los campos que iba a traer el servicio es peor que una que
 * tarda diez segundos más en cerrarse: la primera no se nota hasta que alguien
 * echa de menos el dato, y para entonces ya nadie sabe qué pasó.
 */
export type ModoDeLlamada = 'sincrona' | 'asincrona';

/** Cuánto se espera como mucho, en segundos, cuando la regla no lo dice. */
export const SEGUNDOS_DE_LLAMADA = 20;

/** Y el techo, para que una errata no deje el formulario colgado. */
export const TOPE_DE_SEGUNDOS_DE_LLAMADA = 120;

/**
 * Lo más alto que una regla puede dejar un campo de texto, en líneas.
 *
 * Es el mismo argumento que el techo de una llamada: una errata no puede dejar
 * el formulario inservible. Un `rows` de 200 no es un campo grande, es un campo
 * que ocupa varias pantallas y esconde todas las preguntas que van debajo — y
 * quien diligencia no llega a saber que estaban ahí.
 *
 * Cuarenta líneas son de sobra para el relato más largo que se escribe en
 * campo, y siguen cabiendo con algo más de formulario a la vista.
 */
export const TOPE_DE_LINEAS = 40;

/**
 * Qué se le manda al servicio en una de sus entradas.
 *
 * Dos formas, que son las dos que hacen falta y las mismas de
 * [CampoHeredado]: `de` trae lo que valga un campo del formulario, y `valor`
 * deja una constante. Con las dos escritas manda `de`, por lo mismo de
 * siempre: pedir un campo concreto es más específico que dejar una constante.
 */
export interface EntradaDeLlamada {
  /** La clave que espera el servicio. La dice `GET /integrations`. */
  clave: string;

  /** El `apiId` del campo del que sale el valor. */
  de?: ApiId;

  /** El valor fijo, cuando no sale de ningún campo. */
  valor?: unknown;
}

/**
 * Dónde se escribe un dato de lo que respondió el servicio.
 *
 * `ruta` nombra el dato **dentro** de la respuesta —`cliente.nombre`,
 * `saldos[0].valor`— y vacía significa la respuesta entera, que es lo que se
 * quiere cuando el servicio devuelve un número o un texto a secas. Ver
 * `leerRuta` en el motor, donde está escrito exactamente cómo se lee.
 */
export interface SalidaDeLlamada {
  /** El `apiId` del campo que recibe el dato. */
  campo: ApiId;

  /** Qué dato de la respuesta va ahí. Vacía, la respuesta entera. */
  ruta?: string;
}

/**
 * Llamar a un servicio externo y llenar campos con lo que responda.
 *
 * Es la acción `llamar-servicio`. `valor` es esto.
 *
 * ## Lo que el flujo **no** lleva
 *
 * Ni la dirección del servicio ni ninguna credencial: solo el identificador de
 * la integración y la correspondencia de ida y de vuelta. Un flujo se descarga
 * a todos los teléfonos que sincronizan ese formulario, así que una clave
 * escrita aquí es una clave repartida por ahí. Quien sabe a dónde llamar es el
 * intermediario, y solo él.
 *
 * ## Y lo que no hace el motor
 *
 * Llamar. El motor **decide que hay que llamar y con qué** —deja un [Encargo]
 * con las entradas ya resueltas— y quien ejecuta lo cumple; la respuesta le
 * vuelve al motor como un valor más, con `INTEGRACION:` delante. Es lo mismo
 * que se hace con `crear-actividad` y con `despachar`, y por lo mismo: el
 * motor tiene que dar el mismo resultado en el simulador, donde no hay red.
 */
export interface LlamadaAServicio {
  /** El identificador de la integración en el intermediario. */
  id: string;

  /**
   * Lo que se lee en el botón, y con lo que se la nombra al esperar o al
   * fallar. Vacío, se la nombra por su identificador — que es feo, pero es
   * mejor que un mensaje que habla de «la integración» sin decir cuál.
   */
  titulo?: string;

  disparo?: DisparoDeLlamada;
  modo?: ModoDeLlamada;

  /** Cuánto se espera como mucho. Ver [SEGUNDOS_DE_LLAMADA]. */
  segundos?: number;

  /**
   * Junto a qué campo se dibuja el botón, y de qué lado. Vacío, debajo de
   * todos. Se lee igual que en [BotonDeAccion], y se ignora sin `disparo`
   * de botón.
   */
  campo?: ApiId;
  donde?: LadoDelCampo;

  entradas?: EntradaDeLlamada[];
  salidas?: SalidaDeLlamada[];

  /**
   * ¿Se puede guardar si el servicio dijo que no?
   *
   * Con `exigida`, **no**: hasta que responda bien, la actividad no se cierra.
   * Es para lo que es el motivo de la visita —el cupo que autoriza la entrega—
   * donde guardar sin el dato es guardar algo que no vale.
   *
   * Sin la marca se guarda igual y lo que no llega es el dato. Es lo prudente
   * por omisión, igual que en `despachar`: una regla mal configurada no debe
   * poder dejar a alguien en campo sin poder guardar su trabajo.
   */
  exigida?: boolean;

  /**
   * Lo que se hace **cuando el servicio responde bien**.
   *
   * Las mismas acciones que el `entonces` de una regla, y a propósito: el motor
   * ya sabe ejecutarlas y el lienzo ya sabe pintar su selector. Un mecanismo
   * nuevo para decir «y entonces haz esto» habría sido un segundo vocabulario
   * para lo mismo.
   *
   * Corren **después** de escribir las salidas, para que puedan contar con lo
   * que la respuesta acaba de dejar en los campos: «tráete el importe y, con él
   * puesto, calcula el total». Al revés, la primera acción operaría sobre el
   * campo viejo.
   *
   * Se ejecutan mientras la respuesta siga ahí, no una sola vez: son un
   * **estado**, como todo lo demás del motor. Por eso lo que se pone aquí tiene
   * que poder repetirse sin hacer daño — que es lo que ya cumple cualquier
   * acción del catálogo.
   */
  alResponder?: Accion[];

  /**
   * Y lo que se hace **cuando falla**.
   *
   * Con el motivo a mano: mientras corren, `FALLO:mensaje`, `FALLO:codigo` y
   * `FALLO:reintentable` valen lo que dijo el intermediario, así que un
   * `copiar-de` los deja en un campo y un `avisar` los mete en su texto. Ver
   * [PREFIJO_FALLO].
   *
   * Distinguir «el servicio dijo que no» de «no se pudo preguntar» se hace con
   * `FALLO:codigo`, que es justo lo que decide si tiene sentido reintentar.
   */
  alFallar?: Accion[];

  /**
   * Los «si la respuesta dice esto, entonces…» — el *else if* de la llamada.
   *
   * Son [Tramo] de los de siempre, con el mismo significado: **se prueban en
   * orden y solo se ejecuta el primero que se cumpla**. Es la misma palabra que
   * en una regla porque es la misma idea, y darle aquí otro significado sería
   * tener que aprenderla dos veces.
   *
   * ## Qué pueden preguntar
   *
   * Lo respondido por el servicio, con `RESPUESTA:` delante —
   * `RESPUESTA:titular.estado`, `RESPUESTA:items[*].importe@suma`— además de
   * cualquier campo del formulario. Ver [PREFIJO_RESPUESTA].
   *
   * ## Cuándo corren
   *
   * Solo cuando el servicio respondió bien, y **después** de las salidas y de
   * [alResponder]: así deciden sobre los campos ya llenos, que es lo que se
   * espera de algo que mira lo que acaba de llegar.
   *
   * Parar en el primero es lo que los hace excluyentes. Sin eso, dos tramos que
   * se solapan escribirían los dos en el mismo campo y ganaría el último, que es
   * justo lo que un «si no» pretende evitar.
   */
  tramos?: Tramo[];
}

/**
 * Con qué nombre pregunta un tramo por lo que respondió el servicio.
 *
 * `RESPUESTA:` y detrás **la misma ruta** que se usa para mapear un campo:
 * `RESPUESTA:titular.nombre`, `RESPUESTA:saldos[0].valor`,
 * `RESPUESTA:items[*].importe@suma`. Una sola forma de nombrar un dato de la
 * respuesta, se vaya a escribir en un campo o a comparar en una condición.
 *
 * Al ser **un identificador más**, los quince comparadores que ya existen
 * funcionan sobre la respuesta sin escribir ninguno nuevo, y el editor de
 * condiciones del lienzo sirve tal cual.
 *
 * Solo vale dentro de los tramos de su llamada: fuera no hay ninguna respuesta
 * de la que hablar, y dos llamadas distintas tienen dos respuestas distintas.
 *
 * Lleva dos puntos por lo mismo que las páginas, el estado y las tablas: ningún
 * `apiId` de verdad los tiene.
 */
export const PREFIJO_RESPUESTA = 'RESPUESTA:';

/**
 * Dónde se guarda lo respondido mientras se evalúan los tramos de una llamada.
 *
 * Es un apaño deliberado y acotado: el motor lee valores por identificador, así
 * que para que `RESPUESTA:x` signifique algo hay que dejarle **la respuesta de
 * la llamada que se está resolviendo** en un sitio conocido. Se pone antes de
 * los tramos y se quita después, igual que `FALLO:`.
 *
 * Nadie lo escribe en un flujo: no es un identificador que se ofrezca, es el
 * cajón donde el motor deja el dato mientras lo necesita.
 */
export const DATOS_DE_LA_RESPUESTA = 'RESPUESTA:__datos';

/**
 * Con qué nombre se lee el motivo de un fallo dentro de `alFallar`.
 *
 * `FALLO:mensaje` —el texto ya redactado en español—, `FALLO:codigo` —la palabra
 * con la que se decide— y `FALLO:reintentable`. Solo valen mientras corren esas
 * acciones: fuera no existen, porque fuera no hay ningún fallo del que hablar.
 *
 * Lleva dos puntos por lo mismo que las páginas, el estado y las tablas: ningún
 * `apiId` de verdad los tiene, así que no puede chocar con un campo.
 */
export const PREFIJO_FALLO = 'FALLO:';

/**
 * En qué va una llamada. Es lo que el formulario pinta.
 *
 * - `falta` — todavía no hay con qué llamar: alguna de las entradas sale de un
 *   campo que está sin responder. No es un error, es el estado normal mientras
 *   se diligencia, y decirlo con palabras —«falta la cédula»— es lo que
 *   convierte un botón que no hace nada en uno que explica por qué todavía no.
 * - `pendiente` — hay con qué, y todavía no se ha llamado.
 * - `vuelo` — se está llamando. Mientras tanto no se guarda.
 * - `ok` — respondió, y sus datos ya están escritos en los campos.
 * - `error` — el servicio dijo que no, o no se pudo llegar hasta él.
 */
export type EstadoDeLlamada = 'falta' | 'pendiente' | 'vuelo' | 'ok' | 'error';

/**
 * Una llamada tal como sale del motor: con todo resuelto y su estado a la vista.
 *
 * Va en [Resultado.integraciones] y no en `botones` porque no es un botón: es
 * una cosa que está pasando y que hay que poder contar —esperando, falló, se
 * puede reintentar—. Un botón es solo una de las formas de dispararla.
 */
export interface LlamadaPintada {
  /**
   * Con qué se la reconoce entre una evaluación y la siguiente.
   *
   * Es **lo que pide**, no cuándo se pidió: el identificador de la integración
   * más sus entradas ya resueltas. Ver `llaveDeLlamada` en el motor, donde está
   * el porqué largo — es lo que impide que una regla que se dispara al cambiar
   * un campo, y cuya respuesta escribe un campo, llame al servicio en bucle.
   */
  llave: string;

  /** El identificador de la integración en el intermediario. */
  integracion: string;

  titulo: string;
  disparo: DisparoDeLlamada;
  modo: ModoDeLlamada;
  segundos: number;

  /** Lo que se le manda, ya leído del formulario. */
  entradas: Record<string, string>;

  /**
   * Los binarios que sus entradas llevan, por si hay que ponerlos en linea.
   *
   * ## Por que hace falta decirlo
   *
   * Una entrada que apunta a un campo de fotografia manda **la direccion** de
   * la foto, y esa direccion solo existe cuando el archivo ya esta en el
   * almacen. Recien tomada, la foto vive en el telefono o en el navegador: la
   * direccion se puede escribir, pero todavia no lleva a ninguna parte.
   *
   * Llamar al servicio ahi es mandarle a alguien de fuera una direccion que no
   * resuelve. Lo que contesto la primera vez fue «Unable to process input
   * image», porque lo que habia detras no era una fotografia.
   *
   * El motor no sube nada ni sabe de red — tiene que dar el mismo resultado en
   * el simulador—, asi que **dice cuales son** y quien ejecuta se encarga de
   * garantizarlos antes de llamar.
   *
   * Vacio o ausente cuando ninguna entrada sale de un archivo, que es lo
   * corriente.
   */
  binarios?: string[];

  /** Junto a qué campo va el botón, y de qué lado. Ver [BotonPintado]. */
  campo?: ApiId;
  donde?: LadoDelCampo;

  estado: EstadoDeLlamada;

  /**
   * Qué pasó, con palabras y en español.
   *
   * Solo cuando `estado` es `error`. Lo escribe el servicio —el contrato dice
   * que `mensaje` es texto pensado para enseñárselo a quien está
   * diligenciando— y el motor lo deja pasar tal cual: encontrarse un
   * formulario que no responde y no saber por qué es lo que deja a alguien en
   * campo sin saber si está roto o es a propósito.
   */
  mensaje?: string;

  /**
   * Qué clase de fallo fue, en una palabra.
   *
   * Lo dice el intermediario y es una lista cerrada: `tiempo-agotado`,
   * `no-autorizado`, `no-encontrado`, `servicio-caido`, `respuesta-ilegible`,
   * `peticion-rechazada`, `limite-excedido`, `limite-local-excedido`,
   * `destino-no-permitido`, `respuesta-demasiado-grande`,
   * `demasiadas-redirecciones`, `certificado-invalido`,
   * `configuracion-incompleta`, `error-interno`. Quien ejecuta puede añadir los
   * suyos para lo que pasa antes de llegar al intermediario —quedarse sin red,
   * por ejemplo—, que es la diferencia entre «el servicio dijo que no» y «no se
   * pudo preguntar».
   *
   * Sirve para **decidir**, no para enseñar: lo que se le enseña a quien
   * diligencia es [mensaje], que viene ya redactado en español. Distinguir por
   * el código es lo que permite reintentar solo lo que tiene sentido
   * reintentar.
   */
  codigo?: string;

  /** Si tiene sentido volver a intentarlo. Lo dice el servicio. */
  reintentable?: boolean;

  /** Qué regla la pidió, para poder decirlo si algo sale mal. */
  regla: string;
}

/**
 * Con qué nombre se le devuelve al motor lo que respondió un servicio.
 *
 * `INTEGRACION:<llave>` dentro de `valores`, igual que [ESTADO_DE_LA_ACTIVIDAD]
 * y por el mismo motivo: el motor no llama a nadie, así que la respuesta tiene
 * que entrarle por donde le entra todo lo demás. Y así la batería de casos
 * puede probar una regla con la respuesta enlatada, sin red y sin esperar.
 *
 * Lo que se inyecta es un mapa:
 *
 *     {"estado":"vuelo"}
 *     {"estado":"ok","datos": <lo que respondió el servicio>}
 *     {"estado":"error","mensaje":"...","codigo":"...","reintentable":true}
 *
 * Lleva dos puntos por lo mismo que las páginas, el estado y las tablas: ningún
 * `apiId` de verdad los tiene.
 */
export const PREFIJO_INTEGRACION = 'INTEGRACION:';

/** Una lluvia de caritas subiendo por la pantalla. Ver la acción `animar`. */
/**
 * Qué clase de mensaje es un aviso.
 *
 * ## Por qué el motor decide esto y no la pantalla
 *
 * Porque quien sabe si la cosa va bien o va mal es la regla, no el widget que
 * la dibuja. Hasta ahora todos los avisos salían iguales —del mismo color y con
 * el mismo silencio— y quien está en campo tenía que **leerlos** para saber si
 * acababa de pasar algo grave o le estaban recordando llevar el casco.
 *
 * Los cuatro cubren lo que un aviso puede querer decir: informo, salió bien,
 * ojo con esto, esto está mal.
 */
export type TonoDeAviso = 'info' | 'ok' | 'alerta' | 'error';

/** Los tonos, para poder validar lo que venga guardado en el flujo. */
export const TONOS_DE_AVISO: readonly TonoDeAviso[] = ['info', 'ok', 'alerta', 'error'];

/**
 * Los sonidos que hay.
 *
 * Son **tres**, no cuatro: el error y la alerta comparten el suyo a propósito.
 * Un sonido solo sirve si se distingue sin pensarlo, y cuatro tonos parecidos
 * en el altavoz de un teléfono no se distinguen — se convierten en ruido que
 * la gente acaba silenciando, y entonces no queda ninguno.
 *
 * `ninguno` es para el aviso que tiene que salir callado: uno que se repite en
 * cada página, o uno que acompaña a otro que ya sonó.
 */
export type SonidoDeAviso = 'info' | 'ok' | 'alerta' | 'ninguno';

/** Los sonidos, para poder validar lo que venga guardado en el flujo. */
export const SONIDOS_DE_AVISO: readonly SonidoDeAviso[] = ['info', 'ok', 'alerta', 'ninguno'];

/** Qué suena en cada tono, cuando la regla no pide otra cosa. */
export const SONIDO_DEL_TONO: Record<TonoDeAviso, SonidoDeAviso> = {
  info: 'info',
  ok: 'ok',
  alerta: 'alerta',
  error: 'alerta',
};

/**
 * Un aviso en pantalla, ya resuelto.
 *
 * ## Por qué el sonido viene resuelto y no a medias
 *
 * Porque si el motor dejara el sonido sin decidir —«el que le toque al tono»—
 * esa decisión habría que repetirla en el navegador y en el teléfono, y el día
 * que las dos copias no coincidieran el mismo formulario sonaría distinto según
 * por dónde se diligencie. Es exactamente lo que estos motores existen para
 * evitar. Aquí sale ya decidido y quien lo recibe solo obedece.
 */
export interface Aviso {
  /** Lo que dice, con las variables ya reemplazadas. */
  texto: string;

  /** Qué clase de mensaje es: decide el color y el icono. */
  tono: TonoDeAviso;

  /** Qué suena. Ya resuelto: nunca hay que deducirlo. */
  sonido: SonidoDeAviso;

  /**
   * La regla que lo pidió, para saber cuándo deja de pedirlo.
   *
   * Cuando dos reglas dicen el mismo texto sale **uno solo** y lleva la de la
   * primera: son el mismo mensaje, y quien lo retire será quien lo puso.
   */
  regla?: string;
}

export interface Animacion {
  /** Los emojis que suben. Uno o varios, pegados: `🎉🙂`. */
  figuras: string;

  /** Cuántos a la vez. Con tope: son objetos moviéndose en un teléfono. */
  cuantas: number;

  /** Cuánto dura el viaje, en segundos. */
  segundos: number;

  /** Por dónde entran. Hoy solo `abajo`; se anota para no tener que adivinarlo. */
  desde: string;

  /** La regla que la pidió, para reconocerla entre una evaluación y la siguiente. */
  regla?: string;
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
   * Para casillas de verificación, donde se marca más de una opción.
   *
   * `en-lista` no sirve aquí: compara **toda** la respuesta contra cada valor, y
   * una casilla con dos marcadas vale «Avería, Ruido», que no es igual ni a
   * «Avería» ni a «Ruido». Solo acertaba cuando había exactamente una marcada,
   * que es justo el caso que no hacía falta resolver.
   *
   * Estas dos preguntan por **cada opción por separado** dentro de lo
   * respondido: `contiene-alguna` con que aparezca una basta, `contiene-todas`
   * exige que estén todas. `valor` es una lista, o un texto separado por comas.
   */
  | 'contiene-alguna'
  | 'contiene-todas'
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

  /**
   * Contra **otro campo**, en vez de contra un valor escrito a mano.
   *
   * Es lo que hace posible toda la familia de reglas que compara dos respuestas
   * entre sí: «si la fecha de fin es anterior a la de inicio», «si el peso de
   * salida es menor que el de entrada», «si el código leído no coincide con el
   * del activo». Escrito con un literal, eso no se puede decir: el valor bueno
   * no se conoce hasta que alguien responde.
   *
   * ## Por qué una propiedad aparte y no una marca dentro de `valor`
   *
   * Porque `valor` ya lleva de todo —textos, números, listas de opciones
   * marcadas— y meterle dentro un objeto especial obligaría a reconocerlo en
   * cada sitio que lo lee: los dos motores, el relato de la traza, el lienzo y
   * el texto con el que se dibuja la regla. Una clave nueva y opcional no toca
   * nada de eso: un flujo guardado antes de hoy no la trae, y se comporta
   * exactamente igual que ayer.
   *
   * ## Qué manda si llegan las dos
   *
   * **La referencia.** Un literal que sobrevive al lado suele ser el resto de lo
   * que había antes de cambiar de modo en el lienzo, y darle preferencia haría
   * que la regla comparara contra algo que ya nadie ve escrito. El lienzo borra
   * el que no se usa, pero el motor no puede darlo por hecho.
   *
   * ## Y si el campo apuntado no tiene respuesta
   *
   * La condición **no se cumple**, sea cual sea el comparador. Ver
   * `conLaReferenciaResuelta` en el motor, donde está el porqué largo.
   *
   * Se nombra igual que en `campo`: el `apiId` a secas, `DETALLE:tabla:campo`
   * para lo de una tabla y `FORMULARIO:campo` para mirar fuera de una fila.
   */
  valorCampo?: ApiId;

  /** Lo mismo para el segundo extremo: el «hasta» de `entre`, el radio de `cerca-de`. */
  valor2Campo?: ApiId;

  /**
   * Cuántas filas tienen que cumplirla, cuando [campo] es de una tabla.
   *
   * Se ignora en todo lo demás. Un agregado tampoco lo usa: ya es un número y
   * se compara como cualquier otro.
   */
  filas?: Cuantificador;
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
   * Traer un dato del registro del que nació la fila.
   *
   * Solo dentro de una tabla: `valor` es qué dato se quiere —`LOC_CITY`,
   * `AST_NAME`, `ITE_PRICE`, o cualquier campo propio del tipo— y el motor lo
   * saca del registro que la fila arrastra consigo. Es lo que evita volver a
   * preguntar lo que ya se sabe.
   */
  | 'heredar'
  /**
   * Cuántas filas admite una tabla como mucho.
   *
   * `valor` es el número. Se decide con una regla y no en el diseño del
   * formulario porque casi siempre depende de algo: «si el contrato es básico,
   * cinco equipos como mucho».
   */
  | 'limitar-filas'
  /**
   * Qué se puede hacer con las filas de una tabla: añadir, editar y borrar.
   *
   * `valor` es un [PermisosDeTabla]. Cada permiso va por su cuenta y **el que no
   * se nombra no se toca**, que es lo que permite combinarlos sin repetirlos:
   * una regla quita el de añadir, otra quita el de borrar, y la tabla acaba
   * dejando solo editar sin que ninguna de las dos tenga que saber de la otra.
   *
   * Va aparte de `solo-lectura` porque son cosas distintas. Aquello congela el
   * campo entero; esto reparte permiso por permiso, que es lo que se pide de
   * verdad: «ya está aprobada, se pueden corregir los datos pero no meter ni
   * quitar equipos».
   */
  | 'permisos-tabla'
  /**
   * Deja la actividad entera en solo lectura, con el motivo a la vista.
   *
   * `solo-lectura` es por campo; esta cierra el formulario completo. Es para
   * «si llega ya cerrada, que nadie la toque»: sin ella había que escribir una
   * regla por campo y cualquier campo nuevo se quedaba editable sin que nadie
   * se enterara.
   */
  | 'bloquear-edicion'
  /**
   * Quita el botón de guardar.
   *
   * Distinta de `bloquear-guardado`, que deja intentarlo y explica por qué no
   * se puede. Esta es para cuando guardar no tiene sentido en absoluto y
   * ofrecerlo solo confunde.
   */
  | 'ocultar-guardar'
  /**
   * Quita «Guardar de todos modos».
   *
   * Ese botón es la salida de emergencia cuando faltan campos obligatorios.
   * Hay formularios donde esa salida no debe existir, y hoy no había forma de
   * cerrarla.
   */
  | 'bloquear-guardar-igual'
  /**
   * Las contrarias de las tres de arriba.
   *
   * Hacen falta por lo mismo que `mostrar` acompaña a `ocultar`: sin ellas, la
   * rama `si no` de una regla no tiene con qué deshacer lo que hizo la otra, y
   * una actividad que se bloqueó una vez se quedaba bloqueada aunque la
   * condición dejara de cumplirse.
   *
   * Ganan la última que se ejecute, igual que en los campos.
   */
  | 'permitir-edicion'
  | 'mostrar-guardar'
  | 'permitir-guardar-igual'
  /**
   * El valor de un campo pasa a describir la actividad —o la fila.
   *
   * Los descriptivos son lo que se lee en el listado sin abrir nada: el
   * `JSONTitle` de la actividad y el de cada fila de una tabla tienen la misma
   * forma, `{lab, val}`, así que la acción es una sola y **el destino sale del
   * ámbito de la regla**: en una regla de actividad describe la actividad, en
   * una de fila describe esa fila.
   *
   * `valor` es la etiqueta con la que se enseña. Vacía, quien lo aplica usa la
   * del propio campo.
   */
  | 'usar-descriptivo'
  /**
   * Puntuar una columna de una tabla por lo que respondió cada fila.
   *
   * Resuelve lo que una fórmula no puede: «Bueno vale 3, Regular 2, Malo 0;
   * súmalo de las veinte filas y sácame el promedio». `valor` trae la tabla, el
   * campo, el cuadro de puntos y qué se pide —suma, promedio, máximo, mínimo,
   * cuenta o porcentaje—.
   */
  | 'puntuar-tabla'
  /**
   * Llenar una tabla con unos registros, sin que nadie los elija a mano.
   *
   * El motor solo lo **anota**: crear una fila pide ir a la lista y armarla con
   * la forma que espera el backend, y eso el motor no lo sabe ni debe saberlo.
   */
  | 'llenar-tabla'
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
   *
   * `valor` puede ser el identificador del formulario a secas —así están
   * escritas todas las reglas que ya corren— o una [HerenciaDeActividad], que
   * además dice **qué llega escrito** en la actividad nueva.
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
  | 'dias-permitidos'

  /**
   * Poner una nota de ayuda debajo del campo.
   *
   * `valor` es el texto. Los formularios ya traen una ayuda fija por campo, y
   * esto la reemplaza mientras la regla se cumpla.
   *
   * Va aparte de `mensaje` porque no son lo mismo: aquel es un aviso que sale
   * **porque algo pasó** y se lee como una advertencia; esto es la explicación
   * de la pregunta, que tiene que poder cambiar sin gritar. Dicha una
   * instrucción con el estilo de un aviso, lo que se acaba enseñando es a no
   * leerlos.
   */
  | 'poner-ayuda'

  /**
   * Cuántas líneas de alto tiene un campo de texto largo.
   *
   * `valor` es el número de líneas: el `rows` de toda la vida, decidido con una
   * regla porque el alto que hace falta depende de lo que se vaya a escribir
   * —dos líneas para una nota, quince para el relato de un incidente— y eso no
   * se sabe al diseñar el formulario, sino al saber de qué visita se trata.
   *
   * Hay tope, y no por prudencia: un campo más alto que la pantalla esconde las
   * preguntas de debajo, y quien diligencia no llega a enterarse de que existen.
   */
  | 'poner-lineas'

  /**
   * Entre qué números se puede responder un campo numérico.
   *
   * `valor` es un `{min, max}` y **el extremo que no se nombra no se toca**,
   * igual que en [permisos-tabla]: una regla acota por abajo, otra por arriba, y
   * ninguna de las dos necesita saber de la otra.
   *
   * Es el gemelo de [limitar-desde] y [limitar-hasta] para los números, y va
   * aparte por lo que significan en pantalla: aquellas ponen la primera y la
   * última fecha de un calendario, y un calendario no se acota como un teclado
   * numérico. Metido en las mismas dos acciones, cada cliente habría tenido que
   * mirar el tipo del campo para saber qué quería decir `desde`.
   *
   * Un rango imposible —el mínimo por encima del máximo— no se anota: dejaría el
   * campo sin ningún número válido, y eso desde fuera se lee como un formulario
   * roto y no como una regla mal escrita.
   */
  | 'limitar-numero'

  /**
   * Cuántos caracteres admite un campo de texto.
   *
   * `valor` es un `{min, max}`, con las mismas dos normas que [limitar-numero]:
   * el extremo que no se nombra se queda como esté, y un rango imposible no se
   * anota.
   *
   * El máximo importa porque al otro lado hay una columna con un tamaño: lo que
   * no cabe se corta al subir, y enterarse entonces es enterarse cuando ya no
   * está quien lo escribió. El mínimo es para lo contrario —«si marcas *No
   * cumple*, explica por qué»—, que es lo que impide despachar una observación
   * obligatoria con un punto.
   */
  | 'limitar-caracteres'

  /**
   * Exigir que lo respondido case con una expresión regular.
   *
   * `valor` es un `{patron, mensaje}`. El mensaje no es un adorno: un campo que
   * rechaza lo que se escribe sin decir qué esperaba es un campo con el que no
   * se puede trabajar.
   *
   * El motor **anota y no valida**, igual que con los límites de una fecha:
   * comprobarlo aquí solo diría que está mal la próxima vez que la regla se
   * evalúe, y para entonces el campo ya se escribió entero. Quien lo aplica lo
   * traduce a lo suyo y avisa mientras se teclea.
   *
   * Un patrón que no compila no se anota. Es la misma norma que una fórmula que
   * no se entiende: lo que no se puede ejecutar deja el campo como estaba, que
   * es mejor que un campo que no acepta nada.
   *
   * ## Y si además impide guardar
   *
   * `exigir` lo dice, y **por omisión es que sí**. Un patrón que solo avisa es
   * un patrón que se ignora: quien está en campo con prisa lee el aviso, ve que
   * el botón de guardar sigue ahí, y guarda. Lo que se quería —que la placa
   * llegue con la forma de una placa— no llega, y nadie se entera hasta que
   * alguien intenta cruzarla con otra cosa. Los flujos guardados antes de que
   * esto existiera no traen la clave y pasan a exigir, que es lo que quien los
   * escribió creía estar pidiendo.
   *
   * Con `exigir: false` se queda en aviso, para el caso legítimo: una
   * recomendación de formato sobre un dato que a veces llega de otra manera.
   *
   * **Un campo vacío no lo incumple nunca.** El patrón se comprueba solo cuando
   * hay algo que comprobar; que el campo haya que responderlo o no lo sigue
   * decidiendo `obligatorio`, que es una acción aparte. Sin esta norma,
   * cualquier campo opcional con patrón se volvería obligatorio de hecho, y eso
   * deja a alguien en campo sin poder guardar por una pregunta que nunca tuvo
   * que contestar.
   */
  | 'validar-patron'

  /**
   * Pintar una gráfica dentro del formulario con lo que se lleva respondido.
   *
   * `valor` es una [Grafica]: el tipo, el rótulo y de qué se alimenta cada
   * barra. El motor **cuenta** y quien lo aplica dibuja.
   *
   * Cuelga de un campo porque es lo que ya sabe hacer todo lo demás: el campo
   * decide dónde se pinta, si se ve y si la página que lo contiene está
   * escondida. Una gráfica suelta habría necesitado su propio sitio en la
   * pantalla, sus propias reglas de visibilidad y su propio orden, tres cosas
   * que el formulario ya resuelve para los campos. Es la misma decisión que
   * `poner-imagen`.
   */
  | 'graficar'

  /**
   * Poner un botón dentro del formulario que dispara acciones al pulsarlo.
   *
   * `valor` es un [BotonDeAccion]: su título, cuándo se ve y qué hace.
   *
   * No va sobre un campo, igual que `avisar` o `bloquear-guardado`: se dibuja
   * **debajo de los campos**, donde están las acciones. Ver `Resultado.botones`.
   *
   * Pone **uno**. Varios botones son varias acciones, que es como se escribe en
   * el lienzo cualquier otra cosa que se repite.
   */
  | 'poner-boton'

  /**
   * Llamar a un servicio externo y llenar campos con lo que responda.
   *
   * `valor` es una [LlamadaAServicio]: qué integración, qué se le manda, dónde
   * va lo que vuelve, y si hay que esperarla.
   *
   * No cuelga de un campo —llena varios— así que va con `avisar` y
   * `poner-boton`, entre las que son de la actividad entera.
   *
   * Necesita internet. Eso no se dice en la regla porque no es una opción: un
   * servicio externo al que no se puede llegar es una llamada que falla, y
   * fallar se cuenta con palabras. Ver [LlamadaPintada.mensaje].
   */
  | 'llamar-servicio'

  /**
   * Lanzar caritas subiendo desde abajo.
   *
   * `valor` es una [Animacion], o solo el emoji para el caso corriente. Es lo
   * mismo que `avisar` en su naturaleza —no es de ningún campo, es para quien
   * está diligenciando— pero dice algo que un texto no dice: que la cosa va
   * bien, o que acaba de ir mal. En una inspección de cuarenta preguntas eso es
   * la diferencia entre saber cómo vas y enterarte al final.
   *
   * Se calla mientras se escribe, igual que los avisos y con más motivo: una
   * lluvia de emojis por cada letra no es una celebración, es un formulario que
   * no deja trabajar.
   */
  | 'animar'

  /**
   * Dejar un correo apuntado para que lo mande el servidor.
   *
   * `valor` es un [CorreoDeFlujo]: a quién, con qué asunto, con qué HTML y por
   * qué buzón.
   *
   * **Solo al guardar**, como `crear-actividad` y por lo mismo: un correo no se
   * puede deshacer. Una regla de «al cambiar» que se cumple y se deja de cumplir
   * mientras alguien escribe iría dejando un rastro de correos que ya salieron y
   * que nadie puede retirar. Lo que sí se ofrece es ponerlo en un botón, donde
   * el envío es un acto deliberado de quien diligencia.
   *
   * Y **no desde una fila**: el encargo se generaría igual —el motor no
   * distingue el ámbito— pero quien lo ejecuta mira los de la actividad, así que
   * ahí se perdería sin dejar rastro.
   */
  | 'enviar-correo'
  /**
   * Una notificación push. Ver [PushDeFlujo].
   *
   * Con las mismas dos restricciones que el correo, y por los mismos motivos:
   * **solo al guardar** —un aviso que sale mientras alguien escribe es un aviso
   * que no se puede retirar— y **no desde una fila**, porque quien lo ejecuta
   * mira los de la actividad y allí se perdería sin dejar rastro.
   */
  | 'enviar-push';

export interface Accion {
  accion: TipoAccion;
  /** El campo sobre el que actúa. Vacío en las que son del formulario entero. */
  campo?: ApiId;
  /** El valor a poner, el color, el texto del mensaje o el número de página. */
  valor?: unknown;
  /** Para `copiar-de`: de qué campo se copia. */
  origen?: ApiId;

  /**
   * Para `avisar`: qué clase de mensaje es. Vacío significa `info`.
   *
   * Va aparte de [valor] y no dentro porque `valor` ya es el texto del aviso en
   * todos los flujos que existen hoy. Convertirlo en un objeto dejaría mudos los
   * avisos configurados antes de que esto existiera.
   */
  tono?: TonoDeAviso;

  /** Para `avisar`: qué suena. Vacío significa el que le toque al tono. */
  sonido?: SonidoDeAviso;
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

  /**
   * La nota de ayuda que se lee debajo del campo. Ver `poner-ayuda`.
   *
   * Reemplaza a la que trae el formulario mientras la regla se cumpla. Sin
   * regla no aparece, y el campo sigue enseñando la suya: el motor corrige, no
   * impone.
   */
  ayuda?: string;

  /** Cuántas líneas de alto tiene un campo de texto largo. Ver `poner-lineas`. */
  lineas?: number;

  /**
   * Entre qué números se puede responder. Ver `limitar-numero`.
   *
   * Como los de una fecha, son una **restricción del editor** y no una
   * condición: el motor los anota y el formulario los traduce a lo suyo —el
   * `min` y el `max` de un `input` en el navegador, el teclado y el aviso en el
   * teléfono—. Impedir escribir mal es mejor que avisar después de haberlo
   * escrito.
   */
  minimo?: number;
  maximo?: number;

  /** Cuántos caracteres admite el texto. Ver `limitar-caracteres`. */
  minCaracteres?: number;
  maxCaracteres?: number;

  /**
   * La expresión regular con la que se valida, y qué se lee cuando no cuadra.
   *
   * Sale del motor **ya comprobada** —un patrón que no compila no se anota— para
   * que quien lo aplique pueda usarlo sin envolverlo en un intento. Ver
   * `validar-patron`.
   */
  patron?: string;
  patronMensaje?: string;

  /**
   * ¿Hay que cumplir el patrón **ahora mismo** para poder guardar?
   *
   * Sale siempre resuelto —`true` o `false`, nunca ausente— cuando hay
   * [patron]. Es a propósito: el valor por omisión de `exigir` vive en el motor
   * y en ningún otro sitio, así que el día que cambie no hay que acordarse de
   * los tres clientes. Uno que se lo supiera de memoria se quedaría con el
   * anterior sin que nadie lo notara.
   *
   * Dice «hay que cumplirlo», no «se pidió cumplirlo»: con el campo vacío vale
   * `false` aunque la regla lo exija, porque **un campo vacío no incumple un
   * patrón**. Lo contrario convertiría cualquier campo opcional con patrón en
   * uno obligatorio de hecho. Ver `validar-patron`.
   */
  patronExigido?: boolean;

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

  /**
   * La gráfica que el campo enseña, con **los números ya calculados**.
   *
   * El motor no dibuja —no sabe de píxeles ni debe saberlo— pero sí cuenta. Que
   * la cuenta la haga el motor y no cada plataforma es lo único que garantiza
   * que la barra mida lo mismo en el teléfono que en el navegador; si cada una
   * sumara por su cuenta, tarde o temprano no coincidirían y nadie sabría cuál
   * de las dos miente.
   */
  grafica?: GraficaPintada;

  /**
   * Cuántas filas admite una tabla como mucho.
   *
   * No es una condición sino una restricción del editor, igual que los límites
   * de una fecha: el motor lo anota y el formulario esconde el botón de agregar
   * al llegar.
   */
  maxFilas?: number;

  /**
   * ¿Se pueden añadir filas a esta tabla?
   *
   * `undefined` no es «no»: es que **ninguna regla lo decidió**, y entonces la
   * tabla se comporta como siempre. Es la misma norma que el resto del estado —
   * el motor corrige, no impone— y la que hace que un formulario sin flujo no
   * cambie en nada.
   */
  agregar?: boolean;

  /** ¿Se puede entrar a una fila y cambiar lo respondido? Ver [agregar]. */
  editar?: boolean;

  /** ¿Se pueden borrar filas? Ver [agregar]. */
  eliminar?: boolean;
}

/**
 * Lo que una regla decide sobre los permisos de una tabla.
 *
 * Los tres son opcionales a propósito: se escriben los que la regla quiera
 * cambiar y los demás se quedan como estén. Una acción que los trajera todos
 * obligaría a repetir en cada regla lo que no se quiere tocar, y a la tercera
 * regla nadie sabría cuál manda.
 */
export interface PermisosDeTabla {
  agregar?: boolean;
  editar?: boolean;
  eliminar?: boolean;
}

/**
 * Un campo de la actividad hija que nace con algo escrito.
 *
 * Hay **dos formas de heredar** y las dos hacen falta:
 *
 * - `de` — «trae lo que tenga el campo X del padre». El sitio y la fecha ya
 *   están respondidos arriba; volver a teclearlos es donde se cuelan los
 *   errores.
 * - `valor` — «llega con este valor fijo». Es lo que se quiere para un estado
 *   inicial, un tipo de trabajo o una nota que siempre es la misma.
 *
 * Con las dos escritas manda `de`: pedir un campo concreto es más específico
 * que dejar una constante, y una constante al lado se lee como el respaldo de
 * cuando aquel venga en blanco. Que es justo lo que **no** pasa: si el campo
 * del padre está vacío, no se escribe nada. Ver `herenciaDeActividad` en el
 * motor.
 */
export interface CampoHeredado {
  /**
   * El `apiId` del campo **del formulario hijo**, no del que crea la actividad.
   *
   * Son dos formularios distintos y casi nunca comparten identificadores; por
   * eso el editor pide primero el formulario y luego sus campos.
   */
  campo: ApiId;

  /** El `apiId` del campo del padre del que se trae el valor. */
  de?: ApiId;

  /** El valor fijo, cuando no se trae de ningún campo. */
  valor?: unknown;
}

/**
 * Una tabla de la actividad hija que nace llena.
 *
 * Habla el mismo vocabulario que la acción `llenar-tabla` —`tabla` es el
 * `apiId` del `masterdetail` y `items` los registros de su lista— porque es lo
 * mismo visto desde el otro lado, y dos vocabularios para una idea es la forma
 * segura de que quien configura la aprenda dos veces.
 *
 * Lo que no lleva es `modo`: la actividad hija **nace vacía**, así que añadir y
 * reemplazar son la misma cosa y ofrecer la elección solo invita a pensar que
 * significa algo.
 */
export interface TablaHeredada {
  /** El `apiId` de la tabla del formulario hijo. */
  tabla: ApiId;

  /**
   * El `apiId` de la tabla del padre cuyas filas se traen.
   *
   * Se copian las filas tal como quedaron —con lo respondido dentro— y quien lo
   * ejecuta les da identificadores nuevos: son filas de otra actividad. Solo
   * tiene sentido entre dos tablas que salen **de la misma lista**; con listas
   * distintas los campos de la fila no se llaman igual y lo copiado no se
   * podría leer. Quien lo ejecuta lo comprueba y, si no encajan, no copia nada.
   */
  de?: ApiId;

  /** Registros de la lista con los que se llena, cuando no se copia del padre. */
  items?: { id: string; txt: string }[];
}

/**
 * Una firma, una foto, un vídeo, un audio o un documento que pasa al hijo.
 *
 * Va aparte de [CampoHeredado] porque un binario **no es un valor**: el archivo
 * vive en el disco y su registro cuelga de la actividad, no de la respuesta.
 * Copiarlo como si fuera texto dejaría en el hijo una referencia a un archivo
 * que no es suyo, y el día que se borrara la actividad del padre el hijo se
 * quedaría enseñando un hueco.
 */
export interface BinarioHeredado {
  /** El `apiId` del campo del formulario hijo que recibe el archivo. */
  campo: ApiId;

  /** El `apiId` del campo del padre de donde sale. Vacío, el mismo nombre. */
  de?: ApiId;
}

/**
 * Lo que la actividad hija recibe ya escrito.
 *
 * Antes esta acción solo llevaba el formulario, y la actividad nueva nacía en
 * blanco: quien la abría volvía a teclear la sede, la fecha, el cliente y el
 * responsable, que ya estaban respondidos en el formulario de arriba.
 *
 * ## Qué resuelve el motor y qué no
 *
 * Los **campos** salen resueltos: el motor lee el padre y deja el texto hecho,
 * igual que hace con el destinatario de una consigna. Quien crea la actividad
 * no tiene que volver a leer nada.
 *
 * Las **tablas** y los **binarios** salen como una correspondencia —«de esta
 * tabla a esta otra»—, no resueltos. Copiar una fila es armarla con la forma
 * que espera el backend y copiar un binario es mover un archivo del disco: dos
 * cosas que el motor no sabe ni debe saber, porque tiene que dar el mismo
 * resultado en el simulador, donde no hay ni base ni disco.
 */
export interface HerenciaDeActividad {
  /** El formulario del que nace la actividad. */
  formulario: string;

  campos?: CampoHeredado[];
  tablas?: TablaHeredada[];
  binarios?: BinarioHeredado[];
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
  que:
    | 'crear-actividad'
    | 'cambiar-estado'
    | 'despachar'
    | 'llenar-tabla'
    /**
     * Una llamada a un servicio externo que **está por hacer**.
     *
     * Solo sale cuando falta: en cuanto la respuesta está inyectada, el motor
     * deja de pedirla. Así la lista de encargos es literalmente «lo que queda
     * por llamar» y quien ejecuta no tiene que llevar la cuenta de lo que ya
     * hizo para no repetirlo. `valor` es una [LlamadaPintada].
     */
    | 'llamar-servicio'
    /**
     * Un correo que hay que **encolar**. `valor` es un [CorreoPedido].
     *
     * Encolar, no enviar: el motor no manda correos —no sabría por dónde, y las
     * credenciales no bajan al aparato— y quien lo ejecuta tampoco. Lo apunta y
     * lo manda el servidor. Ver [CorreoDeFlujo].
     */
    | 'enviar-correo'
    /**
     * Una notificación que hay que **encolar**. `valor` es un [PushPedido].
     *
     * Encolar, no enviar: el motor no manda avisos —no sabría a qué aparatos, y
     * eso solo lo sabe el servidor mirando las sesiones vivas de cada persona—.
     * Lo apunta y lo manda el servidor. Ver [PushDeFlujo].
     */
    | 'enviar-push';
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
   * Qué reglas se **miraron**, cumplieran o no.
   *
   * ## Por qué no basta con [disparadas]
   *
   * Porque una regla que se evalúa y **deja de cumplirse** no aparece ahí, y es
   * justo la que hay que poder limpiar: si lo que puso antes no se retira, su
   * botón —o su aviso, o su lluvia— se queda en pantalla para siempre.
   *
   * ## Para qué sirve
   *
   * Una evaluación es **parcial**: al responder un campo solo se miran las
   * reglas que preguntan por él. Quien guarde lo que el flujo pide tiene que
   * poder distinguir «esta regla ya no lo pide» de «a esta regla no se la ha
   * preguntado», y sin esta lista las dos se ven igual. Confundirlas cuesta un
   * fallo en un sentido o en el otro: o se queda pegado lo que debería irse, o
   * desaparece lo que debería quedarse.
   */
  evaluadas: string[];

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

  /**
   * Avisos que hay que enseñar en pantalla. Ver la acción `avisar`.
   *
   * Cada uno trae su tono y su sonido ya resueltos. Antes eran textos sueltos y
   * todos salían iguales; ver [Aviso] para por qué se decide aquí.
   */
  avisos: Aviso[];

  /**
   * Los botones que el flujo dibuja **debajo de los campos**, en orden.
   *
   * ## Por qué aquí y no colgando de un campo
   *
   * Una gráfica cuelga de un campo porque es el resumen de **eso** que se está
   * respondiendo, y quiere estar al lado. Un botón no: es una acción sobre la
   * actividad entera —enseñar el resumen, avisar a alguien— y su sitio es donde
   * están las acciones, al final, junto a guardar. Colgado de un campo se leería
   * como parte de la pregunta y aparecería en mitad del formulario, que es justo
   * donde nadie lo busca.
   *
   * Se reemplazan **por título**: dos reglas que pongan el mismo botón ponen
   * uno, y gana la última que se ejecute. Dos botones que dicen lo mismo no dan
   * a elegir nada, dan a dudar.
   */
  botones: BotonPintado[];

  /**
   * Las llamadas a servicios externos que el flujo quiere, y en qué van.
   *
   * ## Por qué una lista aparte y no unos botones o unos avisos
   *
   * Porque una llamada **no es una de las dos cosas**: es algo que está
   * pasando. Tiene un botón cuando se dispara pulsando, pero también tiene un
   * «esperando», un «falló porque el documento no existe» y un «se puede
   * reintentar», y nada de eso cabe en un `BotonPintado`. Metido en `avisos`
   * sería peor: los avisos se callan mientras se escribe —con razón, si no
   * saldrían en cada tecla— y un error de integración que se calla es un
   * formulario que no responde sin decir por qué.
   *
   * Salen **todas** las que el flujo pide, en cualquier estado. Las que están
   * por hacer salen además como [Encargo], que es lo que dispara la llamada.
   *
   * Se recalcula entera en cada evaluación, como todo lo demás: una llamada
   * cuya regla deja de cumplirse desaparece sola.
   */
  integraciones: LlamadaPintada[];

  /**
   * Caritas que suben por la pantalla cuando algo sale bien —o mal.
   *
   * El motor no anima nada: anota **qué** habría que lanzar y quien llama lo
   * hace. Es la misma norma que los avisos, y aquí importa más todavía, porque
   * una animación es un **momento** y el resultado es un **estado**: el flujo se
   * recalcula en cada tecla y esta lista sale igual mientras la condición siga
   * cumpliéndose. Quien la aplique tiene que lanzarla cuando aparece y no volver
   * a lanzarla mientras siga ahí; por eso cada una lleva la regla que la pidió,
   * que es lo que permite reconocerla entre una evaluación y la siguiente.
   */
  animaciones: Animacion[];

  /**
   * Motivos por los que la actividad no se puede editar. Vacío: sí se puede.
   *
   * Se guardan los motivos y no un simple `true` por lo mismo que en
   * `bloqueos`: encontrarse un formulario que no responde y no decir por qué
   * deja a alguien en campo sin saber si está roto o es a propósito.
   */
  edicionBloqueada: string[];

  /** Alguna regla pidió esconder el botón de guardar. */
  guardarOculto: boolean;

  /** Alguna regla pidió cerrar la salida de «Guardar de todos modos». */
  guardarIgualBloqueado: boolean;

  /**
   * Lo que el flujo quiere que describa a la actividad —o a la fila.
   *
   * Se anotan y no se escriben: el motor no sabe dónde vive el `JSONTitle` ni
   * debe saberlo. Se recalculan enteros en cada evaluación, así que uno que deja
   * de cumplirse desaparece solo, como el resto.
   */
  descriptivos: { campo: ApiId; lab: string; val: string }[];

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

  /**
   * El `id` interno del campo, cuando es de un sub-formulario.
   *
   * Una fila guarda sus respuestas **por `id`** y una regla las pide por
   * `apiId`, que es lo que se ve al escribirla. Los dos hacen falta, y solo
   * aquí: en el formulario de la actividad los valores llegan ya traducidos.
   */
  id?: string;

  fty: string;

  /**
   * La direccion que pinta un campo de tipo `image`.
   *
   * Un campo de imagen no se responde: **enseña** lo que haya en una URL, y esa
   * URL vive en la definicion del formulario, no en la respuesta. Por eso hace
   * falta aqui: sin ella el motor lee el valor respondido, lo encuentra vacio, y
   * un aviso que iba a llevar esa foto sale sin ninguna.
   *
   * Una regla puede cambiarla con `poner-imagen`; eso se refleja en
   * [EstadoCampo.imagen] y no toca esto, que es la de partida.
   */
  url?: string;

  /**
   * Opciones de un radio o una casilla, para poder comparar por texto.
   *
   * `puntos` es lo que vale la opción cuando se promedia una encuesta. Es
   * opcional y sin declararlo no cambia nada: solo lo miran las reglas que
   * piden `segunOpcion`, y aun entonces hay dos formas más de sacar el número
   * —ver `puntosDeLaOpcion` en el motor— para no obligar a rellenarlo en las
   * escalas que ya se configuran escribiendo «1», «2», «3».
   */
  opt?: { id?: string; txt?: string; val?: string; puntos?: number | string }[];
  pagina?: number;

  /**
   * Esto no es un campo: es una página entera del formulario.
   *
   * Se puede esconder o dejar en solo lectura como si fuera uno, y lo que se
   * decida sobre ella cae sobre **todos sus campos**.
   */
  esPagina?: boolean;

  /**
   * ¿El esquema pide este campo?
   *
   * Solo hace falta en los campos de un sub-formulario, y para una cosa: contar
   * qué filas están completas.
   */
  obligatorio?: boolean;

  /**
   * El sub-formulario de una tabla de detalle: los campos de cada fila.
   *
   * Hace falta para traducir entre el `apiId` que dice la regla y el `id` con
   * el que la fila guardó su respuesta. Vacío en todo lo que no sea una tabla.
   */
  detalle?: Campo[];
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
   * Qué hora es, en el reloj de quien diligencia (`aaaa-mm-dd hh:mm`).
   *
   * Solo la usa la programación de una consigna: «dentro de dos días», «el 5
   * del mes». Se recibe en vez de leerla del sistema por dos motivos que van
   * juntos: el motor tiene que dar el mismo resultado en el simulador que en un
   * teléfono —si no, la batería de casos no podría comprobar nada— y la hora
   * buena es la del aparato, que es el único que sabe en qué huso está.
   *
   * Sin ella, una regla que programa en relativo no programa: sale ya.
   */
  ahora?: string;

  /**
   * Con qué se arma la dirección de un archivo, para poder meterla en un correo.
   *
   * `https://and.visitrack.com/WebResource.aspx` — la plataforma sirve un
   * binario por su GUID. Se recibe en vez de escribirla aquí por lo mismo que
   * [ahora]: el motor tiene que dar el mismo resultado en el simulador que en
   * un teléfono, y un host escrito dentro haría que la batería de casos
   * dependiera de un dominio.
   *
   * Sin ella, `{FOTO.url}` se queda vacío. Es lo correcto: mejor un hueco que
   * una dirección inventada que quien reciba el correo va a pulsar.
   */
  urlDeBinarios?: string;

  /**
   * Sobre qué se está evaluando: la actividad, o **una fila** de una tabla.
   *
   * Una fila es un formulario pequeño con su propio mundo: sus campos, sus
   * respuestas y sus reglas. Evaluándolo con las reglas de la actividad, una
   * regla que habla de «Observaciones» decidiría a la vez sobre la de arriba y
   * sobre las de dentro, que casi nunca es lo que se quiso.
   */
  ambito?: Ambito;

  /** La tabla cuyas filas se están evaluando, cuando [ambito] es `fila`. */
  tabla?: ApiId;

  /**
   * El registro del que nació la fila, cuando [ambito] es `fila`.
   *
   * Es lo que hace posible el llenado automático: la acción `heredar` saca de
   * aquí la ciudad de la sede o el precio del ítem sin que el formulario haya
   * vuelto a preguntarlos. Lleva `LocationInfo`, `AssetInfo` e `itemsInfo` tal
   * como los guarda la fila.
   */
  origen?: Record<string, unknown>;

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

/**
 * Con qué nombre se refiere una regla **de fila** a un campo del formulario.
 *
 * Dentro de una fila el mundo es la fila: `OBSERVACIONES` es el campo de la
 * fila, no el de arriba. Pero hace falta poder mirar hacia afuera —«si el tipo
 * de servicio es Garantía, en cada fila esconde el precio»— y para eso el campo
 * de arriba se nombra con este prefijo.
 *
 * Lleva dos puntos por lo mismo que las páginas, el estado y las tablas: ningún
 * `apiId` de verdad los tiene, así que no puede chocar con un campo de la fila
 * aunque los dos se llamen igual. Que es justo el caso que hay que resolver.
 */
export const PREFIJO_FORMULARIO = 'FORMULARIO:';
