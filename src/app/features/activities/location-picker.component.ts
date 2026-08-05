import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';

import { LocationForm, Survey, SurveyAnswer } from '../../core/models/entities.model';
import {
  ActivityService,
  SurveyRequirements,
  readRequirements,
  resolveNextStep,
} from '../../core/services/activity.service';
import {
  Descriptor,
  descriptorsMatch,
  parseEntityDescriptors,
} from '../../shared/utils/descriptors';
import { EntityPickerComponent, PickerItem } from './entity-picker/entity-picker.component';

/** Cuántas ubicaciones se traen por página. */
const PAGE_SIZE = 30;

/** Espera antes de lanzar la búsqueda, para no consultar en cada tecla. */
const SEARCH_DELAY_MS = 300;

/**
 * Paso «elegir ubicación» del flujo de apertura.
 *
 * Llega aquí quien creó o abrió una actividad de un formulario que exige
 * ubicación y todavía no la tiene. Al elegir se guarda **en el acto** y se pasa
 * al siguiente paso, que puede ser el selector de activo o el formulario.
 *
 * La actividad viaja por la URL (`?actividad=<GUID>`) y no en memoria: así
 * recargar la página en mitad del flujo lo retoma en el mismo punto, en vez de
 * dejar una actividad huérfana y mandar al usuario al principio.
 */
@Component({
  selector: 'vt-location-picker',
  standalone: true,
  imports: [EntityPickerComponent],
  template: `
    <vt-entity-picker
      icon="map-pin"
      [title]="title()"
      [subtitle]="subtitle()"
      [items]="items()"
      [loading]="loading()"
      [searching]="searching()"
      [hasMore]="hasMore()"
      [searchTerm]="search()"
      [totalCount]="total()"
      emptyMessage="Este tipo de ubicación no tiene registros en este equipo. Sincroniza tus datos e inténtalo de nuevo."
      (search)="onSearch($event)"
      (loadMore)="loadMore()"
      (choose)="choose($event)"
      (back)="goBack()"
    />
  `,
})
export class LocationPickerComponent {
  private readonly router = inject(Router);
  private readonly activities = inject(ActivityService);

  /** Formulario, del segmento de la ruta. */
  readonly surveyId = input.required<string>();

  /** GUID de la actividad en curso, del parámetro de consulta. */
  readonly actividad = input('');

  private readonly survey = signal<Survey | null>(null);
  private readonly answer = signal<SurveyAnswer | null>(null);
  private readonly typeName = signal('');

  /** Ubicaciones cargadas hasta ahora (paginación). */
  private readonly page = signal<LocationForm[]>([]);

  /** Resultado de la búsqueda sobre el conjunto completo. `null` = sin búsqueda. */
  private readonly matches = signal<LocationForm[] | null>(null);

  readonly loading = signal(true);
  readonly searching = signal(false);
  readonly search = signal('');
  readonly total = signal(0);

  private searchTimer?: ReturnType<typeof setTimeout>;

  readonly title = computed(() => this.typeName() || 'Ubicaciones');

  readonly subtitle = computed(() => {
    const survey = this.survey();
    return survey ? `Elige la ubicación para «${survey.Title}»` : '';
  });

  /** Lo que se muestra: los resultados de la búsqueda o la página cargada. */
  readonly items = computed<PickerItem[]>(() => {
    const source = this.matches() ?? this.page();
    return source.map((location) => this.toItem(location));
  });

  /** Solo se pagina cuando no hay búsqueda: la búsqueda ya recorrió todo. */
  readonly hasMore = computed(
    () => this.matches() === null && this.page().length < this.total(),
  );

  private readonly requirements = computed<SurveyRequirements | null>(() => {
    const survey = this.survey();
    return survey ? readRequirements(survey) : null;
  });

  constructor() {
    effect(() => {
      const surveyId = this.surveyId();
      const guid = this.actividad();
      void this.init(surveyId, guid);
    });
  }

  private async init(surveyId: string, guid: string): Promise<void> {
    this.loading.set(true);

    try {
      const [survey, answer] = await Promise.all([
        this.activities.findSurvey(surveyId),
        guid ? this.activities.findByGuid(guid) : Promise.resolve(null),
      ]);

      this.survey.set(survey);
      this.answer.set(answer);

      if (!survey) return;

      const requirements = readRequirements(survey);
      const [name, total, first] = await Promise.all([
        this.activities.locationTypeName(requirements.locationTypeGuid),
        this.activities.countLocations(requirements.locationTypeGuid),
        this.activities.listLocations(requirements.locationTypeGuid, { limit: PAGE_SIZE }),
      ]);

      this.typeName.set(name);
      this.total.set(total);
      this.page.set(first);
    } catch (error) {
      console.error('[LocationPicker] no se pudieron cargar las ubicaciones', error);
    } finally {
      this.loading.set(false);
    }
  }

  /** Trae la siguiente página y la añade a lo que ya se está mostrando. */
  async loadMore(): Promise<void> {
    const requirements = this.requirements();
    if (!requirements) return;

    const next = await this.activities.listLocations(requirements.locationTypeGuid, {
      limit: PAGE_SIZE,
      offset: this.page().length,
    });

    this.page.update((current) => [...current, ...next]);
  }

  onSearch(term: string): void {
    this.search.set(term);
    clearTimeout(this.searchTimer);

    if (!term.trim()) {
      this.matches.set(null);
      this.searching.set(false);
      return;
    }

    this.searching.set(true);
    this.searchTimer = setTimeout(() => void this.runSearch(term), SEARCH_DELAY_MS);
  }

  /**
   * Busca sobre **todas** las ubicaciones del tipo, no solo las ya cargadas.
   *
   * Buscar en la página visible daría «sin resultados» para una sede que sí
   * está en el equipo, y el usuario concluiría que le faltan datos cuando lo
   * único que falta es haber bajado más páginas.
   */
  private async runSearch(term: string): Promise<void> {
    const requirements = this.requirements();
    if (!requirements) return;

    try {
      const all = await this.activities.listLocations(requirements.locationTypeGuid);
      const needle = term.trim().toLowerCase();

      this.matches.set(
        all.filter(
          (location) =>
            location.Name?.toLowerCase().includes(needle) ||
            location.FullAddress?.toLowerCase().includes(needle) ||
            location.TagUID?.toLowerCase().includes(needle) ||
            descriptorsMatch(this.descriptorsOf(location), needle),
        ),
      );
    } catch (error) {
      console.error('[LocationPicker] falló la búsqueda', error);
      this.matches.set([]);
    } finally {
      this.searching.set(false);
    }
  }

  /**
   * Asocia la ubicación y avanza.
   *
   * El siguiente paso se recalcula sobre la actividad **ya actualizada**: si el
   * formulario también pide activo, toca el otro selector; si no, el formulario.
   */
  async choose(item: PickerItem): Promise<void> {
    const answer = this.answer();
    const requirements = this.requirements();
    const surveyId = this.survey()?.SurveyID;
    if (!answer || !requirements || !surveyId) return;

    const source = this.matches() ?? this.page();
    const location = source.find((candidate) => candidate.GUID === item.id);
    if (!location) return;

    const updated = await this.activities.attachLocation(answer, location);
    if (!updated) return;

    const step = resolveNextStep(requirements, updated);

    if (step === 'asset') {
      // `desde` deja constancia de que el selector de activo se abrió como
      // paso siguiente de éste. Sin esa marca, el botón de volver del activo no
      // puede distinguir este caso del de una actividad que ya tenía ubicación
      // y entró directa — y mandaría a re-elegir una sede que nadie tocó.
      await this.router.navigate(['/formularios', surveyId, 'activos'], {
        queryParams: { actividad: updated.GUID, desde: 'ubicaciones' },
      });
      return;
    }

    await this.router.navigate(['/formularios', surveyId, 'actividad', updated.GUID]);
  }

  /** Vuelve al listado de actividades del formulario. */
  async goBack(): Promise<void> {
    await this.router.navigate(['/formularios', this.surveyId()]);
  }

  private descriptorsOf(location: LocationForm): Descriptor[] {
    return parseEntityDescriptors(location.jsonDescriptor, location.jsonValues);
  }

  private toItem(location: LocationForm): PickerItem {
    return {
      id: location.GUID,
      name: location.Name || 'Sin nombre',
      hint: location.FullAddress || '',
      descriptors: this.descriptorsOf(location),
    };
  }
}
