import { Injectable, inject } from '@angular/core';

import { ListDefinition } from '../models/entities.model';
import {
  AssetRepository,
  ItemRepository,
  ListDetailRepository,
  LocationRepository,
} from '../repositories/entity.repositories';
import { DescriptorConfig, FormField, FormPage, parseQuestions } from './form-schema';
import {
  FieldRef,
  ListFilter,
  ListSource,
  ListSourceService,
  parseListDescriptors,
} from './list-source.service';
import { MasterDetailRow } from './master-detail';

/**
 * De dónde salen las filas de una tabla de detalle.
 *
 * No lo decide el campo sino **su lista**: es la configuración de la lista la
 * que dice si cada fila es una ubicación, un activo, un ítem de inventario o
 * un registro de la propia lista. El campo solo dice a qué lista apunta.
 */
export type DetailOrigin =
  /** Sin nada que elegir: cada fila nace vacía y se llena en su formulario. */
  | 'blank'
  /** Cada fila es una ubicación del tipo configurado. */
  | 'locations'
  /** Cada fila es un activo del tipo configurado. */
  | 'assets'
  /** Cada fila es un ítem de inventario. */
  | 'items'
  /** Ítems de la lista, solo los del usuario de la sesión. */
  | 'users'
  /** Ítems de la lista. */
  | 'list'
  /**
   * Dos pasos: primero una ubicación, después los ítems que cuelgan de ella.
   *
   * Si la actividad ya tiene ubicación, el primer paso se salta — la app hace
   * exactamente eso, y pedirla otra vez sería preguntar por algo ya respondido.
   */
  | 'location-l2'
  /** No se puede resolver. `message` dice por qué. */
  | 'unavailable';

/** Todo lo que hace falta para operar un campo de tabla de detalle. */
export interface DetailConfig {
  origin: DetailOrigin;

  /** La lista configurada en el campo. */
  definition: ListDefinition | null;

  /**
   * La lista de la que salen de verdad los ítems.
   *
   * Distinta de [definition] cuando esa es un puntero (`ListTypeID == '1'`):
   * entonces la real es la que indica su `ListID`, y es de ella de donde salen
   * los descriptivos y el `IsForSync` que decide local o en línea.
   */
  target: ListDefinition | null;

  /** Nombre de la lista, para el botón y el título del selector. */
  label: string;

  /** El formulario de cada fila. */
  schema: FormPage[];

  /** Datos del ítem que se enseñan al elegir. */
  descriptors: DescriptorConfig[];

  /** Tipo de ubicación, de activo o de ítem, según el origen. */
  typeGuid: string;

  /** Por qué no se puede, cuando el origen es `unavailable`. */
  message: string;
}

/** Contexto de la actividad y de la fila padre, que acota varias listas. */
export interface DetailContext {
  answerGuid?: string;

  /** `LocationID` heredado: de la actividad o de la ubicación elegida en el paso 1. */
  loc?: string;

  /** `AssetID` heredado. */
  ass?: string;

  /**
   * Ítem del que cuelgan estos registros: el de la **fila que contiene** esta
   * tabla.
   *
   * Es la herencia entre tablas anidadas. Una fila del MasterDetail de arriba
   * nació de un ítem de una lista; los registros de la tabla que lleva dentro
   * son los ítems que cuelgan de aquel —los que tienen su GUID en `ParentGUID`.
   * Sin esto, la tabla de dentro ofrecería el catálogo entero en vez de lo que
   * pertenece al ítem que se está detallando.
   */
  parent?: string;

  /**
   * Ítem elegido en **otro campo** del mismo formulario.
   *
   * Es el encadenado corriente —«línea» y luego solo sus equipos—, y acota
   * además por la lista. Distinto del anterior: aquel viene de la fila que
   * contiene la tabla, este de una respuesta hermana.
   */
  parentField?: string;

  search?: string;
}

/**
 * Los datos del origen de una fila.
 *
 * La app los llama así y los guarda en la fila; los usan los valores por
 * defecto del sub-formulario (`LOC_NAME`, `AST_NAME`, los campos del
 * `jsonValues`) y el filtrado de las listas que haya dentro.
 */
export interface RowInfo {
  itemsInfo?: unknown;
  LocationInfo?: unknown;
  AssetInfo?: unknown;
}

/**
 * De dónde salen las filas de un MasterDetail, y con qué se llenan.
 *
 * ## Por qué no basta con el servicio de listas
 *
 * Un desplegable pregunta «¿qué opciones tengo?» y la respuesta sale de `ent` y
 * `lst` del campo. Una tabla de detalle pregunta otra cosa: «¿qué **es** cada
 * fila?», y eso lo responde la configuración de la lista. Una misma lista puede
 * producir filas que son ubicaciones, activos, ítems de inventario o registros
 * suyos, y en dos casos ni siquiera hay nada que elegir.
 *
 * El árbol de abajo es el de `MasterDetailListPage.dart`, en su orden. Ese
 * orden no es arbitrario: cada rama excluye a las siguientes, y alterarlo
 * produce selectores que muestran el catálogo entero donde deberían mostrar
 * tres opciones.
 */
@Injectable({ providedIn: 'root' })
export class MasterDetailSourceService {
  private readonly lists = inject(ListSourceService);
  private readonly details = inject(ListDetailRepository);
  private readonly locations = inject(LocationRepository);
  private readonly assets = inject(AssetRepository);
  private readonly items = inject(ItemRepository);

  /**
   * Resuelve qué es cada fila de este campo.
   *
   * Se llama una vez al montar el campo: la configuración de una lista no
   * cambia mientras se diligencia el formulario.
   */
  async configure(field: FormField): Promise<DetailConfig> {
    const guid = String(field.lst ?? '').trim();

    const empty: DetailConfig = {
      origin: 'unavailable',
      definition: null,
      target: null,
      label: field.lab || 'Registros',
      schema: [],
      descriptors: [],
      typeGuid: '',
      message: '',
    };

    if (!guid) {
      return {
        ...empty,
        message: 'El formulario no indica de qué lista salen los registros de este campo.',
      };
    }

    const definition = await this.lists.definitionOf(guid);

    if (!definition) {
      return {
        ...empty,
        message:
          'La lista de este campo no está en el dispositivo. ' +
          'Descarga las listas desde Sincronización.',
      };
    }

    const base: DetailConfig = {
      ...empty,
      definition,
      target: definition,
      label: definition.Name || field.lab || 'Registros',
      schema: parseQuestions(definition.jsonFields),
      descriptors: parseListDescriptors(definition.jsonDescriptors),
    };

    // ── Sin nada que elegir ─────────────────────────────────────────────────
    // Ni ubicaciones, ni activos, ni ítems, ni usuarios, ni padre, y sin lista
    // detrás. La fila no representa ningún registro: es un formulario suelto
    // que se repite —«hallazgos», «observaciones»— y se agrega en blanco.
    if (isFreeForm(definition)) {
      return String(definition.ParentID ?? '').trim() === ''
        ? { ...base, origin: 'blank' }
        : {
            ...base,
            origin: 'unavailable',
            message: 'Este tipo de lista no está disponible en la versión web.',
          };
    }

    // ── Ubicaciones ─────────────────────────────────────────────────────────
    if (isOn(definition.hasLocations)) {
      return {
        ...base,
        origin: 'locations',
        typeGuid: String(definition.LocationTypeID ?? ''),
      };
    }

    // ── Activos ─────────────────────────────────────────────────────────────
    if (isOn(definition.hasAssets)) {
      return { ...base, origin: 'assets', typeGuid: String(definition.AssetTypeID ?? '') };
    }

    // ── Ítems de inventario ─────────────────────────────────────────────────
    // Los descriptivos salen de `ItemsTypes`, que es otro catálogo: leerlos del
    // `jsonDescriptors` de la lista mostraba los de la lista equivocada.
    if (isOn(definition.hasItems)) {
      const typeGuid = String(definition.ItemTypeID ?? '');
      const itemType = await this.lists.itemTypeOf(typeGuid);

      return {
        ...base,
        origin: 'items',
        typeGuid,
        descriptors: parseListDescriptors(itemType?.jsonDescriptors),
      };
    }

    // ── Ítems propios del usuario ───────────────────────────────────────────
    if (isOn(definition.hasUsers)) {
      return { ...base, origin: 'users' };
    }

    /**
     * ── Ítems de una lista ──────────────────────────────────────────────────
     *
     * Con un rodeo: `ListID` apunta a **otra lista**, y de esa segunda salen
     * dos cosas distintas.
     *
     * 1. Si además está ligada a ubicaciones, la elección pasa a ser de dos
     *    niveles: primero la sede, después sus registros. La app lo resuelve
     *    con un `JOIN` que trae `hasLocations` de la lista apuntada bajo el
     *    nombre `hasLocationL2` — aquí se consulta, porque en el dispositivo no
     *    hay nada que junte dos tablas por su cuenta.
     * 2. Si la lista del campo es solo un puntero (`ListTypeID == '1'`), la
     *    apuntada es la que de verdad tiene los ítems, y de ella salen los
     *    descriptivos y el `IsForSync` que decide entre local y en línea.
     */
    const child = await this.lists.definitionByListId(String(definition.ListID ?? ''));
    const target = String(definition.ListTypeID ?? '') === '1' && child ? child : definition;

    const resolved: DetailConfig = {
      ...base,
      target,
      descriptors: parseListDescriptors(target.jsonDescriptors),
    };

    // Dos niveles: la ubicación primero, sus ítems después.
    if (child && isOn(child.hasLocations)) {
      return {
        ...resolved,
        origin: 'location-l2',
        typeGuid: String(child.LocationTypeID ?? ''),
      };
    }

    return { ...resolved, origin: 'list' };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Los ítems que se pueden elegir
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Las opciones del paso actual.
   *
   * @param step en un origen de dos niveles, `1` son las ubicaciones y `2` los
   *   ítems de la elegida. En los demás orígenes se ignora.
   */
  async choices(
    field: FormField,
    config: DetailConfig,
    context: DetailContext,
    step: 1 | 2 = 1,
  ): Promise<ListSource> {
    const search = (context.search ?? '').trim();
    const ref = this.refOf(field, config);

    switch (config.origin) {
      case 'locations':
        return this.lists.locationsOfType(config.typeGuid, search);

      case 'assets':
        return this.lists.assetsOfType(config.typeGuid, search);

      case 'items':
        return this.lists.itemsOfType(ref, config.typeGuid, {
          search,
          answerGuid: context.answerGuid,
          filter: this.filterFor(config, context),

          // Una tabla de detalle no acota el inventario al usuario; el
          // desplegable sí. Es la diferencia entre `MasterDetailListPage` y
          // `DropDownListPage` en la app, y confundirlas vacía la tabla.
          users: false,
        });

      case 'location-l2':
        // Paso 1: la ubicación. Solo se llega aquí si la actividad no traía una.
        if (step === 1) return this.lists.locationsOfType(config.typeGuid, search);
        return this.itemsOfTarget(ref, config, context, search);

      case 'users':
      case 'list':
        return this.itemsOfTarget(ref, config, context, search);

      default:
        return {
          origin: 'none',
          choices: [],
          truncated: false,
          message: config.message || 'Este campo no tiene registros que elegir.',
        };
    }
  }

  /** Ítems de la lista, con el filtro que corresponda al contexto. */
  private async itemsOfTarget(
    ref: FieldRef,
    config: DetailConfig,
    context: DetailContext,
    search: string,
  ): Promise<ListSource> {
    const target = config.target ?? config.definition;

    if (!target) {
      return {
        origin: 'none',
        choices: [],
        truncated: false,
        message: 'La lista de este campo no está en el dispositivo.',
      };
    }

    return this.lists.itemsOfList(ref, target, this.filterFor(config, context), {
      search,
      answerGuid: context.answerGuid,
    });
  }

  /**
   * Por qué se acotan los ítems.
   *
   * El orden es el de `getListDet` en la app, donde cada criterio reemplaza al
   * anterior: el último que se cumple es el que manda. Aquí se escribe como
   * casos exclusivos, que es lo mismo sin consultar de más.
   */
  private filterFor(config: DetailConfig, context: DetailContext): ListFilter {
    if (config.origin === 'users') {
      return {
        byusers: true,
        byuserList: String((config.target ?? config.definition)?.ListIDBD ?? ''),
      };
    }

    // El orden es el de `getListDet` en la app, donde cada criterio reemplaza
    // al anterior y por eso manda el último que se cumple: el campo hermano
    // antes que el activo, el activo antes que la ubicación, y la fila que
    // contiene la tabla en último lugar.
    if (context.parentField) return { parentlist: context.parentField };
    if (context.ass) return { ass: context.ass };
    if (context.loc) return { loc: context.loc };
    if (context.parent) return { parent: context.parent };

    return {};
  }

  /**
   * El campo, visto por el árbol de listas.
   *
   * Se le pasa el `des` del campo —lo que hay que guardar del ítem— pero **no**
   * su `parentId`: la dependencia de un MasterDetail no es la de un desplegable
   * y ya está resuelta en [filterFor]. Dejarlo bloquearía el selector pidiendo
   * responder un campo que aquí no aplica.
   */
  private refOf(field: FormField, config: DetailConfig): FieldRef {
    return {
      id: field.id,
      lab: config.label,
      des: field.des,
      lst: field.lst,
      ent: field.ent,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Los datos del origen de una fila
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Recupera el registro del que salió una fila.
   *
   * Al reabrir una actividad guardada, la fila trae el `ListDetGUID` pero no
   * siempre el registro completo —las filas creadas por versiones anteriores no
   * lo guardaban—. Sin él, los valores por defecto del sub-formulario que
   * heredan de la ubicación o del ítem se quedan vacíos y las listas de dentro
   * no saben por qué filtrar.
   *
   * Es lo que hace `MasterDetailPage` al pulsar una fila.
   */
  async infoFor(row: MasterDetailRow, config: DetailConfig): Promise<RowInfo> {
    const guid = String(row.ListDetGUID ?? '').trim();

    const known: RowInfo = {
      itemsInfo: row.itemsInfo,
      LocationInfo: row.LocationInfo,
      AssetInfo: row.AssetInfo,
    };

    if (!guid) return known;

    try {
      switch (config.origin) {
        case 'locations': {
          if (isFilled(known.LocationInfo)) return known;

          const location = await this.locations.getByIndex('byGUID', guid);
          return { ...known, LocationInfo: location ?? {} };
        }

        case 'assets': {
          if (isFilled(known.AssetInfo)) return known;

          const asset = await this.assets.getByIndex('byGUID', guid);
          return { ...known, AssetInfo: asset ?? {} };
        }

        case 'items': {
          if (isFilled(known.itemsInfo)) return known;

          const item = await this.items.getByIndex('byGUID', guid);
          return { ...known, itemsInfo: item ?? {} };
        }

        default: {
          if (isFilled(known.itemsInfo)) return known;

          const detail = await this.details.getByIndex('byGUID', guid);
          return { ...known, itemsInfo: detail ?? {} };
        }
      }
    } catch (error) {
      console.warn('[MasterDetail] no se pudo recuperar el origen de la fila', error);
      return known;
    }
  }

  /** La ubicación y el activo de la actividad. */
  async answerContext(answerGuid: string): Promise<{ loc: string; ass: string }> {
    return this.lists.answerContext(answerGuid);
  }
}

/**
 * ¿La lista no representa ningún registro?
 *
 * Sin ubicaciones, activos, ítems, usuarios ni padre, y con `ListID` en `-1` o
 * `0` —que es como el diseñador marca «ninguna»—. Entonces cada fila es solo el
 * formulario, y no hay nada que escoger antes de llenarlo.
 */
function isFreeForm(definition: ListDefinition): boolean {
  const listId = String(definition.ListID ?? '').trim();

  return (
    !isOn(definition.hasLocations) &&
    !isOn(definition.hasAssets) &&
    !isOn(definition.hasItems) &&
    !isOn(definition.hasUsers) &&
    String(definition.hasParent ?? '').trim() === '' &&
    (listId === '-1' || listId === '0' || listId === '')
  );
}

/**
 * Interpreta los indicadores de una lista.
 *
 * Llegan como `'1'`, `'0'`, `'true'` o vacíos según por dónde entró la fila. Un
 * `Boolean('false')` es `true`, y por ahí se colaban listas de usuarios que no
 * lo eran.
 */
function isOn(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'number') return value === 1;

  const text = String(value ?? '').trim().toLowerCase();
  return text === '1' || text === 'true';
}

/** Un registro con datos, no un `{}` de «se buscó y no estaba». */
function isFilled(value: unknown): boolean {
  return Boolean(value) && typeof value === 'object' && Object.keys(value as object).length > 0;
}
