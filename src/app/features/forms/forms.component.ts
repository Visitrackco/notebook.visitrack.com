import { Component, computed, effect, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { resolveCatalogOwnerId } from '../../core/config/company-rules';
import { Survey } from '../../core/models/entities.model';
import { SurveyAnswerRepository, SurveyRepository } from '../../core/repositories/entity.repositories';
import { ActivityService } from '../../core/services/activity.service';
import { AuthService } from '../../core/services/auth.service';
import { ConnectivityService } from '../../core/services/connectivity.service';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { SeedPalette, seedGradient, seedPalette } from '../../shared/utils/seed-color';

/** Un formulario, ya preparado para pintarse. */
export interface FormCard {
  survey: Survey;
  /** Cuántas actividades tiene guardadas en este equipo. */
  count: number;
  /**
   * Cuántas están detenidas esperando que sus archivos lleguen al servidor.
   *
   * Se avisa desde el listado —y no solo dentro del formulario— porque con una
   * conexión inestable esas actividades pueden quedarse ahí sin que nadie se
   * entere hasta que alguien las eche en falta en Visitrack.
   */
  waiting: number;
  /** Paleta estable derivada de su GUID. */
  palette: SeedPalette;
  /** Degradado listo para el distintivo. */
  gradient: string;
  /** Primera letra del título. */
  initial: string;
}

/** Cómo se ordena el listado. */
type SortMode = 'title' | 'activity';

/**
 * Listado de formularios.
 *
 * Es la pantalla de entrada al trabajo: aquí se elige qué diligenciar. Cada
 * formulario lleva su propio color, igual que en la app móvil, porque en campo
 * se reconoce antes por el color que leyendo el título.
 */
@Component({
  selector: 'vt-forms',
  standalone: true,
  imports: [IconComponent, RouterLink],
  templateUrl: './forms.component.html',
  styleUrl: './forms.component.scss',
})
export class FormsComponent {
  private readonly surveys = inject(SurveyRepository);
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly activities = inject(ActivityService);
  private readonly router = inject(Router);

  readonly auth = inject(AuthService);
  readonly connectivity = inject(ConnectivityService);

  readonly loading = signal(true);
  readonly search = signal('');
  readonly sortMode = signal<SortMode>('title');

  /** Todos los formularios del usuario, sin filtrar. */
  private readonly all = signal<FormCard[]>([]);

  /**
   * Los que se muestran, tras aplicar búsqueda y orden.
   *
   * El filtrado va en memoria y no en una consulta: los formularios de un
   * usuario son decenas, no miles, y así la búsqueda responde en cada
   * pulsación sin ir a la base.
   */
  readonly cards = computed(() => {
    const term = this.search().trim().toLowerCase();
    const mode = this.sortMode();

    let result = this.all();

    if (term) {
      result = result.filter(
        (card) =>
          card.survey.Title?.toLowerCase().includes(term) ||
          card.survey.Description?.toLowerCase().includes(term),
      );
    }

    return [...result].sort((a, b) =>
      mode === 'activity'
        ? b.count - a.count || a.survey.Title.localeCompare(b.survey.Title)
        : a.survey.Title.localeCompare(b.survey.Title),
    );
  });

  readonly total = computed(() => this.all().length);
  readonly hasResults = computed(() => this.cards().length > 0);

  /** Cuántas actividades hay en total, sumando todos los formularios. */
  readonly totalActivities = computed(() =>
    this.all().reduce((sum, card) => sum + card.count, 0),
  );

  constructor() {
    // Se recarga cuando cambian las actividades —crear, eliminar, guardar—
    // para que el contador de cada ficha no se quede con un número viejo.
    effect(() => {
      this.activities.revision();
      void this.load();
    });
  }

  private async load(): Promise<void> {
    try {
      const user = this.auth.currentUser();
      if (!user) return;

      const ownerId = resolveCatalogOwnerId(user);

      const [surveys, counts, waiting] = await Promise.all([
        this.surveys.findByUser(ownerId),
        this.answers.countBySurvey(user.UserID),
        this.answers.countWaitingBinariesBySurvey(user.UserID),
      ]);

      this.all.set(
        surveys.map((survey) => {
          // El GUID es lo que no cambia aunque se renombre el formulario: si el
          // color saliera del título, renombrarlo lo cambiaría de color y el
          // usuario perdería la referencia visual que ya tenía aprendida.
          const seed = survey.GUID || survey.SurveyID || survey.Title;

          return {
            survey,
            count: counts[survey.SurveyID] ?? 0,
            waiting: waiting[survey.SurveyID] ?? 0,
            palette: seedPalette(seed),
            gradient: seedGradient(seed),
            initial: (survey.Title?.trim().charAt(0) || '?').toUpperCase(),
          };
        }),
      );
    } catch (error) {
      console.error('[Forms] No se pudieron cargar los formularios', error);
    } finally {
      this.loading.set(false);
    }
  }

  onSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  clearSearch(): void {
    this.search.set('');
  }

  setSort(mode: SortMode): void {
    this.sortMode.set(mode);
  }

  /**
   * Abre el formulario: lleva a sus actividades.
   *
   * No se crea nada aquí. Igual que en la app móvil, primero se ve qué hay
   * —actividades a medias, pendientes de subir— y desde allí se decide si crear
   * una nueva o retomar una empezada.
   */
  async open(card: FormCard): Promise<void> {
    await this.router.navigate(['/formularios', card.survey.SurveyID]);
  }
}
