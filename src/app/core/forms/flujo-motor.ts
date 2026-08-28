/*
 * ⚠️  COPIA SINCRONIZADA. NO EDITAR AQUÍ.
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
  Contexto,
  EstadoCampo,
  Flujo,
  Grupo,
  ModoTexto,
  Puntuacion,
  Regla,
  Resultado,
  Tramo, PasoDeCondicion, PasoDeRegla } from './flujo-modelo';

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

export function evaluar(flujo: Flujo, contexto: Contexto): Resultado {
  const resultado: Resultado = {
    campos: {},
    bloqueos: [],
    disparadas: [],
    encargos: [],
    pisadas: [],
    avisos: [],
    enEspera: [],
    ciclo: false,
    conflictos: [],
  };

  const vivas = (flujo?.reglas ?? []).filter((r) => r.activa !== false);

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
  const generales = contexto.momento === 'guardar' ? vivas.filter((r) => r.general) : [];

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
    resultado.encargos = [];
    resultado.pisadas = [];
    resultado.avisos = [];
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

        aplicar(accion, resultado, valores, contexto.campos, regla.id, puedeAvisar, iniciales, String(contexto.ahora ?? ''));

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
      cerrar(generales, resultado, valores, contexto.campos, puedeAvisar, String(contexto.ahora ?? ''));
      expandirPaginas(resultado.campos, contexto.campos);
      resultado.campos = limpiar(resultado.campos);
      return resultado;
    }
  }

  resultado.ciclo = true;
  cerrar(generales, resultado, valores, contexto.campos, puedeAvisar, String(contexto.ahora ?? ''));
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
): void {
  for (const regla of generales) {
    // También aquí: una general puede esperar a otra general anterior.
    if (regla.tras && !resultado.disparadas.includes(regla.tras)) continue;

    const cumple = evaluarGrupo(regla.si, valores, campos);
    const acciones = (cumple ? regla.entonces : regla.sino) ?? [];

    if (cumple) resultado.disparadas.push(regla.id);

    for (const accion of acciones) {
      /*
       * Las generales sí leen el valor vivo, también para el campo que escriben:
       * una que acumula sobre lo que dejó la anterior es el caso normal aquí, y
       * como corren una sola vez no hay nada que se dispare.
       */
      aplicar(accion, resultado, valores, campos, regla.id, puedeAvisar, valores, ahoraDelCierre);
    }
  }
}

/** Las acciones que dejan un valor en el campo. */
const ESCRIBEN_VALOR = new Set(['poner-valor', 'limpiar', 'copiar-de', 'calcular', 'puntuar']);

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
      esperaba: c.valor === undefined ? '' : String(c.valor),
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
  const crudo = valores[cond.campo];
  const texto = comoTexto(crudo, campos[cond.campo]);
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
      return compararOrden(cond.cmp, texto, cond.valor, cond.valor2, campos[cond.campo]);

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
    const cuantos = Math.trunc(Number(config['dias'] ?? 0));
    if (!Number.isFinite(cuantos) || cuantos < 0) return '';

    return armarMomento(a, mes, dia + cuantos, hora);
  }

  if (cuando === 'mesdia') {
    const elegido = Math.trunc(Number(config['dia'] ?? 0));
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
function aNumero(texto: string): number | null {
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


function aplicar(
  accion: Accion,
  resultado: Resultado,
  valores: Record<ApiId, unknown>,
  campos: Record<ApiId, Campo>,
  regla = '',
  puedeAvisar = true,
  iniciales: Record<ApiId, unknown> = {},
  ahora = '',
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

  if (accion.accion === 'crear-actividad' || accion.accion === 'cambiar-estado') {
    const yaEsta = resultado.encargos.some(
      (e) => e.que === accion.accion && JSON.stringify(e.valor) === JSON.stringify(accion.valor),
    );

    // Sin repetir: dos reglas que piden el mismo cambio de estado son un
    // cambio de estado, no dos.
    if (!yaEsta) {
      resultado.encargos.push({ que: accion.accion, valor: accion.valor, regla });
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

    const aviso = String(accion.valor ?? '').trim();

    // Sin repetir: dos reglas que dicen lo mismo son un aviso, no dos.
    if (aviso && !resultado.avisos.includes(aviso)) resultado.avisos.push(aviso);

    return;
  }

  // Las que no son de un campo concreto.
  if (accion.accion === 'bloquear-guardado') {
    const motivo = String(accion.valor ?? 'Falta algo por resolver');
    if (!resultado.bloqueos.includes(motivo)) resultado.bloqueos.push(motivo);
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
    case 'mensaje': estado.mensaje = String(accion.valor ?? ''); break;

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
    case 'poner-texto': estado.texto = String(accion.valor ?? ''); break;

    /*
     * La imagen que enseña un campo, por su dirección.
     *
     * Los campos de tipo imagen pintan lo que haya en una URL. Cambiarla desde
     * una regla permite que el formulario enseñe el plano, la ficha o el ejemplo
     * que toca según lo que se vaya respondiendo.
     */
    case 'poner-imagen': estado.imagen = String(accion.valor ?? ''); break;

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

    case 'poner-valor':
      estado.valor = accion.valor;
      valores[apiId] = accion.valor;
      break;

    case 'limpiar':
      estado.valor = '';
      valores[apiId] = '';
      break;

    case 'copiar-de': {
      if (!accion.origen) break;

      const copiado = comoTexto(valores[accion.origen], campos[accion.origen]);
      estado.valor = copiado;
      valores[apiId] = copiado;
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
export function camposDeLaRegla(regla: Regla): string[] {
  const usados = new Set<string>();

  const mirar = (grupo: any): void => {
    for (const c of grupo?.cond ?? []) {
      if (c?.cond) mirar(c);
      else if (c?.campo) usados.add(String(c.campo));
    }
  };

  mirar((regla as any).si);

  for (const tramo of (regla as any).sinoSi ?? []) mirar(tramo?.si);

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
      if (c?.cond) mirar(c);
      else if (c?.campo) usados.add(String(c.campo));
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
    const texto = comoTexto(valores[nombre], campo);

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
  const piezas = (formula ?? '').match(/\d+\.?\d*|[A-Za-z_][A-Za-z0-9_]*|[+\-*/%(),]/g);
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

  let suma = 0;
  let cuentan = 0;
  let excluidas = 0;

  for (const apiId of config.campos) {
    const texto = comoTexto(valores[apiId], campos[apiId]);
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
    if (!tabla.has(clave)) continue;

    suma += tabla.get(clave)!;
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
  const tope = Math.max(...tabla.values());
  if (!tope) return null;

  return redondear((suma / (cuentan * tope)) * 100);
}
