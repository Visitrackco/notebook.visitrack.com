import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';

import { EntityType, LocationForm } from '../../core/models/entities.model';
import { LocationRepository } from '../../core/repositories/entity.repositories';
import { AuthService } from '../../core/services/auth.service';
import { LocationEditorService } from '../../core/services/location-editor.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { DataRevisionService } from '../../core/sync/data-revision.service';
import { resolveCatalogOwnerId } from '../../core/config/company-rules';
import { ToTopComponent } from '../../shared/components/to-top/to-top.component';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { NearEndDirective } from '../../shared/directives/near-end.directive';
import {
  Descriptor,
  descriptorsMatch,
  parseEntityDescriptors,
} from '../../shared/utils/descriptors';

/** Una ubicación, con lo que hace falta para pintarla. */
export interface LocationCard {
  location: LocationForm;
  guid: string;
  name: string;
  typeName: string;
  descriptors: Descriptor[];
  /** Tiene coordenadas capturadas. */
  located: boolean;
  /** Se creó desde un dispositivo y todavía no subió. */
  pending: boolean;
  /** Se creó desde un dispositivo. */
  own: boolean;
}

/**
 * Las ubicaciones del usuario.
 *
 * ## Por qué agrupadas por tipo
 *
 * Una ubicación no significa lo mismo en dos empresas: para una son sedes, para
 * otra puntos de venta, torres y subestaciones a la vez. Mezclarlas en una lista
 * plana obliga a leer cada nombre para saber qué es. Agrupadas por su tipo, la
 * pregunta «¿cuántas subestaciones tengo?» se responde sin leer nada.
 *
 * ## Qué se ve de cada una
 *
 * El nombre, sus **descriptivos** —el código, la ciudad, lo que su tipo haya
 * configurado— y dos señales que en campo importan más que el resto: si tiene
 * **coordenadas** y si está **pendiente de subir**. La segunda es la que evita
 * que alguien dé por registrada una sede que solo existe en su navegador.
 */
@Component({
  selector: 'vt-locations',
  standalone: true,
  imports: [IconComponent, NearEndDirective, RouterLink, ToTopComponent],
  templateUrl: './locations.component.html',
  styleUrl: './locations.component.scss',
})
export class LocationsComponent {
  private readonly repository = inject(LocationRepository);
  private readonly editor = inject(LocationEditorService);
  private readonly auth = inject(AuthService);
  private readonly revisions = inject(DataRevisionService);
  readonly permissions = inject(PermissionsService);

  readonly loading = signal(true);
  readonly search = signal('');

  /** Tipo por el que se está filtrando. Vacío son todos. */
  readonly typeFilter = signal('');

  readonly all = signal<LocationCard[]>([]);
  readonly types = signal<EntityType[]>([]);

  /**
   * Se ofrece crear si hay un tipo que rellenar **y** el rol lo permite.
   *
   * Cuando el rol lo prohíbe se dice, en vez de esconder el botón: quien busca
   * el «Nueva ubicación» que vio otro día necesita saber que no desapareció,
   * sino que su rol no lo tiene.
   */
  readonly canCreate = computed(() => this.types().length > 0 && this.permissions.canCreateLocations());

  readonly noPermission = computed(() => this.permissions.entitiesReason());

  /**
   * Cuántas hay de cada tipo.
   *
   * Se cuenta sobre **todas**, no sobre lo filtrado: los contadores son la
   * forma de moverse entre tipos, y si cambiaran al buscar dejarían de servir
   * para eso.
   */
  readonly tabs = computed(() => {
    const counts = new Map<string, number>();

    for (const card of this.all()) {
      counts.set(card.typeName, (counts.get(card.typeName) ?? 0) + 1);
    }

    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  });

  /**
   * Cuántas se añaden en cada tanda.
   *
   * Una empresa puede tener miles de ubicaciones. Pintarlas todas de golpe deja
   * miles de tarjetas en el documento —con sus descriptivos y sus iconos— y en
   * un equipo modesto eso se nota al desplazar. Se enseñan las primeras y el
   * resto llega al bajar.
   */
  private static readonly PAGE = 24;

  /** Cuántas hay puestas ahora mismo. */
  private readonly shown = signal(LocationsComponent.PAGE);

  /** Las que pasan el filtro, todas. */
  private readonly matching = computed(() => {
    const type = this.typeFilter();
    const needle = this.search().trim().toLowerCase();

    return this.all().filter((card) => {
      if (type && card.typeName !== type) return false;
      if (!needle) return true;

      return (
        card.name.toLowerCase().includes(needle) ||
        descriptorsMatch(card.descriptors, needle)
      );
    });
  });

  /** Las que están puestas en la página. */
  readonly visible = computed(() => this.matching().slice(0, this.shown()));

  readonly hasMore = computed(() => this.matching().length > this.shown());

  /** Pone la siguiente tanda. Lo llama el final de la lista al asomarse. */
  showMore(): void {
    this.shown.update((current) => current + LocationsComponent.PAGE);
  }

  readonly pendingCount = computed(() => this.all().filter((card) => card.pending).length);

  readonly counter = computed(() => {
    const shown = this.matching().length;
    const total = this.all().length;
    const noun = total === 1 ? 'ubicación' : 'ubicaciones';

    return shown === total ? `${total} ${noun}` : `${shown} de ${total} ${noun}`;
  });

  constructor() {
    effect(() => {
      const user = this.auth.currentUser();

      // Se relee cuando algo cambia las entidades desde otra pantalla: crear
      // una ubicación y volver aquí tiene que enseñarla, y una sincronización
      // en segundo plano también.
      this.revisions.entities();

      untracked(() => void this.load(user ? resolveCatalogOwnerId(user) : null));
    });
  }

  private async load(owner: number | null): Promise<void> {
    if (owner === null) return;

    this.loading.set(true);

    try {
      const [locations, types] = await Promise.all([
        this.repository.findByUser(owner),
        this.editor.locationTypesOf(),
      ]);

      const byId = new Map(types.map((type) => [String(type.ID), type]));

      this.all.set(
        locations
          .filter((location) => location.isDeleted !== '1')
          .map((location) => this.toCard(location, byId))
          .sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' })),
      );

      this.types.set(types);
    } catch (error) {
      console.error('[Ubicaciones] no se pudieron cargar', error);
      this.all.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  private toCard(location: LocationForm, types: Map<string, EntityType>): LocationCard {
    const own = location.CreateWithMovil === '1';

    return {
      location,
      guid: location.GUID,
      name: location.Name || 'Sin nombre',

      // El nombre del tipo puede venir en el propio registro —lo trae el sync—
      // o haber que buscarlo en el catálogo cuando se creó aquí.
      typeName:
        location.typeTitle ||
        types.get(String(location.LocationTypeGUID))?.Name ||
        'Sin tipo',

      descriptors: parseEntityDescriptors(location.jsonDescriptor, location.jsonValues),
      located: Boolean(location.Latitude && location.Longitude),
      own,
      pending: own && location.Upload !== '1',
    };
  }

  onSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
    this.shown.set(LocationsComponent.PAGE);
  }

  onTypePicked(event: Event): void {
    this.typeFilter.set((event.target as HTMLSelectElement).value);
    this.shown.set(LocationsComponent.PAGE);
  }

  /** Recarga tras crear, editar o borrar. */
  async refresh(): Promise<void> {
    const user = this.auth.currentUser();
    await this.load(user ? resolveCatalogOwnerId(user) : null);
  }
}
