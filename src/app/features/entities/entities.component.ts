import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';

import { resolveCatalogOwnerId } from '../../core/config/company-rules';
import { Asset, ListDetail, ListDefinition, LocationForm } from '../../core/models/entities.model';
import {
  AssetRepository,
  ListRepository,
  ListDetailRepository,
  LocationRepository,
} from '../../core/repositories/entity.repositories';
import { AuthService } from '../../core/services/auth.service';
import { ConnectivityService } from '../../core/services/connectivity.service';
import { ToastService } from '../../core/services/toast.service';
import { DataRevisionService } from '../../core/sync/data-revision.service';
import { EntityUploadService } from '../../core/sync/entity-upload.service';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { ToTopComponent } from '../../shared/components/to-top/to-top.component';
import { Descriptor, parseEntityDescriptors } from '../../shared/utils/descriptors';

/** Qué clase de registro es. Decide el icono y a dónde lleva. */
type Kind = 'location' | 'asset' | 'item';

/** Una entidad pendiente, lista para pintar. */
interface EntityCard {
  key: string;
  kind: Kind;
  name: string;

  /** De qué es: el tipo de sede, el tipo de activo, el nombre de la lista. */
  origin: string;

  descriptors: Descriptor[];

  /** Nació aquí, o ya existía en Visitrack y se modificó. */
  isNew: boolean;

  updated: string;
  updatedLabel: string;

  /**
   * Espera a otro registro para poder subir.
   *
   * Un activo no sale antes que su sede; un ítem de lista, no antes que el ítem
   * del que cuelga. Decirlo evita que se lea como un fallo.
   */
  waiting: string;

  /** A dónde lleva pulsarla. Vacío cuando no tiene pantalla propia. */
  link: unknown[] | null;
}

/**
 * Las entidades creadas o modificadas en este dispositivo.
 *
 * ## Por qué merecen pantalla propia
 *
 * Una ubicación, un activo o un ítem de lista dados de alta aquí **no están en
 * Visitrack todavía**, y hasta que lleguen no existen para nadie más: ni para
 * el compañero que abre la misma sede, ni para el informe que sale del otro
 * lado. Eso no se ve por ninguna parte — el catálogo los muestra igual que a
 * los descargados — así que quien crea una sede en campo no tiene forma de
 * saber si ya subió.
 *
 * Aquí están todas, con **qué son**, **si son nuevas o modificadas** y **qué
 * las detiene**. Y desde cada una se llega a su ficha o a su editor, que es lo
 * que se quiere cuando algo lleva mucho rato sin salir: mirarlo.
 *
 * ## Suben solas
 *
 * El proceso automático corre cada minuto y empieza precisamente por esto —
 * antes que las actividades, porque una actividad que las referencia llegaría
 * apuntando a nada. El botón de esta pantalla no hace nada distinto: adelanta
 * la corrida para quien no quiere esperar.
 *
 * ## Ordenadas por lo que lleva más tiempo esperando
 *
 * No alfabéticamente: lo que importa de una entidad pendiente es cuánto lleva
 * sin salir, y lo que se atascó tiene que estar arriba sin buscarlo.
 */
@Component({
  selector: 'vt-entities',
  standalone: true,
  imports: [IconComponent, NgTemplateOutlet, RouterLink, ToTopComponent],
  templateUrl: './entities.component.html',
  styleUrl: './entities.component.scss',
})
export class EntitiesComponent {
  private readonly locations = inject(LocationRepository);
  private readonly assets = inject(AssetRepository);
  private readonly details = inject(ListDetailRepository);
  private readonly lists = inject(ListRepository);
  private readonly auth = inject(AuthService);
  private readonly revisions = inject(DataRevisionService);
  private readonly toasts = inject(ToastService);

  readonly uploads = inject(EntityUploadService);
  readonly connectivity = inject(ConnectivityService);

  readonly loading = signal(true);
  readonly cards = signal<EntityCard[]>([]);

  readonly counter = computed(() => {
    const total = this.cards().length;

    if (total === 0) return 'Todo está en Visitrack';
    return total === 1 ? '1 registro por subir' : `${total} registros por subir`;
  });

  /** Cuántas esperan a otro registro. Se dice aparte: no es lo mismo que fallar. */
  readonly waitingCount = computed(() => this.cards().filter((card) => card.waiting).length);

  constructor() {
    /**
     * La lista se rehace con cada cambio en los catálogos.
     *
     * Es lo que hace que una entidad desaparezca de aquí en cuanto sube, sin
     * que haya que recargar para comprobar si el proceso automático hizo algo.
     */
    effect(() => {
      this.revisions.entities();
      untracked(() => void this.load());
    });
  }

  async load(): Promise<void> {
    const user = this.auth.currentUser();

    if (!user) {
      this.cards.set([]);
      this.loading.set(false);
      return;
    }

    this.loading.set(true);

    try {
      const owner = resolveCatalogOwnerId(user);

      const [locations, assets, items, definitions] = await Promise.all([
        this.locations.findPendingUpload(owner),
        this.assets.findPendingUpload(owner),
        this.details.findPendingUpload(owner),
        this.lists.findByUser(owner),
      ]);

      // Las sedes que siguen sin subir: es lo que retiene a sus activos.
      const pendingLocations = new Set(locations.map((row) => row.GUID));
      const pendingItems = new Set(items.map((row) => row.GUID));

      const byList = new Map(definitions.map((list) => [String(list.ListIDBD ?? ''), list]));

      const cards = [
        ...locations.map((row) => this.locationCard(row)),
        ...assets.map((row) => this.assetCard(row, pendingLocations)),
        ...items
          // Un ítem a medio dar de alta no es algo que deba llegar a Visitrack.
          .filter((row) => row.Save === '1')
          .map((row) => this.itemCard(row, byList, pendingItems)),
      ];

      // Lo que lleva más tiempo esperando, arriba.
      cards.sort((a, b) => a.updated.localeCompare(b.updated));

      this.cards.set(cards);
    } catch (error) {
      console.error('[Entidades] no se pudo leer lo pendiente', error);
      this.cards.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  /** Adelanta la corrida. Es lo único que hace: el proceso ya corre solo. */
  async runNow(): Promise<void> {
    if (this.uploads.running()) return;

    if (this.connectivity.isOffline()) {
      this.toasts.info('Sin conexión', 'Se subirán solas en cuanto vuelva la red.');
      return;
    }

    const summary = await this.uploads.run();

    if (summary.failed > 0) {
      this.toasts.error('Algunas no pudieron subir', summary.message);
    } else {
      this.toasts.success('Listo', summary.message);
    }

    await this.load();
  }

  // ── Presentación ───────────────────────────────────────────────────────────

  private locationCard(row: LocationForm): EntityCard {
    return {
      key: `loc:${row.GUID}`,
      kind: 'location',
      name: row.Name || 'Ubicación sin nombre',
      origin: row.typeTitle || 'Ubicación',
      descriptors: parseEntityDescriptors(row.jsonDescriptor, row.jsonValues),

      // Sin identificador de Visitrack, nunca ha estado allá.
      isNew: !row.LocationID,

      updated: row.UpdatedOn || row.CreatedOn || '',
      updatedLabel: when(row.UpdatedOn || row.CreatedOn),
      waiting: '',
      link: ['/ubicaciones', row.GUID],
    };
  }

  private assetCard(row: Asset, pendingLocations: ReadonlySet<string>): EntityCard {
    const guid = String(row.LocationGUID ?? '');
    const held = Boolean(guid) && pendingLocations.has(guid);

    return {
      key: `ast:${row.GUID}`,
      kind: 'asset',
      name: row.Name || 'Activo sin nombre',
      origin: row.typeTitle || 'Activo',
      descriptors: parseEntityDescriptors(row.JSONTitle, row.jsonValues),
      isNew: !row.AssetID,

      updated: row.UpdatedOn || row.CreatedOn || '',
      updatedLabel: when(row.UpdatedOn || row.CreatedOn),

      waiting: held ? 'Espera a que suba su ubicación.' : '',

      // La ficha del activo cuelga de su sede, también en la dirección.
      link: guid ? ['/ubicaciones', guid, 'activo', row.GUID] : null,
    };
  }

  private itemCard(
    row: ListDetail,
    byList: ReadonlyMap<string, ListDefinition>,
    pendingItems: ReadonlySet<string>,
  ): EntityCard {
    const parent = String(row.ParentGUID ?? '');
    const held = Boolean(parent) && pendingItems.has(parent);

    return {
      key: `itm:${row.GUID}`,
      kind: 'item',
      name: row.Name || 'Ítem sin nombre',
      origin: byList.get(String(row.ListIDBD ?? ''))?.Name || 'Ítem de lista',
      descriptors: parseEntityDescriptors(row.JSONTilte, row.jsonValues),

      // Un ítem se referencia por su GUID: no hay identificador que mirar, así
      // que todo lo que está aquí es nuevo o recién modificado.
      isNew: true,

      updated: row.UpdatedOn || row.CreatedOn || '',
      updatedLabel: when(row.UpdatedOn || row.CreatedOn),

      waiting: held ? 'Espera al ítem del que cuelga.' : '',

      /**
       * Un ítem de lista no tiene pantalla propia.
       *
       * Vive dentro del selector del campo que lo usa, y no hay ninguna
       * dirección que lleve ahí. Enlazar a un sitio aproximado sería peor que
       * no enlazar: se pulsa esperando ver el ítem y se aterriza en otra cosa.
       */
      link: null,
    };
  }

  iconOf(kind: Kind): string {
    if (kind === 'location') return 'map-pin';
    return kind === 'asset' ? 'box' : 'clipboard';
  }

  labelOf(kind: Kind): string {
    if (kind === 'location') return 'Ubicación';
    return kind === 'asset' ? 'Activo' : 'Ítem de lista';
  }
}

/** Cuándo se tocó por última vez, en palabras. */
function when(raw: string | undefined): string {
  const date = raw ? new Date(raw) : null;
  if (!date || Number.isNaN(date.getTime())) return '';

  const minutes = Math.floor((Date.now() - date.getTime()) / 60000);

  if (minutes < 1) return 'hace un momento';
  if (minutes < 60) return `hace ${minutes} min`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;

  const days = Math.floor(hours / 24);
  if (days === 1) return 'ayer';
  if (days < 30) return `hace ${days} días`;

  return date.toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' });
}
