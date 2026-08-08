import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';

import { resolveCatalogOwnerId } from '../../core/config/company-rules';
import { Survey, SurveyAnswer } from '../../core/models/entities.model';
import { SurveyRepository } from '../../core/repositories/entity.repositories';
import { SurveyAnswerRepository } from '../../core/repositories/survey-answer.repository';
import { AuthService } from '../../core/services/auth.service';
import { DraftMaintenanceService } from '../../core/services/draft-maintenance.service';
import { DraftPolicyService } from '../../core/services/draft-policy.service';
import { ToastService } from '../../core/services/toast.service';
import { DataRevisionService } from '../../core/sync/data-revision.service';
import { ConfirmDialogComponent } from '../../shared/components/confirm-dialog/confirm-dialog.component';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { ToTopComponent } from '../../shared/components/to-top/to-top.component';
import { Descriptor, parseAnswerTitles } from '../../shared/utils/descriptors';

/** Un borrador, listo para pintar. */
interface DraftCard {
  guid: string;
  surveyId: string;
  surveyTitle: string;
  place: string;
  descriptors: Descriptor[];

  created: string;
  createdLabel: string;

  /** Cuándo se borrará. `null` si no se puede saber. */
  expires: Date | null;
  expiresLabel: string;

  /** Le queda poco: menos de dos horas. */
  urgent: boolean;
}

/**
 * Los borradores: actividades abiertas y nunca guardadas.
 *
 * ## Por qué merecen pantalla propia
 *
 * Un borrador no aparece en ningún sitio hasta que se entra al formulario del
 * que salió. Con varios formularios, saber qué hay a medias obliga a recorrerlos
 * uno por uno — y como además caducan, lo que no se encuentra se pierde.
 *
 * Aquí están todos, con **de qué formulario son** y **cuánto les queda**, que
 * son las dos preguntas que se hacen al mirarlos: dónde estaba y si llego a
 * tiempo.
 *
 * ## Ordenados por lo que caduca antes
 *
 * No por fecha de creación ni alfabéticamente: lo que importa de un borrador es
 * cuánto le queda, y lo urgente tiene que estar arriba sin buscarlo.
 */
@Component({
  selector: 'vt-drafts',
  standalone: true,
  imports: [ConfirmDialogComponent, IconComponent, RouterLink, ToTopComponent],
  templateUrl: './drafts.component.html',
  styleUrl: './drafts.component.scss',
})
export class DraftsComponent {
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly surveys = inject(SurveyRepository);
  private readonly policy = inject(DraftPolicyService);
  private readonly maintenance = inject(DraftMaintenanceService);
  private readonly auth = inject(AuthService);
  private readonly revisions = inject(DataRevisionService);
  private readonly toasts = inject(ToastService);

  readonly loading = signal(true);
  readonly drafts = signal<DraftCard[]>([]);

  /** Borrador señalado para eliminar. */
  private readonly pendingRemoval = signal<DraftCard | null>(null);
  readonly asking = computed(() => this.pendingRemoval() !== null);
  readonly removalName = computed(() => this.pendingRemoval()?.surveyTitle ?? '');

  /** Horas que sobrevive un borrador, según la configuración. */
  readonly hours = signal(0);

  readonly urgentCount = computed(() => this.drafts().filter((card) => card.urgent).length);

  readonly counter = computed(() => {
    const total = this.drafts().length;
    return `${total} ${total === 1 ? 'borrador' : 'borradores'}`;
  });

  constructor() {
    effect(() => {
      const user = this.auth.currentUser();
      this.revisions.activities();

      untracked(() => void this.load(user));
    });
  }

  private async load(user: { UserID: string; CompanyID: number } | null): Promise<void> {
    if (!user) return;

    this.loading.set(true);

    try {
      const [drafts, surveys, hours] = await Promise.all([
        this.answers.findDrafts(String(user.UserID)),
        this.surveys.findByUser(resolveCatalogOwnerId(user)),
        this.policy.draftHours(),
      ]);

      this.hours.set(hours);

      const byId = new Map(surveys.map((survey) => [String(survey.SurveyID), survey]));
      const cards: DraftCard[] = [];

      for (const draft of drafts) {
        cards.push(await this.toCard(draft, byId));
      }

      // Lo que caduca antes, arriba: es lo único que hay que decidir ya.
      this.drafts.set(
        cards.sort((a, b) => (a.expires?.getTime() ?? Infinity) - (b.expires?.getTime() ?? Infinity)),
      );
    } catch (error) {
      console.error('[Borradores] no se pudieron cargar', error);
      this.drafts.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  private async toCard(draft: SurveyAnswer, surveys: Map<string, Survey>): Promise<DraftCard> {
    const survey = surveys.get(String(draft.SurveyID));
    const titles = parseAnswerTitles(draft.Titles);
    const expires = await this.policy.expiresAt(draft);

    const remaining = expires ? expires.getTime() - Date.now() : Infinity;

    return {
      guid: draft.GUID,
      surveyId: draft.SurveyID,
      surveyTitle: survey?.Title || titles[0]?.val || 'Formulario',
      place: [draft.LocationName, draft.AssetName].filter(Boolean).join(' · '),
      descriptors: titles.slice(1),

      created: draft.CreatedOn ?? '',
      createdLabel: absolute(draft.CreatedOn ?? ''),

      expires,
      expiresLabel: expires ? relative(expires) : 'sin fecha de caducidad',
      urgent: remaining <= 2 * 60 * 60 * 1000,
    };
  }

  // ── Acciones ───────────────────────────────────────────────────────────────

  askRemove(card: DraftCard): void {
    this.pendingRemoval.set(card);
  }

  cancelRemove(): void {
    this.pendingRemoval.set(null);
  }

  async confirmRemove(): Promise<void> {
    const card = this.pendingRemoval();
    this.pendingRemoval.set(null);

    if (!card) return;

    await this.policy.discard(card.guid);
    this.revisions.touchActivities();

    this.toasts.info('Borrador eliminado', card.surveyTitle);
  }

  /** Limpia ahora lo que ya caducó, sin esperar a la revisión periódica. */
  async purgeNow(): Promise<void> {
    const removed = await this.maintenance.run();

    if (removed === 0) {
      this.toasts.info('No había borradores caducados', 'Todo lo que ves sigue dentro de plazo.');
    }
  }
}

/** «en 40 minutos», «en 2 horas», «ya caducó». */
function relative(date: Date): string {
  const minutes = Math.round((date.getTime() - Date.now()) / 60000);

  if (minutes <= 0) return 'ya caducó';
  if (minutes < 60) return `en ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `en ${hours} ${hours === 1 ? 'hora' : 'horas'}`;

  const days = Math.round(hours / 24);
  return `en ${days} ${days === 1 ? 'día' : 'días'}`;
}

/** Fecha y hora de creación, para saber de cuándo viene. */
function absolute(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  return date.toLocaleString('es-CO', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
