import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { Asset, LocationForm, SurveyAnswer } from '../../core/models/entities.model';
import { AssetRepository } from '../../core/repositories/entity.repositories';
import { SurveyAnswerRepository } from '../../core/repositories/survey-answer.repository';
import { BinaryStorageService } from '../../core/services/binary-storage.service';
import { LocationEditorService } from '../../core/services/location-editor.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { DataRevisionService } from '../../core/sync/data-revision.service';
import { ConfirmDialogComponent } from '../../shared/components/confirm-dialog/confirm-dialog.component';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { ToTopComponent } from '../../shared/components/to-top/to-top.component';
import { NearEndDirective } from '../../shared/directives/near-end.directive';
import {
  Descriptor,
  descriptorsMatch,
  parseAnswerTitles,
  parseEntityDescriptors,
} from '../../shared/utils/descriptors';
import { DetailGroup, DetailItem, groupEntityValues } from './entity-detail.model';

/** Un activo de la ubicación, listo para pintar. */
interface AssetCard {
  guid: string;
  name: string;
  typeName: string;
  descriptors: Descriptor[];
  located: boolean;
  pending: boolean;
}

/** Una actividad hecha sobre la entidad. */
interface ActivityCard {
  guid: string;
  surveyId: string;
  title: string;
  when: string;
  descriptors: Descriptor[];
  synced: boolean;
}

type Tab = 'info' | 'assets' | 'activities';

/**
 * La ficha de una ubicación o de un activo.
 *
 * ## Una sola pantalla para los dos
 *
 * Una sede y un equipo se consultan igual: sus datos, lo que se les ha hecho, y
 * en el caso de la sede, lo que hay dentro. Separarlos en dos pantallas habría
 * duplicado el cruce de valores con la estructura del tipo, el listado de
 * actividades y el borrado — para que solo cambiara el título.
 *
 * ## Los datos no se enseñan en crudo
 *
 * Lo guardado son pares de identificador y valor. Aquí se cruzan con la
 * estructura del tipo para recuperar el nombre de cada campo, se agrupan por
 * las páginas que ese tipo definió, y se enseñan según lo que sean: un teléfono
 * se puede marcar, una dirección se abre en el mapa y una fotografía se ve.
 */
@Component({
  selector: 'vt-location-detail',
  standalone: true,
  imports: [ConfirmDialogComponent, IconComponent, NearEndDirective, RouterLink, ToTopComponent],
  templateUrl: './location-detail.component.html',
  styleUrl: './location-detail.component.scss',
})
export class LocationDetailComponent {
  private readonly editor = inject(LocationEditorService);
  private readonly assets = inject(AssetRepository);
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly binaries = inject(BinaryStorageService);
  private readonly router = inject(Router);
  private readonly revisions = inject(DataRevisionService);
  private readonly permissions = inject(PermissionsService);

  readonly guid = input('');

  /** Activo que se está viendo. Vacío cuando la ficha es de la ubicación. */
  readonly asset = input('');

  readonly loading = signal(true);
  readonly location = signal<LocationForm | null>(null);
  readonly current = signal<Asset | null>(null);
  readonly tab = signal<Tab>('info');

  readonly assetList = signal<AssetCard[]>([]);
  readonly activityList = signal<ActivityCard[]>([]);
  readonly groups = signal<DetailGroup[]>([]);
  readonly basics = signal<DetailItem[]>([]);

  /** URLs de las imágenes de la ficha, por GUID del archivo. */
  readonly images = signal(new Map<string, string>());

  readonly asking = signal(false);

  // ── Búsqueda y tandas ──────────────────────────────────────────────────────
  //
  // Una sede grande tiene cientos de activos y años de actividades. Pintarlos
  // todos deja miles de filas en el documento; se enseñan las primeras y el
  // resto llega al bajar.

  private static readonly PAGE = 20;

  readonly search = signal('');

  /** Tipo de activo por el que se filtra. Vacío son todos. */
  readonly assetType = signal('');

  private readonly shown = signal(LocationDetailComponent.PAGE);

  /** Cuántos activos hay de cada tipo, para el desplegable. */
  readonly assetTypes = computed(() => {
    const counts = new Map<string, number>();

    for (const item of this.assetList()) {
      counts.set(item.typeName, (counts.get(item.typeName) ?? 0) + 1);
    }

    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  });

  /** Activos que pasan el filtro y la búsqueda. */
  private readonly matchingAssets = computed(() => {
    const needle = this.search().trim().toLowerCase();
    const type = this.assetType();

    return this.assetList().filter((item) => {
      if (type && item.typeName !== type) return false;
      if (!needle) return true;

      return (
        item.name.toLowerCase().includes(needle) ||
        item.typeName.toLowerCase().includes(needle) ||
        descriptorsMatch(item.descriptors, needle)
      );
    });
  });

  /** Actividades que pasan la búsqueda. */
  private readonly matchingActivities = computed(() => {
    const needle = this.search().trim().toLowerCase();
    if (!needle) return this.activityList();

    return this.activityList().filter(
      (item) =>
        item.title.toLowerCase().includes(needle) ||
        descriptorsMatch(item.descriptors, needle),
    );
  });

  readonly visibleAssets = computed(() => this.matchingAssets().slice(0, this.shown()));
  readonly visibleActivities = computed(() => this.matchingActivities().slice(0, this.shown()));

  readonly hasMore = computed(() =>
    this.tab() === 'assets'
      ? this.matchingAssets().length > this.shown()
      : this.matchingActivities().length > this.shown(),
  );

  showMore(): void {
    this.shown.update((current) => current + LocationDetailComponent.PAGE);
  }

  onSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
    this.shown.set(LocationDetailComponent.PAGE);
  }

  onTypePicked(event: Event): void {
    this.assetType.set((event.target as HTMLSelectElement).value);
    this.shown.set(LocationDetailComponent.PAGE);
  }

  readonly isAsset = computed(() => Boolean(this.asset()));
  readonly found = computed(() => (this.isAsset() ? this.current() !== null : this.location() !== null));

  readonly name = computed(() =>
    this.isAsset() ? (this.current()?.Name ?? '') : (this.location()?.Name ?? ''),
  );

  readonly typeName = computed(() => {
    const title = this.isAsset() ? this.current()?.typeTitle : this.location()?.typeTitle;
    return title || (this.isAsset() ? 'Activo' : 'Ubicación');
  });

  /** Ubicación a la que pertenece, cuando la ficha es de un activo. */
  readonly parentName = computed(() => (this.isAsset() ? (this.location()?.Name ?? '') : ''));

  readonly coordinates = computed(() => {
    const record = this.isAsset() ? this.current() : this.location();
    if (!record?.Latitude || !record?.Longitude) return '';

    return `${record.Latitude}, ${record.Longitude}`;
  });

  readonly located = computed(() => Boolean(this.coordinates()));

  /** Se creó aquí y todavía no subió. */
  readonly pending = computed(() => {
    const record = this.isAsset() ? this.current() : this.location();
    return record?.CreateWithMovil === '1' && record?.Upload !== '1';
  });

  /**
   * Solo se puede borrar lo que nunca llegó al servidor.
   *
   * Igual que en la app: borrar aquí algo que allá existe lo dejaría fuera del
   * dispositivo pero vivo en la plataforma, y nadie sabría por qué desapareció.
   */
  readonly canDelete = computed(() => {
    const record = this.isAsset() ? this.current() : this.location();
    if (!record || record.SyncedToServer === '1') return false;

    return this.isAsset()
      ? this.permissions.canDeleteAssets()
      : this.permissions.canDeleteLocations();
  });

  /** Editar y crear activos dependen del rol, no del estado del registro. */
  readonly canEdit = computed(() =>
    this.isAsset() ? this.permissions.canEditAssets() : this.permissions.canEditLocations(),
  );

  readonly canCreateAssets = computed(() => this.permissions.canCreateAssets());

  readonly noPermission = computed(() => this.permissions.entitiesReason());

  /** A dónde lleva el botón de editar. */
  readonly editLink = computed(() =>
    this.isAsset()
      ? ['/ubicaciones', this.guid(), 'activo', this.asset(), 'editar']
      : ['/ubicaciones', this.guid(), 'editar'],
  );

  readonly backLink = computed(() =>
    this.isAsset() ? ['/ubicaciones', this.guid()] : ['/ubicaciones'],
  );

  /** Dirección de un buscador de mapas para las coordenadas. */
  readonly mapLink = computed(() => {
    const coords = this.coordinates();
    return coords ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(coords)}` : '';
  });

  constructor() {
    effect(() => {
      const guid = this.guid();
      const asset = this.asset();

      // Volver de crear o editar tiene que enseñarlo sin recargar la página.
      this.revisions.entities();

      untracked(() => void this.load(guid, asset));
    });
  }

  private async load(guid: string, asset: string): Promise<void> {
    if (!guid) return;

    this.loading.set(true);
    this.tab.set('info');

    try {
      const record = await this.editor.findLocation(guid);
      this.location.set(record);

      if (!record) return;

      const target = asset ? await this.editor.findAsset(asset) : null;
      this.current.set(target);

      if (asset && !target) return;

      await Promise.all([
        this.loadValues(target ?? record),
        this.loadActivities(record, target),
        asset ? Promise.resolve() : this.loadAssets(record),
      ]);
    } catch (error) {
      console.error('[Ubicaciones] no se pudo cargar la ficha', error);
    } finally {
      this.loading.set(false);
    }
  }

  /** Los datos propios y los campos del tipo. */
  private async loadValues(record: LocationForm | Asset): Promise<void> {
    this.basics.set(this.isAsset() ? assetBasics(record as Asset) : locationBasics(record as LocationForm));

    const groups = groupEntityValues(record.jsonQuestion, this.editor.answersOf(record.jsonValues));
    this.groups.set(groups);

    // Las fotos y las firmas se ven, no se citan: una ficha que dijera «archivo
    // adjunto» obligaría a abrir el editor para saber qué hay dentro.
    const wanted = groups.flatMap((group) =>
      group.items.filter((item) => item.kind === 'image' && item.binary).map((item) => item.binary!),
    );

    const urls = new Map<string, string>();

    for (const binary of wanted) {
      try {
        urls.set(binary, await this.binaries.objectUrl(binary));
      } catch {
        // El archivo puede haberse subido y limpiado del dispositivo: se deja
        // el dato sin imagen en vez de romper la ficha.
      }
    }

    this.images.set(urls);
  }

  private async loadAssets(record: LocationForm): Promise<void> {
    // Por identificador y por GUID: los activos creados bajo una sede que
    // también nació aquí no tienen `LocationID` hasta que la sede suba.
    const assets = await this.assets.findByLocationGuid(
      record.UserID,
      Number(record.LocationID) || 0,
      record.GUID,
    );

    this.assetList.set(
      assets
        .filter((asset) => asset.isDeleted !== '1')
        .map((asset) => ({
          guid: asset.GUID,
          name: asset.Name || 'Sin nombre',
          typeName: asset.typeTitle || 'Sin tipo',
          descriptors: parseEntityDescriptors(asset.jsonDescriptor, asset.jsonValues),
          located: Boolean(asset.Latitude && asset.Longitude),
          pending: asset.CreateWithMovil === '1' && asset.Upload !== '1',
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' })),
    );
  }

  /**
   * Las actividades de la entidad.
   *
   * De la ubicación, las suyas; de un activo, solo las que se le hicieron a él.
   * Enseñar las de la sede entera en la ficha de un equipo daría por revisado
   * algo que quizá nunca se tocó.
   */
  private async loadActivities(record: LocationForm, asset: Asset | null): Promise<void> {
    const answers = await this.answers.findByUser(String(record.UserID));

    this.activityList.set(
      answers
        .filter((answer) => {
          if (answer.isSaved === 0) return false;

          return asset
            ? answer.AssetGUID === asset.GUID
            : answer.LocationGUID === record.GUID;
        })
        .map((answer) => this.toActivityCard(answer))
        .sort((a, b) => b.when.localeCompare(a.when)),
    );
  }

  private toActivityCard(answer: SurveyAnswer): ActivityCard {
    const titles = parseAnswerTitles(answer.Titles);

    return {
      guid: answer.GUID,
      surveyId: answer.SurveyID,
      // El primer descriptivo es el nombre del formulario: así lo escribe el
      // motor al guardar, con la etiqueta `[DEF]`.
      title: titles[0]?.val || 'Actividad',
      when: answer.UpdatedOn || answer.CreatedOn || '',
      descriptors: titles.slice(1),
      synced: answer.isSaved === 2,
    };
  }

  show(tab: Tab): void {
    this.tab.set(tab);

    // Cada pestaña empieza por su principio, y con su propia búsqueda: lo que
    // se buscaba entre activos no significa nada entre actividades.
    this.search.set('');
    this.assetType.set('');
    this.shown.set(LocationDetailComponent.PAGE);
  }

  /** La imagen de un dato, si se pudo recuperar. */
  imageOf(item: DetailItem): string {
    return item.binary ? (this.images().get(item.binary) ?? '') : '';
  }

  /** A dónde lleva un dato que se puede accionar. */
  actionOf(item: DetailItem): string {
    switch (item.kind) {
      case 'email':
        return `mailto:${item.val}`;

      case 'phone':
        return `tel:${item.val.replace(/\s+/g, '')}`;

      case 'address':
        return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.val)}`;

      default:
        return '';
    }
  }

  // ── Acciones ───────────────────────────────────────────────────────────────

  async remove(): Promise<void> {
    this.asking.set(false);

    const removed = this.isAsset()
      ? await this.editor.removeAsset(this.asset())
      : await this.editor.removeLocation(this.guid());

    if (removed) await this.router.navigate(this.backLink());
  }

  /** Fecha legible de una actividad. */
  when(value: string): string {
    if (!value) return '';

    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? ''
      : date.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' });
  }
}

/** Los datos fijos de una ubicación que tienen valor. */
function locationBasics(record: LocationForm): DetailItem[] {
  return [
    { lab: 'Dirección', val: record.FullAddress || record.Street, kind: 'address' as const, wide: true },
    { lab: 'Ciudad', val: [record.City, record.State].filter(Boolean).join(', '), kind: 'text' as const },
    { lab: 'Contacto', val: record.ContactName, kind: 'text' as const },
    { lab: 'Correo', val: record.Email, kind: 'email' as const },
    { lab: 'Teléfono', val: record.Phone, kind: 'phone' as const },
    { lab: 'Identificador', val: record.LocationID, kind: 'text' as const },
  ].filter((entry) => Boolean(entry.val?.trim()));
}

/** Lo mismo para un activo: marca, modelo y serie son columnas suyas. */
function assetBasics(record: Asset): DetailItem[] {
  return [
    { lab: 'Marca', val: record.Make, kind: 'text' as const },
    { lab: 'Modelo', val: record.Model, kind: 'text' as const },
    { lab: 'Serie', val: record.SerialNumber, kind: 'text' as const },
    { lab: 'Etiqueta', val: record.TagUID, kind: 'text' as const },
    { lab: 'Descripción', val: record.Description, kind: 'text' as const, wide: true },
    { lab: 'Identificador', val: String(record.AssetID || ''), kind: 'text' as const },
  ].filter((entry) => Boolean(entry.val?.trim()));
}
