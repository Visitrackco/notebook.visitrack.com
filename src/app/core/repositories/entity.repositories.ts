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
  UserConfig,
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
   * Creadas **o modificadas** aquí que aún no llegaron al servidor.
   *
   * La marca es `Upload`, que se reinicia en cada guardado. `SyncedToServer`
   * no sirve para esto: no se revierte nunca, así que una sede descargada y
   * luego editada no volvería a subir jamás — el cambio se quedaría en el
   * dispositivo sin que nadie se enterara.
   */
  async findPendingUpload(userId: number): Promise<LocationForm[]> {
    return this.query({
      index: 'byUserID',
      range: userId,
      filter: (l) => l.CreateWithMovil === '1' && l.Upload !== '1',
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

  /**
   * Ubicaciones cuyo **tipo** coincide con este GUID.
   *
   * Distinta de [findByType], y la diferencia importa: por el cruce de nombres
   * que documenta `entity-mappers`, la columna `LocationTypeGUID` guarda el
   * `LocationTypeID` —un número— y es `LocationTypeGD` la que guarda el GUID.
   *
   * Un desplegable de ubicaciones apunta al tipo por su GUID, así que buscar
   * por el índice devolvía siempre vacío. Se aceptan los dos campos porque los
   * formularios antiguos usan el identificador numérico.
   */
  async findByTypeGuid(userId: number, typeGuid: string): Promise<LocationForm[]> {
    if (!typeGuid) return [];

    const needle = String(typeGuid).trim();
    const matches = (l: LocationForm) =>
      l.isDeleted !== '1' &&
      (String(l.LocationTypeGD) === needle || String(l.LocationTypeGUID) === needle);

    const own = await this.query({ index: 'byUserID', range: userId, filter: matches });
    if (own.length > 0) return sortByName(own);

    // Mismo respaldo que en los activos: el catálogo puede estar bajo otra
    // cuenta. Ver `AssetRepository.findByTypeGuid`.
    return sortByName(await this.query({ filter: matches }));
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
  /**
   * Activos de una sede, por su identificador o por su GUID.
   *
   * El GUID no es un lujo: un activo creado bajo una ubicación que también se
   * dio de alta aquí tiene `LocationID` en cero —el identificador lo asigna
   * Visitrack y todavía no existe— y solo se le puede reconocer por
   * `LocationGUID`. Sin esto, esos activos son invisibles: no salen en la ficha
   * de su sede ni en el selector del formulario, y el usuario acaba creando el
   * mismo equipo dos veces.
   */
  async findByLocationGuid(userId: number, locationId: number, locationGuid: string): Promise<Asset[]> {
    return this.query({
      index: 'byUserID',
      range: userId,
      filter: (a) =>
        a.isDeleted !== '1' &&
        ((locationId > 0 && Number(a.LocationID) === locationId) ||
          (Boolean(locationGuid) && String(a.LocationGUID ?? '') === locationGuid)),
    });
  }

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
    options: { limit?: number; offset?: number; locationGuid?: string } = {},
  ): Promise<Asset[]> {
    const items = await this.query({
      index: 'byAssetTypeGUID',
      range: assetTypeGuid,
      filter: (a) =>
        a.isDeleted !== '1' &&
        Number(a.UserID) === Number(userId) &&
        belongsToLocation(a, locationId, options.locationGuid),
    });

    items.sort((a, b) => (a.Name ?? '').localeCompare(b.Name ?? '', 'es', { sensitivity: 'base' }));

    const offset = options.offset ?? 0;
    return options.limit === undefined
      ? items.slice(offset)
      : items.slice(offset, offset + options.limit);
  }

  /**
   * Activos cuyo **tipo** coincide con este GUID.
   *
   * Mismo cruce de nombres que en las ubicaciones: `AssetTypeGUID` guarda el
   * `AssetTypeID` y `AssetTypeGD` el GUID. Ver `LocationRepository.findByTypeGuid`.
   */
  async findByTypeGuid(
    userId: number,
    typeGuid: string,
    /**
     * Tope de registros.
     *
     * Se aplica **solo cuando no hay búsqueda**: al buscar hay que recorrerlos
     * todos, porque lo que se escribe puede coincidir con el último de veinte
     * mil. Sin búsqueda basta con la primera página, y traer el resto es cargar
     * memoria para enseñar cincuenta.
     */
    limit?: number,
  ): Promise<Asset[]> {
    if (!typeGuid) return [];

    const needle = String(typeGuid).trim();
    const matches = (a: Asset) =>
      a.isDeleted !== '1' &&
      (String(a.AssetTypeGD) === needle || String(a.AssetTypeGUID) === needle);

    // Primero por el índice de usuario, que es el camino rápido.
    const own = await this.query({ index: 'byUserID', range: userId, filter: matches, limit });
    if (own.length > 0) return sortByName(own);

    /**
     * Sin resultados, se recorre el almacén entero.
     *
     * El `UserID` no siempre casa con el que se busca: las compañías con
     * catálogo compartido guardan los activos bajo otra cuenta, y el índice los
     * deja fuera. Descartarlos por eso deja el desplegable vacío teniendo los
     * activos descargados — que es justo lo que hay que evitar.
     */
    return sortByName(await this.query({ filter: matches, limit }));
  }

  /** Cuántos activos hay de un tipo en una ubicación. */
  async countByTypeAndLocation(
    userId: number,
    assetTypeGuid: string,
    locationId: string,
    locationGuid?: string,
  ): Promise<number> {
    return this.count({
      index: 'byAssetTypeGUID',
      range: assetTypeGuid,
      filter: (a) =>
        a.isDeleted !== '1' &&
        Number(a.UserID) === Number(userId) &&
        belongsToLocation(a, locationId, locationGuid),
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

  /** Creados o modificados aquí, sin subir. Ver `LocationRepository`. */
  async findPendingUpload(userId: number): Promise<Asset[]> {
    return this.query({
      index: 'byUserID',
      range: userId,
      filter: (a) => a.CreateWithMovil === '1' && a.Upload !== '1',
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

  /**
   * Estados de despacho de la cuenta.
   *
   * **Sin filtrar por `IsDeviceEnabled`.** Se filtraba, y por eso faltaban
   * estados en el selector: la app no lo mira —su consulta es un `SELECT *` a
   * secas— así que el navegador ofrecía menos opciones que el teléfono para la
   * misma actividad. Quien configuró un estado en la plataforma esperaba
   * poder ponerlo desde los dos sitios.
   *
   * Lo borrado sí se excluye: un estado que ya no existe no se puede elegir.
   * Y qué estados admite cada formulario lo decide su `JSONStatuses`, que se
   * aplica después — ese es el filtro que de verdad corresponde.
   */
  async findByUser(userId: number): Promise<DispatchStatus[]> {
    return this.query({
      index: 'byUserID',
      range: userId,
      filter: (s) => s.IsDeleted !== 1,
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

  /**
   * La definición de la lista a la que apunta un campo del formulario.
   *
   * ## Por qué no basta con buscar por GUID
   *
   * El campo guarda en `lst` el **GUID** de la lista, y así lo consulta la app.
   * Pero no todos los formularios lo hacen igual: los hay que guardan el
   * `ListID`, y con el diseñador de Visitrack cambiando a lo largo de los años
   * conviven las dos formas en producción.
   *
   * Buscando solo por GUID, esos campos daban «la lista no está sincronizada»
   * teniéndola descargada — que es el peor mensaje posible, porque manda al
   * usuario a resincronizar algo que ya está bien.
   *
   * Se prueban los tres identificadores. `Lists` tiene decenas de filas, no
   * miles, así que recorrerlas cuesta nada.
   *
   * ## Y por qué el usuario no filtra
   *
   * Se prefiere la lista del usuario, pero si solo aparece bajo otro —el caso
   * de las compañías con catálogo compartido— se devuelve igual. Descartarla
   * por eso deja al usuario sin poder responder un campo cuyos datos sí están
   * en el dispositivo.
   */
  async findForField(userId: number, key: string): Promise<ListDefinition | null> {
    if (!key) return null;

    const needle = String(key).trim();
    const all = await this.query({ filter: (l) => l.IsDeleted !== 1 });

    const matches = all.filter(
      (list) =>
        String(list.GUID) === needle ||
        String(list.ListIDBD) === needle ||
        String(list.ID) === needle,
    );

    if (matches.length === 0) return null;

    return matches.find((list) => Number(list.UserID) === Number(userId)) ?? matches[0];
  }

  /** Una lista por su `ListIDBD`, para resolver la lista hija. */
  async findByListIdBd(userId: number, listIdBd: string): Promise<ListDefinition | null> {
    if (!listIdBd) return null;

    const all = await this.findByUser(userId);
    return all.find((list) => String(list.ListIDBD) === String(listIdBd)) ?? null;
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
      filter: (d) => sameUser(d.UserID, userId) && d.IsDeleted !== 1,
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
        sameUser(d.UserID, userId) &&
        d.IsDeleted !== 1 &&
        (!needle ||
          d.Name?.toLowerCase().includes(needle) ||
          d.Value?.toLowerCase().includes(needle)),
      limit,
    });
  }

  /** Creados o modificados aquí, sin subir. Ver `LocationRepository`. */
  async findPendingUpload(userId: number): Promise<ListDetail[]> {
    return this.query({
      index: 'byUserID',
      range: userId,
      filter: (d) => d.CreateWithMovil === '1' && d.Upload !== '1',
    });
  }

  /**
   * Ítems hijos de otro ítem.
   *
   * Es el encadenado más común: elegir un departamento arriba deja abajo solo
   * sus ciudades. Va sin `ListID` a propósito, igual que en la app — el padre
   * ya identifica de forma única a sus hijos.
   */
  async findByParent(userId: number, parentGuid: string): Promise<ListDetail[]> {
    return this.query({
      index: 'byParentGUID',
      range: parentGuid,
      filter: (d) => sameUser(d.UserID, userId) && d.IsDeleted !== 1,
    });
  }

  /** Ítems de una lista que además cuelgan de un ítem concreto. */
  async findByParentInList(
    userId: number,
    parentGuid: string,
    listId: string,
  ): Promise<ListDetail[]> {
    return this.query({
      index: 'byParentGUID',
      range: parentGuid,
      filter: (d) =>
        sameUser(d.UserID, userId) && d.IsDeleted !== 1 && String(d.ListID) === String(listId),
    });
  }

  /**
   * Ítems asociados a una ubicación.
   *
   * Los usa una lista marcada con `hasLocations`: sus ítems pertenecen a la
   * ubicación de la actividad, no al catálogo entero. Es lo que hace que en una
   * sede solo aparezcan sus propios equipos.
   */
  async findByLocation(userId: number, locationId: string): Promise<ListDetail[]> {
    return this.query({
      index: 'byUserID',
      range: userId,
      filter: (d) => d.IsDeleted !== 1 && String(d.LocationID) === String(locationId),
    });
  }

  /** Ítems de una lista asociados a un activo. */
  async findByAsset(userId: number, assetId: string, listId: string): Promise<ListDetail[]> {
    return this.query({
      index: 'byListID',
      range: listId,
      filter: (d) =>
        sameUser(d.UserID, userId) && d.IsDeleted !== 1 && String(d.AssetID) === String(assetId),
    });
  }

  /**
   * Ítems de una lista que pertenecen al usuario de la sesión.
   *
   * Una lista marcada con `hasUsers` guarda en `ListDetGUID` a quién pertenece
   * cada ítem. Sin este filtro, cada persona vería los registros de las demás.
   */
  async findByOwner(userId: number, listId: string, ownerId: string): Promise<ListDetail[]> {
    return this.query({
      index: 'byListID',
      range: listId,
      filter: (d) =>
        sameUser(d.UserID, userId) && d.IsDeleted !== 1 && String(d.ListDetGUID) === String(ownerId),
    });
  }
}

@Injectable({ providedIn: 'root' })
export class ItemTypeRepository extends BaseRepository<ItemType> {
  protected readonly storeName = 'ItemsTypes';

  async findByUser(userId: number): Promise<ItemType[]> {
    return this.query({ index: 'byUserID', range: userId, filter: (t) => t.IsDeleted !== 1 });
  }

  /**
   * El tipo de ítem al que apunta un campo de inventario.
   *
   * Acepta el GUID o el identificador por el mismo motivo que las listas: los
   * formularios conviven con las dos formas. Ver `ListRepository.findForField`.
   */
  async findForField(userId: number, key: string): Promise<ItemType | null> {
    if (!key) return null;

    const needle = String(key).trim();
    const all = await this.query({ filter: (t) => t.IsDeleted !== 1 });

    const matches = all.filter(
      (type) =>
        String(type.GUID) === needle ||
        String(type.ListIDBD) === needle ||
        String(type.ID) === needle,
    );

    if (matches.length === 0) return null;

    return matches.find((type) => Number(type.UserID) === Number(userId)) ?? matches[0];
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
/**
 * La configuración por usuario que entrega el servidor.
 *
 * Es una lista de módulos con un interruptor cada uno, y hoy solo la consulta
 * una compañía. Se guarda como el JSON crudo tal cual llega, igual que en la
 * app: darle forma aquí obligaría a mantener un modelo por cada módulo que
 * alguien añada del otro lado.
 */
@Injectable({ providedIn: 'root' })
export class UserConfigRepository extends BaseRepository<UserConfig> {
  protected readonly storeName = 'configUser';

  async findByUser(userId: number): Promise<UserConfig | null> {
    const found = await this.query({ index: 'byUserID', range: userId, limit: 1 });
    return found[0] ?? null;
  }

  /**
   * ¿Está activo este módulo para el usuario?
   *
   * Sin configuración descargada devuelve `null`, que **no** es lo mismo que
   * «no»: quien pregunta decide qué hacer con la duda. Confundir «no lo sé» con
   * «no puedes» dejaría sin trabajar a quien todavía no ha sincronizado.
   */
  async isModuleActive(userId: number, moduleName: string): Promise<boolean | null> {
    const record = await this.findByUser(userId);
    if (!record?.config) return null;

    try {
      const modules = JSON.parse(record.config) as { modulo?: string; active?: unknown }[];
      if (!Array.isArray(modules)) return null;

      const needle = moduleName.trim().toUpperCase();
      const found = modules.find(
        (module) => String(module?.modulo ?? '').trim().toUpperCase() === needle,
      );

      return found ? Boolean(found.active) : null;
    } catch {
      return null;
    }
  }
}

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

/**
 * ¿Estos dos identificadores de usuario son el mismo?
 *
 * El `UserID` llega del backend unas veces como número y otras como texto, y
 * dentro de una misma tabla pueden convivir las dos formas: las filas bajadas
 * del servidor y las creadas en el cliente no pasan por el mismo camino.
 *
 * Comparándolos con `===`, un `'771295'` y un `771295` son distintos, y el
 * filtro descarta silenciosamente registros que sí son del usuario — que es
 * como una lista descargada acaba pareciendo vacía.
 */
function sameUser(a: unknown, b: unknown): boolean {
  return String(a ?? '') === String(b ?? '');
}

/** Ordena por nombre en español, sin distinguir tildes ni mayúsculas. */
function sortByName<T extends { Name?: string }>(items: T[]): T[] {
  return items.sort((a, b) =>
    (a.Name ?? '').localeCompare(b.Name ?? '', 'es', { sensitivity: 'base' }),
  );
}

/**
 * ¿Este activo pertenece a esa ubicación?
 *
 * Se acepta el identificador de Visitrack **o** el GUID. Un activo creado bajo
 * una sede que también nació en este dispositivo no tiene lo primero: el
 * identificador lo asigna el servidor al subir. Comprobar solo por `LocationID`
 * lo dejaba fuera de su propia sede.
 */
function belongsToLocation(asset: Asset, locationId: string, locationGuid?: string): boolean {
  if (!locationId && !locationGuid) return true;

  if (locationId && String(asset.LocationID) === String(locationId)) return true;

  return Boolean(locationGuid) && String(asset.LocationGUID ?? '') === String(locationGuid);
}
