import { computed, signal } from '@angular/core';

import {
  ActiveSection,
  AnswerField,
  FieldValue,
  FormField,
  FormPage,
  asFile,
  asGeo,
  asOption,
  fileValueOf,
  findMissingRequired,
  isEmptyValue,
  isFieldVisible,
  parseAnswerFields,
  parseQuestions,
  splitFileValue,
} from './form-schema';

/** Lo que hace falta para arrancar el motor. */
export interface FormEngineInput {
  /** `Surveys.JSONQuestion`, sin parsear. */
  questions: unknown;
  /** `SurveyAnswers.Fields`, sin parsear. */
  answers: unknown;
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

  constructor(input: FormEngineInput) {
    this.pages = parseQuestions(input.questions);

    const stored = parseAnswerFields(input.answers);
    const initial = this.buildInitialValues(stored);

    this.appliedDefaults = initial.size > stored.length;
    this.values.set(initial);
    this.sections.set(this.deriveSections(stored));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Estado derivado
  // ───────────────────────────────────────────────────────────────────────────

  readonly totalPages = computed(() => this.pages.length);

  readonly currentPage = computed<FormPage | null>(() => this.pages[this.page()] ?? null);

  /** Campos visibles de la página actual, en orden. */
  readonly visibleFields = computed<FormField[]>(() => {
    const page = this.currentPage();
    if (!page) return [];

    const active = this.sections();
    return page.fie.filter((field) => isFieldVisible(field, active));
  });

  /** Obligatorios sin responder, en todo el formulario. */
  readonly missing = computed(() =>
    findMissingRequired(this.pages, this.values(), this.sections()),
  );

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
      return next;
    });

    this.touched.update((current) => new Set(current).add(field.id));
    this.updateSections(field, value);
  }

  /**
   * Recalcula la sección que abre este campo.
   *
   * Solo los campos de selección única activan ramas. En los de selección
   * múltiple una opción con `act_data` abriría una rama que otra opción tendría
   * que cerrar, y el resultado depende del orden en que se marquen — así que el
   * esquema no las usa ahí y aquí tampoco.
   */
  private updateSections(field: FormField, value: FieldValue): void {
    const options = field.opt ?? [];
    if (options.length === 0) return;
    if (Array.isArray(value)) return;

    const chosenId = asOption(value)?.id ?? null;
    const chosen = options.find((option) => option.id === chosenId);
    const sect = (chosen?.act_data ?? '').toString();

    this.sections.update((current) => {
      const others = current.filter((active) => active.id !== field.id);
      return sect ? [...others, { id: field.id, sect }] : others;
    });
  }

  /** Marca todo como tocado. Se llama al intentar guardar. */
  markSubmitted(): void {
    this.submitted.set(true);
  }

  // ── Paginación ─────────────────────────────────────────────────────────────

  goTo(index: number): void {
    if (index < 0 || index >= this.pages.length) return;
    this.page.set(index);
  }

  next(): void {
    this.goTo(this.page() + 1);
  }

  previous(): void {
    this.goTo(this.page() - 1);
  }

  readonly isFirstPage = computed(() => this.page() === 0);
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

        result.push({
          id: field.id,
          val: value,
          fty: field.fty,
          hid: hidden,
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

  /** ¿Este tipo de campo guarda un valor? Los títulos y párrafos no. */
  private acceptsValue(fty: string): boolean {
    return fty !== 'title' && fty !== 'paragraph' && fty !== 'hyperlink';
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

    for (const entry of stored) {
      // Un archivo se reconstruye desde donde esté: `val1` en los tipos que lo
      // desdoblan, `val` en los que no. Leer `val` a secas devolvía el GUID
      // suelto y el campo se dibujaba vacío al reabrir la actividad.
      const file = fileValueOf(entry);
      values.set(entry.id, file ?? entry.val);
    }

    for (const page of this.pages) {
      for (const field of page.fie) {
        if (values.has(field.id)) continue;
        if (!this.acceptsValue(field.fty)) continue;

        const def = (field.def ?? '').toString();

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
   * Reconstruye qué secciones estaban activas al reabrir la actividad.
   *
   * Sin esto, una actividad guardada con una rama abierta se reabriría con esa
   * rama cerrada: los campos respondidos desaparecerían de la vista y la
   * validación los daría por ocultos. El estado se deduce de las respuestas
   * guardadas, que es la única fuente fiable — `fieldGroup` no se persiste.
   */
  private deriveSections(stored: readonly AnswerField[]): ActiveSection[] {
    const byId = new Map(stored.map((entry) => [entry.id, entry.val]));
    const active: ActiveSection[] = [];

    for (const page of this.pages) {
      for (const field of page.fie) {
        const options = field.opt ?? [];
        if (options.length === 0) continue;

        const chosenId = asOption(byId.get(field.id) ?? null)?.id;
        if (!chosenId) continue;

        const chosen = options.find((option) => option.id === chosenId);
        const sect = (chosen?.act_data ?? '').toString();
        if (sect) active.push({ id: field.id, sect });
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
const NOW_KEYWORDS = new Set(['now', 'today', 'hoy', 'ahora', 'actual', 'current']);

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
  if (Array.isArray(value)) return value.map((option) => option.txt).join(', ');

  const option = asOption(value);
  if (option) return option.txt;

  const geo = asGeo(value);
  return geo ? `${geo.lat.toFixed(6)}, ${geo.lng.toFixed(6)}` : '';
}
