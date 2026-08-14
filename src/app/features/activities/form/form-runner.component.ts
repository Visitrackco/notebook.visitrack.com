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
  viewChild,
} from '@angular/core';
import { MatTooltipModule } from '@angular/material/tooltip';

import { FormEngine } from '../../../core/forms/form-engine';
import { FieldValue, FormField, ResolvedDescriptor } from '../../../core/forms/form-schema';
import { Survey, SurveyAnswer } from '../../../core/models/entities.model';
import { SurveyAnswerRepository } from '../../../core/repositories/survey-answer.repository';
import { ActivityService } from '../../../core/services/activity.service';
import { AlertSoundService } from '../../../core/services/alert-sound.service';
import { ShortcutsService } from '../../../core/services/shortcuts.service';
import { AutosaveService } from '../../../core/services/autosave.service';
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
    ToTopComponent,
  ],
  templateUrl: './form-runner.component.html',
  styleUrl: './form-runner.component.scss',
})
export class FormRunnerComponent {
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly activities = inject(ActivityService);
  private readonly autosave = inject(AutosaveService);
  private readonly pendingUploads = inject(PendingUploadService);
  private readonly panels = inject(MasterDetailPanelsService);
  private readonly sound = inject(AlertSoundService);
  private readonly shortcuts = inject(ShortcutsService);
  private readonly companyLogic = inject(CompanyLogicService);

  readonly survey = input.required<Survey>();
  readonly answer = input.required<SurveyAnswer>();

  /** Se emite tras guardar, para que la pantalla refresque su cabecera. */
  readonly saved = output<void>();

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

      const engine = new FormEngine({
        questions: survey.JSONQuestion,
        answers: answer.Fields,
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
    });

    this.registerShortcuts();
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

  /** Páginas para el indicador de progreso. */
  readonly pageMarks = computed(() => {
    const engine = this.engine();
    if (!engine) return [];

    const missing = engine.missing();
    return engine.pages.map((page, index) => ({
      index,
      label: page.lab || `Página ${index + 1}`,
      current: index === engine.page(),
      incomplete: missing.some((entry) => entry.page === index),
    }));
  });

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
  private async commit(incomplete = false): Promise<void> {
    const answer = this.answer();
    if (answer.ID == null) return;

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

      const pendingFiles = await this.activities.countBlockingBinaries(answer.GUID);
      await this.answers.markSaved(answer.ID, pendingFiles > 0);

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

    if (pendingFiles === 0) return `${head} Se subirá en la próxima sincronización.`;

    const files =
      pendingFiles === 1 ? 'su archivo esté' : `sus ${pendingFiles} archivos estén`;

    return `${head} Se enviará cuando ${files} en el servidor.`;
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

}
