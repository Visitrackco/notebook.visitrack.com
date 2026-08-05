import {
  Component,
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
import { FieldValue, FormField } from '../../../core/forms/form-schema';
import { Survey, SurveyAnswer } from '../../../core/models/entities.model';
import { SurveyAnswerRepository } from '../../../core/repositories/survey-answer.repository';
import { ActivityService } from '../../../core/services/activity.service';
import { AutosaveService } from '../../../core/services/autosave.service';
import { PendingUploadService } from '../../../core/sync/pending-upload.service';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { FieldHostComponent } from './fields/field-host.component';
import { PageNavComponent } from './page-nav/page-nav.component';
import { MissingEntry, RequiredDialogComponent } from './required-dialog/required-dialog.component';

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
  ],
  templateUrl: './form-runner.component.html',
  styleUrl: './form-runner.component.scss',
})
export class FormRunnerComponent {
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly activities = inject(ActivityService);
  private readonly autosave = inject(AutosaveService);
  private readonly pendingUploads = inject(PendingUploadService);

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

  /** Programa la escritura de todo el formulario. */
  private persist(engine: FormEngine, id: number): void {
    const key = `form:${this.answer().GUID}`;

    this.autosave.schedule(key, async () => {
      await this.answers.update(id, {
        Fields: JSON.stringify(engine.toAnswerFields()),
        Titles: JSON.stringify(engine.toTitles(this.survey().Title)),
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
    if (engine.missing().length > 0) {
      this.askingRequired.set(true);
      return;
    }

    await this.commit();
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

    const missing = engine.missing();
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
      const pendingFiles = await this.activities.countBlockingBinaries(answer.GUID);
      await this.answers.markSaved(answer.ID, pendingFiles > 0);

      this.activities.notifyChanged();
      this.feedback.set(this.describeSave(incomplete, pendingFiles));
      this.saved.emit();

      // El envío arranca aquí mismo, sin esperar al proceso del minuto: el
      // usuario acaba de pulsar Guardar y es cuando más probable es que tenga
      // cobertura y la pestaña abierta.
      //
      // Va sin `await` a propósito. Subir cinco fotos puede tardar medio
      // minuto, y bloquear el botón todo ese rato hace que la gente lo vuelva
      // a pulsar creyendo que no funcionó. El estado real se sigue en el
      // listado y en la pantalla de pendientes.
      void this.dispatch();
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
  private async dispatch(): Promise<void> {
    try {
      await this.pendingUploads.run(this.answer().GUID);
      this.activities.notifyChanged();
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
