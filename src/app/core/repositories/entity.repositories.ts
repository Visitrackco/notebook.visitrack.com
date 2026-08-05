import { Injectable } from '@angular/core';

import {
  Asset,
  DispatchStatus,
  Division,
  EntityType,
  Group,
  Item,
  ItemType,
  ListDefinition,
  ListDetail,
  LocationForm,
  RolePermission,
  Survey,
  WorkZone,
} from '../models/entities.model';
import { BaseRepository } from './base.repository';

/**
 * Repositorios de las entidades de negocio.
 *
 * Van juntos en un archivo porque son variaciones del mismo patrón: filtrar por
 * usuario y descartar lo eliminado. Cuando alguno crezca con lógica propia
 * —como pasará con `SurveyAnswerRepository` al llegar los formularios— conviene
 * sacarlo a su propio archivo.
 *
 * ## Nota sobre el borrado lógico
 *
 * Los registros eliminados en el servidor no se borran localmente: se marcan.
 * Y el campo NO es consistente entre entidades — unas usan `IsDeleted` numérico
 * y otras `isDeleted` como texto ('0'/'1'), porque así llegan del backend. Cada
 * repositorio sabe cuál le toca, y por eso conviene que nadie filtre por su
 * cuenta desde fuera.
 */

@Injectable({ providedIn: 'root' })
export class WorkZoneRepository extends BaseRepository<WorkZone> {
  protected readonly storeName = 'WorkZones';

  /** Zonas activas del usuario, alfabéticas. */
  async findByUser(userId: number): Promise<WorkZone[]> {
    const zones = await this.query({
      index: 'byUserID',
      range: userId,
      filter: (z) => z.IsDeleted !== 1,
    });
    return zones.sort((a, b) => a.Name.localeCompare(b.Name));
  }
}

@Injectable({ providedIn: 'root' })
export class LocationRepository extends BaseRepository<LocationForm> {
  protected readonly storeName = 'LocationsForms';

  /** Ubicaciones activas del usuario. */
  async findByUser(userId: number): Promise<LocationForm[]> {
    return this.query({
      index: 'byUserID',
      range: userId,
      filter: (l) => l.isDeleted !== '1',
    });
  }

  /** Una ubicación por su identificador de servidor, con respaldo por GUID. */
  async findByLocationId(userId: number, locationId: string): Promise<LocationForm | null> {
    if (!locationId) return null;

    // Las ubicaciones creadas en el cliente todavía no tienen `LocationID` del
    // servidor y guardan su GUID en su lugar; por eso el segundo intento.
    const found = await this.query({
      index: 'byUserID',
      range: userId,
      filter: (l) => String(l.LocationID) === String(locationId) || l.GUID === locationId,
      limit: 1,
    });
    return found[0] ?? null;
  }

  /** Ubicaciones de una zona concreta. */
  async findByWorkZone(userId: number, workZoneId: string): Promise<LocationForm[]> {
    return this.query({
      index: 'byUserID',
      range: userId,
      filter: (l) => l.isDeleted !== '1' && l.WorkZoneID === workZoneId,
    });
  }

  /**
   * Creadas en el cliente que aún no llegaron al servidor.
   *
   * Se apoya en `SyncedToServer` y no en `Upload`: el primero nunca se revierte
   * a '0' una vez confirmado, así que no puede reenviar algo ya subido.
   */
  async findPendingUpload(userId: number): Promise<LocationForm[]> {
    return this.query({
      index: 'byUserID',
      range: userId,
      filter: (l) => l.CreateWithMovil === '1' && l.SyncedToServer !== '1',
    });
  }

  /**
   * Ubicaciones de un tipo concreto, alfabéticas y paginadas.
   *
   * Es la consulta del selector que aparece antes de abrir un formulario. Va
   * paginada porque un cliente con veinte mil sedes no puede pintarlas todas de
   * golpe, y ordenada por nombre porque el usuario busca visualmente antes de
   * escribir en el buscador.
   *
   * El orden se aplica **después** de traer la página: IndexedDB solo puede
   * ordenar por el índice que se recorre, y aquí se recorre por tipo.
   */
  async findByType(
    userId: number,
    locationTypeGuid: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<LocationForm[]> {
    const items = await this.query({
      index: 'byLocationTypeGUID',
      range: locationTypeGuid,
      filter: (l) => l.isDeleted !== '1' && Number(l.UserID) === Number(userId),
    });

    items.sort((a, b) => (a.Name ?? '').localeCompare(b.Name ?? '', 'es', { sensitivity: 'base' }));

    const offset = options.offset ?? 0;
    return options.limit === undefined
      ? items.slice(offset)
      : items.slice(offset, offset + options.limit);
  }

  /** Cuántas ubicaciones hay de un tipo. */
  async countByType(userId: number, locationTypeGuid: string): Promise<number> {
    return this.count({
      index: 'byLocationTypeGUID',
      range: locationTypeGuid,
      filter: (l) => l.isDeleted !== '1' && Number(l.UserID) === Number(userId),
    });
  }

  /** Busca por nombre, dirección o etiqueta. Sin distinguir mayúsculas. */
  async search(userId: number, term: string): Promise<LocationForm[]> {
    const needle = term.trim().toLowerCase();
    if (!needle) return this.findByUser(userId);

    return this.query({
      index: 'byUserID',
      range: userId,
      filter: (l) =>
        l.isDeleted !== '1' &&
        (l.Name?.toLowerCase().includes(needle) ||
          l.FullAddress?.toLowerCase().includes(needle) ||
          l.TagUID?.toLowerCase().includes(needle)),
    });
  }
}

@Injectable({ providedIn: 'root' })
export class AssetRepository extends BaseRepository<Asset> {
  protected readonly storeName = 'Assets';

  async findByUser(userId: number): Promise<Asset[]> {
    return this.query({
      index: 'byUserID',
      range: userId,
      filter: (a) => a.isDeleted !== '1',
    });
  }

  /** Activos que cuelgan de una ubicación. */
  async findByLocation(userId: number, locationId: number): Promise<Asset[]> {
    return this.query({
      index: 'byUserID',
      range: userId,
      filter: (a) => a.isDeleted !== '1' && Number(a.LocationID) === Number(locationId),
    });
  }

  /**
   * Activos de un tipo que además cuelgan de una ubicación.
   *
   * Las dos condiciones van juntas a propósito: el selector de activo aparece
   * *después* del de ubicación, y ofrecer allí activos de otra sede sería
   * ofrecer respuestas equivocadas. Si la ubicación viene vacía no se filtra
   * por ella — así el flujo sigue funcionando en formularios que piden activo
   * sin pedir ubicación.
   */
  async findByTypeAndLocation(
    userId: number,
    assetTypeGuid: string,
    locationId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<Asset[]> {
    const items = await this.query({
      index: 'byAssetTypeGUID',
      range: assetTypeGuid,
      filter: (a) =>
        a.isDeleted !== '1' &&
        Number(a.UserID) === Number(userId) &&
        (!locationId || String(a.LocationID) === String(locationId)),
    });

    items.sort((a, b) => (a.Name ?? '').localeCompare(b.Name ?? '', 'es', { sensitivity: 'base' }));

    const offset = options.offset ?? 0;
    return options.limit === undefined
      ? items.slice(offset)
      : items.slice(offset, offset + options.limit);
  }

  /** Cuántos activos hay de un tipo en una ubicación. */
  async countByTypeAndLocation(
    userId: number,
    assetTypeGuid: string,
    locationId: string,
  ): Promise<number> {
    return this.count({
      index: 'byAssetTypeGUID',
      range: assetTypeGuid,
      filter: (a) =>
        a.isDeleted !== '1' &&
        Number(a.UserID) === Number(userId) &&
        (!locationId || String(a.LocationID) === String(locationId)),
    });
  }

  /** Un activo por su identificador de servidor, con respaldo por GUID. */
  async findByAssetId(userId: number, assetId: string): Promise<Asset | null> {
    if (!assetId) return null;

    const found = await this.query({
      index: 'byUserID',
      range: userId,
      filter: (a) => String(a.AssetID) === String(assetId) || a.GUID === assetId,
      limit: 1,
    });
    return found[0] ?? null;
  }

  async findPendingUpload(userId: number): Promise<Asset[]> {
    return this.query({
      index: 'byUserID',
      range: userId,
      filter: (a) => a.CreateWithMovil === '1' && a.SyncedToServer !== '1',
    });
  }
}

@Injectable({ providedIn: 'root' })
export class LocationTypeRepository extends BaseRepository<EntityType> {
  protected readonly storeName = 'LocationsTypes';

  async findByUser(userId: number): Promise<EntityType[]> {
    return this.query({ index: 'byUserID', range: userId, filter: (t) => t.IsDeleted !== 1 });
  }

  /**
   * Nombre del tipo, para titular el selector.
   *
   * Un formulario no pide "una ubicación" sino "una sede", "una ruta" o "un
   * cliente" — el nombre del tipo es lo que le dice al usuario qué está
   * eligiendo. Devuelve vacío si no se encuentra, y la pantalla cae a un
   * título genérico.
   */
  async nameOf(guid: string): Promise<string> {
    if (!guid) return '';
    const type = await this.getByIndex('byGUID', guid);
    return type?.Name ?? '';
  }
}

@Injectable({ providedIn: 'root' })
export class AssetTypeRepository extends BaseRepository<EntityType> {
  protected readonly storeName = 'AssetsTypes';

  async findByUser(userId: number): Promise<EntityType[]> {
    return this.query({ index: 'byUserID', range: userId, filter: (t) => t.IsDeleted !== 1 });
  }

  /** Nombre del tipo de activo. Mismo criterio que en las ubicaciones. */
  async nameOf(guid: string): Promise<string> {
    if (!guid) return '';
    const type = await this.getByIndex('byGUID', guid);
    return type?.Name ?? '';
  }
}

@Injectable({ providedIn: 'root' })
export class SurveyRepository extends BaseRepository<Survey> {
  protected readonly storeName = 'Surveys';

  /** Formularios disponibles para el usuario, alfabéticos. */
  async findByUser(userId: number): Promise<Survey[]> {
    const surveys = await this.query({
      index: 'byUserID',
      range: userId,
      filter: (s) => s.IsDeleted !== 1,
    });
    return surveys.sort((a, b) => a.Title.localeCompare(b.Title));
  }

  async findBySurveyId(surveyId: string): Promise<Survey | null> {
    return this.getByIndex('bySurveyID', surveyId);
  }

  async search(userId: number, term: string): Promise<Survey[]> {
    const needle = term.trim().toLowerCase();
    if (!needle) return this.findByUser(userId);

    const surveys = await this.query({
      index: 'byUserID',
      range: userId,
      filter: (s) =>
        s.IsDeleted !== 1 &&
        (s.Title?.toLowerCase().includes(needle) ||
          s.Description?.toLowerCase().includes(needle)),
    });
    return surveys.sort((a, b) => a.Title.localeCompare(b.Title));
  }
}

/**
 * Actividades.
 *
 * Vive en `survey-answer.repository.ts` porque es el único store que se
 * **escribe** desde la interfaz y su lógica no cabe aquí. Se reexporta para que
 * el resto de la aplicación siga pidiéndolo por el mismo sitio que los demás.
 */
export { SurveyAnswerRepository } from './survey-answer.repository';

@Injectable({ providedIn: 'root' })
export class DispatchStatusRepository extends BaseRepository<DispatchStatus> {
  protected readonly storeName = 'DispatchStatus';

  /** Estados habilitados para el cliente. */
  async findByUser(userId: number): Promise<DispatchStatus[]> {
    return this.query({
      index: 'byUserID',
      range: userId,
      filter: (s) => s.IsDeleted !== 1 && s.IsDeviceEnabled === 1,
    });
  }

  async findByDispatchId(dispatchId: number): Promise<DispatchStatus | null> {
    return this.getByIndex('byDispatchID', dispatchId);
  }
}

@Injectable({ providedIn: 'root' })
export class ListRepository extends BaseRepository<ListDefinition> {
  protected readonly storeName = 'Lists';

  async findByUser(userId: number): Promise<ListDefinition[]> {
    const lists = await this.query({
      index: 'byUserID',
      range: userId,
      filter: (l) => l.IsDeleted !== 1,
    });
    return lists.sort((a, b) => a.Name.localeCompare(b.Name));
  }

  /** Listas cuyos ítems el usuario eligió descargar. */
  async findMarkedForSync(userId: number): Promise<ListDefinition[]> {
    return this.query({
      index: 'byUserID',
      range: userId,
      filter: (l) => l.IsDeleted !== 1 && l.IsForSync === 1,
    });
  }
}

@Injectable({ providedIn: 'root' })
export class ListDetailRepository extends BaseRepository<ListDetail> {
  protected readonly storeName = 'ListsDet';

  /**
   * Ítems de una lista.
   *
   * Acepta `limit` porque una lista puede tener decenas de miles de ítems y
   * traerlos todos para pintar un desplegable congelaría la pestaña.
   */
  async findByList(userId: number, listId: string, limit?: number): Promise<ListDetail[]> {
    return this.query({
      index: 'byListID',
      range: listId,
      filter: (d) => d.UserID === userId && d.IsDeleted !== 1,
      limit,
    });
  }

  /** Busca dentro de una lista por nombre o valor. */
  async search(userId: number, listId: string, term: string, limit = 50): Promise<ListDetail[]> {
    const needle = term.trim().toLowerCase();

    return this.query({
      index: 'byListID',
      range: listId,
      filter: (d) =>
        d.UserID === userId &&
        d.IsDeleted !== 1 &&
        (!needle ||
          d.Name?.toLowerCase().includes(needle) ||
          d.Value?.toLowerCase().includes(needle)),
      limit,
    });
  }

  async findPendingUpload(userId: number): Promise<ListDetail[]> {
    return this.query({
      index: 'byUserID',
      range: userId,
      filter: (d) => d.CreateWithMovil === '1' && d.SyncedToServer !== '1',
    });
  }
}

@Injectable({ providedIn: 'root' })
export class ItemTypeRepository extends BaseRepository<ItemType> {
  protected readonly storeName = 'ItemsTypes';

  async findByUser(userId: number): Promise<ItemType[]> {
    return this.query({ index: 'byUserID', range: userId, filter: (t) => t.IsDeleted !== 1 });
  }
}

@Injectable({ providedIn: 'root' })
export class ItemRepository extends BaseRepository<Item> {
  protected readonly storeName = 'Items';

  async findByType(userId: number, itemTypeId: string): Promise<Item[]> {
    return this.query({
      index: 'byUserID',
      range: userId,
      filter: (i) => i.IsDeleted !== 1 && i.ItemTypeID === itemTypeId,
    });
  }
}

@Injectable({ providedIn: 'root' })
export class DivisionRepository extends BaseRepository<Division> {
  protected readonly storeName = 'Divisions';

  async findByUser(userId: number): Promise<Division[]> {
    return this.query({ index: 'byUserID', range: userId });
  }
}

@Injectable({ providedIn: 'root' })
export class GroupRepository extends BaseRepository<Group> {
  protected readonly storeName = 'Groups';

  async findByUser(userId: number): Promise<Group[]> {
    return this.query({ index: 'byUserID', range: userId });
  }
}

/**
 * Permisos del rol.
 *
 * Determina qué entradas del menú ve cada usuario. Ante la duda, `can()`
 * responde `false`: es preferible ocultar una opción de más a mostrarle a
 * alguien algo que no le corresponde.
 */
@Injectable({ providedIn: 'root' })
export class RolePermissionRepository extends BaseRepository<RolePermission> {
  protected readonly storeName = 'RolePermissions';

  async findByUser(userId: string): Promise<RolePermission[]> {
    return this.query({ index: 'byUserID', range: userId });
  }

  /** ¿Tiene el usuario este permiso sobre este módulo? */
  async can(userId: string, moduleKey: string, permissionCode: string): Promise<boolean> {
    return this.exists({
      index: 'byUserID',
      range: userId,
      filter: (p) => p.ModuleKey === moduleKey && p.PermissionCode === permissionCode,
    });
  }

  /** Reemplaza todos los permisos del usuario. Se llama al sincronizar el rol. */
  async replaceForUser(userId: string, permissions: RolePermission[]): Promise<void> {
    await this.deleteWhere({ index: 'byUserID', range: userId });
    if (permissions.length > 0) await this.putMany(permissions);
  }
}
