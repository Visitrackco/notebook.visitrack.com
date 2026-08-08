import {
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';

import { resolveCatalogOwnerId } from '../../../core/config/company-rules';
import { LocationForm, Survey } from '../../../core/models/entities.model';
import { LocationRepository, SurveyRepository } from '../../../core/repositories/entity.repositories';
import { SurveyAnswerRepository } from '../../../core/repositories/survey-answer.repository';
import { AuthService } from '../../../core/services/auth.service';
import { ShortcutsService } from '../../../core/services/shortcuts.service';
import { IconComponent } from '../icon/icon.component';

/** Algo a lo que se puede saltar. */
interface Entry {
  id: string;
  /** Qué se ve. */
  label: string;
  /** Aclaración: el tipo, la ubicación, la fecha. */
  hint: string;
  /** Grupo al que pertenece. */
  group: string;
  icon: string;
  /** Texto sobre el que se busca. */
  haystack: string;
  /** A dónde lleva. */
  route: unknown[];
}

/** Cuántos resultados se enseñan. Más no caben sin desplazar. */
const LIMIT = 12;

/**
 * La paleta de comandos.
 *
 * ## Qué resuelve
 *
 * Llegar a cualquier sitio sin recorrer el menú. Se abre con `Ctrl+K`, se
 * escribe media palabra y se pulsa Enter: un formulario, una ubicación, una
 * actividad reciente o una pantalla. Para quien pasa el día abriendo
 * actividades de tres formularios, eso son dos teclas en vez de cuatro clics.
 *
 * ## Por qué carga los datos al abrirse
 *
 * Y no al arrancar la aplicación: la mayoría de las sesiones no la usan, y leer
 * los formularios, las ubicaciones y las actividades de arranque retrasaría lo
 * único que de verdad importa al entrar — ver la pantalla.
 */
@Component({
  selector: 'vt-command-palette',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './command-palette.component.html',
  styleUrl: './command-palette.component.scss',
})
export class CommandPaletteComponent {
  private readonly shortcuts = inject(ShortcutsService);
  private readonly surveys = inject(SurveyRepository);
  private readonly locations = inject(LocationRepository);
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');

  readonly open = this.shortcuts.paletteOpen;
  readonly search = signal('');
  readonly loading = signal(false);

  /** Todo lo que se puede alcanzar. */
  private readonly entries = signal<Entry[]>([]);

  /** Cuál está señalado, para moverse con las flechas. */
  readonly cursor = signal(0);

  readonly results = computed(() => {
    const needle = this.search().trim().toLowerCase();
    const all = this.entries();

    if (!needle) {
      // Sin escribir nada se ofrecen las pantallas: es el uso más frecuente y
      // evita que la paleta abra en blanco.
      return all.filter((entry) => entry.group === 'Ir a').slice(0, LIMIT);
    }

    return all.filter((entry) => entry.haystack.includes(needle)).slice(0, LIMIT);
  });

  /** Los resultados por grupo, conservando el orden. */
  readonly grouped = computed(() => {
    const groups: { title: string; items: Entry[] }[] = [];

    for (const entry of this.results()) {
      const last = groups.at(-1);

      if (last?.title === entry.group) last.items.push(entry);
      else groups.push({ title: entry.group, items: [entry] });
    }

    return groups;
  });

  constructor() {
    effect(() => {
      if (!this.open()) return;

      untracked(() => {
        this.search.set('');
        this.cursor.set(0);
        void this.load();

        // El foco va al campo en cuanto se dibuja: quien abrió con el teclado
        // espera poder escribir sin tocar el ratón.
        setTimeout(() => this.field()?.nativeElement.focus());
      });
    });
  }

  private async load(): Promise<void> {
    const user = this.auth.currentUser();
    if (!user) return;

    this.loading.set(true);

    try {
      const owner = resolveCatalogOwnerId(user);

      const [surveys, locations, answers] = await Promise.all([
        this.surveys.findByUser(owner),
        this.locations.findByUser(owner),
        this.answers.findByUser(String(user.UserID)),
      ]);

      this.entries.set([
        ...this.screens(),
        ...surveys.map((survey) => this.fromSurvey(survey)),

        // Las actividades recientes primero: lo que se abrió ayer es lo que se
        // vuelve a abrir hoy.
        ...answers
          .filter((answer) => answer.isSaved !== 0)
          .sort((a, b) => (b.UpdatedOn || '').localeCompare(a.UpdatedOn || ''))
          .slice(0, 40)
          .map((answer) => ({
            id: `answer:${answer.GUID}`,
            label: answer.LocationName || answer.AssetName || 'Actividad',
            hint: this.when(answer.UpdatedOn || answer.CreatedOn),
            group: 'Actividades recientes',
            icon: 'clipboard',
            haystack: [answer.LocationName, answer.AssetName, answer.Titles]
              .join(' ')
              .toLowerCase(),
            route: ['/formularios', answer.SurveyID, 'actividad', answer.GUID],
          })),

        ...locations.slice(0, 300).map((location) => this.fromLocation(location)),
      ]);
    } catch (error) {
      console.error('[Atajos] no se pudo cargar la paleta', error);
    } finally {
      this.loading.set(false);
    }
  }

  private screens(): Entry[] {
    const make = (label: string, icon: string, route: string): Entry => ({
      id: `screen:${route}`,
      label,
      hint: route,
      group: 'Ir a',
      icon,
      haystack: `${label} ${route}`.toLowerCase(),
      route: [route],
    });

    return [
      make('Mis consignas', 'send', '/consignas'),
      make('Formularios', 'clipboard', '/formularios'),
      make('Borradores', 'pen', '/borradores'),
      make('Pendientes por subir', 'cloud-upload', '/pendientes'),
      make('Ubicaciones', 'map-pin', '/ubicaciones'),
      make('Sincronización', 'refresh', '/sincronizacion'),
      make('Archivos', 'file', '/archivos'),
      make('Inicio', 'home', '/inicio'),
      make('Mi perfil', 'user', '/perfil'),
    ];
  }

  private fromSurvey(survey: Survey): Entry {
    return {
      id: `survey:${survey.SurveyID}`,
      label: survey.Title,
      hint: 'Abrir sus actividades',
      group: 'Formularios',
      icon: 'clipboard',
      haystack: `${survey.Title} ${survey.Description ?? ''}`.toLowerCase(),
      route: ['/formularios', survey.SurveyID],
    };
  }

  private fromLocation(location: LocationForm): Entry {
    return {
      id: `location:${location.GUID}`,
      label: location.Name || 'Sin nombre',
      hint: location.typeTitle || 'Ubicación',
      group: 'Ubicaciones',
      icon: 'map-pin',
      haystack: `${location.Name} ${location.typeTitle} ${location.City}`.toLowerCase(),
      route: ['/ubicaciones', location.GUID],
    };
  }

  // ── Interacción ────────────────────────────────────────────────────────────

  onSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
    this.cursor.set(0);
  }

  /**
   * Las teclas de la paleta.
   *
   * Se atienden aquí y no en el servicio de atajos: mientras está abierta, las
   * flechas y el Enter le pertenecen, y el resto de la aplicación no debería
   * enterarse.
   */
  onKey(event: KeyboardEvent): void {
    const total = this.results().length;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.cursor.update((index) => (total === 0 ? 0 : (index + 1) % total));
        break;

      case 'ArrowUp':
        event.preventDefault();
        this.cursor.update((index) => (total === 0 ? 0 : (index - 1 + total) % total));
        break;

      case 'Enter': {
        event.preventDefault();
        const entry = this.results()[this.cursor()];
        if (entry) void this.go(entry);
        break;
      }

      case 'Escape':
        event.preventDefault();
        this.close();
        break;
    }
  }

  /** Posición absoluta de una entrada, para señalar la elegida. */
  indexOf(entry: Entry): number {
    return this.results().findIndex((item) => item.id === entry.id);
  }

  async go(entry: Entry): Promise<void> {
    this.close();
    await this.router.navigate(entry.route);
  }

  close(): void {
    this.shortcuts.closeAll();
  }

  private when(value: string): string {
    if (!value) return '';

    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? ''
      : date.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
  }
}
