import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';

import { resolveCatalogOwnerId } from '../../core/config/company-rules';
import { DispatchStatus, Survey, SurveyAnswer } from '../../core/models/entities.model';
import {
  DispatchStatusRepository,
  SurveyRepository,
} from '../../core/repositories/entity.repositories';
import { SurveyAnswerRepository } from '../../core/repositories/survey-answer.repository';
import { AuthService } from '../../core/services/auth.service';
import { DataRevisionService } from '../../core/sync/data-revision.service';
import { DispatchFile, DispatchFilesService } from '../../core/sync/dispatch-files.service';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { ToTopComponent } from '../../shared/components/to-top/to-top.component';
import { NearEndDirective } from '../../shared/directives/near-end.directive';
import { Descriptor, descriptorsMatch, parseAnswerTitles } from '../../shared/utils/descriptors';

/** Una consigna, lista para pintar. */
interface DispatchCard {
  guid: string;
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
 * pregunta completa. Aquí están todas, ordenadas por lo que llegó antes.
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
  imports: [IconComponent, NearEndDirective, RouterLink, ToTopComponent],
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

  private static readonly PAGE = 20;

  readonly loading = signal(true);
  readonly search = signal('');

  /** Filtro por formulario. Vacío es «todos». */
  readonly surveyFilter = signal('');

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

    return this.all().filter((card) => {
      if (survey && card.surveyTitle !== survey) return false;
      if (!needle) return true;

      return card.haystack.includes(needle) || descriptorsMatch(card.descriptors, needle);
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
          .map((answer) => this.toCard(answer, byId, byDispatch))
          // Lo que llegó antes, primero: es lo que lleva más tiempo esperando.
          .sort((a, b) => (a.received || '').localeCompare(b.received || '')),
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
      surveyId: answer.SurveyID,
      surveyTitle,
      place,

      statusName: status?.Name || 'Sin estado',
      statusColor: colorOf(status),

      received: answer.Received || answer.CreatedOn || '',
      receivedLabel: when(answer.Received || answer.CreatedOn || ''),

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
