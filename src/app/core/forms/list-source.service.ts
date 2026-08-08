import { Injectable, inject } from '@angular/core';

import { resolveCatalogOwnerId } from '../config/company-rules';
import { Asset, ItemType, ListDefinition, ListDetail, LocationForm } from '../models/entities.model';
import {
  AssetRepository,
  ItemRepository,
  ItemTypeRepository,
  ListDetailRepository,
  ListRepository,
  LocationRepository,
} from '../repositories/entity.repositories';
import { SurveyAnswerRepository } from '../repositories/survey-answer.repository';
import { AuthService } from '../services/auth.service';
import { ConnectivityService } from '../services/connectivity.service';
import { DescriptorConfig, FormField, ResolvedDescriptor } from './form-schema';
import { ListSearchApi, ListSearchQuery } from './list-search.api';

/** Una opción del desplegable, ya lista para pintar. */
export interface ListChoice {
  /** GUID del ítem. */
  id: string;
  /** Lo que se ve. */
  txt: string;

  /**
   * Lo que se guarda con la respuesta.
   *
   * Sale de `des` en el **campo**, y solo las entradas marcadas. Es lo que el
   * formulario decidió que hay que dejar registrado del ítem elegido.
   */
  des: ResolvedDescriptor[];

  /**
   * Lo que se enseña en la fila del selector.
   *
   * Sale de `jsonDescriptors` en la **lista**, y son todos. Es lo que
   * distingue dos ítems que se llaman parecido en el momento de elegir, y no
   * tiene por qué coincidir con lo que se guarda: una lista puede mostrar el
   * código y la ciudad para ayudar a escoger, y el formulario querer registrar
   * solo el código.
   *
   * La app hace exactamente esta separación.
   */
  preview: ResolvedDescriptor[];

  /**
   * De dónde salió el ítem.
   *
   * Un desplegable no lo necesita: le basta el identificador y el texto. Lo
   * necesita el MasterDetail, porque una fila guarda el registro completo del
   * ítem y de qué era —una ubicación, un activo, un ítem de una lista—, y el
   * backend lee esos campos para saber a qué se está refiriendo la fila.
   */
  src?: ChoiceSource;
}

/** Procedencia de un ítem elegido. Los nombres son los que escribe la app. */
export interface ChoiceSource {
  /** El registro tal cual, para `itemsInfo` / `LocationInfo` / `AssetInfo`. */
  item?: unknown;
  /** Lista a la que pertenece el ítem, no la del campo. */
  lst?: string;
  /** Entidad de la que salió: 0 lista, 1 ubicación, 12 activo, 14 ítem. */
  ent?: number;
  /** El ítem **es** una ubicación. */
  loc?: boolean;
  /** El ítem **es** un activo. */
  ass?: boolean;
}

/**
 * Lo que el árbol de orígenes necesita saber de un campo.
 *
 * No es un [FormField] entero porque el MasterDetail también lo recorre, y sus
 * filas no salen de un campo sino de la **lista** configurada en él. Con esta
 * forma mínima, las dos entradas comparten implementación en vez de tener cada
 * una su copia del árbol.
 */
export interface FieldRef {
  id: string;
  lab: string;
  /** Descriptivos que se guardan con la respuesta. */
  des?: DescriptorConfig[];
  /** Campo del que depende, si lo hay. */
  parentId?: string;
  ent?: string | number;
  lst?: string | number;
}

/** De dónde salieron los ítems, para explicárselo al usuario. */
export type ListOrigin =
  /** Opciones escritas en el propio formulario. */
  | 'static'
  /** Descargados en este dispositivo. */
  | 'local'
  /** Consultados al servidor en el momento. */
  | 'online'
  /** No hay de dónde sacarlos. */
  | 'none';

export interface ListSource {
  origin: ListOrigin;
  choices: ListChoice[];
  /** Explicación cuando no hay nada que elegir. */
  message: string;
  /** true si el conjunto puede estar recortado por el tope. */
  truncated: boolean;
}

/**
 * Tope de ítems.
 *
 * Cincuenta, el mismo de la app. Una lista de Visitrack llega a decenas de
 * miles de registros: pintarlos todos congela la pestaña, y nadie recorre
 * veinte mil filas con el dedo — se busca.
 */
const PAGE = 50;

/**
 * Cualquier registro del que se puedan sacar descriptivos.
 *
 * Un ítem de lista y un activo se describen igual —un nombre y un `jsonValues`
 * con sus campos— aunque vengan de tablas distintas. Con esta forma mínima, la
 * extracción y la búsqueda por descriptivos sirven para los dos sin duplicar
 * nada.
 */
interface Describable {
  Name?: string;
  jsonValues?: string;
}

/**
 * Entidades de las que puede salir un desplegable.
 *
 * Son los valores de `ent` que usa el diseñador de formularios. Están escritos
 * como los interpreta la app, no como cabría suponer: `10` son usuarios y `14`
 * inventario, sin relación con `1` y `12`.
 */
const ENTITY = {
  LIST: 0,
  LOCATIONS: 1,
  USERS: 10,
  ASSETS: 12,
  ITEMS: 14,
} as const;

/**
 * De dónde salen las opciones de un desplegable.
 *
 * ## El árbol completo
 *
 * Un `dropdownlist` puede alimentarse de seis sitios distintos, y cuál de ellos
 * depende de tres cosas encadenadas:
 *
 * 1. **`ent`** — la entidad. `0` es una lista de Visitrack; `1` ubicaciones,
 *    `12` activos, `10` usuarios y `14` ítems de inventario.
 * 2. **`IsForSync`** de la lista — si el usuario descargó sus ítems. Con `0`
 *    los ítems **no están en el dispositivo** y hay que preguntarle al
 *    servidor; con `1` se leen de la base local.
 * 3. **Los indicadores de la lista** — `hasLocations`, `hasAssets`, `hasUsers`,
 *    `hasParent` y `ListID` deciden por qué se filtra: la ubicación de la
 *    actividad, su activo, el usuario de la sesión, o el ítem elegido en otro
 *    campo.
 *
 * Ese orden importa y es el de la app. Saltárselo produce desplegables que
 * muestran el catálogo entero donde deberían mostrar tres opciones —o al revés,
 * vacíos donde sí había datos.
 *
 * ## Por qué el filtro se resuelve aquí y no en la consulta
 *
 * Las consultas locales y las remotas reciben **los mismos criterios**, y solo
 * cambia quién los ejecuta. Resolver el filtro una vez y despacharlo a un lado
 * o al otro evita mantener dos versiones del mismo árbol de decisión, que es
 * exactamente donde divergen las implementaciones con el tiempo.
 */
@Injectable({ providedIn: 'root' })
export class ListSourceService {
  private readonly lists = inject(ListRepository);
  private readonly details = inject(ListDetailRepository);
  private readonly locations = inject(LocationRepository);
  private readonly assets = inject(AssetRepository);
  private readonly items = inject(ItemRepository);
  private readonly itemTypes = inject(ItemTypeRepository);
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly api = inject(ListSearchApi);
  private readonly auth = inject(AuthService);
  private readonly connectivity = inject(ConnectivityService);

  /**
   * Resuelve las opciones de un campo.
   *
   * @param answerGuid actividad abierta, de la que salen la ubicación y el
   *   activo con los que se filtran algunas listas.
   * @param parentValue GUID elegido en el campo del que depende, si lo hay.
   */
  async resolve(
    field: FormField,
    options: { answerGuid?: string; parentValue?: string; search?: string } = {},
  ): Promise<ListSource> {
    const search = (options.search ?? '').trim();

    // Las opciones escritas en el formulario no dependen de nada más.
    if (field.opt && field.opt.length > 0) {
      const needle = search.toLowerCase();

      return {
        origin: 'static',
        truncated: false,
        message: '',
        choices: field.opt
          .filter((option) => !needle || option.txt.toLowerCase().includes(needle))
          .map((option) => ({ id: option.id, txt: option.txt, des: [], preview: [] })),
      };
    }

    const user = this.auth.currentUser();
    if (!user) return none('No hay una sesión activa.');

    const ownerId = resolveCatalogOwnerId(user);
    const entity = Number(field.ent ?? 0);
    const guid = String(field.lst ?? '').trim();

    switch (entity) {
      case ENTITY.LOCATIONS:
        return this.fromLocations(ownerId, guid, search);

      case ENTITY.ASSETS:
        return this.fromAssets(ownerId, guid, search);

      case ENTITY.USERS:
        // Los usuarios siempre se consultan al servidor: no se descargan.
        return this.fromServer(field, { ...options, search }, null, { users: true });

      case ENTITY.ITEMS:
        return this.fromItems(field, ownerId, guid, { ...options, search });

      case ENTITY.LIST:
        return this.fromList(field, ownerId, guid, { ...options, search });

      default:
        return none(
          'Este campo toma sus opciones de un origen que la aplicación no reconoce. ' +
            'Revisa la configuración del formulario.',
        );
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Listas de Visitrack
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * El caso principal: una lista con su configuración.
   *
   * Se lee la definición, se decide por qué filtrar y luego se despacha a la
   * base local o al servidor según la lista esté descargada o no.
   */
  private async fromList(
    field: FieldRef,
    ownerId: number,
    guid: string,
    options: { answerGuid?: string; parentValue?: string; search: string },
  ): Promise<ListSource> {
    if (!guid) {
      return none('El formulario no indica de qué lista salen las opciones de este campo.');
    }

    const definition = await this.lists.findForField(ownerId, guid);

    if (!definition) {
      // Se deja rastro con lo que se buscó y lo que hay: si un formulario
      // apunta a una lista con un identificador que no coincide con ninguno,
      // esto es lo único que permite verlo sin abrir la base a mano.
      const available = await this.lists.findByUser(ownerId);

      console.warn(
        `[Listas] el campo «${field.lab}» apunta a «${guid}» y no coincide con ninguna ` +
          `de las ${available.length} listas del usuario ${ownerId}.`,
        available.map((list) => ({ GUID: list.GUID, ListIDBD: list.ListIDBD, Name: list.Name })),
      );

      // Solo cuando de verdad no está la definición. Que la lista exista pero
      // no tenga ítems descargados es otra cosa —y se resuelve consultando al
      // servidor—, así que no puede compartir mensaje con esto.
      return none(
        'La definición de esta lista no está en el dispositivo. ' +
          'Descarga las listas desde Sincronización.',
      );
    }

    const filter = await this.buildFilter(field, definition, ownerId, options);

    // Cuántos ítems hay de esta lista en el dispositivo, sin filtrar. Es el
    // dato que distingue «la lista no bajó» de «el filtro no encontró nada»,
    // que es la confusión que hace perder más tiempo.
    const stored = await this.details.findByList(
      ownerId,
      String(definition.ListIDBD ?? ''),
    );

    const isLocal = Number(definition.IsForSync) === 1;

    trace(field, {
      buscado: guid,
      usuario: ownerId,
      lista: {
        Name: definition.Name,
        GUID: definition.GUID,
        ListIDBD: definition.ListIDBD,
        ListID: definition.ListID,
        IsForSync: definition.IsForSync,
        hasLocations: definition.hasLocations,
        hasAssets: definition.hasAssets,
        hasUsers: definition.hasUsers,
        hasParent: definition.hasParent,
      },
      modo: isLocal ? 'local (ListsDet)' : 'en línea (/searchList)',
      filtro: filter,
      itemsEnDispositivo: stored.length,
    });

    if (filter.blocked) return none(filter.blocked);

    /**
     * `IsForSync` decide de dónde salen los ítems.
     *
     * Con `1` el usuario marcó la lista para descarga y sus ítems están en
     * `ListsDet`; con `0` no están, y hay que preguntarle al servidor. Es el
     * mismo interruptor que usa la app.
     *
     * Se compara con `Number` porque llega indistintamente como `1` o `"1"`
     * según el camino por el que entró la fila.
     */
    if (isLocal) {
      return this.fromLocalList(field, definition, ownerId, filter, options.search);
    }

    const remote = await this.fromServer(field, options, definition, filter);
    if (remote.origin === 'online') return remote;

    /**
     * El servidor no respondió. Antes de rendirse se mira si hay ítems
     * descargados igualmente.
     *
     * Pasa cuando una lista estuvo marcada para descarga y luego se desmarcó:
     * los ítems siguen en el dispositivo. Preferir un error a los datos que ya
     * están ahí deja al usuario sin poder responder por nada.
     */
    const local = await this.fromLocalList(field, definition, ownerId, filter, options.search);
    return local.choices.length > 0 ? local : remote;
  }

  /**
   * Decide por qué se filtra esta lista.
   *
   * Es el árbol de la app, en el mismo orden. Cada rama excluye a las
   * siguientes: una lista ligada a ubicaciones no mira además el campo padre,
   * porque su vínculo con la actividad ya la acota.
   */
  private async buildFilter(
    field: FieldRef,
    definition: ListDefinition,
    ownerId: number,
    options: { answerGuid?: string; parentValue?: string },
  ): Promise<ListFilter> {
    const answer = options.answerGuid
      ? await this.answers.findByGuid(options.answerGuid)
      : null;

    // Ligada a la ubicación de la actividad.
    if (isOn(definition.hasLocations)) {
      const locationId = answer?.LocationID ?? '';

      if (!locationId) {
        return {
          blocked:
            'Esta lista depende de la ubicación de la actividad, y la actividad todavía no tiene una.',
        };
      }

      return { loc: locationId };
    }

    // Ligada al activo de la actividad, salvo que además dependa de otro campo.
    if (isOn(definition.hasAssets)) {
      if (field.parentId) return this.parentFilter(field, options.parentValue);

      const assetId = answer?.AssetID ?? '';

      if (!assetId) {
        return {
          blocked:
            'Esta lista depende del activo de la actividad, y la actividad todavía no tiene uno.',
        };
      }

      return { ass: assetId };
    }

    // Cada usuario ve solo sus propios ítems.
    if (isOn(definition.hasUsers)) {
      return { byusers: true, byuserList: String(definition.ListIDBD ?? '') };
    }

    // Lista hija: sus ítems cuelgan de los de otra lista.
    if (isChildList(definition)) {
      const parent = await this.parentFilter(field, options.parentValue);
      return { ...parent, lsChild: String(definition.ListID) };
    }

    // Lista simple, quizá encadenada a otro campo.
    return this.parentFilter(field, options.parentValue);
  }

  /**
   * Filtro por el campo del que depende, si lo hay.
   *
   * Sin responder el padre no se ofrece nada: enseñar el catálogo entero invita
   * a elegir algo que la siguiente respuesta va a invalidar.
   */
  private parentFilter(field: FieldRef, parentValue?: string): ListFilter {
    if (!field.parentId) return {};

    if (!parentValue) {
      return { blocked: 'Responde primero el campo del que depende esta lista.' };
    }

    return { parentlist: parentValue };
  }

  /** Ítems descargados, filtrados según corresponda. */
  private async fromLocalList(
    field: FieldRef,
    definition: ListDefinition,
    ownerId: number,
    filter: ListFilter,
    search: string,
  ): Promise<ListSource> {
    const listId = String(definition.ListIDBD ?? '');
    let items: ListDetail[];

    /**
     * El orden replica el de `getListDet` en la app.
     *
     * Allí cada comprobación **reemplaza** el resultado de la anterior, así que
     * la última que se cumple es la que manda. Aquí se escribe como una cadena
     * de casos exclusivos, que es lo mismo pero sin consultar de más.
     */
    if (filter.byusers) {
      items = await this.details.findByOwner(ownerId, filter.byuserList ?? listId, String(ownerId));
    } else if (filter.parentlist) {
      items = await this.details.findByParentInList(ownerId, filter.parentlist, listId);
    } else if (filter.ass) {
      items = await this.details.findByAsset(ownerId, filter.ass, listId);
    } else if (filter.loc) {
      items = await this.details.findByLocation(ownerId, filter.loc);
    } else if (filter.parent) {
      items = await this.details.findByParent(ownerId, filter.parent);
    } else {
      /**
       * Sin búsqueda, solo la primera página.
       *
       * Los demás filtros acotan por sí solos —los hijos de un ítem, los de una
       * ubicación— pero la lista entera puede tener veinte mil registros, y
       * traerlos todos para enseñar los primeros cincuenta bloquea la pestaña
       * cada vez que se abre el selector.
       *
       * Con búsqueda sí hay que recorrerlos: lo que se busca puede estar en
       * cualquier posición.
       */
      items = await this.details.findByList(ownerId, listId, search ? undefined : PAGE);
    }

    const matched = this.searchItems(items, search, [
      ...parseListDescriptors(definition.jsonDescriptors),
      ...(field.des ?? []).filter((entry) => entry.isSelected),
    ]);

    console.log(
      `[Listas] «${definition.Name}» local · consulta=${describeQuery(filter)} · ` +
        `traídos=${items.length} · tras buscar «${search}»=${matched.length}`,
    );

    if (matched.length === 0) {
      return {
        origin: 'local',
        choices: [],
        truncated: false,
        // Distinguir las dos cosas importa: que la búsqueda no encuentre nada
        // no es que la lista esté vacía, y el usuario reacciona distinto ante
        // cada una.
        message: search
          ? `Ningún ítem coincide con «${search}».`
          : describeEmptyLocal(definition, filter),
      };
    }

    return {
      origin: 'local',
      truncated: matched.length >= PAGE,
      message: '',
      choices: this.toChoices(field, matched, definition),
    };
  }

  /**
   * Ítems consultados al servidor.
   *
   * Es el camino de las listas que el usuario no descargó. Sin conexión no hay
   * nada que ofrecer, y se dice con la salida concreta: marcarla para descarga.
   */
  private async fromServer(
    field: FieldRef,
    options: { answerGuid?: string; parentValue?: string; search: string },
    definition: ListDefinition | null,
    filter: ListFilter,
  ): Promise<ListSource> {
    const user = this.auth.currentUser();
    if (!user) return none('No hay una sesión activa.');

    if (!this.connectivity.isOnline()) {
      return none(
        'Esta lista se consulta en línea y ahora no hay conexión. ' +
          'Márcala para descarga en Sincronización si necesitas usarla sin red.',
      );
    }

    const isItem = filter.item === true;
    const listId = isItem
      ? String(filter.itemTypeId ?? '')
      : String(definition?.ListIDBD ?? '');

    const query: ListSearchQuery = {
      ListID: isItem ? null : listId || null,
      ItemID: isItem ? listId || null : null,
      lsChild: filter.lsChild ?? null,
      txt: options.search,
      parent: filter.parent ?? '',
      loc: filter.loc ?? '',
      ass: filter.ass ?? '',
      parentlist: filter.parentlist ?? '',
      users: filter.users === true,
      byusers: filter.byusers === true,
      byuserList: filter.byuserList ?? '',
    };

    const result = await this.api.search(query, {
      companyId: user.CompanyID,
      userId: user.UserID,
    });

    console.log('[Listas] consulta en línea', query, '→', {
      ok: result.ok,
      items: result.items.length,
      error: result.error,
    });

    if (!result.ok) return none(result.error ?? 'No se pudo consultar la lista.');

    if (result.items.length === 0) {
      return {
        origin: 'online',
        choices: [],
        truncated: false,
        message: options.search
          ? `Ningún ítem coincide con «${options.search}».`
          : 'Escribe para buscar en esta lista.',
      };
    }

    return {
      origin: 'online',
      truncated: result.items.length >= PAGE,
      message: '',
      choices: this.toChoices(field, result.items, definition),
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Otras entidades
  // ───────────────────────────────────────────────────────────────────────────

  /** Ubicaciones de un tipo. El `lst` del campo es el GUID del tipo. */
  private async fromLocations(
    ownerId: number,
    typeGuid: string,
    search: string,
  ): Promise<ListSource> {
    const found = await this.locations.findByTypeGuid(ownerId, typeGuid);
    const matched = applySearch(found, search);

    if (found.length === 0) {
      const all = await this.locations.findByUser(ownerId);

      console.warn(
        `[Listas] ubicaciones: ningún registro con tipo «${typeGuid}». ` +
          `Hay ${all.length} ubicaciones en el dispositivo.`,
        resumeTypes(all, (l) => [l.LocationTypeGD, l.LocationTypeGUID]),
      );

      return none(
        all.length === 0
          ? 'No hay ubicaciones descargadas en este dispositivo. Descárgalas desde Sincronización.'
          : 'Ninguna ubicación del dispositivo pertenece al tipo que pide este campo.',
      );
    }

    console.log(
      `[Listas] ubicaciones de tipo ${typeGuid} · encontradas=${found.length} · ` +
        `tras buscar «${search}»=${matched.length}`,
    );

    return {
      origin: 'local',
      truncated: matched.length >= PAGE,
      message: '',
      choices: matched.map((location: LocationForm) => ({
        id: location.GUID,
        txt: location.Name ?? '',
        des: [],
        preview: [],
        // `lst` es el catálogo del que salió el ítem —aquí, el tipo de
        // ubicación—, no la lista configurada en el campo.
        src: { item: location, lst: location.LocationTypeGD ?? '', ent: 1, loc: true },
      })),
    };
  }

  /**
   * Activos de un tipo.
   *
   * Sin acotar por ubicación: el desplegable ofrece los del tipo, no los de una
   * sede. Es lo que hace `getAssetsByTypeGUID` en la app.
   *
   * ## Los descriptivos salen del propio activo
   *
   * Cada activo trae `jsonDescriptor` —los campos que su **tipo** decidió
   * mostrar— y `jsonValues` con sus datos. No hace falta consultar el tipo por
   * separado: el activo llega con las dos cosas desde el sync.
   *
   * Eso es lo que permite distinguir dos bombas que se llaman igual por su
   * placa o su serie, y buscarlas por ese dato.
   */
  private async fromAssets(
    ownerId: number,
    typeGuid: string,
    search: string,
  ): Promise<ListSource> {
    // Sin búsqueda basta con la primera página. Con búsqueda hay que
    // recorrerlos todos: lo escrito puede estar en el último de veinte mil.
    const found = await this.assets.findByTypeGuid(
      ownerId,
      typeGuid,
      search ? undefined : PAGE,
    );

    // Los descriptivos son los mismos para todos: los define el tipo, y todos
    // los de esta consulta son del mismo tipo. Se leen del primero.
    const config = parseListDescriptors(found[0]?.jsonDescriptor);
    const matched = this.searchItems(found, search, config);

    if (found.length === 0) {
      // Se enseñan los tipos que sí existen en el dispositivo: comparar el que
      // pide el formulario con los que hay es lo que revela si el desajuste
      // está en el identificador o en que los activos no se descargaron.
      const all = await this.assets.findByUser(ownerId);

      console.warn(
        `[Listas] activos: ningún registro con tipo «${typeGuid}». ` +
          `Hay ${all.length} activos en el dispositivo.`,
        resumeTypes(all, (a) => [a.AssetTypeGD, a.AssetTypeGUID]),
      );

      return none(
        all.length === 0
          ? 'No hay activos descargados en este dispositivo. Descárgalos desde Sincronización.'
          : 'Ningún activo del dispositivo pertenece al tipo que pide este campo.',
      );
    }

    console.log(
      `[Listas] activos de tipo ${typeGuid} · encontrados=${found.length} · ` +
        `tras buscar «${search}»=${matched.length} · descriptivos=${config.length}`,
    );

    return {
      origin: 'local',
      truncated: matched.length >= PAGE,
      message: '',
      choices: matched.map((asset: Asset) => {
        const des = extractDescriptors(config, asset);

        return {
          id: asset.GUID,
          txt: asset.Name ?? '',
          // Los mismos datos se enseñan y se guardan: a diferencia de una
          // lista, aquí no hay dos configuraciones distintas que separar.
          des,
          preview: des,
          src: { item: asset, lst: asset.AssetTypeGD ?? '', ent: 12, ass: true },
        };
      }),
    };
  }

  /**
   * Ítems de inventario.
   *
   * Se comportan como una lista: tienen su propia definición con `IsForSync`,
   * así que pueden estar descargados o consultarse al servidor. La diferencia
   * es que viajan por `ItemID` en vez de por `ListID`.
   */
  private async fromItems(
    field: FieldRef,
    ownerId: number,
    guid: string,
    options: { answerGuid?: string; parentValue?: string; search: string },
    /**
     * Cómo acotar la consulta remota.
     *
     * `users` es la diferencia entre los dos sitios desde donde se llega aquí:
     * un desplegable de inventario pide solo los ítems del usuario —la app lo
     * fija en `DropDownListPage`—, y una tabla de detalle no. Copiar uno en el
     * otro dejaba la tabla vacía o mostrando de más.
     */
    extra: { filter?: ListFilter; users?: boolean } = {},
  ): Promise<ListSource> {
    // La configuración sale de `ItemsTypes`, no de `Lists`: el inventario tiene
    // su propio catálogo de tipos aunque el campo se comporte igual.
    const definition = await this.itemTypes.findForField(ownerId, guid);

    if (!definition) {
      return none('El tipo de ítem no está sincronizado en el dispositivo.');
    }

    if (Number(definition.IsForSync) !== 1) {
      return this.fromServer(field, options, null, {
        ...(extra.filter ?? {}),
        item: true,
        users: extra.users ?? true,
        itemTypeId: String(definition.ListIDBD ?? ''),
      });
    }

    const found = await this.items.findByType(ownerId, String(definition.ListIDBD ?? ''));
    const matched = applySearch(found, options.search);

    if (found.length === 0) {
      return none('No hay ítems de inventario descargados para este tipo.');
    }

    return {
      origin: 'local',
      truncated: matched.length >= PAGE,
      message: '',
      choices: matched.map((item) => ({
        id: item.GUID,
        txt: item.Name ?? '',
        des: [],
        preview: [],
        src: { item, ent: 14 },
      })),
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Entradas para el MasterDetail
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Las piezas del árbol, sueltas.
   *
   * Un desplegable entra por [resolve], que decide por él a partir de `ent` y
   * `lst`. Un MasterDetail no puede: sus filas salen de la **lista**, y es la
   * configuración de esa lista —`hasLocations`, `hasAssets`, `hasItems`…— la
   * que decide de dónde. Su servicio arma el árbol a su manera y llama aquí a
   * la pieza que toque, en vez de duplicar consultas y mensajes.
   */

  /** La lista configurada en un campo, por su GUID o su identificador. */
  async definitionOf(guid: string): Promise<ListDefinition | null> {
    const owner = this.ownerId();
    if (owner === null || !guid) return null;

    return this.lists.findForField(owner, guid);
  }

  /**
   * La lista a la que apunta otra.
   *
   * Una lista con `ListTypeID == '1'` no tiene ítems propios: es un puntero a
   * la lista real, cuyo identificador guarda en `ListID`. Sin resolverlo se
   * acaba leyendo los descriptivos y el esquema de la lista equivocada.
   */
  async definitionByListId(listId: string): Promise<ListDefinition | null> {
    const owner = this.ownerId();
    const needle = String(listId ?? '').trim();

    // `-1` y `0` son como el diseñador marca «ninguna».
    if (owner === null || !needle || needle === '-1' || needle === '0') return null;

    return this.lists.findByListIdBd(owner, needle);
  }

  /** El tipo de ítem de inventario, que vive en su propio catálogo. */
  async itemTypeOf(guid: string): Promise<ItemType | null> {
    const owner = this.ownerId();
    if (owner === null || !guid) return null;

    return this.itemTypes.findForField(owner, guid);
  }

  /** Ubicaciones de un tipo. */
  async locationsOfType(typeGuid: string, search: string): Promise<ListSource> {
    const owner = this.ownerId();
    if (owner === null) return none('No hay una sesión activa.');

    return this.fromLocations(owner, typeGuid, search);
  }

  /** Activos de un tipo. */
  async assetsOfType(typeGuid: string, search: string): Promise<ListSource> {
    const owner = this.ownerId();
    if (owner === null) return none('No hay una sesión activa.');

    return this.fromAssets(owner, typeGuid, search);
  }

  /**
   * Ítems de inventario de un tipo.
   *
   * `filter` y `users` solo afectan a la consulta remota: los ítems descargados
   * no guardan de quién cuelgan —`Items` no tiene `ParentGUID`—, así que en
   * local se ofrecen todos los del tipo, como en la app.
   */
  async itemsOfType(
    field: FieldRef,
    typeGuid: string,
    options: {
      answerGuid?: string;
      parentValue?: string;
      search: string;
      filter?: ListFilter;
      users?: boolean;
    },
  ): Promise<ListSource> {
    const owner = this.ownerId();
    if (owner === null) return none('No hay una sesión activa.');

    return this.fromItems(field, owner, typeGuid, options, {
      filter: options.filter,
      users: options.users,
    });
  }

  /**
   * Ítems de una lista ya resuelta, con el filtro que decida quien llama.
   *
   * A diferencia de [resolve], el filtro **no** se deduce del campo: el
   * MasterDetail lo arma con lo suyo —la ubicación de la fila padre, el ítem
   * elegido antes— y aquí solo se decide si se leen del dispositivo o se
   * consultan al servidor.
   */
  async itemsOfList(
    field: FieldRef,
    definition: ListDefinition,
    filter: ListFilter,
    options: { search: string; answerGuid?: string; parentValue?: string },
  ): Promise<ListSource> {
    const owner = this.ownerId();
    if (owner === null) return none('No hay una sesión activa.');

    if (filter.blocked) return none(filter.blocked);

    if (Number(definition.IsForSync) === 1) {
      return this.fromLocalList(field, definition, owner, filter, options.search);
    }

    const remote = await this.fromServer(field, options, definition, filter);
    if (remote.origin === 'online') return remote;

    // Lo mismo que en [fromList]: una lista que se desmarcó conserva sus ítems
    // descargados, y preferir el error a los datos que están ahí deja al
    // usuario sin poder responder por nada.
    const local = await this.fromLocalList(field, definition, owner, filter, options.search);
    return local.choices.length > 0 ? local : remote;
  }

  /** La ubicación y el activo de una actividad, que acotan varias listas. */
  async answerContext(answerGuid: string): Promise<{ loc: string; ass: string }> {
    if (!answerGuid) return { loc: '', ass: '' };

    const answer = await this.answers.findByGuid(answerGuid);
    return { loc: answer?.LocationID ?? '', ass: answer?.AssetID ?? '' };
  }

  private ownerId(): number | null {
    const user = this.auth.currentUser();
    return user ? resolveCatalogOwnerId(user) : null;
  }

  /**
   * El sub-formulario que define la lista de un campo MasterDetail.
   *
   * Cada fila de un MasterDetail se responde con un formulario propio, y ese
   * formulario **no** está en el campo: vive en `jsonFields` de la lista a la
   * que apunta. Es la misma estructura de páginas y campos que un formulario
   * normal, así que la dibuja el mismo motor.
   */
  async rowSchema(field: FormField): Promise<unknown> {
    const definition = await this.definitionOf(String(field.lst ?? '').trim());
    return definition?.jsonFields ?? null;
  }

  /**
   * Los descriptivos de un ítem concreto.
   *
   * Lo usa el campo al reabrir una actividad guardada sin `des` —las de
   * versiones anteriores— para poder mostrar el detalle igualmente.
   */
  async descriptorsOf(field: FormField, itemGuid: string): Promise<ResolvedDescriptor[]> {
    const config = field.des ?? [];
    if (config.length === 0 || !itemGuid) return [];

    const item = await this.details.getByIndex('byGUID', itemGuid);
    return item ? extractDescriptors(config, item) : [];
  }

  /**
   * Busca por nombre **y por los datos del ítem**.
   *
   * Los descriptivos son a menudo lo único que distingue dos registros: dos
   * «Bomba centrífuga» que solo se diferencian por su código de placa. Buscar
   * solo por nombre obliga a recorrer la lista a mano hasta dar con el bueno.
   *
   * ## Cómo evita parsear veinte mil ítems
   *
   * Resolver los descriptivos exige interpretar el JSON de cada registro, y
   * hacerlo con la lista entera en cada pulsación bloquea la pestaña. Así que
   * primero se descartan los que **ni siquiera contienen el texto** en su JSON
   * en crudo —una comparación de subcadenas, sin interpretar nada— y solo los
   * que quedan se resuelven de verdad.
   *
   * Ese primer paso puede dar falsos positivos: el texto puede estar en un
   * campo que la lista no muestra, o dentro de un identificador. Por eso el
   * segundo paso confirma que la coincidencia esté en un descriptivo visible.
   */
  private searchItems<T extends Describable>(
    items: readonly T[],
    search: string,
    config: readonly DescriptorConfig[],
  ): T[] {
    const needle = search.trim().toLowerCase();
    if (!needle) return items.slice(0, PAGE);

    const byName: T[] = [];
    const candidates: T[] = [];

    for (const item of items) {
      const name = (item.Name ?? '').toLowerCase();

      if (name.includes(needle)) {
        byName.push(item);
        continue;
      }

      // Prefiltro barato sobre el JSON sin interpretar.
      if (String(item.jsonValues ?? '').toLowerCase().includes(needle)) {
        candidates.push(item);
      }
    }

    // El nombre manda: quien escribe espera ver primero lo que se llama así.
    if (byName.length >= PAGE || config.length === 0) return byName.slice(0, PAGE);

    const byDescriptor = candidates.filter((item) =>
      extractDescriptors(config, item).some((descriptor) =>
        descriptor.val.toLowerCase().includes(needle),
      ),
    );

    return [...byName, ...byDescriptor].slice(0, PAGE);
  }

  /**
   * Convierte los ítems en opciones, con sus dos juegos de descriptivos.
   *
   * Los del campo se guardan; los de la lista se enseñan. Ver [ListChoice].
   */
  private toChoices(
    field: FieldRef,
    items: readonly ListDetail[],
    definition: ListDefinition | null,
  ): ListChoice[] {
    const fieldConfig = (field.des ?? []).filter((entry) => entry.isSelected);
    const listConfig = parseListDescriptors(definition?.jsonDescriptors);

    return items.map((item) => ({
      id: item.GUID,
      txt: item.Name ?? '',
      des: extractDescriptors(fieldConfig, item),
      preview: extractDescriptors(listConfig, item),
      src: { item, lst: String(definition?.GUID ?? ''), ent: 0 },
    }));
  }
}

/** Cómo hay que acotar la consulta. Vale igual para la local y la remota. */
export interface ListFilter {
  /** GUID del ítem padre. */
  parent?: string;
  /** Ubicación de la actividad. */
  loc?: string;
  /** Activo de la actividad. */
  ass?: string;
  /** GUID elegido en el campo del que depende. */
  parentlist?: string;
  /** La lista son usuarios de la plataforma. */
  users?: boolean;
  /** Cada usuario ve solo sus ítems. */
  byusers?: boolean;
  byuserList?: string;
  /** Lista hija: el servidor resuelve su lista real a partir de este. */
  lsChild?: string;
  /** La consulta es de inventario, no de lista. */
  item?: boolean;
  /** Tipo de ítem, cuando la consulta es de inventario. */
  itemTypeId?: string;
  /** Si viene, no hay nada que consultar y esto explica por qué. */
  blocked?: string;
}

/**
 * Los tipos distintos que aparecen en un conjunto, con cuántos hay de cada uno.
 *
 * Es lo que permite comparar de un vistazo el tipo que pide el formulario con
 * los que de verdad tienen los registros descargados. Sin esto, un desplegable
 * vacío obliga a abrir IndexedDB a mano para ver si el problema es el
 * identificador o que no se descargó nada.
 */
function resumeTypes<T>(items: readonly T[], keys: (item: T) => (string | undefined)[]) {
  const counts = new Map<string, number>();

  for (const item of items) {
    for (const key of keys(item)) {
      const value = String(key ?? '').trim();
      if (!value) continue;

      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([tipo, registros]) => ({ tipo, registros }));
}

/** Qué consulta local se usó, en una palabra, para el rastro. */
function describeQuery(filter: ListFilter): string {
  if (filter.byusers) return 'por usuario dueño';
  if (filter.parentlist) return 'por campo padre';
  if (filter.ass) return 'por activo';
  if (filter.loc) return 'por ubicación';
  if (filter.parent) return 'por ítem padre';

  return 'toda la lista';
}

/**
 * ¿Está activada esta bandera de la lista?
 *
 * `hasLocations`, `hasAssets` y `hasUsers` llegan del backend de cuatro formas
 * distintas —`'0'`/`'1'`, `'true'`/`'false'`, `true`/`false` y `0`/`1`— según
 * la versión que creara la lista.
 *
 * La app compara contra `'0'`, y eso da un falso positivo con `"false"`: la
 * cadena no es `'0'`, así que la bandera se daba por activada. Es lo que hacía
 * que una lista corriente se consultara como si fuera de usuarios y devolviera
 * cero resultados teniendo sus ítems descargados.
 *
 * Aquí se comprueba lo contrario —qué cuenta como **sí**— que es la única
 * lectura que no se rompe cuando aparece una quinta forma.
 */
function isOn(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'number') return value === 1;

  const text = String(value ?? '').trim().toLowerCase();
  return text === '1' || text === 'true';
}

/** ¿Los ítems de esta lista cuelgan de otra? */
function isChildList(definition: ListDefinition): boolean {
  const parent = String(definition.ListID ?? '').trim();

  return (
    parent !== '' &&
    parent !== '-1' &&
    parent !== '0' &&
    parent !== 'null' &&
    parent !== 'false'
  );
}

/** Filtra por nombre y recorta al tope, igual que la app. */
function applySearch<T extends { Name?: string }>(items: T[], search: string): T[] {
  const needle = search.trim().toLowerCase();

  const filtered = needle
    ? items.filter((item) => (item.Name ?? '').toLowerCase().includes(needle))
    : items;

  return filtered.slice(0, PAGE);
}

/**
 * Por qué una lista descargada no tiene nada que ofrecer.
 *
 * El motivo casi nunca es que la lista esté vacía: es que el filtro no encontró
 * nada para esta ubicación, este activo o este usuario. Decir «no hay ítems» a
 * secas deja al usuario buscando un problema donde no lo hay.
 */
function describeEmptyLocal(definition: ListDefinition, filter: ListFilter): string {
  if (filter.loc) return 'Esta ubicación no tiene ítems registrados en esta lista.';
  if (filter.ass) return 'Este activo no tiene ítems registrados en esta lista.';
  if (filter.parentlist) return 'La opción elegida en el campo anterior no tiene ítems asociados.';
  if (filter.byusers) return 'No tienes ítems propios en esta lista.';

  return `La lista «${definition.Name ?? ''}» está descargada pero no tiene ítems.`;
}

/**
 * Saca del ítem los datos que el campo pidió enseñar.
 *
 * El `jsonValues` llega en dos formas —un arreglo suelto o un objeto con
 * `fie`— según por dónde se creara el ítem. Las dos se contemplan porque las
 * dos existen en datos reales.
 *
 * Un valor de selección viene como `{id, txt}`: se guarda su texto, que es lo
 * único legible. Guardar el objeto dejaría `[object Object]` en pantalla.
 */
function extractDescriptors(
  config: readonly DescriptorConfig[],
  item: Describable,
): ResolvedDescriptor[] {
  if (config.length === 0) return [];

  const fields = parseItemFields(item.jsonValues);
  if (fields.length === 0) return [];

  const result: ResolvedDescriptor[] = [];

  for (const entry of config) {
    const match = fields.find((field) => field?.id === entry.id);
    if (!match) continue;

    const raw = match.val;
    const value =
      raw && typeof raw === 'object' && 'txt' in raw
        ? String((raw as { txt?: unknown }).txt ?? '')
        : String(raw ?? '');

    if (value.trim()) result.push({ id: entry.id, lab: entry.lab, val: value });
  }

  return result;
}

/**
 * Los descriptivos que la lista quiere enseñar de cada ítem.
 *
 * Llegan en `jsonDescriptors` como `[{id, lab}, …]`. Puede venir vacío, nulo o
 * mal formado —una lista sin descriptivos configurados—, y en cualquiera de
 * esos casos simplemente no hay nada que enseñar.
 */
export function parseListDescriptors(raw: unknown): DescriptorConfig[] {
  if (!raw) return [];

  let decoded: unknown = raw;

  if (typeof raw === 'string') {
    if (!raw.trim()) return [];

    try {
      decoded = JSON.parse(raw);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(decoded)) return [];

  return decoded
    .filter((entry) => entry && typeof entry === 'object' && entry.id)
    .map((entry) => ({ id: String(entry.id), lab: String(entry.lab ?? '') }));
}

/** Lee los campos del ítem, vengan como arreglo o dentro de `fie`. */
function parseItemFields(raw: unknown): { id?: string; val?: unknown }[] {
  if (!raw) return [];

  let decoded: unknown = raw;

  if (typeof raw === 'string') {
    if (!raw.trim()) return [];

    try {
      decoded = JSON.parse(raw);
    } catch {
      return [];
    }
  }

  if (Array.isArray(decoded)) return decoded;

  if (decoded && typeof decoded === 'object') {
    const fie = (decoded as { fie?: unknown }).fie;
    if (Array.isArray(fie)) return fie;
  }

  return [];
}

function none(message: string): ListSource {
  return { origin: 'none', choices: [], message, truncated: false };
}

/**
 * Deja en consola la configuración con la que se resolvió una lista.
 *
 * Un desplegable vacío tiene media docena de causas —la lista no bajó, bajó sin
 * ítems, el filtro por ubicación no encontró nada, el campo apunta a otro
 * identificador— y desde fuera se ven todas igual. Esto las distingue en una
 * mirada, sin tener que abrir IndexedDB a mano.
 *
 * Se imprime siempre, no solo cuando falla: cuando algo sale raro, lo que hace
 * falta es comparar el caso que funciona con el que no.
 */
function trace(field: FieldRef, detail: Record<string, unknown>): void {
  console.groupCollapsed(
    `%c[Listas]%c ${field.lab || field.id} · ent=${field.ent ?? 0} · lst=${field.lst ?? ''}`,
    'color:#e11d48;font-weight:700',
    'color:inherit',
  );

  console.log('campo', {
    id: field.id,
    lab: field.lab,
    lst: field.lst,
    ent: field.ent,
    parentId: field.parentId,
    descriptivos: field.des?.length ?? 0,
  });

  for (const [key, value] of Object.entries(detail)) console.log(key, value);

  console.groupEnd();
}
