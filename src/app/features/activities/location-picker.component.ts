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
import { PermissionsService } from '../../core/services/permissions.service';
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
      [createLabel]="canCreate() ? 'Nueva ubicación' : ''"
      [createBlocked]="permissions.entitiesReason()"
      (choose)="choose($event)"
      (create)="createNew()"
      (back)="goBack()"
    />
  `,
})
export class LocationPickerComponent {
  private readonly router = inject(Router);
  private readonly activities = inject(ActivityService);
  readonly permissions = inject(PermissionsService);

  /** Formulario, del segmento de la ruta. */
  readonly surveyId = input.required<string>();

  /** GUID de la actividad en curso, del parámetro de consulta. */
  readonly actividad = input('');

  /**
   * Ubicación recién dada de alta, de vuelta del editor.
   *
   * Quien salió a crearla lo hizo porque era la que necesitaba: se asocia sola
   * y se sigue al paso siguiente, en vez de devolver a una lista donde habría
   * que buscarla.
   */
  readonly creado = input('');

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

      // Antes de que el usuario toque nada: viene de crearla, no de mirar.
      if (this.creado()) await this.attachCreated(this.creado(), requirements);
    } catch (error) {
      console.error('[LocationPicker] no se pudieron cargar las ubicaciones', error);
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Asocia la ubicación recién creada y sigue.
   *
   * Se busca sobre todas las del tipo y no sobre la primera página: acaba de
   * nacer y puede estar en cualquier posición del orden.
   */
  private async attachCreated(guid: string, requirements: SurveyRequirements): Promise<void> {
    const all = await this.activities.listLocations(requirements.locationTypeGuid);
    const created = all.find((location) => location.GUID === guid);

    // Si no está —se canceló el alta, o se creó de otro tipo—, no se hace nada:
    // el selector se queda como estaba y el usuario elige.
    if (!created) return;

    await this.attach(created);
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
    const source = this.matches() ?? this.page();
    const location = source.find((candidate) => candidate.GUID === item.id);

    if (location) await this.attach(location);
  }

  /**
   * Asocia la ubicación y avanza.
   *
   * Recibe el registro y no su identificador porque quien acaba de crear una
   * sede la tiene en la mano: buscarla en la lista visible fallaría en silencio
   * si por orden alfabético cayó más allá de la primera página.
   */
  private async attach(location: LocationForm): Promise<void> {
    const answer = this.answer();
    const requirements = this.requirements();
    const surveyId = this.survey()?.SurveyID;
    if (!answer || !requirements || !surveyId) return;

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

    // Fuera del historial: la ubicación ya quedó guardada, y volver atrás desde
    // el formulario debe llevar al listado en vez de repetir la elección.
    await this.router.navigate(['/formularios', surveyId, 'actividad', updated.GUID], {
      replaceUrl: true,
    });
  }

  /** El rol permite dar de alta lo que no aparece en la lista. */
  readonly canCreate = computed(() => this.permissions.canCreateLocations());

  /**
   * Sale a crear la entidad y vuelve aquí.
   *
   * La actividad a medias sigue en la dirección, así que al volver el selector
   * se retoma en el mismo punto — con la recién creada ya en la lista. Es lo
   * que evita que dar de alta una sede obligue a empezar la actividad de nuevo.
   */
  async createNew(): Promise<void> {
    await this.router.navigate(['/ubicaciones', 'nueva'], {
      queryParams: {
        volver: this.router.url,

        // Del tipo que exige el formulario: creada de otro, no aparecería en
        // este mismo selector al volver.
        tipo: this.requirements()?.locationTypeGuid ?? '',
      },
    });
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
