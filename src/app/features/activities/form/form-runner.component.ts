import {
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { MatTooltipModule } from '@angular/material/tooltip';

import { ActivityInheritsService } from '../../../core/forms/activity-inherits.service';
import { FormEngine } from '../../../core/forms/form-engine';
import { FieldValue, FormField, ResolvedDescriptor } from '../../../core/forms/form-schema';
import { Survey, SurveyAnswer } from '../../../core/models/entities.model';
import { DispatchStatusRepository } from '../../../core/repositories/entity.repositories';
import { SurveyAnswerRepository } from '../../../core/repositories/survey-answer.repository';
import { ActivityService } from '../../../core/services/activity.service';
import { AlertSoundService } from '../../../core/services/alert-sound.service';
import { AuthService } from '../../../core/services/auth.service';
import { DespachoService } from '../../../core/services/despacho.service';
import { ToastService } from '../../../core/services/toast.service';
import { Destinatario, DestinatarioDialogComponent } from './destinatario-dialog/destinatario-dialog.component';
import { ShortcutsService } from '../../../core/services/shortcuts.service';
import { AutosaveService } from '../../../core/services/autosave.service';
import { FlujoService } from '../../../core/forms/flujo.service';
import { PendingUploadService } from '../../../core/sync/pending-upload.service';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { ToTopComponent } from '../../../shared/components/to-top/to-top.component';
import { FieldHostComponent } from './fields/field-host.component';
import { PageNavComponent } from './page-nav/page-nav.component';
import { MasterDetailPanelsService } from './master-detail-row/master-detail-panels.service';
import { MissingEntry, RequiredDialogComponent } from './required-dialog/required-dialog.component';
import { CompanyLogicService } from '../../../core/rules/company-logic.service';

/**
 * Diligenciamiento de una actividad.
 *
 * Junta las tres piezas: el [FormEngine] que lleva el estado, los componentes
 * que dibujan cada campo y la persistencia.
 *
 * ## Guardar no es lo mismo que persistir
 *
 * Cada cambio se escribe solo, con retardo, igual que en la app: un formulario
 * a medias sobrevive a que se cierre la pestaña. El botón **Guardar** hace otra
 * cosa —marca la actividad como terminada y lista para subir— y es el único
 * momento en que se exigen los obligatorios.
 *
 * Separarlos importa: si el autoguardado exigiera campos completos no podría
 * escribir nada hasta el final, que es justo cuando ya no hace falta.
 */
@Component({
  selector: 'vt-form-runner',
  standalone: true,
  imports: [
    FieldHostComponent,
    IconComponent,
    MatTooltipModule,
    PageNavComponent,
    RequiredDialogComponent,
    DestinatarioDialogComponent,
    ToTopComponent,
  ],
  templateUrl: './form-runner.component.html',
  styleUrl: './form-runner.component.scss',
})
export class FormRunnerComponent {
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly activities = inject(ActivityService);
  private readonly autosave = inject(AutosaveService);
  private readonly flujos = inject(FlujoService);
  private readonly pendingUploads = inject(PendingUploadService);
  private readonly panels = inject(MasterDetailPanelsService);
  private readonly sound = inject(AlertSoundService);
  private readonly shortcuts = inject(ShortcutsService);
  private readonly companyLogic = inject(CompanyLogicService);
  private readonly inherits = inject(ActivityInheritsService);
  private readonly estados = inject(DispatchStatusRepository);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly despachos = inject(DespachoService);

  /** Los avisos del flujo que ya se enseñaron, para no repetirlos. */
  private readonly avisosDichos = new Set<string>();

  /** Títulos de las actividades que el flujo abrió al guardar. Ver [describeSave]. */
  private readonly abiertasPorElFlujo = signal<string[]>([]);

  readonly survey = input.required<Survey>();
  readonly answer = input.required<SurveyAnswer>();

  /**
   * El sello del flujo para un campo, para la clave del `@for`.
   *
   * Va aquí y no se lee del motor en la plantilla porque una expresión de
   * `track` solo puede tocar el campo, el índice y **el propio componente**:
   * Angular la evalúa fuera del contexto de la plantilla.
   */
  selloDe(id: string): number {
    return this.engine()?.selloDe(id) ?? 0;
  }

  /** Se emite tras guardar, para que la pantalla refresque su cabecera. */
  readonly saved = output<void>();

  /**
   * El flujo movió la actividad de estado.
   *
   * Lo escribe el runner en la base, pero la cabecera y la barra de estado
   * viven arriba y su copia de la actividad no se entera sola: sin avisar, el
   * selector seguía enseñando el estado anterior hasta recargar la pantalla.
   */
  readonly statusChanged = output<string>();

  /**
   * Petición de salir desde la barra inferior.
   *
   * El runner no sale por su cuenta: las comprobaciones de salida —descartar el
   * borrador, avisar antes— son de la actividad, no del formulario, y viven en
   * la pantalla que lo contiene. Aquí solo se vacía lo pendiente de escribir y
   * se pasa el aviso.
   */
  readonly leave = output<void>();

  readonly engine = signal<FormEngine | null>(null);
  readonly saving = signal(false);
  readonly feedback = signal('');

  /** Obligatorios sin responder, señalados tras pulsar «Revisar». */
  readonly blocking = signal<MissingEntry[]>([]);

  /** El aviso de obligatorios está abierto. */
  readonly askingRequired = signal(false);

  /** Contenedor de campos: destino del desplazamiento al cambiar de página. */
  private readonly fieldsRef = viewChild<ElementRef<HTMLElement>>('fields');

  /** GUID de la actividad que está montada en el motor. */
  private mountedGuid = '';

  constructor() {
    effect(() => {
      const survey = this.survey();
      const answer = this.answer();

      // Solo se reconstruye al cambiar de actividad. La entrada `answer` es un
      // objeto nuevo cada vez que la pantalla de arriba relee la actividad —al
      // guardar, por ejemplo—, y reconstruir en cada una de esas veces
      // devolvería al usuario a la primera página y perdería lo que llevara
      // sin escribir.
      if (answer.GUID === this.mountedGuid) return;
      this.mountedGuid = answer.GUID;

      // Otra actividad, otra memoria: el estado que traía la anterior no dice
      // nada de esta.
      this.estadoAntesDelFlujo = null;
      this.estadoPuestoPorElFlujo = null;

      // `untracked`: dentro se leen señales —la sesión, al buscar la ubicación—
      // y sin esto el efecto quedaría suscrito a ellas y se volvería a montar
      // el formulario por cualquier cambio ajeno.
      untracked(() => void this.mount(survey, answer));
    });

    /*
     * El estado que pide el flujo, en cuanto lo pide.
     *
     * Un efecto y no una llamada dentro del motor: escribir en la base no es
     * cosa suya —tiene que dar el mismo resultado aquí, en el móvil y en el
     * simulador del Module—, así que anota lo que quiere y esto lo ejecuta.
     *
     * Se lee la señal fuera del `untracked` para quedar suscrito solo a ella;
     * lo de dentro toca la base y no debe volver a disparar el efecto.
     */
    effect(() => {
      const pedido = this.engine()?.estadoDelFlujo() ?? null;

      untracked(() => {
        /*
         * El fallo se cuenta, no se traga.
         *
         * Es una promesa que nadie espera: sin este `catch`, cualquier error de
         * la base —un índice que no está, una escritura rechazada— se perdía
         * como un rechazo sin dueño y el estado simplemente no cambiaba, sin
         * decir por qué.
         */
        this.aplicarEstadoDelFlujo(pedido).catch((error) =>
          console.error('[flujo] no se pudo aplicar el estado', pedido, error),
        );
      });
    });

    /*
     * Los avisos que pida el flujo, en cuanto los pida.
     *
     * **Solo los nuevos.** El flujo se evalúa con cada respuesta, así que
     * enseñarlos todos cada vez llenaría la pantalla del mismo mensaje una y
     * otra vez. Uno que deja de pedirse se olvida, y si su regla vuelve a
     * cumplirse se enseña otra vez: eso sí es información nueva.
     */
    effect(() => {
      const ahora = this.engine()?.avisosDelFlujo() ?? [];

      untracked(() => {
        for (const aviso of ahora) {
          if (this.avisosDichos.has(aviso)) continue;

          this.avisosDichos.add(aviso);
          this.toasts.show({ title: aviso, tone: 'info' });
        }

        for (const dicho of [...this.avisosDichos]) {
          if (!ahora.includes(dicho)) this.avisosDichos.delete(dicho);
        }
      });
    });

    /*
     * El estado de la actividad, siempre al día en el motor.
     *
     * Una condición puede preguntar por él —«si quedó en Aprobado, despacha»— y
     * el motor no conoce la actividad, solo los campos. Se le pasa desde aquí,
     * que es quien la tiene.
     */
    effect(() => {
      const estado = String(this.answer()?.Status ?? '');

      untracked(() => this.engine()?.estadoActividad.set(estado));
    });

    this.registerShortcuts();
  }

  /**
   * Monta el formulario de una actividad.
   *
   * Es asíncrono por la herencia: los campos que traen su valor de la sede o
   * del equipo necesitan esos registros **antes** de que el motor aplique los
   * valores por defecto. Aplicarlos después obligaría a repintar y, peor, a
   * distinguir lo heredado de lo que el usuario ya hubiera escrito.
   *
   * Si la actividad no tiene ubicación ni activo, o no están descargados, el
   * motor se arma igual con la fuente vacía: los heredados quedan en blanco y
   * el formulario funciona.
   */
  private async mount(survey: Survey, answer: SurveyAnswer): Promise<void> {
    const inherits = await this.inherits.forAnswer(answer, survey.JSONQuestion);

    /*
     * El flujo se trae **antes** de armar el motor.
     *
     * Sus reglas deciden qué se ve y qué se exige desde el primer pintado: si
     * llegaran después, el formulario aparecería un instante con los campos que
     * el flujo oculta, y esa aparición es justo lo que quien configuró el flujo
     * quería evitar.
     */
    const flujo = await this.flujos.paraFormulario(survey.ID);

    // Entre la espera y aquí el usuario pudo abrir otra actividad. Montar la
    // vieja encima sería peor que no montar nada.
    if (answer.GUID !== this.mountedGuid) return;

    const engine = new FormEngine({
      questions: survey.JSONQuestion,
      answers: answer.Fields,
      inherits,
      flujo,
    });

    this.engine.set(engine);
    this.blocking.set([]);
    this.feedback.set('');

    // Los valores de fábrica se escriben nada más aplicarse, como en la app:
    // si el usuario abre el formulario, no toca nada y guarda, tienen que
    // quedar registrados.
    if (engine.appliedDefaults && answer.ID != null) {
      this.persist(engine, answer.ID);
    }
  }

  /**
   * Hay teclado, así que los atajos existen y merece la pena anunciarlos.
   *
   * En una tableta o un teléfono el botón sería un control que no lleva a nada
   * que se pueda usar.
   */
  readonly shortcutsAvailable = this.shortcuts.enabled;

  /**
   * Enseña los atajos disponibles aquí.
   *
   * ## Por qué un botón y no solo la tecla
   *
   * El panel ya se abre con `?`, pero `?` **no llega** mientras se escribe: una
   * interrogación dentro de un campo de texto es una interrogación, no un
   * atajo. Y en un formulario el foco está casi siempre dentro de un campo, así
   * que la ayuda de los atajos era justo lo único inalcanzable desde la
   * pantalla donde más atajos hay.
   *
   * Un botón no depende de dónde esté el foco. Y de paso resuelve el problema
   * anterior: enterarse de que los atajos existen, que con una tecla escondida
   * solo pasa por accidente.
   */
  openShortcuts(): void {
    this.shortcuts.toggleHelp();
  }

  /**
   * Los atajos del formulario.
   *
   * Aquí es donde se pasa el tiempo, y cada paso —guardar, cambiar de página,
   * saltar al siguiente campo— son un desplazamiento y un clic. Se registran
   * mientras el formulario vive y se retiran al salir, así el panel de ayuda
   * solo ofrece lo que de verdad funciona en la pantalla que se está viendo.
   */
  private registerShortcuts(): void {
    const destroy = inject(DestroyRef);

    const undo = this.shortcuts.registerAll([
      {
        id: 'form-save',
        keys: 'ctrl+s',
        label: 'Guardar la actividad',
        group: 'Formulario',
        run: () => void this.save(),
      },
      {
        id: 'form-next',
        keys: 'alt+arrowright',
        label: 'Página siguiente',
        group: 'Formulario',
        run: () => void this.goNext(),
      },
      {
        id: 'form-prev',
        keys: 'alt+arrowleft',
        label: 'Página anterior',
        group: 'Formulario',
        run: () => void this.goPrevious(),
      },
      {
        id: 'form-field-next',
        keys: 'alt+arrowdown',
        label: 'Ir al siguiente campo',
        group: 'Formulario',
        run: () => this.moveFocus(1),
      },
      {
        id: 'form-field-prev',
        keys: 'alt+arrowup',
        label: 'Ir al campo anterior',
        group: 'Formulario',
        run: () => this.moveFocus(-1),
      },
      {
        id: 'form-missing',
        keys: 'alt+f',
        label: 'Ir al primer campo obligatorio que falta',
        group: 'Formulario',
        run: () => {
          const first = this.missing()[0];
          if (first) void this.goToMissing(first);
        },
      },
    ]);

    destroy.onDestroy(undo);
  }

  /**
   * Mueve el foco al campo de al lado.
   *
   * Sobre lo que hay **en pantalla** y no sobre el esquema: los campos ocultos
   * por una condición no están en el documento, y saltar a uno de ellos dejaría
   * el foco en ninguna parte. Se toma el control que de verdad recibe escritura
   * dentro de cada tarjeta.
   */
  private moveFocus(step: number): void {
    const container = this.fieldsRef()?.nativeElement;
    if (!container) return;

    const controls = [
      ...container.querySelectorAll<HTMLElement>(
        'input:not([type=hidden]), textarea, select, [contenteditable=true], button.lst__trigger',
      ),
    ].filter((element) => !element.hasAttribute('disabled'));

    if (controls.length === 0) return;

    const active = document.activeElement as HTMLElement | null;
    const index = active ? controls.indexOf(active) : -1;

    const next = index < 0 ? 0 : (index + step + controls.length) % controls.length;

    controls[next].focus();
    controls[next].scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /** Etiqueta de la página actual: la del esquema, o su número. */
  readonly pageLabel = computed(() => {
    const engine = this.engine();
    if (!engine) return '';

    const page = engine.currentPage();
    return page?.lab || `Página ${engine.page() + 1}`;
  });

  /**
   * Longitud del aro de progreso, en unidades del `viewBox`.
   *
   * Es la circunferencia del círculo (2πr con r = 50). Se calcula una vez y se
   * usa como `stroke-dasharray`: así el trazo tiene exactamente una raya del
   * largo del aro, y desplazarla con `stroke-dashoffset` descubre la porción
   * que corresponde al porcentaje.
   */
  readonly ringLength = computed(() => 2 * Math.PI * 50);

  /** Cuánto se retrae el trazo. En 0 % el aro queda vacío; en 100 %, completo. */
  readonly ringOffset = computed(() => {
    const percent = this.engine()?.progress().percent ?? 0;
    return this.ringLength() * (1 - percent / 100);
  });

  /** Nombres de las páginas, para titular los grupos de obligatorios. */
  readonly pageLabels = computed(() => {
    const engine = this.engine();
    if (!engine) return [];

    return engine.pages.map((page, index) => page.lab || `Página ${index + 1}`);
  });

  /**
   * Páginas para el indicador de progreso, **solo las que se ven**.
   *
   * Una regla puede esconder una página entera, y entonces desaparece también
   * del paginador: si siguiera ahí se podría pulsar para ir a una página que el
   * flujo quitó del formulario.
   *
   * Se guarda la posición real de cada una para poder volver a ella: el
   * paginador trabaja con posiciones de su propia lista y el motor con las del
   * formulario, y son distintas en cuanto falta una.
   */
  readonly pageMarks = computed(() => {
    const engine = this.engine();
    if (!engine) return [];

    const missing = engine.missing();

    return engine.paginasVisibles().map((real) => ({
      index: real,
      label: engine.pages[real]?.lab || `Página ${real + 1}`,
      current: real === engine.page(),
      incomplete: missing.some((entry) => entry.page === real),
    }));
  });

  /** En qué punto del paginador se está, contando solo las páginas visibles. */
  readonly posicionEnElPaginador = computed(() =>
    Math.max(0, this.pageMarks().findIndex((p) => p.current)),
  );

  /** Del punto pulsado a la página real. Ver [pageMarks]. */
  irAlPunto(posicion: number): void {
    const marca = this.pageMarks()[posicion];
    if (marca) this.goToPage(marca.index);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Diligenciamiento
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Registra un cambio y programa su escritura.
   *
   * El valor se refleja en pantalla al instante y la escritura va con retardo:
   * esperar a que la base confirme para mover el control lo haría sentirse
   * lento sin ninguna ganancia.
   */
  onValueChange(field: FormField, value: FieldValue): void {
    const engine = this.engine();
    const answer = this.answer();
    if (!engine || answer.ID == null) return;

    engine.setValue(field, value);
    this.persist(engine, answer.ID);
  }

  /**
   * Llegan los datos del ítem elegido en un campo de lista.
   *
   * Van por un canal aparte del valor porque no son la respuesta: acompañan a
   * `val` dentro del mismo campo, en `des`. Se anotan antes de que llegue el
   * cambio de valor —el componente emite en ese orden—, así que la escritura
   * que dispara el valor ya los incluye.
   */
  onDescriptorsChange(field: FormField, values: ResolvedDescriptor[]): void {
    this.engine()?.setDescriptors(field.id, values);
  }

  /**
   * ¿Este campo es un encabezado de sección?
   *
   * Los títulos y párrafos no son preguntas: separan bloques dentro del
   * formulario. Su tarjeta va con otro fondo para que se lean como el rótulo
   * de lo que viene debajo y no como una pregunta más que se olvidó responder.
   */
  isHeading(field: FormField): boolean {
    return field.fty === 'title' || field.fty === 'paragraph';
  }

  /** Programa la escritura de todo el formulario. */
  private persist(engine: FormEngine, id: number): void {
    const key = `form:${this.answer().GUID}`;

    this.autosave.schedule(key, async () => {
      await this.answers.update(id, {
        Fields: JSON.stringify(engine.toAnswerFields()),
        Titles: JSON.stringify(await this.titlesFor(engine, id)),
        UpdatedOn: new Date().toISOString(),
      });
    });
  }

  // ── Paginación ─────────────────────────────────────────────────────────────

  /**
   * Avanza de página.
   *
   * No bloquea por campos incompletos: en campo se salta una pregunta para
   * volver a ella —falta el dato, hay que preguntarle a alguien— y obligar a
   * completarla para pasar convierte eso en un callejón sin salida. Lo que sí
   * se hace es señalarlos, y exigirlos al guardar.
   */
  async goNext(): Promise<void> {
    this.engine()?.next();
    this.scrollToTop();
    await this.flush();
  }

  async goPrevious(): Promise<void> {
    this.engine()?.previous();
    this.scrollToTop();
    await this.flush();
  }

  async goToPage(index: number): Promise<void> {
    this.engine()?.goTo(index);
    this.scrollToTop();
    await this.flush();
  }

  /**
   * Sube al primer campo de la página nueva.
   *
   * Sin esto, cambiar de página conserva el desplazamiento: quien venía de
   * responder el último campo de una página larga aterriza a mitad de la
   * siguiente, sin ver su encabezado y con la impresión de que no pasó nada.
   *
   * El destino es el contenedor de campos y no el principio del documento: la
   * cabecera de la actividad ya se ve fija arriba, y volver a ella cada vez
   * obligaría a bajar de nuevo.
   */
  private scrollToTop(): void {
    // Tras el repintado: la página nueva todavía no está en el DOM cuando esto
    // se llama.
    setTimeout(() => {
      this.fieldsRef()?.nativeElement.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
  }

  /** Vacía lo pendiente y pide salir. */
  async requestLeave(): Promise<void> {
    await this.flush();
    this.leave.emit();
  }

  /**
   * Los descriptivos: los del formulario, **sin borrar los de fuera**.
   *
   * `toTitles()` los reconstruye desde cero con los campos marcados `pri`. Eso
   * está bien para lo que responde el usuario, pero arrasa con lo que escriben
   * las reglas de la compañía —«CORREO ENVIADO», los indicadores de conformidad
   * de Brillantex— que no salen de ningún campo `pri` y por lo tanto no se
   * regeneran. El síntoma era que aparecían al calcularse y desaparecían al
   * siguiente autoguardado.
   *
   * Se conserva lo que cumpla las dos condiciones: que no lo acabe de generar
   * el formulario, y que **no corresponda a un campo `pri`**. Lo segundo es lo
   * que evita el efecto contrario — que un descriptivo se quede pegado después
   * de borrar la respuesta que lo produjo.
   */
  private async titlesFor(
    engine: FormEngine,
    id: number,
  ): Promise<{ lab: string; val: string; id?: string }[]> {
    const generated = engine.toTitles(this.survey().Title);

    try {
      const stored = await this.answers.getByKey(id);
      const previous = JSON.parse(String(stored?.Titles ?? '[]')) as {
        lab?: string;
        val?: string;
        id?: string;
      }[];

      if (!Array.isArray(previous)) return generated;

      const priIds = new Set(
        engine.pages.flatMap((page) => page.fie).filter((field) => field.pri).map((field) => field.id),
      );

      const kept = previous.filter(
        (entry) =>
          entry.lab !== '[DEF]' &&
          entry.id != null &&
          !priIds.has(entry.id) &&
          !generated.some((item) => item.id === entry.id),
      );

      return [...generated, ...(kept as { lab: string; val: string; id?: string }[])];
    } catch (error) {
      // Descriptivos ilegibles: se escriben los del formulario y ya. Perder un
      // añadido es menos malo que no poder guardar.
      console.warn('[Formulario] no se pudieron conservar los descriptivos previos', error);
      return generated;
    }
  }

  /** Escribe lo pendiente antes de cambiar de página. */
  private async flush(): Promise<void> {
    await this.autosave.flush(`form:${this.answer().GUID}`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Guardar
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Marca la actividad como terminada.
   *
   * Antes vacía el autoguardado: guardar con un cambio todavía en el aire
   * marcaría como completa una actividad a la que le falta el último dato.
   */
  async save(): Promise<void> {
    const engine = this.engine();
    if (!engine || this.saving()) return;

    this.feedback.set('');

    /*
     * Lo que el flujo impide, se impide de verdad.
     *
     * Es la única acción del flujo que **para** al usuario en vez de ayudarle,
     * así que el motivo lo escribe quien configuró la regla y se enseña tal
     * cual: un «no se puede guardar» sin explicación deja a alguien en campo
     * sin saber qué corregir.
     */
    const bloqueos = engine.revisarFlujoAlGuardar();

    if (bloqueos.length) {
      this.feedback.set(bloqueos.join(' · '));
      void this.sound.warn();
      return;
    }

    // Con obligatorios sin responder no se decide por el usuario: se le
    // muestran y él elige entre volver a ellos o guardar la actividad
    // incompleta. Ver `RequiredDialogComponent` para el porqué de la segunda
    // opción.
    if (this.missing().length > 0) {
      this.askingRequired.set(true);

      // En campo la pantalla se mira a ratos: se pulsa guardar, se levanta la
      // vista y se da por hecho que quedó registrada. Un aviso solo visual se
      // pierde justo en ese momento.
      void this.sound.warn();
      return;
    }

    await this.commit();
  }

  /**
   * Lo que falta por responder, campos y tablas de detalle.
   *
   * Una tabla no se valida sola: el motor ve un arreglo con registros dentro y
   * lo da por respondido, pero un registro a medias es exactamente igual de
   * incompleto que una pregunta en blanco — y llega al servidor así. Los
   * registros que les faltan respuestas se añaden aquí, con su propio destino:
   * pulsarlos lleva **dentro** del registro, que es donde está lo que corregir.
   */
  readonly missing = computed<MissingEntry[]>(() => {
    const engine = this.engine();
    if (!engine) return [];

    const fromFields = engine.missing();
    const fromDetails: MissingEntry[] = [];

    for (const panel of this.panels.topLevel()) {
      const rows = panel.incompleteRows();
      if (rows.length === 0) continue;

      const entry = this.locate(engine, panel.fieldId);
      if (!entry) continue;

      fromDetails.push({
        ...entry,
        note:
          rows.length === 1
            ? '1 registro sin completar'
            : `${rows.length} registros sin completar`,
        go: () => panel.open(rows[0]),
      });
    }

    return [...fromFields, ...fromDetails];
  });

  /** Dónde está un campo dentro del formulario. */
  private locate(engine: FormEngine, fieldId: string): MissingEntry | null {
    for (const [page, content] of engine.pages.entries()) {
      const field = content.fie.find((entry) => entry.id === fieldId);
      if (field) return { field, page };
    }

    return null;
  }

  /**
   * «Revisar campos»: los enciende en rojo y lleva al primero.
   *
   * `markSubmitted` es lo que hace que la marca de obligatorio se encienda en
   * todos, no solo en los que el usuario ya había tocado.
   */
  async onReviewRequired(): Promise<void> {
    const engine = this.engine();
    if (!engine) return;

    const missing = this.missing();
    engine.markSubmitted();
    this.blocking.set(missing);
    this.askingRequired.set(false);

    if (missing.length > 0) await this.goToMissing(missing[0]);
  }

  /** «Guardar de todos modos»: la actividad queda registrada e incompleta. */
  async onSaveAnyway(): Promise<void> {
    this.askingRequired.set(false);
    await this.commit(true);
  }

  /** Escribe y marca la actividad como terminada. */
  /**
   * El estado que la actividad tenía **antes** de que el flujo lo tocara.
   *
   * `null` significa que el flujo nunca se lo cambió. La cadena vacía es otra
   * cosa: significa que no tenía ninguno, y es a eso a lo que hay que volver si
   * la regla deja de cumplirse.
   */
  private estadoAntesDelFlujo: string | null = null;

  /** El estado que el flujo dejó puesto, para no reescribir el mismo. */
  private estadoPuestoPorElFlujo: string | null = null;

  /**
   * Pone —o quita— el estado que el flujo pida.
   *
   * Se aplica en cuanto cambia, no solo al guardar: un cambio de estado por
   * una regla de «al cambiar» tiene que verse al momento, igual que se ve un
   * campo que aparece.
   *
   * Y se deshace igual que se hace. Si la regla que puso el estado deja de
   * cumplirse —se borró la respuesta que la disparaba— la actividad vuelve al
   * estado que traía, que puede ser ninguno. Dejarla con el estado puesto sería
   * como dejar visible un campo que el flujo ya no quiere mostrar.
   */
  private async aplicarEstadoDelFlujo(pedido: string | null): Promise<void> {
    const answer = this.answer();

    if (answer.ID == null) {
      console.debug('[flujo] estado: la actividad todavía no tiene ID');
      return;
    }

    const actual = String(answer.Status ?? '');

    if (!pedido) {
      // Ninguna regla pide estado. Si el flujo nunca lo tocó no hay nada que
      // hacer; si lo tocó, se devuelve a como estaba.
      if (this.estadoAntesDelFlujo === null) return;

      const vuelta = this.estadoAntesDelFlujo;
      this.estadoAntesDelFlujo = null;
      this.estadoPuestoPorElFlujo = null;

      if (actual === vuelta) return;

      await this.answers.update(answer.ID, {
        Status: vuelta,
        UpdatedOn: new Date().toISOString(),
      });

      this.statusChanged.emit(vuelta);
      this.activities.notifyChanged();
      return;
    }

    // Cómo estaba antes, la primera vez que el flujo se mete: es a lo que hay
    // que volver si la regla deja de cumplirse.
    if (this.estadoAntesDelFlujo === null) this.estadoAntesDelFlujo = actual;

    /*
     * Ya lo tiene: no se reescribe, pero tampoco se da por hecho.
     *
     * Se compara contra **la actividad** y no contra lo último que puso el
     * flujo. Así, si alguien mueve el estado a mano mientras la regla sigue
     * cumpliéndose, la siguiente evaluación lo corrige: mientras su condición
     * se cumpla, el flujo manda.
     */
    if (actual === pedido) {
      console.debug('[flujo] estado: la actividad ya está en', pedido);
      this.estadoPuestoPorElFlujo = pedido;
      return;
    }

    /*
     * Un estado que no llegó en la sincronización se ignora.
     *
     * Dejar la actividad en un estado que el navegador no conoce la vuelve
     * indescifrable en el listado —sin nombre y sin color—, y eso es peor que
     * no haberlo cambiado.
     */
    const estado = await this.estados.findByDispatchId(Number(pedido));

    if (!estado) {
      console.warn('[FormRunner] el flujo pidió un estado que no está descargado', pedido);
      return;
    }

    this.estadoPuestoPorElFlujo = pedido;

    await this.answers.update(answer.ID, {
      Status: pedido,
      UpdatedOn: new Date().toISOString(),
    });

    console.debug('[flujo] estado: actividad movida de', actual || 'ninguno', 'a', pedido, `(${estado.Name})`);

    this.statusChanged.emit(pedido);
    this.activities.notifyChanged();
  }

  /**
   * Abre las actividades que el flujo pidió crear.
   *
   * ## Qué se hereda y qué no
   *
   * La sede y el equipo se copian **solo si el formulario destino los pide del
   * mismo tipo**. Copiarlos siempre dejaría una actividad apuntando a una sede
   * que su formulario no admite, y eso llega a Visitrack como un registro
   * válido que nadie puede cuadrar después. Cuando no encajan se deja en blanco
   * y quien la abra los elige, que es lo que haría de todos modos.
   *
   * Se comparan los dos formularios entre sí y no el formulario con la
   * actividad: en la actividad el tipo de sede se guarda como GUID y en el
   * formulario como número, así que compararlos no daría igual nunca.
   *
   * Nace como borrador y colgando de la que la creó, para que se sepa de dónde
   * salió: una actividad que aparece sola en el listado sin que nadie la haya
   * pedido desconcierta.
   */
  private async abrirLasQuePidioElFlujo(answer: SurveyAnswer): Promise<void> {
    const engine = this.engine();
    if (!engine) return;

    const destinos = engine.formulariosQuePideElFlujo();
    if (!destinos.length) return;

    const user = this.auth.currentUser();
    if (!user) return;

    const deOrigen = await this.activities.findSurvey(answer.SurveyID);
    const abiertas: string[] = [];

    for (const destino of destinos) {
      const survey = await this.activities.findSurvey(destino);

      // Un formulario que no está descargado no se puede abrir. Se dice y no
      // se crea: una actividad de un formulario que no existe no se puede ni
      // diligenciar ni borrar con sentido.
      if (!survey) {
        console.warn('[FormRunner] el flujo pidió un formulario que no está descargado', destino);
        continue;
      }

      const mismaSede =
        !!deOrigen &&
        String(survey.LocationTypeID ?? '') === String(deOrigen.LocationTypeID ?? '') &&
        !!answer.LocationID;

      const mismoEquipo =
        !!deOrigen &&
        Number(survey.hasAsset) === 1 &&
        String(survey.AssetTypeID ?? '') === String(deOrigen.AssetTypeID ?? '') &&
        !!answer.AssetID;

      try {
        const nueva = await this.answers.createDraft({
          survey,
          userId: user.UserID,
          companyId: user.CompanyID,
          parentGuid: answer.GUID,
        });

        if ((mismaSede || mismoEquipo) && nueva.ID != null) {
          await this.answers.update(nueva.ID, {
            ...(mismaSede
              ? {
                  LocationTypeID: answer.LocationTypeID,
                  LocationID: answer.LocationID,
                  LocationGUID: answer.LocationGUID,
                  LocationName: answer.LocationName,
                  WorkZoneID: answer.WorkZoneID,
                }
              : {}),
            ...(mismoEquipo
              ? {
                  AssetID: answer.AssetID,
                  AssetGUID: answer.AssetGUID,
                  AssetName: answer.AssetName,
                }
              : {}),
          });
        }

        abiertas.push(survey.Title);
      } catch (error) {
        console.error('[FormRunner] no se pudo abrir la actividad del flujo', error);
      }
    }

    if (abiertas.length) {
      this.abiertasPorElFlujo.set(abiertas);
      this.activities.notifyChanged();
    }
  }

  /**
   * Apunta las consignas que pidió el flujo. **No las manda.**
   *
   * Salen cuando la actividad esté arriba con sus archivos confirmados; de eso
   * se ocupa `DespachoService`, al que se avisa desde el envío. Aquí solo se
   * dejan en la cola local para que sobrevivan a lo que pase en medio: perder
   * la conexión, cerrar la pestaña, apagar el equipo.
   */
  private async apuntarLasConsignas(answer: SurveyAnswer, incompleta: boolean): Promise<void> {
    const engine = this.engine();
    if (!engine) return;

    const pedidos = engine.despachosQuePideElFlujo();

    // Con rastro: esto ha costado varias vueltas y desde fuera «no despacha» se
    // ve igual tanto si la regla no se disparó como si se descartó aquí.
    console.debug('[flujo] consignas al guardar', {
      incompleta,
      pedidas: pedidos.length,
      detalle: pedidos,
    });

    for (const despacho of pedidos) {
      /*
       * «Solo si la actividad quedó completa».
       *
       * Guardar deja pasar aunque falten obligatorios —se avisa y quien
       * diligencia decide—, y una consigna que nace de un informe a medias
       * suele ser un error. Con la marca puesta, en ese caso no sale nada.
       */
      if (despacho['soloCompleta'] === true && incompleta) continue;

      /*
       * El que traiga la regla, el que se acaba de elegir en el diálogo, o uno
       * mismo.
       *
       * «Al mismo que la llenó» el motor no lo resuelve —tiene que dar el mismo
       * resultado en el simulador, donde no hay nadie diligenciando— así que lo
       * marca y lo resuelve quien despacha. Aquí sí se sabe quién es.
       */
      const destinatario = (
        String(despacho['destinatario'] ?? '').trim() ||
        this.elegidos.get(this.claveDeDespacho(despacho)) ||
        (despacho['mismoUsuario'] === true
          ? String(this.auth.currentUser()?.UserID ?? '')
          : '') ||
        ''
      ).trim();

      /*
       * Sin destinatario no se apunta.
       *
       * No debería llegar aquí: quien guarda ya lo resolvió en el diálogo. Si
       * llega, se avisa en vez de callarse — una consigna que desaparece sin
       * decir nada es lo peor que puede pasar con esto.
       */
      if (!destinatario) {
        console.warn('[despacho] descartado: sin a quién enviarlo', despacho);
        continue;
      }

      await this.despachos.apuntar({
        AnswerGUID: answer.GUID,
        Que: String(despacho['que'] ?? 'otro'),
        SurveyID: String(despacho['formulario'] ?? ''),
        Destinatario: destinatario,
        EstadoGUID: String(despacho['estado'] ?? ''),
        Aviso: String(despacho['aviso'] ?? ''),
        Hija: despacho['hija'] === true,
        Regla: String(despacho['regla'] ?? ''),
        Programado: String(despacho['programado'] ?? ''),
      });
    }
  }

  /**
   * Los despachos a los que les falta a quién enviarlos.
   *
   * Salen del flujo marcados con `preguntar`: o la regla dice «pregunta al
   * guardar», o dice «sácalo de este campo» y el campo vino en blanco.
   */
  private despachosSinDestinatario(): Record<string, unknown>[] {
    return (this.engine()?.despachosQuePideElFlujo() ?? []).filter((d) => d['preguntar'] === true);
  }

  /**
   * Pide el destinatario que falte, uno por uno, antes de dejar guardar.
   *
   * Devuelve `false` si se canceló: entonces **no se guarda**. Es la única
   * forma de que el despacho no se pierda sin que nadie se entere — una
   * consigna sin dueño no la ve nadie.
   */
  private async resolverDestinatarios(): Promise<boolean> {
    for (const despacho of this.despachosSinDestinatario()) {
      this.pidiendoDestinatario.set(
        despacho['que'] === 'misma' ? 'esta misma actividad' : 'una actividad nueva',
      );

      const elegido = await new Promise<Destinatario | null>((resolve) => {
        this.resolverEleccion = resolve;
      });

      this.pidiendoDestinatario.set(null);
      this.resolverEleccion = null;

      if (!elegido) {
        this.feedback.set('No se guardó: falta decir a quién se le despacha la consigna.');
        void this.sound.warn();
        return false;
      }

      // Se resuelve sobre el propio encargo: lo que se apunta después ya lleva
      // el usuario dentro y no vuelve a preguntar.
      this.elegidos.set(this.claveDeDespacho(despacho), String(elegido.ID));
    }

    return true;
  }

  /**
   * Lo elegido en el diálogo, mientras dura este guardado.
   *
   * Hace falta guardarlo aparte: `despachosQuePideElFlujo` **copia** los
   * encargos en cada llamada, así que escribir el usuario sobre lo que devuelve
   * no llega a ninguna parte — al apuntar se pediría otra vez, vendría igual de
   * vacío, y la consigna se descartaría en silencio.
   */
  private readonly elegidos = new Map<string, string>();

  /** Con qué se reconoce un despacho entre dos guardados. */
  private claveDeDespacho(d: Record<string, unknown>): string {
    return [d['regla'] ?? '', d['que'] ?? '', d['formulario'] ?? ''].join('|');
  }

  /** Qué se está despachando mientras el diálogo está abierto, o `null`. */
  readonly pidiendoDestinatario = signal<string | null>(null);

  /** Cómo se le contesta al diálogo. Ver [resolverDestinatarios]. */
  private resolverEleccion: ((quien: Destinatario | null) => void) | null = null;

  alElegirDestinatario(quien: Destinatario): void {
    this.resolverEleccion?.(quien);
  }

  alCancelarDestinatario(): void {
    this.resolverEleccion?.(null);
  }

  private async commit(incomplete = false): Promise<void> {
    const answer = this.answer();
    if (answer.ID == null) return;

    /*
     * El flujo, con el momento «al guardar», por aquí y no solo en [save].
     *
     * A esto se llega por dos botones: «guardar» y «guardar de todos modos»
     * —el de la lista de obligatorios sin responder—. Comprobándolo solo en el
     * primero, salir por el segundo dejaba la actividad sin el estado que
     * pedía el flujo y sin abrir la siguiente: el mismo formulario se
     * comportaba distinto según por qué botón se hubiera salido. Aquí pasan
     * los dos.
     *
     * Volver a evaluarlo no cuesta: con las mismas respuestas el motor da el
     * mismo resultado, así que la segunda pasada solo cambia algo si de verdad
     * cambió un dato.
     */
    const engineAlGuardar = this.engine();

    if (engineAlGuardar) {
      const bloqueos = engineAlGuardar.revisarFlujoAlGuardar();

      if (bloqueos.length) {
        this.feedback.set(bloqueos.join(' · '));
        void this.sound.warn();
        return;
      }
    }

    /*
     * Lo que falte por decidir, se decide antes de escribir nada.
     *
     * Si se cancela, no se guarda: es la única forma de que la consigna no se
     * pierda en silencio. Va aquí y no en `save` porque a `commit` se llega
     * también por «guardar de todos modos».
     */
    this.elegidos.clear();

    if (!(await this.resolverDestinatarios())) return;

    this.blocking.set([]);
    this.saving.set(true);

    try {
      await this.flush();

      // Con archivos por subir, la actividad queda esperándolos en lugar de
      // ponerse en cola: subirla antes la dejaría en Visitrack apuntando a
      // fotos que no existen, y eso pasa por completa sin serlo.
      /**
       * Las reglas de la compañía, antes de marcarla como guardada.
       *
       * Deciden el estado a partir de lo respondido —si falta la firma queda
       * pendiente, si el trabajo se cerró queda terminado—. Va antes de
       * `markSaved` para que el estado ya esté escrito cuando la actividad
       * entre en la cola de subida: al revés, podría salir con el estado
       * anterior. Ver `core/rules/company-logic.service.ts`.
       */
      const engineForRules = this.engine();
      if (engineForRules) {
        await this.companyLogic.onSaved(
          answer,
          engineForRules.toAnswerFields(),
          engineForRules.pages,
        );
      }

      /*
       * Lo que el flujo pidió hacer con la actividad.
       *
       * Después de las reglas de la compañía y antes de `markSaved`, por el
       * mismo motivo que ellas: tiene que estar escrito cuando la actividad
       * entre en la cola de subida. Después de ellas porque el flujo lo
       * configuró el cliente para este formulario, y eso es más concreto que
       * una regla de compañía escrita en el código.
       */
      await this.abrirLasQuePidioElFlujo(answer);
      await this.apuntarLasConsignas(answer, incomplete);
      await this.aplicarEstadoDelFlujo(this.engine()?.estadoDelFlujo() ?? null);

      const pendingFiles = await this.activities.countBlockingBinaries(answer.GUID);

      /*
       * «Completada» es sin obligatorios pendientes, y nada más.
       *
       * De esta marca cuelga la regla de borrado del formulario —el equipo
       * retira sus actividades terminadas pasado un plazo—, así que sellarla
       * al guardar de todos modos ponía a contar el plazo de algo que sigue a
       * medias, y la actividad acababa retirándose sin haberse terminado.
       *
       * Es el mismo criterio de la app: allí solo se sella cuando la actividad
       * pasa a un estado de completada.
       */
      const completedOn = incomplete ? '' : answer.CompletedOn || new Date().toISOString();

      await this.answers.markSaved(answer.ID, pendingFiles > 0, completedOn);

      this.activities.notifyChanged();
      this.feedback.set(this.describeSave(incomplete, pendingFiles));

      // El envío arranca aquí mismo, sin esperar al proceso del minuto: el
      // usuario acaba de pulsar Guardar y es cuando más probable es que tenga
      // cobertura y la pestaña abierta.
      //
      // Va sin `await` a propósito. Subir cinco fotos puede tardar medio
      // minuto, y bloquear el botón todo ese rato hace que la gente lo vuelva
      // a pulsar creyendo que no funcionó. El estado real se sigue en el
      // listado y en la pantalla de pendientes.
      //
      // Y **antes** de avisar de que se guardó, con el GUID ya en la mano:
      // ese aviso saca al usuario al listado y destruye este componente, así
      // que leer la entrada después sería leer algo que ya no está.
      void this.dispatch(answer.GUID);

      this.saved.emit();
    } catch (error) {
      console.error('[FormRunner] no se pudo guardar', error);
      this.feedback.set('No se pudo guardar la actividad.');
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Lanza la subida de esta actividad en segundo plano.
   *
   * Los fallos se registran pero no se le muestran al usuario: acaba de
   * guardar y su trabajo ya está a salvo en el dispositivo. Que el envío no
   * saliera ahora mismo no es un error suyo ni algo que pueda resolver desde
   * aquí — se reintentará solo, y el listado dice en qué estado quedó.
   */
  private async dispatch(guid: string): Promise<void> {
    try {
      await this.pendingUploads.run(guid);
    } catch (error) {
      console.error('[FormRunner] no se pudo enviar la actividad', error);
    }

    /*
     * Las consignas se intentan **pase lo que pase con la subida**.
     *
     * Estaban dentro del `try`, después de subir, y ahí había un caso que no
     * salía nunca: una actividad que ya estaba arriba —se guarda otra vez, o no
     * tenía nada pendiente— hace que `run` no haga nada o falle, y la consigna
     * se quedaba en la cola sin que nadie la intentara jamás.
     *
     * Intentarlo siempre es seguro: si la actividad todavía no está en
     * Visitrack, el servidor responde 409 y se reintenta. Es él quien sabe si
     * está, no nosotros.
     */
    await this.despachos.enviarPendientes(guid);
  }

  /**
   * Qué se le dice al usuario después de guardar.
   *
   * Los archivos pendientes se nombran a propósito: si no, una actividad que se
   * queda esperando a que suban sus fotos parece atascada sin motivo, y el
   * usuario acaba volviéndola a guardar o borrándola.
   */
  private describeSave(incomplete: boolean, pendingFiles: number): string {
    const head = incomplete
      ? 'Actividad guardada con campos obligatorios sin responder.'
      : 'Actividad guardada.';

    const cola =
      pendingFiles === 0
        ? `${head} Se subirá en la próxima sincronización.`
        : `${head} Se enviará cuando ${
            pendingFiles === 1 ? 'su archivo esté' : `sus ${pendingFiles} archivos estén`
          } en el servidor.`;

    // Lo que el flujo abrió se cuenta aquí y no en un aviso aparte: al guardar
    // la pantalla se va al listado, y un segundo mensaje no llegaría a leerse.
    const abiertas = this.abiertasPorElFlujo();
    if (!abiertas.length) return cola;

    return abiertas.length === 1
      ? `${cola} El flujo abrió una actividad de «${abiertas[0]}».`
      : `${cola} El flujo abrió ${abiertas.length} actividades nuevas.`;
  }

  /** Salta al campo que falta y lo deja enfocado. */
  async goToMissing(entry: MissingEntry): Promise<void> {
    this.askingRequired.set(false);
    await this.goToPage(entry.page);

    /**
     * Una tabla de detalle lleva **dentro**, al registro que está a medias.
     *
     * Llevar al campo no serviría de nada: a la vista está lleno, y lo que hay
     * que corregir son las respuestas de uno de sus registros.
     */
    if (entry.go) {
      entry.go();
      return;
    }

    // El desplazamiento va tras el repintado: el campo puede estar en otra
    // página y todavía no existir en el DOM cuando se pide.
    setTimeout(() => {
      const element = document.getElementById(`field-${entry.field.id}`);
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      element?.querySelector<HTMLElement>('input, textarea, select')?.focus({
        preventScroll: true,
      });
    });
  }

  /**
   * Los límites que el flujo puso a un campo, si puso alguno.
   *
   * Se devuelve `null` cuando no hay ninguno para que el campo no tenga que
   * distinguir entre «sin límites» y «con límites vacíos».
   */
  limitesDe(estado: { desde?: string; hasta?: string; dias?: string } | undefined) {
    if (!estado?.desde && !estado?.hasta && !estado?.dias) return null;

    return { desde: estado.desde, hasta: estado.hasta, dias: estado.dias };
  }

}
