import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';

import { Asset, Survey, SurveyAnswer } from '../../core/models/entities.model';
import {
  ActivityService,
  SurveyRequirements,
  readRequirements,
} from '../../core/services/activity.service';
import {
  Descriptor,
  descriptorsMatch,
  parseEntityDescriptors,
} from '../../shared/utils/descriptors';
import { PermissionsService } from '../../core/services/permissions.service';
import { EntityPickerComponent, PickerItem } from './entity-picker/entity-picker.component';

/** Cuántos activos se traen por página. */
const PAGE_SIZE = 30;

/** Espera antes de lanzar la búsqueda. */
const SEARCH_DELAY_MS = 300;

/**
 * Paso «elegir activo» del flujo de apertura.
 *
 * Va siempre después de la ubicación cuando el formulario pide las dos cosas:
 * los activos se listan **dentro** de la ubicación elegida, porque ofrecer los
 * de otra sede sería ofrecer respuestas equivocadas — y quien las elija no
 * tendrá forma de darse cuenta hasta que la actividad llegue mal a Visitrack.
 *
 * Al elegir se guarda de inmediato y se abre el formulario.
 */
@Component({
  selector: 'vt-asset-picker',
  standalone: true,
  imports: [EntityPickerComponent],
  template: `
    <vt-entity-picker
      icon="box"
      [title]="title()"
      [subtitle]="subtitle()"
      [items]="items()"
      [loading]="loading()"
      [searching]="searching()"
      [hasMore]="hasMore()"
      [searchTerm]="search()"
      [totalCount]="total()"
      [emptyMessage]="emptyMessage()"
      (search)="onSearch($event)"
      (loadMore)="loadMore()"
      [createLabel]="canCreate() ? 'Nuevo activo' : ''"
      [createBlocked]="permissions.entitiesReason()"
      (choose)="choose($event)"
      (create)="createNew()"
      (back)="goBack()"
    />
  `,
})
export class AssetPickerComponent {
  private readonly router = inject(Router);
  private readonly activities = inject(ActivityService);
  readonly permissions = inject(PermissionsService);

  readonly surveyId = input.required<string>();
  readonly actividad = input('');

  /**
   * De qué pantalla se llegó. `'ubicaciones'` cuando este selector es el paso
   * siguiente del de ubicación; vacío cuando se entró directo desde el listado.
   */
  readonly desde = input('');

  /** Activo recién dado de alta, de vuelta del editor. Se asocia solo. */
  readonly creado = input('');

  private readonly survey = signal<Survey | null>(null);
  private readonly answer = signal<SurveyAnswer | null>(null);
  private readonly typeName = signal('');
  private readonly page = signal<Asset[]>([]);
  private readonly matches = signal<Asset[] | null>(null);

  readonly loading = signal(true);
  readonly searching = signal(false);
  readonly search = signal('');
  readonly total = signal(0);

  private searchTimer?: ReturnType<typeof setTimeout>;

  readonly title = computed(() => this.typeName() || 'Activos');

  readonly subtitle = computed(() => {
    const answer = this.answer();
    // La ubicación va en el subtítulo a propósito: es el contexto que explica
    // por qué la lista es esta y no otra.
    if (answer?.LocationName) return `En ${answer.LocationName}`;

    const survey = this.survey();
    return survey ? `Elige el activo para «${survey.Title}»` : '';
  });

  readonly emptyMessage = computed(() => {
    const answer = this.answer();
    return answer?.LocationName
      ? `No hay activos de este tipo registrados en ${answer.LocationName}.`
      : 'No hay activos de este tipo en este equipo. Sincroniza tus datos e inténtalo de nuevo.';
  });

  readonly items = computed<PickerItem[]>(() => {
    const source = this.matches() ?? this.page();
    return source.map((asset) => this.toItem(asset));
  });

  readonly hasMore = computed(
    () => this.matches() === null && this.page().length < this.total(),
  );

  private readonly requirements = computed<SurveyRequirements | null>(() => {
    const survey = this.survey();
    return survey ? readRequirements(survey) : null;
  });

  /** Ubicación sobre la que se filtran los activos. */
  private get locationId(): string {
    return this.answer()?.LocationID ?? '';
  }

  /**
   * …y su GUID.
   *
   * Una sede creada en este dispositivo no tiene `LocationID` —lo asigna
   * Visitrack al subir—, así que sus activos solo se reconocen por aquí. Sin
   * esto, quien acababa de dar de alta una sede y un equipo dentro no veía el
   * equipo en este selector.
   */
  private get locationGuid(): string {
    return this.answer()?.LocationGUID ?? '';
  }

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
      const locationId = answer?.LocationID ?? '';
      const locationGuid = answer?.LocationGUID ?? '';

      const [name, total, first] = await Promise.all([
        this.activities.assetTypeName(requirements.assetTypeGuid),
        this.activities.countAssets(requirements.assetTypeGuid, locationId, locationGuid),
        this.activities.listAssets(requirements.assetTypeGuid, locationId, {
          limit: PAGE_SIZE,
          locationGuid,
        }),
      ]);

      this.typeName.set(name);
      this.total.set(total);
      this.page.set(first);

      if (this.creado()) await this.attachCreated(this.creado(), requirements, locationId);
    } catch (error) {
      console.error('[AssetPicker] no se pudieron cargar los activos', error);
    } finally {
      this.loading.set(false);
    }
  }

  async loadMore(): Promise<void> {
    const requirements = this.requirements();
    if (!requirements) return;

    const next = await this.activities.listAssets(requirements.assetTypeGuid, this.locationId, {
      limit: PAGE_SIZE,
      offset: this.page().length,
      locationGuid: this.locationGuid,
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

  /** Busca sobre todos los activos de la ubicación, no solo los ya cargados. */
  private async runSearch(term: string): Promise<void> {
    const requirements = this.requirements();
    if (!requirements) return;

    try {
      const all = await this.activities.listAssets(requirements.assetTypeGuid, this.locationId, {
        locationGuid: this.locationGuid,
      });
      const needle = term.trim().toLowerCase();

      this.matches.set(
        all.filter(
          (asset) =>
            asset.Name?.toLowerCase().includes(needle) ||
            asset.SerialNumber?.toLowerCase().includes(needle) ||
            asset.TagUID?.toLowerCase().includes(needle) ||
            descriptorsMatch(this.descriptorsOf(asset), needle),
        ),
      );
    } catch (error) {
      console.error('[AssetPicker] falló la búsqueda', error);
      this.matches.set([]);
    } finally {
      this.searching.set(false);
    }
  }

  /** Asocia el activo y abre el formulario. */
  async choose(item: PickerItem): Promise<void> {
    const source = this.matches() ?? this.page();
    const asset = source.find((candidate) => candidate.GUID === item.id);

    if (asset) await this.attach(asset);
  }

  /**
   * Asocia el activo y sigue al formulario.
   *
   * Recibe el registro y no su identificador: quien acaba de crearlo lo tiene
   * en la mano, y buscarlo en la lista visible fallaría en silencio si por
   * orden alfabético cayó más allá de la primera página.
   */
  private async attach(asset: Asset): Promise<void> {
    const answer = this.answer();
    const surveyId = this.survey()?.SurveyID;
    if (!answer || !surveyId) return;

    const updated = await this.activities.attachAsset(answer, asset);
    if (!updated) return;

    /**
     * `replaceUrl` saca el selector del historial.
     *
     * El activo ya está elegido y guardado en la actividad: volver atrás desde
     * el formulario debe llevar al listado, no a repetir una elección hecha. Sin
     * esto, el botón atrás del navegador devolvía al selector una y otra vez, y
     * el usuario tenía que pulsarlo varias veces para salir.
     *
     * Cambiar de activo sigue siendo posible desde la propia actividad, que es
     * donde tiene sentido: allí se ve qué se está cambiando.
     */
    await this.router.navigate(['/formularios', surveyId, 'actividad', updated.GUID], {
      replaceUrl: true,
    });
  }

  /**
   * Asocia el activo recién creado y sigue al formulario.
   *
   * Se busca entre todos los de la sede: acaba de nacer y no tiene por qué
   * caer en la primera página.
   */
  private async attachCreated(
    guid: string,
    requirements: SurveyRequirements,
    locationId: string,
  ): Promise<void> {
    const all = await this.activities.listAssets(requirements.assetTypeGuid, locationId, {
      locationGuid: this.locationGuid,
    });

    const created = all.find((asset) => asset.GUID === guid);

    if (!created) return;

    await this.attach(created);
  }

  /** El rol permite dar de alta lo que no aparece en la lista. */
  readonly canCreate = computed(() => this.permissions.canCreateAssets());

  /**
   * Sale a crear el activo y vuelve aquí.
   *
   * Se crea **dentro de la ubicación de la actividad**: un activo cuelga de una
   * sede, y la de esta actividad ya está elegida. Al volver, el selector se
   * retoma con el recién creado en la lista.
   */
  async createNew(): Promise<void> {
    const location = this.answer()?.LocationGUID;
    if (!location) return;

    await this.router.navigate(['/ubicaciones', location, 'activo', 'nuevo'], {
      queryParams: {
        volver: this.router.url,

        // Del tipo que exige el formulario, por lo mismo que en las
        // ubicaciones: de otro tipo no volvería a aparecer aquí.
        tipo: this.requirements()?.assetTypeGuid ?? '',
      },
    });
  }

  /**
   * Vuelve al paso anterior **real**.
   *
   * Si se llegó aquí desde el selector de ubicación (`desde=ubicaciones`), atrás
   * es ese selector: quien se equivocó de sede espera corregirla, no empezar de
   * cero.
   *
   * Si se entró directo desde el listado —la actividad ya tenía su ubicación—,
   * atrás es el listado. Mandar ahí al selector de ubicación obligaría a
   * re-elegir una sede que nadie tocó en este recorrido, y peor: dejaría creer
   * que hay que volver a elegirla.
   */
  async goBack(): Promise<void> {
    const surveyId = this.surveyId();

    if (this.desde() === 'ubicaciones') {
      await this.router.navigate(['/formularios', surveyId, 'ubicaciones'], {
        queryParams: { actividad: this.actividad() },
      });
      return;
    }

    await this.router.navigate(['/formularios', surveyId]);
  }

  private descriptorsOf(asset: Asset): Descriptor[] {
    // Los activos traen sus descriptivos en `JSONTitle` cuando bajan resueltos
    // del servidor; si no, se cruzan igual que en las ubicaciones.
    const fromTitle = parseEntityDescriptors(asset.JSONTitle, asset.jsonValues);
    if (fromTitle.length > 0) return fromTitle;

    return parseEntityDescriptors(asset.jsonDescriptor, asset.jsonValues);
  }

  private toItem(asset: Asset): PickerItem {
    const hint = [asset.Make, asset.Model, asset.SerialNumber].filter(Boolean).join(' · ');

    return {
      id: asset.GUID,
      name: asset.Name || 'Sin nombre',
      hint,
      descriptors: this.descriptorsOf(asset),
    };
  }
}
