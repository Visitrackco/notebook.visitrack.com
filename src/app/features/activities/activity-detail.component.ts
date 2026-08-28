import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router, RouterLink, RouterOutlet } from '@angular/router';

import { resolveCatalogOwnerId } from '../../core/config/company-rules';
import {
  ANSWER_STATE,
  AnswerStateInfo,
  DeleteRule,
  describeAnswer,
  describeDeleteRule,
} from '../../core/models/activity.model';
import { Asset, DispatchStatus, LocationForm, Survey, SurveyAnswer } from '../../core/models/entities.model';
import { DispatchStatusRepository } from '../../core/repositories/entity.repositories';
import { SurveyAnswerRepository } from '../../core/repositories/survey-answer.repository';
import { ActivityService, ConsistencyIssue } from '../../core/services/activity.service';
import { DataRevisionService } from '../../core/sync/data-revision.service';
import { AuthService } from '../../core/services/auth.service';
import { AutosaveService } from '../../core/services/autosave.service';
import { DraftPolicyService, cuantoFalta } from '../../core/services/draft-policy.service';
import { ConfirmDialogComponent } from '../../shared/components/confirm-dialog/confirm-dialog.component';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { Descriptor, parseAnswerTitles } from '../../shared/utils/descriptors';
import { seedGradient, seedPalette } from '../../shared/utils/seed-color';
import { FormRunnerComponent } from './form/form-runner.component';
import { MasterDetailStackService } from './form/master-detail-row/master-detail-stack.service';
import { StatusBarComponent } from './form/status-bar/status-bar.component';

/**
 * Una actividad abierta.
 *
 * Es el destino del flujo de apertura: aquí llega quien ya resolvió ubicación y
 * activo. Esta pantalla aporta el marco —estado, contexto, estado de despacho y
 * datos de control— y delega el diligenciamiento en `vt-form-runner`, que lleva
 * los campos, la paginación y las validaciones.
 *
 * ## Autoguardado
 *
 * Nada de lo que se toca aquí necesita un botón: cada cambio se programa en
 * [AutosaveService], que agrupa las escrituras y las confirma contra IndexedDB.
 * El indicador de la cabecera dice en qué punto va, porque un guardado que no
 * se ve genera la duda de si se guardó — y esa duda lleva a la gente a repetir
 * el trabajo «por si acaso».
 *
 * El botón Guardar del formulario hace otra cosa: marca la actividad como
 * terminada y lista para subir. No es «escribir en disco», que ya pasó.
 */
@Component({
  selector: 'vt-activity-detail',
  standalone: true,
  imports: [
    ConfirmDialogComponent,
    FormRunnerComponent,
    IconComponent,
    MatButtonModule,
    MatTooltipModule,
    RouterLink,
    RouterOutlet,
    StatusBarComponent,
  ],
  templateUrl: './activity-detail.component.html',
  styleUrl: './activity-detail.component.scss',
})
export class ActivityDetailComponent {
  private readonly router = inject(Router);
  private readonly activities = inject(ActivityService);
  private readonly revisions = inject(DataRevisionService);
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly dispatch = inject(DispatchStatusRepository);
  private readonly drafts = inject(DraftPolicyService);
  private readonly auth = inject(AuthService);

  readonly autosave = inject(AutosaveService);

  private readonly rowStack = inject(MasterDetailStackService);

  /**
   * Hay una fila de tabla de detalle abierta.
   *
   * La actividad se oculta pero **no se desmonta**: dentro vive el campo que
   * abrió la fila, y es quien tiene que recibir lo que se responda en ella.
   */
  readonly rowOpen = signal(false);

  readonly surveyId = input.required<string>();
  readonly guid = input.required<string>();

  readonly loading = signal(true);
  readonly survey = signal<Survey | null>(null);
  readonly answer = signal<SurveyAnswer | null>(null);
  readonly location = signal<LocationForm | null>(null);
  readonly asset = signal<Asset | null>(null);
  readonly statuses = signal<DispatchStatus[]>([]);
  readonly feedback = signal('');

  /** Horas que vive un borrador sin guardarse, según la preferencia del usuario. */
  private readonly draftHours = signal(0);

  /**
   * La hora, para que la cuenta atrás avance sola.
   *
   * Una actividad se deja abierta mientras se diligencia —a veces horas— y un
   * «se borra en 3 h 25 min» calculado al entrar acaba mintiendo justo cuando
   * más importa. Se refresca cada minuto, que es la precisión que se enseña.
   */
  private readonly ahora = signal(Date.now());

  /**
   * Descuadre entre la ubicación y el activo.
   *
   * Con valor, el formulario no se dibuja: responder sobre una pareja
   * imposible produce una actividad que dice haber inspeccionado un equipo en
   * una sede donde no está, y eso llega a Visitrack como un dato válido.
   */
  readonly issue = signal<ConsistencyIssue | null>(null);

  /**
   * Qué diálogo está abierto.
   *
   * Uno solo a la vez: son preguntas excluyentes —salir o descartar— y con dos
   * señales sueltas sería posible dejar ambas abiertas por un camino no
   * previsto.
   */
  readonly dialog = signal<'none' | 'exit' | 'discard'>('none');

  // ── Derivados ──────────────────────────────────────────────────────────────

  readonly gradient = computed(() => {
    const survey = this.survey();
    return seedGradient(survey?.GUID || survey?.SurveyID || 'vt');
  });

  readonly accent = computed(() => {
    const survey = this.survey();
    return seedPalette(survey?.GUID || survey?.SurveyID || 'vt').from;
  });

  readonly state = computed<AnswerStateInfo | null>(() => {
    const answer = this.answer();
    return answer ? describeAnswer(answer) : null;
  });

  readonly descriptors = computed<Descriptor[]>(() => {
    const answer = this.answer();
    return answer ? parseAnswerTitles(answer.Titles) : [];
  });

  /**
   * Cuándo se borra sola, si es que se borra.
   *
   * Derivado y no guardado a mano: en cuanto la actividad deja de ser borrador
   * —al guardarla— esto pasa a `null` sin que nadie se acuerde de apagarlo. La
   * versión anterior lo calculaba una vez al abrir y se quedaba anunciando un
   * borrado imposible en una actividad que ya no se puede ni descartar.
   */
  /**
   * Cuánto le queda al borrador, en horas y minutos.
   *
   * Vacío cuando no es un borrador: una actividad guardada ya no se borra sola
   * —y tampoco se puede descartar—, así que anunciarle un plazo es mentirle.
   */
  readonly draftLeft = computed(() => {
    this.ahora();
    return cuantoFalta(this.expiresAt());
  });

  readonly expiresAt = computed<Date | null>(() => {
    const answer = this.answer();
    const hours = this.draftHours();

    if (!answer || answer.eraser !== 1 || hours <= 0) return null;

    const created = Date.parse(answer.CreatedOn ?? '');
    return Number.isFinite(created) ? new Date(created + hours * 60 * 60 * 1000) : null;
  });

  readonly deleteRule = computed<DeleteRule>(() => {
    const survey = this.survey();
    return describeDeleteRule(survey?.DeviceMaintType, survey?.DeviceMaintValue);
  });

  /** ¿El formulario permite elegir estado de despacho? */
  readonly statusEnabled = computed(() => Number(this.survey()?.StatusEnabled) === 1);

  /**
   * ¿Queda algo por guardar de verdad?
   *
   * El autoguardado escribe en el navegador, no en Visitrack. Decir «Guardado a
   * las 10:32» en cuanto vuelca lo escrito hace creer que la actividad ya está
   * hecha, cuando lo único que pasó es que no se perdería al cerrar la pestaña.
   * Mientras no se pulse Guardar, lo que hay son cambios pendientes.
   */
  readonly hasPendingChanges = computed(() => {
    const answer = this.answer();
    const editada = this.autosave.state() === 'pending' || this.autosave.state() === 'saved';

    return editada || answer?.eraser === 1 || answer?.isSaved === ANSWER_STATE.UNSAVED;
  });

  /** Texto del indicador de guardado. */
  readonly autosaveLabel = computed(() => {
    switch (this.autosave.state()) {
      case 'saving':
        return 'Guardando…';
      case 'error':
        return 'No se pudo guardar';
      default:
        return this.hasPendingChanges() ? 'Cambios pendientes' : 'Todo guardado';
    }
  });

  /**
   * Color del indicador.
   *
   * No es el estado del autoguardado: ese pone en verde un «saved» que aquí se
   * lee como «Cambios pendientes», y un texto de aviso en verde no lo mira
   * nadie.
   */
  readonly autosaveTone = computed(() => {
    const estado = this.autosave.state();

    if (estado === 'saving' || estado === 'error') return estado;
    return this.hasPendingChanges() ? 'pending' : 'saved';
  });

  /**
   * Identificador recortado.
   *
   * Los 36 caracteres completos ocupan más que cualquier otro dato del panel y
   * nadie los lee enteros; los primeros ocho bastan para reconocer de cuál se
   * habla al comparar contra un ticket.
   */
  readonly shortGuid = computed(() => {
    const guid = this.answer()?.GUID ?? '';
    return guid.length > 14 ? `${guid.slice(0, 8)}…${guid.slice(-4)}` : guid;
  });

  /** Es un borrador que se descartará al salir sin guardar. */
  readonly isDiscardable = computed(() => this.answer()?.eraser === 1);

  /** Clave del autoguardado para esta actividad. */
  private get autosaveKey(): string {
    return `answer:${this.guid()}`;
  }

  constructor() {
    // El minutero de la cuenta atrás del borrador. Se para al salir: un
    // intervalo suelto sigue despertando la pestaña para siempre.
    const minutero = setInterval(() => this.ahora.set(Date.now()), 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(minutero));

    effect(() => {
      const surveyId = this.surveyId();
      const guid = this.guid();

      // De aquí cuelgan las filas de las tablas de detalle, que son rutas
      // hijas: necesitan saber a dónde volver.
      this.rowStack.setBase(['/formularios', surveyId, 'actividad', guid]);

      void this.load(surveyId, guid);
    });

    /**
     * Refresca el encabezado cuando la actividad cambia por fuera.
     *
     * Una actividad abierta y en espera de sus archivos puede salir sola en
     * cualquier momento: la sube el proceso automático mientras el usuario la
     * tiene delante. Sin esto, la barra seguiría diciendo «esperando archivos»
     * sobre una actividad que ya llegó a Visitrack.
     *
     * Solo se relee la fila, no el formulario entero: recargar el motor
     * borraría lo que se esté escribiendo en ese momento.
     */
    effect(() => {
      this.revisions.activities();
      untracked(() => void this.refreshAnswer());
    });
  }

  /** Vuelve a leer la fila de la actividad, sin tocar el formulario. */
  private async refreshAnswer(): Promise<void> {
    const guid = this.guid();
    if (!guid || this.loading()) return;

    const updated = await this.activities.findByGuid(guid);
    if (updated) this.answer.set(updated);
  }

  private async load(surveyId: string, guid: string): Promise<void> {
    this.loading.set(true);

    try {
      const [survey, answer] = await Promise.all([
        this.activities.findSurvey(surveyId),
        this.activities.findByGuid(guid),
      ]);

      this.survey.set(survey);
      this.answer.set(answer);

      if (!answer) return;

      const [location, asset, hours] = await Promise.all([
        this.activities.locationOf(answer),
        this.activities.assetOf(answer),
        this.drafts.draftHours(),
      ]);

      this.location.set(location);
      this.asset.set(asset);
      this.draftHours.set(hours);

      // Se comprueba que ubicación y activo cuadren. Mientras no cuadren, el
      // formulario no se dibuja: lo que se responda quedaría atado a una pareja
      // imposible.
      this.issue.set(survey ? await this.activities.findConsistencyIssue(survey, answer) : null);

      if (survey && Number(survey.StatusEnabled) === 1) {
        this.statuses.set(await this.loadStatuses(survey));
      }
    } catch (error) {
      console.error('[ActivityDetail] no se pudo cargar la actividad', error);
      this.feedback.set('No se pudo cargar la actividad.');
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Estados de despacho ofrecidos por este formulario.
   *
   * `JSONStatuses` acota la lista; vacío significa «todos los de la compañía».
   */
  private async loadStatuses(survey: Survey): Promise<DispatchStatus[]> {
    const user = this.auth.currentUser();
    if (!user) return [];

    // Los estados son un catálogo, así que se consultan bajo el usuario dueño
    // del catálogo. Con `user.UserID` a secas, la compañía que los comparte se
    // quedaba sin ningún estado que elegir.
    const all = await this.dispatch.findByUser(resolveCatalogOwnerId(user));
    const allowed = this.parseAllowedStatuses(survey.JSONStatuses);

    // Lista vacía significa «todos los de la compañía», no «ninguno»: es la
    // convención del servidor y la que usa la app.
    if (allowed.length === 0) return all;

    return all.filter((status) => allowed.includes(String(status.DispatchID)));
  }

  /**
   * Estados que este formulario permite elegir.
   *
   * `JSONStatuses` llega en tres formatos según la antigüedad del registro:
   * `[1,2,3]`, `["1","2"]` y `[{"DispatchID":1}]` —a veces con `id` o `ID` en
   * lugar de `DispatchID`—. Se aceptan los tres porque conviven en producción.
   */
  private parseAllowedStatuses(raw: string): string[] {
    if (!raw?.trim()) return [];

    try {
      const decoded = JSON.parse(raw);
      if (!Array.isArray(decoded)) return [];

      return decoded
        .map((entry) => {
          if (entry && typeof entry === 'object') {
            const record = entry as Record<string, unknown>;
            return String(record['DispatchID'] ?? record['id'] ?? record['ID'] ?? '');
          }
          return String(entry ?? '');
        })
        .filter(Boolean);
    } catch {
      // Un JSON corrupto no puede dejar la actividad sin estados: se cae al
      // comportamiento por defecto, que es ofrecerlos todos.
      console.error('[ActivityDetail] JSONStatuses ilegible');
      return [];
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Autoguardado
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Aplica un cambio parcial: en memoria ya, en la base con retardo.
   *
   * `UpdatedOn` se toca en cada cambio para que el listado ordene por
   * modificación real y no por la fecha en que se creó la actividad.
   */
  private patch(changes: Partial<SurveyAnswer>): void {
    const current = this.answer();
    if (!current || current.ID == null) return;

    const updated: SurveyAnswer = {
      ...current,
      ...changes,
      UpdatedOn: new Date().toISOString(),
    };
    this.answer.set(updated);

    const id = current.ID;
    this.autosave.schedule(this.autosaveKey, async () => {
      await this.answers.update(id, { ...changes, UpdatedOn: updated.UpdatedOn });
      this.activities.notifyChanged();
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Acciones
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * El formulario terminó de guardar.
   *
   * Se relee la actividad para que la cabecera refleje su estado nuevo: acaba
   * de dejar de ser un borrador y de tener cambios sin guardar, y ambas cosas
   * se muestran arriba.
   */
  /**
   * La actividad se guardó: vuelta al listado del formulario.
   *
   * Guardar es el final del trabajo, no una pausa. Quedarse en el formulario
   * ya diligenciado obligaba a buscar el botón de volver, y lo que casi todo el
   * mundo quiere después de guardar es empezar la siguiente.
   *
   * Antes de salir se refresca la actividad en memoria: la salida puede
   * cancelarse —el diálogo de borrador— y en ese caso la pantalla tiene que
   * mostrar el estado nuevo, no el de antes de guardar.
   */
  async onFormSaved(): Promise<void> {
    const updated = await this.activities.findByGuid(this.guid());
    if (updated) this.answer.set(updated);

    await this.exit();
  }

  /**
   * Sale de la actividad.
   *
   * Si es un borrador y el usuario tiene desactivado el modo borrador, se
   * descarta —eso es justo lo que esa preferencia significa—, pero se avisa
   * antes: nadie debería descubrir que perdió lo que llevaba escrito.
   */
  async leave(): Promise<void> {
    await this.autosave.flush(this.autosaveKey);

    if (await this.drafts.shouldDiscardOnExit(this.guid())) {
      this.dialog.set('exit');
      return;
    }

    await this.exit();
  }

  /** Confirmó salir sabiendo que el borrador se descarta. */
  async confirmExit(): Promise<void> {
    this.dialog.set('none');
    await this.drafts.discard(this.guid());
    this.activities.notifyChanged();
    await this.exit();
  }

  /** Pide descartar el borrador explícitamente, sin salir por la puerta de atrás. */
  askDiscard(): void {
    this.dialog.set('discard');
  }

  async confirmDiscard(): Promise<void> {
    this.dialog.set('none');
    this.autosave.cancel(this.autosaveKey);
    await this.drafts.discard(this.guid());
    this.activities.notifyChanged();
    await this.exit();
  }

  closeDialog(): void {
    this.dialog.set('none');
  }

  /** Vuelve al listado de actividades del formulario. */
  private async exit(): Promise<void> {
    await this.router.navigate(['/formularios', this.surveyId()]);
  }

  /** Vuelve al selector de ubicación para cambiarla. */
  /**
   * Segunda línea de la ficha del activo.
   *
   * Se prefiere la etiqueta física —es la que se lee en el equipo— y si no la
   * hay, la serie o el modelo. Cualquiera de las tres sirve para confirmar que
   * el activo es el que se tiene delante, que es para lo que se mira la ficha.
   */
  assetDetail(asset: Asset): string {
    const parts = [asset.TagUID, asset.SerialNumber, [asset.Make, asset.Model].filter(Boolean).join(' ')];
    return parts.find((part) => part?.trim()) ?? '';
  }

  /**
   * Vuelve al selector de ubicación. **Solo para reparar.**
   *
   * No hay ningún acceso a esto en el uso normal: la ubicación se elige al
   * abrir la actividad y ahí queda. Cambiarla con el formulario ya
   * diligenciado dejaría las respuestas atadas a una sede que no es la que se
   * inspeccionó, y eso llega a Visitrack como un registro válido.
   *
   * El único camino hasta aquí es el aviso de datos descuadrados —una actividad
   * que llegó así del móvil, o cuyo activo desapareció del dispositivo—. Sin
   * esa salida, quedaría bloqueada para siempre sin nada que hacer.
   */
  async changeLocation(): Promise<void> {
    await this.autosave.flush(this.autosaveKey);
    await this.router.navigate(['/formularios', this.surveyId(), 'ubicaciones'], {
      queryParams: { actividad: this.guid() },
    });
  }

  /** Vuelve al selector de activo. **Solo para reparar**, como [changeLocation]. */
  async changeAsset(): Promise<void> {
    await this.autosave.flush(this.autosaveKey);
    await this.router.navigate(['/formularios', this.surveyId(), 'activos'], {
      queryParams: { actividad: this.guid() },
    });
  }

  /**
   * Cambia el estado de despacho.
   *
   * Se escribe con su propia clave de autoguardado: un cambio de estado no
   * debe arrastrar una escritura del formulario entero, que puede ser grande.
   */
  onStatusChange(dispatchId: string): void {
    const answer = this.answer();
    if (!answer || answer.ID == null) return;

    this.answer.set({ ...answer, Status: dispatchId });

    const id = answer.ID;
    this.autosave.schedule(`status:${answer.GUID}`, async () => {
      await this.answers.update(id, {
        Status: dispatchId,
        UpdatedOn: new Date().toISOString(),
      });
      this.activities.notifyChanged();
    });
  }

  /**
   * El flujo movió la actividad de estado.
   *
   * Solo se refresca la copia en memoria: el runner ya lo escribió en la base,
   * y volver a escribirlo desde aquí sería pisarlo con lo mismo. Sin esto, el
   * selector de estado de la cabecera seguía enseñando el anterior.
   */
  onFlowStatus(dispatchId: string): void {
    const answer = this.answer();
    if (!answer) return;

    this.answer.set({ ...answer, Status: dispatchId });
  }

  /** Copia el identificador completo al portapapeles. */
  async copyGuid(): Promise<void> {
    const guid = this.answer()?.GUID;
    if (!guid) return;

    try {
      await navigator.clipboard.writeText(guid);
      this.feedback.set('Identificador copiado al portapapeles.');
    } catch {
      this.feedback.set('El navegador no permitió copiar. Selecciónalo a mano.');
    }
  }

  /** Fecha legible en la zona del navegador. */
  formatDate(value: string | Date | null): string {
    if (!value) return '';

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';

    return date.toLocaleString('es', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}
