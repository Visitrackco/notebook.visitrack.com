import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatChipListboxChange, MatChipsModule } from '@angular/material/chips';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router, RouterLink } from '@angular/router';

import {
  ANSWER_STATE,
  ANSWER_STATES,
  AnswerStateInfo,
  DRAFT_FILTER,
  DeleteRule,
  describeAnswer,
  describeDeleteRule,
  matchesStateFilter,
} from '../../core/models/activity.model';
import { DispatchStatus, Survey, SurveyAnswer } from '../../core/models/entities.model';
import { DispatchStatusRepository } from '../../core/repositories/entity.repositories';
import {
  ActivityService,
  SurveyRequirements,
  readRequirements,
  resolveNextStep,
} from '../../core/services/activity.service';
import { AuthService } from '../../core/services/auth.service';
import { DraftPolicyService, cuantoFalta } from '../../core/services/draft-policy.service';
import { ConfirmDialogComponent } from '../../shared/components/confirm-dialog/confirm-dialog.component';
import { PendingUploadService } from '../../core/sync/pending-upload.service';
import { ConnectivityService } from '../../core/services/connectivity.service';
import { PdfPreviewComponent } from '../../shared/components/pdf-preview/pdf-preview.component';
import { IconComponent } from '../../shared/components/icon/icon.component';
import {
  RetentionPolicyService,
  timeLeft,
} from '../../core/services/retention-policy.service';
import { Descriptor, descriptorsMatch, parseAnswerTitles } from '../../shared/utils/descriptors';
import { SeedPalette, seedGradient, seedPalette } from '../../shared/utils/seed-color';
import { Colleague } from '../../core/services/reassign.service';
import { ToastService } from '../../core/services/toast.service';
import { ReassignDialogComponent } from './reassign-dialog/reassign-dialog.component';
import {
  ActionItem,
  ActivityAction,
  ActivityActionsComponent,
} from './activity-actions/activity-actions.component';

/** Una actividad ya preparada para pintarse. */
export interface ActivityCard {
  answer: SurveyAnswer;
  state: AnswerStateInfo;
  /** Descriptivos que la distinguen de las demás del mismo formulario. */
  descriptors: Descriptor[];
  /** Color del estado de despacho, si lo tiene. */
  dispatchColor: string;
  dispatchName: string;
  updated: string;
  created: string;
  /** GUID recortado para mostrar sin ocupar toda la línea. */
  shortGuid: string;

  /**
   * Cuándo se retirará del equipo, si el formulario tiene regla de borrado.
   *
   * Vacío cuando no aplica. Se dice en la propia ficha y no solo en el panel de
   * información: la regla general —«30 días»— no responde la pregunta que se
   * hace quien mira una actividad concreta, que es cuánto le queda a **esta**.
   */
  retires: string;

  /**
   * Cuánto le queda como borrador, si lo es.
   *
   * Es otra cosa distinta de [retires]: aquí no se libera espacio, se **pierde
   * lo diligenciado**. Por eso se dice aunque la ficha ya diga «Borrador»: la
   * etiqueta cuenta qué es, no cuánto le queda.
   */
  borrador: string;
}

/** Por qué campo se ordena el listado. */
type SortField = 'UpdatedOn' | 'CreatedOn';

/**
 * Actividades de un formulario.
 *
 * Es la pantalla donde se decide qué hacer: crear una actividad nueva o retomar
 * una empezada. Replica la lista de la app móvil, incluida la parte que no se
 * ve a primera vista pero es la que evita sorpresas — el estado de cada
 * actividad, el aviso de las que esperan archivos, y la regla de borrado del
 * formulario.
 *
 * ## Por qué la creación no abre el formulario de una vez
 *
 * Un formulario puede exigir ubicación, activo, o ambos. Esa cadena se resuelve
 * en [ActivityService.resolveNextStep] y se recorre con rutas, no con estado en
 * memoria: cada paso lleva el GUID de la actividad en la URL, así que recargar
 * la página en mitad del flujo lo retoma donde iba en vez de empezar de cero.
 */
@Component({
  selector: 'vt-activities',
  standalone: true,
  imports: [
    ActivityActionsComponent,
    ConfirmDialogComponent,
    IconComponent,
    MatButtonModule,
    MatChipsModule,
    MatTooltipModule,
    ReassignDialogComponent,
    RouterLink,
    PdfPreviewComponent,
  ],
  templateUrl: './activities.component.html',
  styleUrl: './activities.component.scss',
})
export class ActivitiesComponent {
  private readonly router = inject(Router);
  private readonly activities = inject(ActivityService);
  private readonly pendingUploads = inject(PendingUploadService);
  readonly connectivity = inject(ConnectivityService);
  private readonly toasts = inject(ToastService);
  private readonly dispatch = inject(DispatchStatusRepository);
  private readonly auth = inject(AuthService);

  readonly drafts = inject(DraftPolicyService);

  /**
   * Formulario cuyas actividades se listan. Llega del segmento de la ruta.
   *
   * Es un `input` y no una lectura de `snapshot` porque la ruta puede cambiar
   * sin que el componente se destruya —navegar de un formulario a otro— y con
   * el snapshot la lista se quedaría mostrando las actividades del anterior.
   */
  readonly surveyId = input.required<string>();

  // ── Estado de la pantalla ──────────────────────────────────────────────────

  /** La actividad cuyo PDF se está viendo. `null` = vista previa cerrada. */
  readonly pdfCard = signal<ActivityCard | null>(null);

  /** Mientras se comprueba contra el servidor. */
  readonly checking = signal(false);

  /**
   * Dirección del documento que se está viendo.
   *
   * Se calcula aquí y no en la plantilla porque el servicio es privado, y
   * abrirlo entero a la vista solo para componer una dirección sería pagar de
   * más: la plantilla no necesita nada más de él.
   */
  readonly pdfUrl = computed(() => {
    const card = this.pdfCard();
    return card ? this.activities.pdfUrl(card.answer.GUID) : '';
  });

  /**
   * Con qué se titula la vista previa.
   *
   * Los descriptivos son lo que distingue una actividad de otra del mismo
   * formulario —es para lo que están—, así que se usan los dos primeros. Si no
   * hay, queda el GUID recortado, que al menos identifica.
   */
  readonly pdfTitulo = computed(() => {
    const card = this.pdfCard();
    if (!card) return 'Actividad';

    const desc = card.descriptors
      .slice(0, 2)
      .map((d) => d.val)
      .filter((v) => !!v)
      .join('  ·  ');

    return desc || `Actividad ${card.shortGuid}`;
  });

  readonly loading = signal(true);
  readonly survey = signal<Survey | null>(null);

  /**
   * Si este formulario deja crear actividades a mano.
   *
   * Apagado, solo recibe consignas: se sigue diligenciando cuando alguien se lo
   * despacha, pero no se puede arrancar una desde aquí. Nulo o ausente es
   * «nadie lo ha tocado», y eso es que sí — mismo criterio que la columna del
   * servidor, que se añadió como NULL a propósito.
   */
  readonly puedeCrear = computed(() => this.survey()?.CreateEnabled !== 0);
  readonly all = signal<ActivityCard[]>([]);
  readonly creating = signal(false);
  readonly feedback = signal('');

  /** Filtros y orden. */
  readonly search = signal('');
  readonly stateFilter = signal<number | null>(null);
  readonly sortField = signal<SortField>('UpdatedOn');
  readonly sortDescending = signal(true);

  /** Paneles desplegables. */
  readonly showFilters = signal(false);
  readonly showInfo = signal(false);

  /** Actividad cuyo panel de acciones está abierto. */
  readonly selected = signal<ActivityCard | null>(null);
  readonly actionsOpen = signal(false);

  /** Archivos de la actividad seleccionada. Se consultan al abrir el panel. */
  private readonly binaryCount = signal(0);
  private readonly blockingBinaries = signal(0);

  /** Confirmación de borrado abierta. */
  readonly removing = signal(false);

  /** Estados disponibles en el filtro. */
  readonly states = ANSWER_STATES;
  readonly draftFilter = DRAFT_FILTER;

  // ── Derivados ──────────────────────────────────────────────────────────────

  /** Color estable del formulario. El mismo que en el listado. */
  readonly palette = computed<SeedPalette>(() => {
    const survey = this.survey();
    return seedPalette(survey?.GUID || survey?.SurveyID || 'vt');
  });

  readonly gradient = computed(() => {
    const survey = this.survey();
    return seedGradient(survey?.GUID || survey?.SurveyID || 'vt');
  });

  readonly initial = computed(() =>
    (this.survey()?.Title?.trim().charAt(0) || '?').toUpperCase(),
  );

  /** Qué exige el formulario antes de dejarse diligenciar. */
  readonly requirements = computed<SurveyRequirements | null>(() => {
    const survey = this.survey();
    return survey ? readRequirements(survey) : null;
  });

  /** Regla de borrado, para el panel de información. */
  readonly deleteRule = computed<DeleteRule>(() => {
    const survey = this.survey();
    return describeDeleteRule(survey?.DeviceMaintType, survey?.DeviceMaintValue);
  });

  /** Las que se muestran, tras aplicar búsqueda, filtro y orden. */
  readonly cards = computed(() => {
    const term = this.search().trim().toLowerCase();
    const state = this.stateFilter();
    const field = this.sortField();
    const descending = this.sortDescending();

    let result = this.all().filter((card) => matchesStateFilter(card.answer, state));

    if (term) {
      result = result.filter(
        (card) =>
          card.answer.LocationName?.toLowerCase().includes(term) ||
          card.answer.AssetName?.toLowerCase().includes(term) ||
          card.answer.Consecutive?.toLowerCase().includes(term) ||
          descriptorsMatch(card.descriptors, term),
      );
    }

    return [...result].sort((a, b) => {
      const left = (a.answer[field] ?? '').toString();
      const right = (b.answer[field] ?? '').toString();
      return descending ? right.localeCompare(left) : left.localeCompare(right);
    });
  });

  readonly total = computed(() => this.all().length);
  readonly visible = computed(() => this.cards().length);
  readonly isFiltered = computed(
    () => this.search().trim().length > 0 || this.stateFilter() !== null,
  );

  /** Con qué nombre se identifica la actividad en la confirmación de borrado. */
  readonly removingLabel = computed(() => {
    const card = this.selected();
    if (!card) return 'esta actividad';
    return card.descriptors[0]?.val || card.answer.LocationName || 'esta actividad';
  });

  /** Aviso extra al borrar algo que ya está en Visitrack. */
  readonly removingDetail = computed(() =>
    this.selected()?.answer.IsUpload === '1'
      ? 'Esta actividad ya subió a Visitrack: se marcará para eliminarse allí en la próxima sincronización.'
      : '',
  );

  /** Cuántas esperan a que sus archivos lleguen al servidor. */
  readonly waitingCount = computed(
    () => this.all().filter((card) => card.state.key === 'waiting').length,
  );

  /**
   * Acciones disponibles para la actividad seleccionada.
   *
   * Las reglas son las mismas de la app, y aquí están juntas en vez de
   * repartidas por los manejadores. Ninguna acción se oculta por no cumplirse
   * su condición: se deshabilita **con el motivo a la vista**. Ocultarla deja
   * al usuario buscando una opción que sabe que existe; deshabilitarla sin
   * explicar la convierte en un botón roto.
   */
  readonly actions = computed<ActionItem[]>(() => {
    const card = this.selected();
    const survey = this.survey();
    if (!card || !survey) return [];

    const answer = card.answer;
    const isDraft = answer.eraser === 1;
    const blocking = this.blockingBinaries();
    const files = this.binaryCount();

    const items: ActionItem[] = [
      {
        id: 'open',
        label: 'Abrir',
        hint: 'Continuar diligenciando',
        icon: 'clipboard',
        tone: 'brand',
      },
    ];

    // El PDF lo genera Visitrack, así que solo existe para lo que ya subió.
    if (String(survey.IsDownloadPDF) === '1') {
      items.push({
        id: 'pdf',
        label: 'Descargar PDF',
        hint: 'Abre el informe en otra pestaña',
        icon: 'file',
        tone: 'neutral',
        disabledReason:
          answer.IsUpload === '1' ? undefined : 'Disponible cuando la actividad haya subido',
      });
    }

    items.push({
      id: 'reprocess',
      label: 'Reprocesar archivos',
      hint:
        files === 1 ? 'Vuelve a subir su archivo' : `Vuelve a subir sus ${files} archivos`,
      icon: 'cloud-upload',
      tone: 'warning',
      disabledReason: files === 0 ? 'Esta actividad no tiene archivos' : undefined,
    });

    items.push({
      id: 'reassign',
      label: 'Reasignar',
      hint: 'Pasarla a otro usuario',
      icon: 'send',
      tone: 'neutral',
      disabledReason: this.reassignBlocker(card),
    });

    items.push({
      id: 'copy',
      label: 'Copiar identificador',
      hint: 'Para rastrearla en Visitrack',
      icon: 'copy',
      tone: 'neutral',
    });

    items.push({
      id: 'delete',
      label: 'Eliminar',
      hint: isDraft ? 'Descarta el borrador' : 'También la borra de Visitrack',
      icon: 'trash',
      tone: 'danger',
      // Borrar con archivos a medio subir deja huérfano lo que ya llegó al
      // servidor, y el usuario pierde fotos que creía guardadas.
      disabledReason:
        !isDraft && blocking > 0
          ? blocking === 1
            ? 'Hay 1 archivo sin terminar de subir'
            : `Hay ${blocking} archivos sin terminar de subir`
          : undefined,
    });

    return items;
  });

  /** Por qué no se puede reasignar esta actividad. `undefined` si sí se puede. */
  // ── Reasignar ──────────────────────────────────────────────────────────────

  /** Actividad que se está entregando a otra persona. */
  readonly reassigning = signal<ActivityCard | null>(null);

  /** Con qué se reconoce en el diálogo. */
  readonly reassignLabel = computed(() => {
    const card = this.reassigning();
    if (!card) return '';

    return (
      [card.answer.LocationName, card.answer.AssetName].filter(Boolean).join(' · ') ||
      'Actividad'
    );
  });

  /**
   * La actividad ya es de otra persona.
   *
   * Se recarga el listado porque el servicio la quitó de este dispositivo: si
   * siguiera en pantalla, abrirla llevaría a una actividad que ya no existe.
   */
  async onReassigned(person: Colleague): Promise<void> {
    this.reassigning.set(null);

    this.toasts.success('Actividad reasignada', `Ahora es de ${person.name}.`);
    await this.load(this.surveyId());
  }

  private reassignBlocker(card: ActivityCard): string | undefined {
    const answer = card.answer;

    // Reasignar transfiere la propiedad en el servidor. Si los cambios locales
    // no han llegado allí, se perderían al pasar a otra persona.
    if (answer.eraser === 1) return 'Termínala y sincronízala antes';
    if (answer.isSaved === ANSWER_STATE.WAITING_BINARIES) return 'Espera a que suban sus archivos';
    if (answer.isSaved !== ANSWER_STATE.SYNCED) return 'Debe estar sincronizada';

    return undefined;
  }

  constructor() {
    // Recarga cuando cambia el formulario de la ruta o cuando otra parte de la
    // aplicación toca las actividades (crear, asociar ubicación, eliminar).
    effect(() => {
      const surveyId = this.surveyId();
      this.activities.revision();
      void this.load(surveyId);
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Carga
  // ───────────────────────────────────────────────────────────────────────────

  private async load(surveyId: string): Promise<void> {
    if (!surveyId) return;

    try {
      const survey = await this.activities.findSurvey(surveyId);
      this.survey.set(survey);

      if (!survey) {
        this.all.set([]);
        return;
      }

      const [answers, statuses, draftHours] = await Promise.all([
        this.activities.listBySurvey(surveyId),
        this.loadDispatchStatuses(),
        this.drafts.draftHours(),
      ]);

      this.draftHours = draftHours;

      this.all.set(answers.map((answer) => this.toCard(answer, statuses)));
    } catch (error) {
      console.error('[Activities] no se pudieron cargar las actividades', error);
      this.feedback.set('No se pudieron cargar las actividades.');
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Estados de despacho, indexados por su identificador.
   *
   * En el móvil esto era un `LEFT JOIN`; IndexedDB no tiene uniones, así que se
   * trae el catálogo entero —son unas pocas filas— y se cruza en memoria.
   */
  private async loadDispatchStatuses(): Promise<Map<string, DispatchStatus>> {
    const user = this.auth.currentUser();
    if (!user) return new Map();

    const statuses = await this.dispatch.findByUser(Number(user.UserID) || 0);
    return new Map(statuses.map((status) => [String(status.DispatchID), status]));
  }

  private readonly retention = inject(RetentionPolicyService);

  /** Horas que vive un borrador aquí, según la preferencia del usuario. */
  private draftHours = 0;

  private toCard(answer: SurveyAnswer, statuses: Map<string, DispatchStatus>): ActivityCard {
    const dispatch = statuses.get(String(answer.Status));

    // La regla es del formulario, así que sale de la actividad abierta: no hace
    // falta consultarla por cada ficha.
    const expires = this.retention.expiresAt(answer, this.retention.ruleOf(this.survey()));

    return {
      answer,
      state: describeAnswer(answer),
      descriptors: parseAnswerTitles(answer.Titles),
      // El color viene como '#rrggbb'; si llega vacío la ficha usa el del estado.
      dispatchColor: dispatch?.Color?.startsWith('#') ? dispatch.Color : '',
      dispatchName: dispatch?.Name ?? '',
      updated: formatDateTime(answer.UpdatedOn),
      created: formatDateTime(answer.CreatedOn),
      shortGuid: shortenGuid(answer.GUID),
      retires: expires ? timeLeft(expires) : '',
      borrador: this.cuantoLeQuedaAlBorrador(answer),
    };
  }

  /**
   * Cuánto le queda a un borrador antes de que se limpie solo.
   *
   * Vacío si no es un borrador. Es la otra regla, la del equipo: cuenta desde
   * que se creó y las horas las pone el usuario en sus preferencias. Y aquí sí
   * se pierde trabajo, así que se dice en la propia ficha y con minutos — «te
   * quedan 40 min» y «te quedan 3 h» llevan a decisiones distintas.
   */
  private cuantoLeQuedaAlBorrador(answer: SurveyAnswer): string {
    if (answer.eraser !== 1 || this.draftHours <= 0) return '';

    const creada = Date.parse(answer.CreatedOn ?? '');
    if (!Number.isFinite(creada)) return '';

    return cuantoFalta(new Date(creada + this.draftHours * 3_600_000));
  }

  /**
   * Copia el identificador completo al portapapeles.
   *
   * En la ficha se muestra recortado por espacio, pero soporte lo pide entero
   * para rastrear una actividad en Visitrack — y transcribir 36 caracteres a
   * mano es una fuente garantizada de errores.
   */
  async copyGuid(card: ActivityCard): Promise<void> {
    try {
      await navigator.clipboard.writeText(card.answer.GUID);
      this.feedback.set('Identificador copiado al portapapeles.');
    } catch {
      this.feedback.set('El navegador no permitió copiar. Selecciónalo a mano.');
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Panel de acciones
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Abre el panel de una actividad.
   *
   * Los archivos se cuentan **al abrir** y no al pintar la lista: sería una
   * consulta por ficha en cada recarga, y el dato solo hace falta cuando el
   * usuario va a decidir algo con él.
   */
  async openActions(card: ActivityCard): Promise<void> {
    this.selected.set(card);
    this.actionsOpen.set(true);

    try {
      const [total, blocking] = await Promise.all([
        this.activities.countBinaries(card.answer.GUID),
        this.activities.countBlockingBinaries(card.answer.GUID),
      ]);
      this.binaryCount.set(total);
      this.blockingBinaries.set(blocking);
    } catch {
      this.binaryCount.set(0);
      this.blockingBinaries.set(0);
    }
  }

  /**
   * Cierra el panel.
   *
   * La actividad seleccionada se conserva a propósito: si se anulara aquí, el
   * `@if` de la plantilla destruiría el `<dialog>` en el mismo tick, antes de
   * que el navegador termine de cerrarlo. Se sobrescribe sola la próxima vez
   * que se abre el panel.
   */
  closeActions(): void {
    this.actionsOpen.set(false);
  }

  async onAction(action: ActivityAction): Promise<void> {
    const card = this.selected();
    if (!card) return;

    this.closeActions();

    switch (action) {
      case 'open':
        await this.open(card);
        break;
      case 'pdf':
        this.downloadPdf(card);
        break;
      case 'reprocess':
        await this.reprocessBinaries(card);
        break;
      case 'reassign':
        this.reassigning.set(card);
        break;
      case 'copy':
        await this.copyGuid(card);
        break;
      case 'delete':
        this.askRemove(card);
        break;
    }
  }

  /**
   * Abre la vista previa del PDF dentro de la aplicación.
   *
   * Antes saltaba a otra pestaña, que era lo único posible mientras el
   * generador respondía `attachment`. Revisar actividades es abrir varias
   * seguidas, y cada una dejaba una pestaña huérfana detrás.
   */
  private downloadPdf(card: ActivityCard): void {
    this.pdfCard.set(card);
  }

  /** Devuelve los archivos al estado inicial para que se vuelvan a subir. */
  private async reprocessBinaries(card: ActivityCard): Promise<void> {
    const count = await this.activities.reprocessBinaries(card.answer.GUID);

    this.feedback.set(
      count === 0
        ? 'Esta actividad no tiene archivos.'
        : count === 1
          ? 'Se marcó 1 archivo para volver a subirse.'
          : `Se marcaron ${count} archivos para volver a subirse.`,
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Acciones
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Crea una actividad y arranca el flujo de apertura.
   *
   * La actividad queda guardada antes de navegar: si el usuario abandona el
   * selector de ubicación, la encuentra en la lista como borrador en vez de
   * haber desaparecido sin dejar rastro.
   */
  async createActivity(): Promise<void> {
    const survey = this.survey();
    if (!survey || this.creating()) return;

    /*
     * Y aunque el boton no se pinte.
     *
     * A esto tambien se llega por teclado, por una ruta guardada o por un ajuste
     * que cambio mientras la pantalla estaba abierta. Esconder el boton es lo
     * que se ve; esta linea es la que de verdad lo impide.
     */
    if (!this.puedeCrear()) return;

    this.creating.set(true);
    this.feedback.set('');

    try {
      const answer = await this.activities.create(survey);
      await this.goToNextStep(answer);
    } catch (error) {
      console.error('[Activities] no se pudo crear la actividad', error);
      this.feedback.set('No se pudo crear la actividad.');
    } finally {
      this.creating.set(false);
    }
  }

  /** Abre una actividad existente por donde le corresponda. */
  async open(card: ActivityCard): Promise<void> {
    await this.goToNextStep(card.answer);
  }

  /** Lleva al paso que falte: ubicación, activo o el formulario. */
  private async goToNextStep(answer: SurveyAnswer): Promise<void> {
    const requirements = this.requirements();
    const surveyId = this.survey()?.SurveyID;
    if (!requirements || !surveyId) return;

    const step = resolveNextStep(requirements, answer);

    if (step === 'form') {
      await this.router.navigate(['/formularios', surveyId, 'actividad', answer.GUID]);
      return;
    }

    const segment = step === 'location' ? 'ubicaciones' : 'activos';
    await this.router.navigate(['/formularios', surveyId, segment], {
      queryParams: { actividad: answer.GUID },
    });
  }

  /**
   * Elimina una actividad.
   *
   * Se confirma siempre: en el listado las fichas se parecen entre sí y borrar
   * la equivocada supone perder trabajo de campo que no se puede rehacer.
   */
  askRemove(card: ActivityCard): void {
    this.selected.set(card);
    this.removing.set(true);
  }

  /** Ejecuta el borrado tras la confirmación. */
  async remove(): Promise<void> {
    const card = this.selected();
    this.removing.set(false);
    if (!card) return;

    try {
      const result = await this.activities.remove(card.answer);
      this.feedback.set(
        result === 'flagged'
          ? 'La actividad ya estaba en Visitrack: se marcó para eliminarse en la próxima sincronización.'
          : 'Actividad eliminada.',
      );
    } catch (error) {
      console.error('[Activities] no se pudo eliminar', error);
      this.feedback.set('No se pudo eliminar la actividad.');
    }
  }

  /**
   * Refresca la lista y limpia los borradores caducados.
   *
   * Es el gesto de «vuelve a mirar»: además de releer, aprovecha para ejecutar
   * el mantenimiento, que es justo lo que el usuario espera cuando refresca
   * porque «esa actividad ya no debería estar ahí».
   */
  /**
   * Comprueba de verdad: pregunta al servidor y vacía la cola.
   *
   * Antes esto solo hacía mantenimiento local —borrar borradores caducados y
   * repintar—, así que el botón junto a «N actividades esperan que sus archivos
   * lleguen al servidor» no llegaba a preguntar por esos archivos. Pulsarlo no
   * cambiaba nada y la única forma de salir de ahí era esperar al proceso
   * automático, sin saber que existía.
   *
   * `PendingUploadService.run()` es lo que hace el trabajo completo: sube lo
   * que no ha salido del navegador, le pide al servidor que confirme los
   * archivos y manda las actividades que ya no tienen nada bloqueándolas.
   */
  async refresh(): Promise<void> {
    this.feedback.set('');

    if (this.checking()) return;

    // Sin conexión no hay nada que comprobar, y decirlo evita que el botón
    // parezca averiado: el resto de la aplicación sí funciona sin red.
    if (this.connectivity.isOffline()) {
      this.feedback.set('Sin conexión: no se puede comprobar con el servidor todavía.');
      return;
    }

    this.checking.set(true);

    try {
      const removed = await this.activities.runMaintenance();
      const summary = await this.pendingUploads.run();

      const partes: string[] = [];

      if (summary.confirmedFiles > 0) {
        partes.push(
          summary.confirmedFiles === 1
            ? '1 archivo confirmado'
            : `${summary.confirmedFiles} archivos confirmados`,
        );
      }

      if (summary.sentActivities > 0) {
        partes.push(
          summary.sentActivities === 1
            ? '1 actividad enviada'
            : `${summary.sentActivities} actividades enviadas`,
        );
      }

      if (removed > 0) {
        partes.push(
          removed === 1
            ? '1 borrador caducado eliminado'
            : `${removed} borradores caducados eliminados`,
        );
      }

      if (partes.length) {
        this.feedback.set(`${partes.join(', ')}.`);
      } else if (summary.stillWaiting > 0) {
        // Que no haya cambiado nada es un resultado, no un fallo: los archivos
        // grandes tardan en confirmarse. Decirlo evita volver a pulsar en bucle.
        this.feedback.set(
          'El servidor todavía no confirma los archivos. Vuelve a comprobar en un momento.',
        );
      } else {
        this.feedback.set(summary.message || 'Todo está al día.');
      }
    } catch {
      this.feedback.set('No se pudo comprobar con el servidor. Inténtalo de nuevo.');
    } finally {
      this.checking.set(false);
      this.activities.notifyChanged();
    }
  }

  // ── Filtros ────────────────────────────────────────────────────────────────

  onSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  clearSearch(): void {
    this.search.set('');
  }

  /**
   * Cambio de filtro desde los chips.
   *
   * Deseleccionar el chip activo deja `value` en `undefined`; se traduce a
   * `null`, que es «todos» — el listado nunca se queda sin nada que mostrar.
   */
  onStateChange(event: MatChipListboxChange): void {
    this.stateFilter.set(event.value ?? null);
  }

  setSort(field: SortField): void {
    if (this.sortField() === field) {
      this.sortDescending.update((value) => !value);
      return;
    }
    this.sortField.set(field);
    this.sortDescending.set(true);
  }

  clearFilters(): void {
    this.search.set('');
    this.stateFilter.set(null);
    this.sortField.set('UpdatedOn');
    this.sortDescending.set(true);
  }

  toggleFilters(): void {
    this.showFilters.update((value) => !value);
  }

  toggleInfo(): void {
    this.showInfo.update((value) => !value);
  }

  /** Índice para `@for`. El GUID es estable aunque cambie el orden. */
  trackByGuid(_: number, card: ActivityCard): string {
    return card.answer.GUID;
  }
}

/**
 * Fecha legible en la zona horaria del navegador.
 *
 * Las fechas se guardan en UTC —así lo hace el móvil y así las espera el
 * servidor— pero mostrarlas en UTC confundiría a quien trabaja de noche: vería
 * una actividad creada «mañana».
 */
function formatDateTime(value: string): string {
  if (!value) return '';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleString('es', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * GUID recortado: primeros ocho y últimos cuatro.
 *
 * Suficiente para reconocer de cuál se habla al comparar contra un ticket, sin
 * gastar una línea entera de la ficha en 36 caracteres que nadie lee enteros.
 */
function shortenGuid(guid: string): string {
  if (!guid || guid.length <= 14) return guid;
  return `${guid.slice(0, 8)}…${guid.slice(-4)}`;
}
