import { computed, signal } from '@angular/core';

import {
  ActiveSection,
  AnswerField,
  FieldValue,
  FormField,
  FormPage,
  ResolvedDescriptor,
  asFile,
  asGeo,
  asOption,
  asOptions,
  fileValueOf,
  findMissingRequired,
  isDisplayOnly,
  isEmptyValue,
  isFieldVisible,
  parseAnswerFields,
  parseQuestions,
  splitFileValue,
} from './form-schema';
import { ValueReader, computeDerived, derivedFieldsOf } from './derived-fields';
import {
  InheritedSource,
  inheritsDefault,
  resolveInheritedDefault,
  valoresDelEntorno,
} from './inherited-defaults';
import { Campo, Encargo, EstadoCampo, Flujo, Momento, Resultado, ESTADO_DE_LA_ACTIVIDAD } from './flujo-modelo';
import {
  camposDeLaRegla,
  camposDeLasReglas,
  camposQueDecideLaRegla,
  comoLoGuarda,
  comoTexto,
  evaluar,
} from './flujo-motor';

/**
 * Cuántas veces se rehacen los campos calculados antes de rendirse.
 *
 * Cada pasada resuelve un nivel de dependencia —el total, y encima el
 * impuesto—. Cinco cubren de sobra cualquier formulario real y ponen freno a
 * una fórmula que se alimente de sí misma.
 */
const DERIVED_PASSES = 5;

/** Lo que hace falta para arrancar el motor. */
export interface FormEngineInput {
  /** `Surveys.JSONQuestion`, sin parsear. */
  questions: unknown;
  /** `SurveyAnswers.Fields`, sin parsear. */
  answers: unknown;

  /**
   * El registro del que este formulario hereda datos.
   *
   * En una actividad, su ubicación y su activo; en una fila de tabla de
   * detalle, el ítem del que nació. De ahí salen los valores por defecto que el
   * esquema marca con `defaultIsLocationField` y compañía — la dirección de la
   * sede, el código del equipo— para no volver a preguntar lo que ya se sabe.
   */
  inherits?: InheritedSource;

  /**
   * El formulario solo se consulta: no se va a diligenciar ni a guardar.
   *
   * Cambia una cosa, y es importante: **no se aplican valores por defecto**. En
   * una actividad que se está llenando, un `def` es una ayuda que el usuario
   * puede cambiar y que se acabará guardando. En una que se consulta meses
   * después sería una respuesta que nadie dio, indistinguible de las de verdad.
   * Lo que no se respondió tiene que verse vacío.
   */
  readOnly?: boolean;

  /**
   * El flujo de trabajo que aplica a este formulario, si lo hay.
   *
   * Lo trae `FlujoService` desde lo que bajó la sincronización. Sin flujo, el
   * formulario se comporta como siempre.
   */
  flujo?: Flujo | null;
}

/**
 * Motor de diligenciamiento de un formulario.
 *
 * Lleva el estado de una actividad abierta: qué vale cada campo, qué secciones
 * están activas, qué página se está viendo y qué falta por responder.
 *
 * ## Por qué es una clase y no un servicio
 *
 * El estado pertenece **al formulario abierto**, no a la aplicación. Con un
 * servicio de raíz habría que acordarse de limpiarlo al salir, y la actividad
 * siguiente heredaría los valores de la anterior — el tipo de fallo que aparece
 * solo cuando alguien diligencia dos seguidas y se descubre tarde. Instanciarlo
 * por formulario hace imposible ese caso.
 *
 * ## Qué NO hace
 *
 * No guarda. Emite qué cambió y quien lo usa decide cuándo persistir; así el
 * motor se puede probar sin base de datos y la política de autoguardado vive en
 * un solo sitio.
 */
export class FormEngine {
  /** Páginas visibles del formulario. */
  readonly pages: FormPage[];

  /** Valores actuales, por id de campo. */
  private readonly values = signal(new Map<string, FieldValue>());

  /**
   * Secciones activas.
   *
   * Una por campo activador: elegir otra opción del mismo campo reemplaza la
   * suya en vez de acumular, porque una selección única no puede tener dos
   * ramas abiertas a la vez.
   */
  private readonly sections = signal<ActiveSection[]>([]);

  /** Página que se está viendo, empezando en 0. */
  readonly page = signal(0);

  /** Campos que se han tocado. Se usa para no exigir antes de tiempo. */
  private readonly touched = signal(new Set<string>());

  /** true una vez que se intenta guardar: a partir de ahí se marca todo. */
  readonly submitted = signal(false);

  /**
   * true si al arrancar se aplicó algún valor por defecto que no estaba
   * guardado.
   *
   * Quien crea el motor debe persistir en ese caso: si el usuario abre el
   * formulario, no toca nada y guarda, los valores de fábrica tienen que quedar
   * escritos. Es lo que hace la app móvil, que los graba nada más cargar el
   * campo.
   */
  readonly appliedDefaults: boolean;

  /** Algún campo calculado dio un resultado distinto al guardado. */
  private recalculated = false;

  /** El registro del que se heredan valores. Vacío si no cuelga de ninguno. */
  private readonly inherits: InheritedSource;

  /** Campos que se calculan solos, localizados una vez. */
  private readonly derived: FormField[];

  /** Solo consulta: ver [FormEngineInput.readOnly]. */
  private readonly readOnly: boolean;

  // ── Flujo de trabajo ──────────────────────────────────────────────────────

  /** Las reglas que aplican, si el formulario tiene flujo. */
  private readonly flujo: Flujo | null;

  /** Lo que el flujo decidió sobre cada campo, por `id` de campo. */
  private readonly estadoFlujo = signal(new Map<string, EstadoCampo>());

  /**
   * En qué estado está la actividad, para poder preguntarlo en una condición.
   *
   * Lo mantiene al día la pantalla, que es la que conoce la actividad: el motor
   * solo sabe de campos.
   */
  readonly estadoActividad = signal('');

  /**
   * Cuántas veces le ha reescrito el flujo el valor a cada campo.
   *
   * Va en la clave del `@for` que dibuja los campos: al subir, ese campo —y
   * solo ese— se rehace. Ver [escribirLoQueElFlujoPuso] para el porqué.
   */
  private readonly sellos = signal<Record<string, number>>({});

  /** El sello de un campo, para la clave del `@for`. */
  selloDe(id: string): number {
    return this.sellos()[id] ?? 0;
  }

  /** Los avisos que hay que enseñar, con las mismas llaves que lo demás. */
  private readonly avisosPorMomento = signal<Record<string, readonly string[]>>({});

  /**
   * Todo lo que el flujo quiere avisar ahora mismo, sin repetir.
   *
   * Es una señal para que la pantalla reaccione en cuanto aparezca uno: un aviso
   * que llega tarde ya no informa de nada.
   */
  readonly avisosDelFlujo = computed<string[]>(() => {
    const porMomento = this.avisosPorMomento();

    return [...new Set(this.enOrden(Object.keys(porMomento)).flatMap((k) => porMomento[k] ?? []))];
  });

  /** Lo que decidió cada momento por separado. Ver [correrFlujo]. */
  private readonly porMomento = new Map<string, Map<string, EstadoCampo>>();

  /**
   * Lo que pidió cada momento por su cuenta. Ver [correrFlujo].
   *
   * Por momento y no todo junto, por lo mismo que los campos: un estado puesto
   * por una regla de «al cambiar» tenía que sobrevivir a la evaluación de «al
   * guardar». Quedándose solo con la última, guardar borraba el estado que el
   * flujo había puesto mientras se diligenciaba.
   */
  private readonly encargosPorMomento = signal<Record<string, readonly Encargo[]>>({});

  /** Todo lo pedido, en el orden en que ocurren los momentos. */
  private readonly encargosDeFlujo = computed<readonly Encargo[]>(() => {
    const porMomento = this.encargosPorMomento();

    return this.enOrden(Object.keys(porMomento)).flatMap((k) => porMomento[k] ?? []);
  });

  /**
   * El estado al que el flujo quiere pasar la actividad, o `null`.
   *
   * `null` no significa «déjalo como está»: significa que **ninguna regla pide
   * un estado ahora mismo**. Si el flujo se lo había cambiado antes, hay que
   * devolverlo a como estaba — una regla que deja de cumplirse tiene que
   * deshacer lo que hizo, igual que con un campo que vuelve a verse.
   *
   * Es una señal y no un método para que la pantalla pueda reaccionar en
   * cuanto cambie: un estado puesto por una regla de «al cambiar» tiene que
   * verse al momento, no al guardar.
   */
  readonly estadoDelFlujo = computed<string | null>(() => {
    let pedido: string | null = null;

    for (const encargo of this.encargosDeFlujo()) {
      if (encargo.que !== 'cambiar-estado') continue;

      const valor = String(encargo.valor ?? '').trim();
      if (valor) pedido = valor;
    }

    return pedido;
  });
  private readonly bloqueosPorMomento = new Map<string, readonly string[]>();

  /**
   * Junta lo que decidió cada momento, del más general al más concreto.
   *
   * «Al abrir» pone el estado de partida, «al cambiar» reacciona a lo que se
   * responde y «al guardar» tiene la última palabra: es el orden en que ocurren
   * y por tanto el orden en que uno espera que se pisen.
   */
  private combinarMomentos(): Map<string, EstadoCampo> {
    const salida = new Map<string, EstadoCampo>();

    for (const llave of this.enOrden([...this.porMomento.keys()])) {
      for (const [id, estado] of this.porMomento.get(llave) ?? []) {
        salida.set(id, { ...salida.get(id), ...estado });
      }
    }

    return salida;
  }

  /**
   * Olvida lo que decidieron en otras pasadas las reglas que se acaban de
   * evaluar.
   *
   * ## Por qué hace falta
   *
   * Cada pasada se guarda en su propio cajón —`abrir`, `cambia:GESTION`,
   * `guardar`— y eso es lo que permite que responder una cosa no borre lo que
   * decidieron las reglas de otra. Pero una regla marcada **en dos momentos**
   * decide en dos cajones distintos sobre los mismos campos, y ahí se rompía:
   *
   * Una regla «al abrir y al cambiar» que esconde un campo lo escondía al
   * entrar. Al responder, la regla se volvía a evaluar, su condición ya no se
   * cumplía y no decidía nada… pero lo que había decidido al abrir seguía en su
   * cajón, así que el campo no volvía a aparecer nunca. Deshacer funcionaba
   * solo cuando las dos evaluaciones caían en el mismo cajón.
   *
   * Así que cuando una regla se evalúa, lo que decidió antes se tira: sus
   * decisiones viven en la última pasada que la miró, y en ninguna otra.
   */
  private olvidarLoViejoDe(momento: Momento, campoQueCambio: string | undefined, llave: string): void {
    const evaluadas = (this.flujo?.reglas ?? []).filter((regla) => {
      if (regla.activa === false) return false;
      if (regla.general) return momento === 'guardar';
      if (!regla.cuando?.includes(momento)) return false;

      // Sin campo que cambie —al abrir, al guardar— se evalúan todas. Con él,
      // solo las suyas, que es el mismo criterio que usa el motor.
      if (!campoQueCambio) return true;

      const suyos = camposDeLaRegla(regla);
      return suyos.length === 0 || suyos.includes(campoQueCambio);
    });

    if (!evaluadas.length) return;

    const decididos = new Set<string>();

    for (const regla of evaluadas) {
      for (const apiId of camposQueDecideLaRegla(regla)) {
        const id = this.idPorApiId.get(apiId);
        decididos.add(id ?? apiId);
      }
    }

    for (const [otra, mapa] of this.porMomento) {
      if (otra === llave) continue;

      for (const id of decididos) mapa.delete(id);
    }
  }

  /**
   * Las llaves ordenadas: primero abrir, luego lo respondido en su orden, y
   * guardar al final.
   *
   * Guardar va el último porque es la última palabra, y abrir el primero porque
   * es el punto de partida. En medio, cada campo en el orden en que se fue
   * respondiendo: si dos reglas dicen cosas distintas del mismo campo, manda la
   * del campo que se contestó después.
   */
  private enOrden(llaves: string[]): string[] {
    return [
      ...llaves.filter((k) => k === 'abrir'),
      ...llaves.filter((k) => k !== 'abrir' && k !== 'guardar'),
      ...llaves.filter((k) => k === 'guardar'),
    ];
  }

  /** Motivos por los que el flujo impide guardar. Vacío = se puede. */
  readonly bloqueosDeFlujo = signal<readonly string[]>([]);

  /** Página a la que el flujo pidió ir, si alguna regla lo pidió. */
  readonly paginaDeFlujo = signal<number | null>(null);

  /** Los campos del formulario tal como los necesita el motor, por `apiId`. */
  private readonly camposPorApiId = new Map<string, Campo>();

  /** De `apiId` a `id` interno: el motor habla en `apiId` y el motor de formularios en `id`. */
  private readonly idPorApiId = new Map<string, string>();

  constructor(input: FormEngineInput) {
    this.pages = parseQuestions(input.questions);
    this.inherits = input.inherits ?? {};
    this.derived = derivedFieldsOf(this.pages);
    this.readOnly = input.readOnly ?? false;
    this.flujo = input.flujo ?? null;

    const stored = parseAnswerFields(input.answers);
    const initial = this.buildInitialValues(stored);

    this.appliedDefaults = initial.size > stored.length || this.recalculated;
    this.values.set(initial);

    // Con `initial` y no con `stored`: hace falta contar también los valores por
    // defecto, o una rama que abre un `def` no aparece hasta la segunda vez que
    // se abre la actividad. Ver [deriveSections].
    this.sections.set(this.deriveSections(initial));

    if (this.flujo?.reglas?.length) {
      this.indexarCampos();

      /*
       * Al entrar, **solo** el momento «al abrir».
       *
       * Ahí es donde viven las reglas que miran la sede y el equipo: esos datos
       * vienen ya escritos del registro del que cuelga la actividad, nadie los
       * va a responder aquí, y si no se evaluaran al entrar no se evaluarían
       * nunca.
       *
       * Los campos del formulario no: los resuelve el propio formulario según
       * se van respondiendo, que es lo que significa «al cambiar». Correrlo
       * también al entrar adelantaba decisiones sobre campos que el usuario
       * todavía no ha tocado.
       */
      this.correrFlujo('abrir');
    }
  }

  /**
   * El índice de campos que necesita el motor de flujos.
   *
   * Se arma una sola vez: el esquema no cambia mientras se diligencia, y
   * recorrerlo en cada tecla sería recorrer cientos de campos por pulsación.
   */
  private indexarCampos(): void {
    this.pages.forEach((page, indice) => {
      /*
       * La página, como un campo más.
       *
       * Se puede esconder o dejar en solo lectura, y el motor reparte a sus
       * campos lo que se decida sobre ella. Su identificador es `PAGINA:1`,
       * `PAGINA:2`… — el mismo que arma el Module, para que la regla que se
       * escribe allí valga aquí.
       *
       * No entra en `idPorApiId` a propósito: no tiene valor que leer ni que
       * escribir, y lo que se decide sobre ella acaba en sus campos.
       */
      this.camposPorApiId.set(`PAGINA:${indice + 1}`, {
        apiId: `PAGINA:${indice + 1}`,
        fty: 'page',
        pagina: indice + 1,
        esPagina: true,
      });

      for (const field of page.fie) {
        /*
         * El identificador de un campo es su `apiId`, y si no tiene, su `id`.
         *
         * Los títulos, los párrafos y los separadores no llevan `apiId`, y por
         * eso quedaban fuera del flujo: no había forma de escribir una regla
         * sobre ellos. Pero sí llevan `id`, que es único dentro del formulario
         * y sirve igual. El motor trata el identificador como una cadena opaca.
         */
        const apiId = (field.apiId ?? '').toString().trim() || (field.id ?? '').toString().trim();
        if (!apiId) continue;

        this.camposPorApiId.set(apiId, {
          apiId,
          fty: field.fty,
          opt: field.opt as any,
          pagina: indice + 1,
        });

        this.idPorApiId.set(apiId, field.id);
      }
    });
  }

  /**
   * Evalúa el flujo y guarda lo que decidió.
   *
   * ## Por qué el resultado se guarda en vez de calcularse al vuelo
   *
   * El motor puede **escribir valores** —«poner el valor», «copiar de»— y eso
   * no se puede hacer dentro de un `computed`, que tiene que ser puro. Se
   * ejecuta en los tres momentos que el flujo declara (al abrir, al cambiar y
   * al guardar) y el resto del motor lee lo que dejó.
   */
  private correrFlujo(momento: Momento, campoQueCambio?: string): void {
    if (!this.flujo?.reglas?.length) return;



    // El motor trabaja con `apiId`; los valores viven aquí por `id`.
    const actuales = this.values();

    /*
     * Se parte de la sede y del activo, y encima van las respuestas.
     *
     * Una regla puede preguntar por dónde se trabaja y sobre qué —«si la sede
     * es la de Bogotá»— y esos datos no están en el formulario: vienen del
     * registro del que cuelga la actividad. Van primero para que, si alguna vez
     * un campo del formulario se llamara igual, mande el del formulario, que es
     * lo que el usuario está respondiendo delante.
     */
    const valores: Record<string, unknown> = { ...valoresDelEntorno(this.inherits) };

    /*
     * El estado de la actividad, como si fuera un campo más.
     *
     * No se responde —lo pone la plataforma o una regla— pero sí se pregunta:
     * «si quedó en Aprobado, despacha». Se mete aquí, junto a las respuestas,
     * para que el motor no tenga que saber nada especial sobre él.
     */
    valores[ESTADO_DE_LA_ACTIVIDAD] = this.estadoActividad();

    for (const [apiId, id] of this.idPorApiId) {
      valores[apiId] = actuales.get(id) ?? null;
    }

    /*
     * Los campos del entorno se declaran como texto.
     *
     * El motor mira el `fty` para saber si compara como fecha o como número, y
     * un campo que no conoce se compara como texto — que es justo lo que hay
     * que hacer con el nombre de una sede o la marca de un equipo.
     */
    const campos = Object.fromEntries(this.camposPorApiId);

    /*
     * Sin opciones a propósito: comoTexto traduce identificadores a nombres
     * cuando el campo las trae, y aquí se compara identificador contra
     * identificador. Con opciones, la condición nunca casaría.
     */
    campos[ESTADO_DE_LA_ACTIVIDAD] = { apiId: ESTADO_DE_LA_ACTIVIDAD, fty: 'estado' };

    for (const apiId of Object.keys(valores)) {
      if (!campos[apiId]) campos[apiId] = { apiId, fty: 'text' };
    }

    const resultado: Resultado = evaluar(this.flujo, {
      valores,
      campos,
      momento,
      campoQueCambio,
    });

    const porId = new Map<string, EstadoCampo>();

    for (const [apiId, estado] of Object.entries(resultado.campos)) {
      const id = this.idPorApiId.get(apiId);

      if (id) {
        porId.set(id, estado);
        continue;
      }

      /*
       * Una página se guarda con su propio identificador.
       *
       * No tiene `id` de campo —no es un campo—, pero lo que se decida sobre
       * ella hace falta después para quitarla del paginador. `PAGINA:2` no
       * puede chocar con el `id` de ningún campo, así que caben en el mismo
       * sitio y se combinan por momento como todo lo demás.
       */
      if (this.camposPorApiId.get(apiId)?.esPagina) porId.set(apiId, estado);
    }

    /*
     * Se guarda **lo de cada momento por separado**, y se combinan al leer.
     *
     * `evaluar` solo mira las reglas del momento que se le pide, así que su
     * resultado es completo para ese momento pero no dice nada de los otros.
     * Machacarlo todo con lo último hacía que pulsar guardar borrara lo que las
     * reglas de «al cambiar» habían decidido —reaparecían los campos ocultos—;
     * y acumularlo sin más dejaba pegado para siempre lo que una regla decidió
     * y luego dejó de cumplirse.
     *
     * Por momento, cada pasada reemplaza limpiamente lo suyo y respeta lo ajeno.
     */
    /*
     * La llave no es solo el momento sino «momento:campo».
     *
     * Cada campo dispara sus propias reglas: responder «Tipo de gestión» evalúa
     * las suyas y no toca las de «Fecha». Guardándolo solo por momento, cada
     * respuesta borraría lo que habían decidido las reglas de los demás campos.
     *
     * Y se reemplaza, no se acumula: así una regla que deja de cumplirse deshace
     * lo que hizo sin tocar lo ajeno.
     */
    const llave = campoQueCambio ? `${momento}:${campoQueCambio}` : momento;

    /*
     * Y se reinserta al final, no se sobreescribe en su sitio.
     *
     * Un `Map` conserva el orden de inserción, pero reasignar una llave que ya
     * existe **no la mueve**. Sin esto, responder A, luego B y luego A otra vez
     * dejaba a A donde estaba y las decisiones de B seguían pesando más que las
     * de A, aunque A fuera lo último que se contestó.
     */
    this.porMomento.delete(llave);
    this.bloqueosPorMomento.delete(llave);

    // Y lo que estas mismas reglas hubieran decidido en otra pasada deja de
    // valer: acaban de decidir otra vez. Ver [olvidarLoViejoDe].
    this.olvidarLoViejoDe(momento, campoQueCambio, llave);

    this.porMomento.set(llave, porId);
    this.bloqueosPorMomento.set(llave, resultado.bloqueos);

    /*
     * Lo que hay que hacer con la actividad, para que lo recoja la pantalla.
     *
     * El motor no cambia estados ni crea actividades —no sabe dónde está la
     * actividad, y tiene que dar el mismo resultado aquí que en el móvil—, así
     * que los deja anotados y quien sí lo sabe los ejecuta.
     */
    // Lo mismo con los encargos: se quita y se vuelve a poner para que quede el
    // último, que es el que manda cuando dos reglas piden estados distintos.
    const encargos = { ...this.encargosPorMomento() };
    delete encargos[llave];

    this.encargosPorMomento.set({ ...encargos, [llave]: resultado.encargos ?? [] });

    const avisos = { ...this.avisosPorMomento() };
    delete avisos[llave];

    this.avisosPorMomento.set({ ...avisos, [llave]: resultado.avisos ?? [] });

    this.estadoFlujo.set(this.combinarMomentos());
    this.bloqueosDeFlujo.set([...new Set([...this.bloqueosPorMomento.values()].flat())]);
    /*
     * Y si una regla pidió ir a otra página, se va.
     *
     * El motor solo puede anotar el número: no sabe nada de paginación. Se
     * anotaba y no lo recogía nadie, así que «ir a la página» era una acción
     * que se podía configurar y no hacía absolutamente nada.
     *
     * Las páginas se cuentan desde 1 al escribir la regla —es lo que se ve en
     * el formulario— y desde 0 por dentro.
     */
    const pagina = resultado.irAPagina ?? null;
    this.paginaDeFlujo.set(pagina);

    if (pagina !== null && pagina - 1 !== this.page()) this.goTo(pagina - 1);

    this.salirDeLaPaginaEscondida();

    // Los valores que el flujo escribió se llevan al formulario. Sin esto, una
    // regla que rellena un campo se vería en el resultado pero no en pantalla.
    this.escribirLoQueElFlujoPuso(resultado.campos, campos);

    /*
     * Rastro de lo que hizo, para no diagnosticar a ciegas.
     *
     * El flujo decide en silencio: si una regla no se dispara no hay nada que
     * mirar, y averiguar por qué obligaba a ir poniendo puntos de parada. Es
     * `debug`, así que no aparece salvo que se pida.
     */
    // Lo que leyó de cada campo por el que preguntan las reglas: es lo que dice
    // si una regla no se dispara porque su condición no se cumple o porque el
    // valor no llegó.
    const leido: Record<string, string> = {};

    for (const apiId of camposDeLasReglas(this.flujo)) {
      leido[apiId] = campos[apiId]
        ? `${campos[apiId].fty} = "${comoTexto(valores[apiId], campos[apiId])}"`
        : '(no está en el formulario)';
    }

    /*
     * Y con qué acabó.
     *
     * Una regla puede escribirle encima a un campo, y entonces la siguiente ya
     * no decide con lo que respondió el usuario. Enseñando solo lo de entrada,
     * el rastro decía «leí Llamada comercial» y a la vez «no se disparó la
     * regla que pregunta por Llamada comercial», que no hay forma de entender.
     */
    const acabo: Record<string, string> = {};

    for (const apiId of Object.keys(leido)) {
      acabo[apiId] = `"${comoTexto(resultado.valoresFinales?.[apiId], campos[apiId])}"`;
    }

    console.debug('[flujo]', momento, {
      cambió: campoQueCambio ?? '(ninguno)',
      leyó: leido,
      acabó: acabo,
      reglasCargadas: (this.flujo?.reglas ?? [])
        .filter((r) => r.cuando?.includes(momento))
        .map((r) => `${r.id}: ${r.nombre ?? ''}${r.activa === false ? ' (apagada)' : ''}`),
      seDispararon: resultado.disparadas,
      campos: Object.keys(resultado.campos),
      escribieron: resultado.escrituras,
      // Una regla que intenta borrar lo que alguien acaba de contestar casi
      // nunca es lo que quería quien la escribió.
      ojo: resultado.pisadas,
      bloqueos: resultado.bloqueos,
      estado: this.estadoDelFlujo(),
    });
  }

  private escribirLoQueElFlujoPuso(
    porApiId: Record<string, EstadoCampo>,
    campos: Record<string, Campo>,
  ): void {
    const cambios: [string, FieldValue][] = [];

    // Los que además hay que rehacer, no solo reescribir. Ver abajo.
    const seRehacen: string[] = [];

    for (const [apiId, estado] of Object.entries(porApiId)) {
      if (estado.valor === undefined) continue;

      const id = this.idPorApiId.get(apiId);
      if (!id) continue;

      /*
       * El valor, con la forma que ese campo guarda.
       *
       * Una regla dice «pon "No enciende"» porque es lo que se eligió de una
       * lista al escribirla, pero un radio guarda `{id, txt}` y una casilla una
       * lista de eso. Escribiendo el texto a secas no se marcaba ninguna
       * opción: `selectedId()` buscaba un `id` dentro de una cadena.
       */
      const nuevo = comoLoGuarda(estado.valor, campos[apiId]);

      // Una regla que nombra una opción que ya no existe: se deja el campo como
      // está. Escribirle una respuesta que no está entre sus opciones es peor
      // que no tocarlo.
      if (nuevo === undefined) {
        console.warn('[FormEngine] el campo no admite ese valor', apiId, estado.valor);
        continue;
      }

      const actual = this.values().get(id) ?? null;

      /*
       * Solo si de verdad cambia.
       *
       * Se comparan **los textos** y no los objetos: dos objetos con las mismas
       * claves en distinto orden se serializan distinto, y un radio recién
       * escrito parecía cambiar en cada pasada. Cada escritura dispara otra
       * evaluación, así que eso era un formulario rehaciéndose sin parar.
       */
      if (comoTexto(actual, campos[apiId]) === comoTexto(nuevo, campos[apiId])) continue;

      cambios.push([id, nuevo as FieldValue]);

      /*
       * Y se apunta para rehacer el control, **pero solo si es de opciones**.
       *
       * Rehacerlo hace falta cuando el control se guarda por dentro lo que el
       * usuario pulsó: un `mat-radio-group` corregido en la misma pasada acaba
       * enseñando lo que se pulsó mientras el motor tiene otra cosa, y ya no
       * vuelven a coincidir.
       *
       * Los demás leen su valor de la entrada en cada pintado y no necesitan
       * nada. Rehacerlos era peor que no hacerlo: una tabla de detalle se
       * destruía y volvía a nacer al guardar una fila, y con ella se perdía el
       * sitio al que había que devolver la vista — por eso guardar un registro
       * dejaba el formulario arriba del todo.
       */
      const fty = (campos[apiId]?.fty ?? '').toLowerCase();

      if (fty === 'radio' || fty === 'checkbox' || fty === 'dropdownlist') {
        seRehacen.push(id);
      }
    }

    /*
     * Se apunta qué campos reescribió el flujo, para poder rehacer su control.
     *
     * Un `mat-radio-group` **se guarda por dentro lo que el usuario pulsó**. Si
     * el flujo lo corrige en la misma pasada, la expresión del `[value]` acaba
     * dando lo mismo que la vez anterior, Angular la da por no cambiada y no
     * se la escribe al componente: el motor queda con «Malo» y la pantalla
     * enseñando «Bueno», y a partir de ahí ya no vuelven a coincidir nunca.
     *
     * Es justo el caso de «lo cambia una vez y ya no lo vuelve a cambiar». Con
     * el sello en la clave del `@for`, el control se destruye y se rehace, y
     * nace leyendo el valor bueno.
     */
    if (seRehacen.length) {
      this.sellos.update((current) => {
        const next = { ...current };
        for (const id of seRehacen) next[id] = (next[id] ?? 0) + 1;
        return next;
      });
    }

    if (!cambios.length) return;

    this.values.update((current) => {
      const next = new Map(current);
      for (const [id, valor] of cambios) next.set(id, valor);
      this.applyDerived(next);
      return next;
    });

    this.sections.set(this.deriveSections(this.values()));
  }

  /** Cómo dejó el flujo a un campo. `undefined` si no dijo nada de él. */
  estadoDeFlujo(fieldId: string): EstadoCampo | undefined {
    return this.estadoFlujo().get(fieldId);
  }

  /**
   * ¿Se ve el campo, contando lo que el flujo decidió?
   *
   * El flujo manda sobre el esquema, y por eso se pregunta aquí y no solo al
   * pintar: si un campo que abre una rama lo esconde una regla, **la rama
   * entera tiene que cerrarse con él**. Sin esto, ocultar una firma dejaba a la
   * vista los campos que esa firma mostraba —colgando de una pregunta que ya no
   * se ve— y encima se seguían exigiendo como obligatorios.
   *
   * La cascada la resuelve `deriveSections` sola: repite hasta que no aparezca
   * ninguna sección nueva, así que basta con que un campo oculto deje de
   * activar la suya para que se cierre todo lo que colgaba de él.
   */
  private visibleConFlujo(field: FormField, active: readonly ActiveSection[]): boolean {
    const dijo = this.estadoFlujo().get(field.id)?.visible;
    if (dijo !== undefined) return dijo;

    return isFieldVisible(field, active);
  }

  /** Se evalúa el flujo con el momento «al guardar», y se dice si deja. */
  revisarFlujoAlGuardar(): readonly string[] {
    this.correrFlujo('guardar');
    return this.bloqueosDeFlujo();
  }

  /**
   * Los formularios de los que el flujo quiere abrir una actividad.
   *
   * Son identificadores de formulario, no títulos: un título se edita y la
   * regla dejaría de funcionar el día que alguien lo cambiara.
   *
   * Se devuelven todos y sin repetir. A diferencia del estado —donde solo cabe
   * uno y gana el último—, aquí varias reglas pueden querer abrir formularios
   * distintos y todas tienen razón; lo que no tiene sentido es abrir dos veces
   * el mismo.
   */
  /**
   * Las consignas que el flujo quiere despachar.
   *
   * Vienen con todo resuelto: qué se despacha, a quién, con qué estado y con
   * qué aviso. Las que traen `preguntar` no tienen destinatario — hay que
   * pedírselo a quien está guardando antes de dejar cerrar la actividad.
   *
   * Solo las del momento «al guardar»: despachar mientras alguien escribe
   * mandaría una consigna por cada tecla.
   */
  despachosQuePideElFlujo(): Record<string, unknown>[] {
    return (this.encargosPorMomento()['guardar'] ?? [])
      .filter((e) => e.que === 'despachar' && e.valor && typeof e.valor === 'object')
      .map((e) => ({ ...(e.valor as Record<string, unknown>), regla: e.regla }));
  }

  formulariosQuePideElFlujo(): string[] {
    const destinos = new Set<string>();

    /*
     * Solo lo pedido «al guardar», y a propósito.
     *
     * Crear una actividad **no se puede deshacer**. Una regla que se cumple y
     * se deja de cumplir mientras se escribe dejaría un rastro de actividades
     * sueltas que alguien tendría que ir borrando a mano. El estado sí se
     * aplica en cuanto cambia el campo, porque devolverlo es tan fácil como
     * ponerlo.
     */
    for (const encargo of this.encargosPorMomento()['guardar'] ?? []) {
      if (encargo.que !== 'crear-actividad') continue;

      const valor = String(encargo.valor ?? '').trim();
      if (valor) destinos.add(valor);
    }

    return [...destinos];
  }


  // ───────────────────────────────────────────────────────────────────────────
  // Estado derivado
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Las páginas que se pueden ver, por su posición real.
   *
   * Esconder una página es quitarla del formulario entero, no solo vaciarla: no
   * aparece en el paginador, no se llega a ella pasando páginas y sus
   * obligatorios no impiden guardar. Una página a la que no se puede llegar y
   * que aun así exige algo es una actividad que no hay forma de cerrar.
   */
  readonly paginasVisibles = computed<number[]>(() => {
    const estado = this.estadoFlujo();

    return this.pages
      .map((_, i) => i)
      .filter((i) => estado.get(`PAGINA:${i + 1}`)?.visible !== false);
  });

  readonly totalPages = computed(() => this.paginasVisibles().length);

  readonly currentPage = computed<FormPage | null>(() => this.pages[this.page()] ?? null);

  /** Campos visibles de la página actual, en orden. */
  readonly visibleFields = computed<FormField[]>(() => {
    const page = this.currentPage();
    if (!page) return [];

    const active = this.sections();

    // El flujo manda sobre el esquema: para eso existe. Un campo del que
    // ninguna regla dijo nada se comporta como siempre.
    return page.fie.filter((field) => this.visibleConFlujo(field, active));
  });

  /** Obligatorios sin responder, en todo el formulario. */
  readonly missing = computed(() => {
    const base = findMissingRequired(this.pages, this.values(), this.sections());
    const flujo = this.estadoFlujo();

    if (!flujo.size) return base;

    // Lo que el flujo escondió deja de exigirse aunque el esquema lo pidiera:
    // un obligatorio que nadie ve bloquea el guardado sin decir por qué.
    const active = this.sections();

    // Lo que el flujo dejó opcional u oculto deja de faltar, y lo que hizo
    // obligatorio se suma aunque el esquema no lo pidiera.
    const salida = base.filter((entrada) => {
      const estado = flujo.get(entrada.field.id);
      if (estado?.visible === false) return false;
      if (estado?.obligatorio === false) return false;
      return true;
    });

    const yaEstan = new Set(salida.map((e) => e.field.id));

    this.pages.forEach((page, indice) => {
      for (const field of page.fie) {
        const estado = flujo.get(field.id);

        if (estado?.obligatorio !== true) continue;
        if (!this.visibleConFlujo(field, active)) continue;
        if (yaEstan.has(field.id)) continue;
        if (isDisplayOnly(field.fty)) continue;
        if (!isEmptyValue(this.values().get(field.id) ?? null)) continue;

        salida.push({ field, page: indice });
      }
    });

    return salida;
  });

  /** ¿Está todo lo obligatorio respondido? */
  readonly isComplete = computed(() => this.missing().length === 0);

  /** Obligatorios sin responder en la página actual. */
  readonly missingHere = computed(() => {
    const index = this.page();
    return this.missing().filter((entry) => entry.page === index);
  });

  /**
   * Progreso: cuántos campos visibles tienen respuesta.
   *
   * Cuenta los que **se pueden** responder, no todos los del esquema: incluir
   * los ocultos daría un porcentaje que nunca llega al 100 y que baja al abrir
   * una rama, lo que se lee como que el trabajo retrocede.
   */
  readonly progress = computed(() => {
    const active = this.sections();
    const values = this.values();

    let total = 0;
    let filled = 0;

    for (const page of this.pages) {
      for (const field of page.fie) {
        if (!isFieldVisible(field, active)) continue;
        if (!this.acceptsValue(field.fty)) continue;

        total++;
        if (!isEmptyValue(values.get(field.id) ?? null)) filled++;
      }
    }

    return { total, filled, percent: total === 0 ? 0 : Math.round((filled / total) * 100) };
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Lectura
  // ───────────────────────────────────────────────────────────────────────────

  /** Valor actual de un campo. */
  valueOf(id: string): FieldValue {
    return this.values().get(id) ?? null;
  }

  /** ¿Hay que señalar este campo como pendiente? */
  showsError(field: FormField): boolean {
    if (!field.req) return false;
    // Antes de intentar guardar solo se señala lo que el usuario ya tocó:
    // teñir de rojo un formulario recién abierto es acusarle de un error que
    // todavía no ha tenido ocasión de cometer.
    if (!this.submitted() && !this.touched().has(field.id)) return false;

    return isEmptyValue(this.valueOf(field.id));
  }

  /** Índice de la primera página con obligatorios sin responder. `-1` si no hay. */
  firstIncompletePage(): number {
    return this.missing()[0]?.page ?? -1;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Escritura
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Fija el valor de un campo.
   *
   * Si el campo activa secciones, también recalcula cuáles quedan abiertas.
   */
  setValue(field: FormField, value: FieldValue): void {
    this.values.update((current) => {
      const next = new Map(current);
      next.set(field.id, value);

      // Los campos calculados se rehacen aquí y no en un cálculo derivado: su
      // resultado **se guarda** en la respuesta, y un `computed` que además
      // escribe no tendría un orden de evaluación definido.
      this.applyDerived(next);
      return next;
    });

    this.touched.update((current) => new Set(current).add(field.id));

    // Las secciones se rehacen enteras, no se retoca la del campo respondido.
    // Ver [updateSections].
    this.updateSections();

    // Y el flujo: responder un campo es lo que dispara la mitad de las reglas.
    // El mismo identificador con el que se indexó: `apiId`, o `id` si no tiene.
    this.correrFlujo(
      'cambia',
      (field.apiId ?? '').toString().trim() || (field.id ?? '').toString().trim() || undefined,
    );
  }

  /**
   * Rehace los campos que se calculan solos.
   *
   * ## Por qué en varias pasadas
   *
   * Un campo calculado puede alimentarse de otro: lo habitual es un total que
   * suma una tabla de detalle y, encima, otro que le aplica el impuesto.
   * Calcularlos en el orden en que aparecen dejaría al segundo una vuelta por
   * detrás — enseñando el impuesto del total anterior—. Se repite hasta que
   * nada cambia, con un tope por si alguien configura una fórmula que se
   * alimenta de sí misma: sin él, esto no terminaría nunca.
   *
   * ## Por qué no un provider de dependencias
   *
   * La app suscribe cada campo calculado a los que lo alimentan porque su
   * árbol de widgets no tiene otra forma de saber qué cambió. Aquí los valores
   * viven en un solo sitio y son cuatro operaciones sobre un mapa en memoria:
   * declarar dependencias sería mantener un grafo para ahorrar un trabajo que
   * no se nota.
   */
  private applyDerived(values: Map<string, FieldValue>): void {
    if (this.derived.length === 0) return;

    const read: ValueReader = (id) => values.get(id) ?? null;

    for (let pass = 0; pass < DERIVED_PASSES; pass++) {
      let changed = false;

      for (const field of this.derived) {
        const result = computeDerived(field, read);

        if (values.get(field.id) !== result) {
          values.set(field.id, result);
          changed = true;
        }
      }

      if (!changed) return;
    }
  }

  /**
   * Descriptivos del ítem elegido en un campo de lista.
   *
   * Van aparte de los valores porque no son una respuesta: son el retrato del
   * ítem en el momento de elegirlo. Se guardan en `des` del campo, junto a su
   * valor, y se recuperan al reabrir la actividad.
   *
   * Es una señal y no un mapa suelto porque la plantilla los lee: sin
   * reactividad, el detalle del ítem recién elegido solo aparecería cuando
   * algo más forzara un repintado.
   */
  private readonly descriptors = signal(new Map<string, ResolvedDescriptor[]>());

  setDescriptors(fieldId: string, values: readonly ResolvedDescriptor[]): void {
    this.descriptors.update((current) => {
      const next = new Map(current);

      if (values.length === 0) next.delete(fieldId);
      else next.set(fieldId, [...values]);

      return next;
    });
  }

  descriptorsOf(fieldId: string): ResolvedDescriptor[] {
    return this.descriptors().get(fieldId) ?? EMPTY_DESCRIPTORS;
  }

  /**
   * Lo elegido en el campo del que depende otro.
   *
   * Devuelve el GUID, que es lo que el ítem hijo lleva en `ParentGUID`. Cadena
   * vacía si el padre no se ha respondido: eso deja la lista hija sin ofrecer
   * nada, en vez de ofrecer el catálogo entero.
   */
  parentValueOf(field: FormField): string {
    if (!field.parentId) return '';
    return asOption(this.valueOf(field.parentId))?.id ?? '';
  }

  /**
   * Recalcula la sección que abre este campo.
   *
   * Solo los campos de selección única activan ramas. En los de selección
   * múltiple una opción con `act_data` abriría una rama que otra opción tendría
   * que cerrar, y el resultado depende del orden en que se marquen — así que el
   * esquema no las usa ahí y aquí tampoco.
   */
  /**
   * Rehace **todas** las secciones activas a partir de los valores.
   *
   * Antes se retocaba solo la entrada del campo que se acababa de responder, y
   * eso deja la cadena inconsistente en los dos sentidos:
   *
   * - **Al cerrar**: se quitaba la de A, pero la de B —que vive dentro de A y
   *   conserva su valor— seguía activa, así que C se quedaba visible colgando
   *   de una pregunta que ya no se ve. Y se le exigía como obligatorio.
   * - **Al reabrir**: volvía B, pero la sección que B abría no, porque nadie la
   *   volvía a activar hasta que el usuario respondiera B otra vez — aunque su
   *   respuesta siguiera ahí.
   *
   * Recalcular resuelve los dos casos con la misma regla, sin llevar cuentas de
   * qué colgaba de qué. Cuesta un recorrido de los campos por respuesta, que en
   * un formulario real es imperceptible.
   */
  private updateSections(): void {
    this.sections.set(this.deriveSections(this.values()));
  }

  /** Marca todo como tocado. Se llama al intentar guardar. */
  markSubmitted(): void {
    this.submitted.set(true);
  }

  // ── Paginación ─────────────────────────────────────────────────────────────

  goTo(index: number): void {
    if (index < 0 || index >= this.pages.length) return;

    // A una página escondida no se va, ni pasando páginas ni pulsando su punto.
    if (!this.paginasVisibles().includes(index)) return;

    this.page.set(index);
  }

  /**
   * Si la página en la que se está acaba de esconderse, se sale de ella.
   *
   * Pasa cuando una regla la esconde mientras se diligencia: quedarse ahí deja
   * una pantalla en blanco sin forma de salir salvo a ciegas.
   */
  private salirDeLaPaginaEscondida(): void {
    const visibles = this.paginasVisibles();
    if (!visibles.length || visibles.includes(this.page())) return;

    // La más cercana hacia atrás, y si no hay, la primera que quede.
    const antes = [...visibles].reverse().find((i) => i < this.page());

    this.page.set(antes ?? visibles[0]);
  }

  /** La siguiente que se pueda ver, saltándose las escondidas. */
  next(): void {
    const siguiente = this.paginasVisibles().find((i) => i > this.page());
    if (siguiente !== undefined) this.goTo(siguiente);
  }

  previous(): void {
    const anterior = [...this.paginasVisibles()].reverse().find((i) => i < this.page());
    if (anterior !== undefined) this.goTo(anterior);
  }

  readonly isFirstPage = computed(() => this.page() === (this.paginasVisibles()[0] ?? 0));
  readonly isLastPage = computed(() => this.page() >= this.pages.length - 1);

  // ───────────────────────────────────────────────────────────────────────────
  // Serialización
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Las respuestas en el formato que espera `SurveyAnswers.Fields`.
   *
   * Cada entrada lleva su `hid` **del momento**, no el del esquema: la
   * validación posterior —y la de la app móvil— se apoya en él para no exigir
   * un campo que estaba oculto cuando se guardó.
   */
  toAnswerFields(): AnswerField[] {
    const active = this.sections();
    const values = this.values();
    const result: AnswerField[] = [];

    for (const page of this.pages) {
      for (const field of page.fie) {
        if (!this.acceptsValue(field.fty)) continue;

        const hidden = !isFieldVisible(field, active);
        const value = values.get(field.id);

        // Los campos ocultos se registran igual, con su marca y su valor vacío.
        // No es redundante: la validación —aquí y en la app móvil— se apoya en
        // ese `hid` para no exigir algo que el usuario no pudo responder, y sin
        // la entrada no hay nada en que apoyarse. Un campo que se ocultó
        // *después* de haberse respondido conserva además su valor, para que
        // reabrir la rama lo devuelva tal como estaba.
        if (value === undefined) {
          if (hidden) result.push({ id: field.id, val: '', fty: field.fty, hid: true });
          continue;
        }

        // Los archivos se reparten entre `val` y `val1` según el tipo, que es
        // como los escribe la app y como sabe leerlos el backend. Guardar el
        // objeto entero en `val` para todos —lo que se hacía antes— dejaba las
        // fotografías, los audios y los videos ilegibles del otro lado.
        const file = asFile(value);

        if (file) {
          const { val, val1 } = splitFileValue(field.fty, file);
          result.push({ id: field.id, val, val1, fty: field.fty, hid: hidden });
          continue;
        }

        // Los descriptivos del ítem elegido viajan con la respuesta, no se
        // recalculan al leerla: el ítem puede cambiar en Visitrack después, y
        // lo que la actividad documenta es lo que decía al responderse.
        const des = this.descriptorsOf(field.id);

        result.push({
          id: field.id,
          val: value,
          fty: field.fty,
          hid: hidden,
          ...(des.length > 0 ? { des } : {}),
        });
      }
    }

    return result;
  }

  /**
   * Descriptivos para el listado de actividades.
   *
   * Solo los campos marcados con `pri`. Es lo que distingue una actividad de
   * sus vecinas en la lista, y por eso se recalcula al guardar en vez de
   * dejarlo para la sincronización.
   */
  toTitles(surveyTitle: string): { lab: string; val: string; id?: string }[] {
    const titles: { lab: string; val: string; id?: string }[] = [
      { lab: '[DEF]', val: surveyTitle },
    ];

    const active = this.sections();
    const values = this.values();

    for (const page of this.pages) {
      for (const field of page.fie) {
        if (!field.pri) continue;
        if (!isFieldVisible(field, active)) continue;

        const value = values.get(field.id);
        if (isEmptyValue(value ?? null)) continue;

        titles.push({ id: field.id, lab: field.lab, val: textOf(value ?? null) });
      }
    }

    return titles;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Interno
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * ¿Este tipo de campo guarda un valor?
   *
   * Los que solo muestran algo no: títulos, párrafos, enlaces, la imagen de
   * referencia y el formulario vinculado. Contarlos en el progreso daría un
   * porcentaje que nunca llega al cien por cien.
   */
  private acceptsValue(fty: string): boolean {
    return !isDisplayOnly(fty);
  }

  /**
   * Valores de arranque: los guardados, y el `def` del esquema para los que
   * nunca se respondieron.
   *
   * El valor por defecto solo se aplica a campos **sin respuesta previa**. Si se
   * aplicara siempre, reabrir una actividad pisaría lo que el usuario escribió
   * con el valor de fábrica.
   */
  private buildInitialValues(stored: readonly AnswerField[]): Map<string, FieldValue> {
    const values = new Map<string, FieldValue>();

    // Se acumulan aparte y se publican de una vez: escribir la señal dentro del
    // bucle dispararía un repintado por cada campo restaurado.
    const restored = new Map<string, ResolvedDescriptor[]>();

    for (const entry of stored) {
      // Un archivo se reconstruye desde donde esté: `val1` en los tipos que lo
      // desdoblan, `val` en los que no. Leer `val` a secas devolvía el GUID
      // suelto y el campo se dibujaba vacío al reabrir la actividad.
      const file = fileValueOf(entry);
      values.set(entry.id, file ?? entry.val);

      // Los descriptivos guardados vuelven tal cual: son el retrato del ítem
      // cuando se eligió, no lo que diga hoy el catálogo.
      if (entry.des?.length) restored.set(entry.id, entry.des);
    }

    /**
     * En consulta se para aquí: lo guardado y nada más.
     *
     * Los descriptivos sí se publican igual —son parte de lo que se respondió—,
     * pero ni valores por defecto, ni heredados, ni recálculo de los campos
     * calculados. Ver [FormEngineInput.readOnly].
     */
    if (this.readOnly) {
      if (restored.size > 0) this.descriptors.set(restored);
      return values;
    }

    for (const page of this.pages) {
      for (const field of page.fie) {
        if (values.has(field.id)) continue;
        if (!this.acceptsValue(field.fty)) continue;

        /**
         * Un valor heredado no es un `def` que se copia: es un dato que se lee
         * del registro del que cuelga el formulario. Se resuelve antes que
         * nada, porque su `def` no es texto sino la referencia a ese dato.
         */
        if (inheritsDefault(field)) {
          const inherited = resolveInheritedDefault(field, this.inherits);
          if (inherited) values.set(field.id, inherited);
          continue;
        }

        const def = typeof field.def === 'string' ? field.def : '';

        // Fecha y hora arrancan en el momento actual aunque el formulario no
        // traiga `def`. Es lo que se espera de un formato de campo: la visita
        // ocurre ahora, y teclear la fecha de hoy en cada actividad es trabajo
        // que la aplicación puede ahorrarse.
        if (isTemporalField(field.fty)) {
          values.set(field.id, resolveTemporalDefault(field.fty, def || 'now'));
          continue;
        }

        if (!def || def === 'null') continue;

        values.set(field.id, this.defaultFor(field, def));
      }
    }

    if (restored.size > 0) this.descriptors.set(restored);

    /**
     * Al abrir, los calculados se rehacen sobre lo que hay guardado: un campo
     * que alimentaba la fórmula pudo cambiar en otra sesión, y enseñar el
     * resultado viejo es peor que no enseñar ninguno.
     *
     * Si alguno cambió, se marca como si se hubieran aplicado valores de
     * fábrica: quien monta el motor persiste en ese caso, y el número corregido
     * tiene que quedar escrito aunque el usuario no toque nada más.
     */
    const before = this.derived.map((field) => values.get(field.id));
    this.applyDerived(values);
    this.recalculated = this.derived.some(
      (field, index) => values.get(field.id) !== before[index],
    );

    return values;
  }

  /**
   * Traduce el `def` del esquema al tipo de valor que usa ese campo.
   *
   * En los campos de fecha y hora se reconocen palabras clave —`now`, `today`,
   * `hoy`, `ahora`— y se resuelven al momento de abrir el formulario, que es
   * para lo que están: registrar cuándo se hizo la visita sin obligar a
   * teclearlo. Si no traen `def`, [buildInitialValues] les pone igualmente el
   * momento actual.
   *
   * Conviene tener presente el efecto secundario: un campo de fecha obligatorio
   * queda respondido sin que nadie lo mire. Es un compromiso aceptado —ahorra
   * teclear la fecha de hoy en cada actividad—, pero significa que la fecha de
   * un formulario a medias puede ser la de apertura y no la del hecho que
   * registra.
   */
  private defaultFor(field: FormField, def: string): FieldValue {
    const options = field.opt ?? [];

    if (options.length > 0) {
      const match = options.find((option) => option.id === def || option.txt === def);
      if (!match) return null;

      const single = { id: match.id, txt: match.txt };
      return field.fty === 'checkbox' ? [single] : single;
    }

    if (isTemporalField(field.fty)) return resolveTemporalDefault(field.fty, def);

    return def;
  }

  /**
   * Qué secciones quedan abiertas al arrancar.
   *
   * ## Recibe los valores iniciales, no las respuestas guardadas
   *
   * Y la diferencia es todo el asunto: los valores iniciales incluyen los `def`
   * del esquema, y las respuestas guardadas no existen la primera vez que se
   * abre la actividad.
   *
   * Leyendo solo lo guardado, un formulario recién abierto cuyo radio trae una
   * opción por defecto que abre una rama la mostraba **cerrada**. Al guardar y
   * reabrir aparecía —el valor ya estaba escrito— y eso hacía parecer que la
   * visibilidad «tardaba un ciclo en aplicarse».
   *
   * ## Un radio sin responder no abre nada
   *
   * Si el campo que condiciona está vacío —sin `def` y sin respuesta— no se
   * activa ninguna sección, y todos los campos que dependen de él quedan
   * ocultos. Es lo que hace [isFieldVisible] con la lista vacía, y es la
   * respuesta correcta: nadie ha elegido todavía por qué rama va el formulario.
   */
  private deriveSections(values: ReadonlyMap<string, FieldValue>): ActiveSection[] {
    const active: ActiveSection[] = [];
    const seen = new Set<string>();

    /**
     * Se resuelve **en cadena**, no de una pasada.
     *
     * Una rama puede abrir otra: la opción de A muestra B, y la respuesta de B
     * muestra C. Recorriendo los campos una sola vez, B activaba lo suyo aunque
     * estuviera oculto —porque conserva el valor que tenía antes de que su
     * padre lo escondiera— y C se quedaba visible colgando de una pregunta que
     * ya no se ve. El usuario respondía algo que no debía y, peor, se le exigía
     * como obligatorio.
     *
     * Aquí solo activa quien **está visible con lo que ya se activó**, y se
     * repite hasta que no aparezca ninguna sección nueva. Cada vuelta añade al
     * menos una, así que el número de vueltas está acotado por el número de
     * secciones del formulario.
     */
    let added = true;

    while (added) {
      added = false;

      for (const page of this.pages) {
        for (const field of page.fie) {
          const options = field.opt ?? [];
          if (options.length === 0) continue;

          // La condición nueva: un campo escondido no manda sobre nada.
          if (!this.visibleConFlujo(field, active)) continue;

          const chosenId = asOption(values.get(field.id) ?? null)?.id;
          if (!chosenId) continue;

          const chosen = options.find((option) => option.id === chosenId);
          const sect = (chosen?.act_data ?? '').toString();
          if (!sect) continue;

          const key = `${field.id}|${sect}`;
          if (seen.has(key)) continue;

          seen.add(key);
          active.push({ id: field.id, sect });
          added = true;
        }
      }
    }

    return active;
  }
}

/** Tipos que guardan una fecha, una hora o ambas. */
function isTemporalField(fty: string): boolean {
  return fty === 'date' || fty === 'datetime' || fty === 'time';
}

/**
 * Palabras con las que un formulario pide «el momento actual».
 *
 * Se aceptan varias porque el esquema lo escriben personas distintas y en dos
 * idiomas; rechazar `hoy` por esperar `now` deja el campo vacío sin decir por
 * qué.
 */
const NOW_KEYWORDS = new Set([
  // Las que escribe el diseñador de formularios de Visitrack, y las únicas que
  // llegan de verdad en los esquemas. Faltaban: un campo con `CURRENTDATE` no
  // se reconocía como palabra clave ni como fecha, así que se guardaba el
  // literal «CURRENTDATE» y el selector se quedaba en blanco.
  'currentdate',
  'currenttime',
  'currentdatetime',

  // Las demás son tolerancia para esquemas escritos a mano.
  'now',
  'today',
  'hoy',
  'ahora',
  'actual',
  'current',
]);

/**
 * Valor por defecto de un campo temporal.
 *
 * El formato es el que espera el `<input>` nativo de cada tipo, que es también
 * el que guarda la app móvil: `yyyy-MM-dd`, `yyyy-MM-ddTHH:mm` y `HH:mm`. Un
 * formato distinto deja el control en blanco sin avisar — el navegador
 * simplemente ignora el valor que no entiende.
 *
 * Se usa la hora **local** y no UTC: el campo registra cuándo ocurrió algo para
 * quien está allí, y con UTC alguien que trabaja de noche vería la fecha del
 * día siguiente.
 */
function resolveTemporalDefault(fty: string, def: string): FieldValue {
  const trimmed = def.trim();
  const useNow = NOW_KEYWORDS.has(trimmed.toLowerCase());
  const moment = useNow ? new Date() : parseFlexibleDate(trimmed);

  // Un `def` que no es palabra clave ni fecha reconocible se respeta tal cual:
  // puede ser un valor que el formulario espera en un formato propio.
  if (!moment) return def;

  const pad = (value: number) => String(value).padStart(2, '0');

  const date = `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`;
  const time = `${pad(moment.getHours())}:${pad(moment.getMinutes())}`;

  if (fty === 'date') return date;
  if (fty === 'time') return time;
  return `${date}T${time}`;
}

/**
 * Interpreta una fecha escrita en el `def` del formulario.
 *
 * Se aceptan los formatos que aparecen en los esquemas: ISO con o sin hora, y
 * `dd/MM/yyyy`, que es como lo escribe quien configura el formulario desde la
 * plataforma. Un formato que el selector no entienda deja el campo en blanco
 * sin decir por qué, y quien lo configuró da por hecho que funcionó.
 *
 * Se construye con componentes y no con `new Date(texto)` porque esa forma
 * interpreta `2026-08-05` como UTC: al oeste de Greenwich saldría el día
 * anterior.
 */
function parseFlexibleDate(text: string): Date | null {
  if (!text) return null;

  // Solo hora: `HH:mm`, con segundos opcionales.
  const onlyTime = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(text);
  if (onlyTime) {
    const result = new Date();
    result.setHours(Number(onlyTime[1]), Number(onlyTime[2]), 0, 0);
    return result;
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(text);
  if (iso) {
    return new Date(
      Number(iso[1]),
      Number(iso[2]) - 1,
      Number(iso[3]),
      Number(iso[4] ?? 0),
      Number(iso[5] ?? 0),
    );
  }

  const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[T ](\d{1,2}):(\d{2}))?/.exec(text);
  if (slashed) {
    return new Date(
      Number(slashed[3]),
      Number(slashed[2]) - 1,
      Number(slashed[1]),
      Number(slashed[4] ?? 0),
      Number(slashed[5] ?? 0),
    );
  }

  return null;
}

/** Texto legible de un valor. Duplica `valueToText` para no importar de más. */
function textOf(value: FieldValue): string {
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return asOptions(value)
      .map((option) => option.txt)
      .join(', ');
  }

  const option = asOption(value);
  if (option) return option.txt;

  const geo = asGeo(value);
  return geo ? `${geo.lat.toFixed(6)}, ${geo.lng.toFixed(6)}` : '';
}

/**
 * Lista vacía compartida.
 *
 * Devolver `[]` nuevo en cada lectura haría que la entrada del componente
 * cambiara de referencia en cada ciclo, y con ella el valor recompuesto del
 * campo: un repintado continuo de algo que no cambió.
 */
const EMPTY_DESCRIPTORS: ResolvedDescriptor[] = [];
