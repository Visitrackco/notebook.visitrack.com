import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';

import { resolveCatalogOwnerId } from '../../core/config/company-rules';
import { DispatchStatus, Survey, SurveyAnswer } from '../../core/models/entities.model';
import {
  DispatchStatusRepository,
  SurveyRepository,
} from '../../core/repositories/entity.repositories';
import { SurveyAnswerRepository } from '../../core/repositories/survey-answer.repository';
import { ActivityService } from '../../core/services/activity.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { DataRevisionService } from '../../core/sync/data-revision.service';
import { DispatchFile, DispatchFilesService } from '../../core/sync/dispatch-files.service';
import { ConfirmDialogComponent } from '../../shared/components/confirm-dialog/confirm-dialog.component';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { ToTopComponent } from '../../shared/components/to-top/to-top.component';
import { NearEndDirective } from '../../shared/directives/near-end.directive';
import { Descriptor, descriptorsMatch, parseAnswerTitles } from '../../shared/utils/descriptors';
import { etiquetaDeConsigna } from '../../shared/utils/fecha-consigna';
import {
  ReasignacionHecha,
  ReassignDialogComponent,
} from '../activities/reassign-dialog/reassign-dialog.component';

/** Cómo se ordena la lista. */
type Orden = 'programada' | 'recibida';

/** Una consigna, lista para pintar. */
interface DispatchCard {
  guid: string;

  /** La actividad tal cual, para las acciones sobre varias. */
  answer: SurveyAnswer;
  surveyId: string;
  surveyTitle: string;

  /** Dónde hay que ir: la ubicación, y el activo si lo hay. */
  place: string;

  /** Estado de despacho, con su color. */
  statusName: string;
  statusColor: string;

  /** Cuándo llegó. */
  received: string;
  receivedLabel: string;

  /** Para cuándo es, `YYYY-MM-DD HH:mm`, y cómo se lee. Vacío si no trae. */
  due: string;
  dueLabel: string;

  descriptors: Descriptor[];

  /** Ya se diligenció y se envió. */
  done: boolean;

  /** Archivos que la consigna trae del servidor. */
  files: DispatchFile[];

  haystack: string;
}

/**
 * Las consignas del usuario.
 *
 * ## Qué es una consigna
 *
 * Una actividad que **no** la creó quien la diligencia: la asignó la plataforma
 * y llegó al dispositivo con su ubicación, su activo y su estado de despacho ya
 * puestos. Es trabajo encargado, no trabajo propio, y por eso se mira distinto:
 * lo que se pregunta aquí no es «¿qué he hecho?» sino «¿qué me toca?».
 *
 * ## Por qué una pantalla propia
 *
 * Hasta ahora quedaban repartidas dentro de cada formulario, mezcladas con las
 * actividades creadas por el propio usuario. Con tres formularios eso son tres
 * pantallas que revisar para saber qué hay pendiente, y ninguna responde la
 * pregunta completa. Aquí están todas, ordenadas por para cuándo son (o por
 * lo que llegó antes, si se pide).
 *
 * ## Qué no se hace aquí
 *
 * Cambiar el estado de despacho. Se cambia dentro de la actividad, junto al
 * trabajo que lo justifica: mover una a «terminada» sin abrirla es exactamente
 * lo que produce consignas cerradas y vacías.
 */
@Component({
  selector: 'vt-dispatches',
  standalone: true,
  imports: [
    ConfirmDialogComponent,
    IconComponent,
    NearEndDirective,
    ReassignDialogComponent,
    RouterLink,
    ToTopComponent,
  ],
  templateUrl: './dispatches.component.html',
  styleUrl: './dispatches.component.scss',
})
export class DispatchesComponent {
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly surveys = inject(SurveyRepository);
  private readonly statuses = inject(DispatchStatusRepository);
  private readonly auth = inject(AuthService);
  private readonly revisions = inject(DataRevisionService);
  private readonly files = inject(DispatchFilesService);
  private readonly activities = inject(ActivityService);
  private readonly toasts = inject(ToastService);

  private static readonly PAGE = 20;

  readonly loading = signal(true);
  readonly search = signal('');

  /** Filtro por formulario. Vacío es «todos». */
  readonly surveyFilter = signal('');

  /**
   * Por para cuándo es, lo más próximo primero: es lo que se busca al
   * recibirlas. Las que no traen fecha van al final.
   */
  readonly orden = signal<Orden>('programada');

  private readonly all = signal<DispatchCard[]>([]);
  private readonly shown = signal(DispatchesComponent.PAGE);

  /** Formularios presentes, con su cuenta. */
  readonly surveyOptions = computed(() => this.optionsBy((card) => card.surveyTitle));

  readonly pendingCount = computed(() => this.all().filter((card) => !card.done).length);

  /**
   * Las que se enseñan.
   *
   * Están **todas**, terminadas incluidas: una consigna cerrada sigue siendo
   * parte de lo asignado, y esconderla obliga a acordarse de que existe un
   * interruptor para verla. Lo que se acota es por formulario y por lo que se
   * escriba, que busca también en los descriptivos — que es como se distingue
   * una consigna de otra del mismo formulario.
   *
   * El estado no filtra: se ve en cada una por su color, y con pocas consignas
   * un desplegable más estorba más de lo que ayuda.
   */
  private readonly matching = computed(() => {
    const needle = this.search().trim().toLowerCase();
    const survey = this.surveyFilter();

    const orden = this.orden();

    return this.all()
      .filter((card) => {
        if (survey && card.surveyTitle !== survey) return false;
        if (!needle) return true;

        return card.haystack.includes(needle) || descriptorsMatch(card.descriptors, needle);
      })
      .sort((a, b) => {
        if (orden === 'recibida') return (a.received || '').localeCompare(b.received || '');
        if (!a.due !== !b.due) return a.due ? -1 : 1;
        return a.due.localeCompare(b.due) || (a.received || '').localeCompare(b.received || '');
      });
  });

  readonly visible = computed(() => this.matching().slice(0, this.shown()));
  readonly hasMore = computed(() => this.matching().length > this.shown());

  readonly counter = computed(() => {
    const shown = this.matching().length;
    const total = this.all().length;
    const noun = total === 1 ? 'consigna' : 'consignas';

    return shown === total ? `${total} ${noun}` : `${shown} de ${total} ${noun}`;
  });

  constructor() {
    effect(() => {
      const user = this.auth.currentUser();

      // Una sincronización trae consignas nuevas: la pantalla no puede confiar
      // en lo que leyó al montarse.
      this.revisions.activities();

      untracked(() => void this.load(user));
    });
  }

  private async load(user: { UserID: string; CompanyID: number } | null): Promise<void> {
    if (!user) return;

    this.loading.set(true);

    try {
      const owner = resolveCatalogOwnerId(user);

      const [answers, surveys, statuses] = await Promise.all([
        this.answers.findByUser(String(user.UserID)),
        this.surveys.findByUser(owner),
        this.statuses.findByUser(owner),
      ]);

      const byId = new Map(surveys.map((survey) => [String(survey.SurveyID), survey]));
      const byDispatch = new Map(
        statuses.map((status) => [String(status.DispatchID), status]),
      );

      this.all.set(
        answers
          // Lo que distingue una consigna: la asignó la plataforma.
          .filter((answer) => answer.Sheduled === '1' && answer.IsDelete !== '1')
          // El orden lo pone `matching`, según lo elegido.
          .map((answer) => this.toCard(answer, byId, byDispatch)),
      );
    } catch (error) {
      console.error('[Consignas] no se pudieron cargar', error);
      this.all.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  private toCard(
    answer: SurveyAnswer,
    surveys: Map<string, Survey>,
    statuses: Map<string, DispatchStatus>,
  ): DispatchCard {
    const survey = surveys.get(String(answer.SurveyID));
    const status = statuses.get(String(answer.Status));
    const titles = parseAnswerTitles(answer.Titles);

    const place = [answer.LocationName, answer.AssetName].filter(Boolean).join(' · ');
    const surveyTitle = survey?.Title || titles[0]?.val || 'Formulario';

    return {
      guid: answer.GUID,
      answer,
      surveyId: answer.SurveyID,
      surveyTitle,
      place,

      statusName: status?.Name || 'Sin estado',
      statusColor: colorOf(status),

      received: answer.Received || answer.CreatedOn || '',
      receivedLabel: when(answer.Received || answer.CreatedOn || ''),

      due: answer.DueDate || '',
      dueLabel: etiquetaDeConsigna(answer.DueDate),

      // El primero es el nombre del formulario, que ya va como título.
      descriptors: titles.slice(1),

      // Lo que la plataforma adjuntó: planos, fotos del reporte, la orden
      // firmada. Se enseñan aquí porque son parte del encargo, no del trabajo.
      files: this.files.filesOf(answer),

      /**
       * Terminada: ya se envió.
       *
       * `isSaved === 2` es la señal de que llegó al servidor. Una consigna
       * enviada sigue en la lista —hay que poder consultarla— pero no cuenta
       * como pendiente ni se enseña salvo que se pidan.
       */
      done: answer.isSaved === 2 && answer.toSync === 0,

      haystack: [surveyTitle, place, status?.Name ?? ''].join(' ').toLowerCase(),
    };
  }

  private optionsBy(pick: (card: DispatchCard) => string): { name: string; count: number }[] {
    const counts = new Map<string, number>();

    for (const card of this.all()) {
      const key = pick(card);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }

  // ── Interacción ────────────────────────────────────────────────────────────

  onSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
    this.reset();
  }

  onSurveyPicked(event: Event): void {
    this.surveyFilter.set((event.target as HTMLSelectElement).value);
    this.reset();
  }

  onOrdenPicked(event: Event): void {
    this.orden.set((event.target as HTMLSelectElement).value as Orden);
    this.reset();
  }

  showMore(): void {
    this.shown.update((current) => current + DispatchesComponent.PAGE);
  }

  // ── Archivos de la consigna ────────────────────────────────────────────────

  /** Consigna cuyos archivos están desplegados. Vacío si ninguna. */
  readonly openFiles = signal('');

  toggleFiles(guid: string): void {
    this.openFiles.update((current) => (current === guid ? '' : guid));
  }

  /**
   * Guarda un archivo en el equipo.
   *
   * Con la copia local se entrega directamente; sin ella se abre su dirección y
   * el navegador se encarga. Ver [DispatchFilesService].
   */
  async download(file: DispatchFile, card: DispatchCard): Promise<void> {
    await this.files.saveToDisk(file, `${card.surveyTitle} - ${file.guid}`);
  }

  /** Todos los de una consigna, uno tras otro. */
  async downloadAll(card: DispatchCard): Promise<void> {
    for (const file of card.files) {
      await this.download(file, card);
    }
  }

  private reset(): void {
    this.shown.set(DispatchesComponent.PAGE);
  }

  // ── Selección de varias ────────────────────────────────────────────────────
  //
  // Las mismas tres acciones que en la lista de cada formulario: eliminar,
  // reasignar y reprocesar archivos, con las mismas reglas que sobre una sola.
  // Las que no las cumplen se omiten y se dice cuántas y por qué.

  /** Modo selección: tocar una consigna la marca en vez de abrirla. */
  readonly seleccionando = signal(false);

  /** GUIDs marcados. */
  readonly marcadas = signal<ReadonlySet<string>>(new Set());

  /** Lo que se está haciendo con el lote, para la barra. Vacío si nada. */
  readonly trabajando = signal('');

  /** Las marcadas que siguen en la lista (un borrado o una recarga las quita). */
  readonly marcadasCards = computed(() => {
    const m = this.marcadas();
    return this.all().filter((c) => m.has(c.guid));
  });

  /** Varias que se están reasignando; `null` si ninguna. */
  readonly reasignandoVarias = signal<SurveyAnswer[] | null>(null);

  /** Hay algo que seleccionar: sin consignas no se ofrece el botón. */
  readonly hayConsignas = computed(() => this.all().length > 0);

  /** Confirmación de borrado: las que sí y por qué no las demás. */
  readonly borrandoVarias = signal<{ aptas: DispatchCard[]; omitidas: string[] } | null>(null);

  empezarSeleccion(card?: DispatchCard): void {
    this.seleccionando.set(true);
    if (card) this.marcadas.set(new Set([card.guid]));
  }

  salirDeSeleccion(): void {
    this.seleccionando.set(false);
    this.marcadas.set(new Set());
  }

  alternarSeleccion(): void {
    if (this.seleccionando()) this.salirDeSeleccion();
    else this.empezarSeleccion();
  }

  private alternar(card: DispatchCard): void {
    const m = new Set(this.marcadas());
    if (m.has(card.guid)) m.delete(card.guid);
    else m.add(card.guid);
    this.marcadas.set(m);
  }

  /** Todas las que coinciden con la búsqueda y el filtro; si ya lo están, ninguna. */
  marcarTodas(): void {
    const todas = this.matching().map((c) => c.guid);
    const yaEstan = todas.length > 0 && todas.every((g) => this.marcadas().has(g));
    this.marcadas.set(yaEstan ? new Set() : new Set(todas));
  }

  /**
   * El clic de la consigna. Seleccionando, el enlace va sin destino
   * (`routerLink` en `null`) y aquí solo se marca.
   */
  onItemClick(card: DispatchCard): void {
    if (this.seleccionando()) this.alternar(card);
  }

  /** Pulsación larga en el teléfono (o clic derecho): entra a seleccionar con esa marcada. */
  onItemContext(event: Event, card: DispatchCard): void {
    event.preventDefault();
    if (this.seleccionando()) this.alternar(card);
    else this.empezarSeleccion(card);
  }

  private nombreDe(card: DispatchCard): string {
    return card.place || card.descriptors[0]?.val || card.surveyTitle;
  }

  async reprocesarVarias(): Promise<void> {
    const lote = this.marcadasCards();
    if (!lote.length || this.trabajando()) return;

    this.trabajando.set('Marcando archivos…');
    let archivos = 0;
    try {
      for (const card of lote) archivos += await this.activities.reprocessBinaries(card.guid);
    } finally {
      this.trabajando.set('');
    }

    this.toasts.success(
      archivos === 0
        ? 'Ninguna tenía archivos'
        : archivos === 1
          ? 'Se marcó 1 archivo para volver a subirse'
          : `Se marcaron ${archivos} archivos para volver a subirse`,
      lote.length === 1 ? 'De 1 consigna.' : `De ${lote.length} consignas.`,
    );
    this.salirDeSeleccion();
  }

  reasignarVarias(): void {
    const lote = this.marcadasCards();
    if (!lote.length || this.trabajando()) return;
    this.reasignandoVarias.set(lote.map((c) => c.answer));
  }

  onReassigned(r: ReasignacionHecha): void {
    this.reasignandoVarias.set(null);

    const sinHacer = [...r.omitidas, ...r.fallidas];
    if (r.hechas) {
      this.toasts.success(
        r.hechas === 1 ? '1 consigna reasignada' : `${r.hechas} consignas reasignadas`,
        `Ahora son de ${r.person.name}.`,
      );
    }
    if (sinHacer.length) {
      this.toasts.warning(
        sinHacer.length === 1 ? '1 no se reasignó' : `${sinHacer.length} no se reasignaron`,
        sinHacer.slice(0, 3).join(' · ') + (sinHacer.length > 3 ? ' …' : ''),
      );
    }
    this.salirDeSeleccion();
    void this.load(this.auth.currentUser());
  }

  /** Mismas reglas que una sola: lo que prohíba el flujo y los archivos a medio subir. */
  async pedirEliminarVarias(): Promise<void> {
    const lote = this.marcadasCards();
    if (!lote.length || this.trabajando()) return;

    this.trabajando.set('Revisando…');
    const aptas: DispatchCard[] = [];
    const omitidas: string[] = [];
    try {
      for (const card of lote) {
        const prohibido = String(card.answer.NoEliminar ?? '').trim();
        if (prohibido) {
          omitidas.push(`${this.nombreDe(card)}: ${prohibido}`);
          continue;
        }
        if (card.answer.eraser !== 1 && (await this.activities.countBlockingBinaries(card.guid)) > 0) {
          omitidas.push(`${this.nombreDe(card)}: tiene archivos sin terminar de subir`);
          continue;
        }
        aptas.push(card);
      }
    } finally {
      this.trabajando.set('');
    }

    this.borrandoVarias.set({ aptas, omitidas });
  }

  readonly borrandoVariasTitulo = computed(() => {
    const b = this.borrandoVarias();
    if (!b) return '';
    if (!b.aptas.length) return 'Ninguna se puede eliminar';
    return b.aptas.length === 1 ? '¿Eliminar 1 consigna?' : `¿Eliminar ${b.aptas.length} consignas?`;
  });

  readonly borrandoVariasMensaje = computed(() =>
    this.borrandoVarias()?.aptas.length
      ? 'Se borrarán con los archivos que tengan asociados. Las que ya están en Visitrack también se borran allí. No se puede deshacer.'
      : 'Ninguna de las seleccionadas cumple las condiciones para eliminarse.',
  );

  readonly borrandoVariasDetalle = computed(() => {
    const b = this.borrandoVarias();
    if (!b?.omitidas.length) return '';
    const cuantas =
      b.omitidas.length === 1 ? 'Esta no se puede eliminar' : `Estas ${b.omitidas.length} no se pueden eliminar`;
    return `${cuantas}: ${b.omitidas.slice(0, 5).join(' · ')}${b.omitidas.length > 5 ? ' …' : ''}`;
  });

  async eliminarVarias(): Promise<void> {
    const b = this.borrandoVarias();
    this.borrandoVarias.set(null);
    if (!b?.aptas.length) return;

    this.trabajando.set(`Eliminando ${b.aptas.length}…`);
    let hechas = 0;
    let enVisitrack = 0;
    const fallidas: string[] = [];
    try {
      for (const card of b.aptas) {
        try {
          const r = await this.activities.remove(card.answer);
          hechas++;
          if (r === 'flagged') enVisitrack++;
        } catch (error) {
          console.error('[Consignas] no se pudo eliminar', error);
          fallidas.push(`${this.nombreDe(card)}: no se pudo`);
        }
      }
    } finally {
      this.trabajando.set('');
    }

    if (hechas) {
      this.toasts.success(
        hechas === 1 ? '1 consigna eliminada' : `${hechas} consignas eliminadas`,
        enVisitrack ? 'Las que ya estaban en Visitrack se borran allí en la próxima sincronización.' : undefined,
      );
    }
    const sinHacer = [...b.omitidas, ...fallidas];
    if (sinHacer.length) {
      this.toasts.warning(
        sinHacer.length === 1 ? '1 no se eliminó' : `${sinHacer.length} no se eliminaron`,
        sinHacer.slice(0, 3).join(' · ') + (sinHacer.length > 3 ? ' …' : ''),
      );
    }
    this.salirDeSeleccion();
  }
}

/**
 * Color de un estado.
 *
 * `DispatchStatus.Color` llega como `#rrggbb`, pero hay registros antiguos con
 * el valor vacío o con basura. Se comprueba el formato antes de usarlo: un
 * color inválido descarta la regla entera y el punto quedaría invisible en vez
 * de gris.
 */
function colorOf(status: DispatchStatus | undefined): string {
  const raw = (status?.Color ?? '').toString().trim();
  return /^#[0-9a-f]{3,8}$/i.test(raw) ? raw : 'var(--vt-text-subtle)';
}

/** Fecha legible, con el año solo si no es el corriente. */
function when(value: string): string {
  if (!value) return '';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const sameYear = date.getFullYear() === new Date().getFullYear();

  return date.toLocaleDateString('es-CO', {
    day: '2-digit',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}
