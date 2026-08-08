import { Injectable, inject } from '@angular/core';

import { resolveCatalogOwnerId } from '../config/company-rules';
import { AnswerField, FormField, valueToText } from '../forms/form-schema';
import { Asset, EntityType, LocationForm } from '../models/entities.model';
import {
  AssetRepository,
  AssetTypeRepository,
  LocationRepository,
  LocationTypeRepository,
} from '../repositories/entity.repositories';
import { AuthService } from '../services/auth.service';
import { DataRevisionService } from '../sync/data-revision.service';

/** Los campos propios de una entidad, tal como los guarda la app. */
interface EntityValues {
  /** GUID de la entidad. */
  id: string;
  /** Su nombre, repetido aquí porque así lo escribe la app. */
  name: string;
  /** Un elemento por campo respondido. */
  fie: AnswerField[];
}

/** Lo que hace falta para crear o modificar una ubicación. */
export interface LocationDraft {
  guid: string;
  name: string;
  /** Tipo elegido. Define qué campos se piden. */
  type: EntityType;
  /** Respuestas de los campos del tipo. */
  answers: AnswerField[];
  /** Descriptivos, para el listado. */
  titles: { id: string; lab: string; val: string }[];
  /** Coordenadas, si algún campo GPS las capturó. */
  latitude?: string;
  longitude?: string;
}

/** Lo mismo para un activo, que cuelga de una ubicación. */
export interface AssetDraft extends Omit<LocationDraft, 'type'> {
  type: EntityType;
  /** Ubicación a la que pertenece, por su identificador de servidor. */
  locationId: string;

  /**
   * …y por su GUID.
   *
   * Es lo único que hay cuando la ubicación también se creó aquí y todavía no
   * ha subido. Ver `Asset.LocationGUID`.
   */
  locationGuid?: string;
}

/**
 * Crear y modificar ubicaciones y activos desde el navegador.
 *
 * ## Qué las distingue de una actividad
 *
 * Una actividad guarda sus respuestas en `SurveyAnswers.Fields`. Una ubicación
 * las guarda **dentro de sí misma**, en `jsonValues`, con una forma propia:
 * `{id, name, fie: […]}`. El motor de formularios sirve igual para pintarlas y
 * validarlas —los campos son los mismos `fty`— pero lo que sale de él hay que
 * envolverlo antes de escribirlo.
 *
 * ## Qué significa guardar aquí
 *
 * Nada viaja al servidor en el momento. La entidad queda marcada con
 * `CreateWithMovil = '1'` y `Upload = '0'`, que es como la app señala «esto lo
 * hice yo y todavía no está allá arriba»; la sincronización las recoge después.
 * Modificar una que ya existe la vuelve a marcar igual, para que el cambio
 * también suba.
 */
@Injectable({ providedIn: 'root' })
export class LocationEditorService {
  private readonly locations = inject(LocationRepository);
  private readonly locationTypes = inject(LocationTypeRepository);
  private readonly assets = inject(AssetRepository);
  private readonly assetTypes = inject(AssetTypeRepository);
  private readonly auth = inject(AuthService);
  private readonly revisions = inject(DataRevisionService);

  // ── Catálogos ──────────────────────────────────────────────────────────────

  /** Tipos de ubicación disponibles para el usuario. */
  async locationTypesOf(): Promise<EntityType[]> {
    const owner = this.owner();
    return owner === null ? [] : this.locationTypes.findByUser(owner);
  }

  /**
   * Tipos de activo que admite una ubicación.
   *
   * Un tipo de activo puede estar atado a un tipo de ubicación
   * (`LocationTypeID`): un extintor cuelga de una sede, no de un vehículo. Los
   * que no lo declaran valen para cualquiera.
   */
  async assetTypesFor(locationTypeId: string): Promise<EntityType[]> {
    const owner = this.owner();
    if (owner === null) return [];

    const all = await this.assetTypes.findByUser(owner);
    const needle = String(locationTypeId ?? '').trim();

    return all.filter((type) => {
      const bound = String(type.LocationTypeID ?? '').trim();
      return !bound || bound === '0' || bound === needle;
    });
  }

  /**
   * Un tipo de activo por su identificador, sin filtrar por tipo de ubicación.
   *
   * Lo usa el alta cuando el formulario **exige** un tipo concreto: puede estar
   * declarado para otro tipo de sede y quedar fuera de [assetTypesFor], y
   * entonces el editor no tendría con qué montarse — dejando al usuario ante un
   * «no hay tipos» justo después de que la plataforma le pidiera ese tipo.
   */
  async assetTypeById(id: string): Promise<EntityType | null> {
    const owner = this.owner();
    const needle = String(id ?? '').trim();

    if (owner === null || !needle) return null;

    const all = await this.assetTypes.findByUser(owner);
    return all.find((type) => String(type.ID) === needle) ?? null;
  }

  // ── Lectura ────────────────────────────────────────────────────────────────

  async findLocation(guid: string): Promise<LocationForm | null> {
    return this.locations.getByIndex('byGUID', guid);
  }

  async findAsset(guid: string): Promise<Asset | null> {
    return this.assets.getByIndex('byGUID', guid);
  }

  /**
   * Las respuestas guardadas de una entidad, listas para el motor.
   *
   * Llegan de dos formas según de dónde venga el registro: las creadas aquí
   * traen el objeto `{id, name, fie}`, y las que bajan del servidor, el arreglo
   * suelto. La app contempla las dos y aquí también.
   */
  answersOf(jsonValues: unknown): AnswerField[] {
    const decoded = decode(jsonValues);

    if (Array.isArray(decoded)) return decoded as AnswerField[];

    const nested = (decoded as { fie?: unknown } | null)?.fie;
    return Array.isArray(nested) ? (nested as AnswerField[]) : [];
  }

  // ── Escritura ──────────────────────────────────────────────────────────────

  /**
   * Crea o actualiza una ubicación.
   *
   * El identificador es el GUID: si ya existe un registro con ese GUID se
   * modifica, y si no, se crea. Así la misma llamada sirve para las dos cosas y
   * no hay dos caminos que puedan divergir.
   */
  async saveLocation(draft: LocationDraft): Promise<LocationForm> {
    const user = this.auth.currentUser();
    if (!user) throw new Error('No hay una sesión activa.');

    const existing = await this.findLocation(draft.guid);
    const now = new Date().toISOString();

    const record: LocationForm = {
      ...(existing ?? blankLocation()),
      ID: existing?.ID ?? 0,
      GUID: draft.guid,
      UserID: resolveCatalogOwnerId(user),
      Name: draft.name,

      LocationTypeGUID: String(draft.type.ID ?? ''),
      LocationTypeGD: draft.type.GUID,
      typeTitle: draft.type.Name,
      jsonQuestion: draft.type.jsonFields,
      jsonDescriptor: draft.type.jsonDescriptors,

      jsonValues: JSON.stringify(this.wrap(draft.guid, draft.name, draft.answers)),
      JSONTitle: JSON.stringify(draft.titles),

      Latitude: draft.latitude ?? existing?.Latitude ?? '',
      Longitude: draft.longitude ?? existing?.Longitude ?? '',

      // Así marca la app lo que se hizo en el dispositivo y falta por subir. Se
      // vuelve a marcar al editar: el cambio también tiene que viajar.
      CreateWithMovil: '1',

      /**
       * Guardar la deja pendiente de subir, aunque ya estuviera sincronizada.
       *
       * `Upload` es lo que dice «esto tiene cambios sin mandar», y se reinicia
       * en **cada** guardado. Antes lo pendiente se miraba por
       * `SyncedToServer`, que no se revierte nunca, así que **editar una sede
       * descargada no llegaba jamás a Visitrack**: el cambio se quedaba en el
       * dispositivo y en la plataforma seguía lo viejo. Peor que no poder
       * editar, porque el usuario cree que ya está.
       *
       * `SyncedToServer` se conserva a propósito: significa «esto ya existe
       * allá», y es lo que impide borrarla desde aquí. Reiniciarlo dejaría
       * borrar del dispositivo algo que la plataforma sigue teniendo.
       *
       * El endpoint del servidor inserta o actualiza según el GUID, así que
       * volver a mandarla es exactamente lo que hay que hacer.
       */
      Upload: '0',
      SyncedToServer: existing?.SyncedToServer ?? '0',
      SyncOn: '0',
      isDeleted: '0',
      UpdatedOn: now,
      CreatedOn: existing?.CreatedOn || now,
    };

    // Sin `ID` la clave la pone IndexedDB; con él se reemplaza el registro.
    // Sin llave, `put` falla: este store no autoincrementa porque las
    // ubicaciones que bajan del servidor traen su propio `ID`. Ver
    // [BaseRepository.nextLocalKey].
    if (!record.ID) record.ID = await this.locations.nextLocalKey();

    await this.locations.put(record);
    this.revisions.touchEntities();

    return record;
  }

  /** Crea o actualiza un activo. */
  async saveAsset(draft: AssetDraft): Promise<Asset> {
    const user = this.auth.currentUser();
    if (!user) throw new Error('No hay una sesión activa.');

    const existing = await this.findAsset(draft.guid);
    const now = new Date().toISOString();

    const record: Asset = {
      ...(existing ?? blankAsset()),
      ID: existing?.ID ?? 0,
      GUID: draft.guid,
      UserID: resolveCatalogOwnerId(user),
      Name: draft.name,

      AssetTypeGUID: String(draft.type.ID ?? ''),
      AssetTypeGD: draft.type.GUID,
      typeTitle: draft.type.Name,
      jsonQuestion: draft.type.jsonFields,
      jsonDescriptor: draft.type.jsonDescriptors,

      LocationID: Number(draft.locationId) || 0,
      LocationGUID: draft.locationGuid ?? existing?.LocationGUID ?? '',
      jsonValues: JSON.stringify(this.wrap(draft.guid, draft.name, draft.answers)),
      JSONTitle: JSON.stringify(draft.titles),

      Latitude: draft.latitude ?? existing?.Latitude ?? '',
      Longitude: draft.longitude ?? existing?.Longitude ?? '',

      CreateWithMovil: '1',

      /**
       * Guardar la deja pendiente de subir, aunque ya estuviera sincronizada.
       *
       * `Upload` es lo que dice «esto tiene cambios sin mandar», y se reinicia
       * en **cada** guardado. Antes lo pendiente se miraba por
       * `SyncedToServer`, que no se revierte nunca, así que **editar una sede
       * descargada no llegaba jamás a Visitrack**: el cambio se quedaba en el
       * dispositivo y en la plataforma seguía lo viejo. Peor que no poder
       * editar, porque el usuario cree que ya está.
       *
       * `SyncedToServer` se conserva a propósito: significa «esto ya existe
       * allá», y es lo que impide borrarla desde aquí. Reiniciarlo dejaría
       * borrar del dispositivo algo que la plataforma sigue teniendo.
       *
       * El endpoint del servidor inserta o actualiza según el GUID, así que
       * volver a mandarla es exactamente lo que hay que hacer.
       */
      Upload: '0',
      SyncedToServer: existing?.SyncedToServer ?? '0',
      SyncOn: '0',
      isDeleted: '0',
      UpdatedOn: now,
      CreatedOn: existing?.CreatedOn || now,
    };

    if (!record.ID) record.ID = await this.assets.nextLocalKey();

    await this.assets.put(record);
    this.revisions.touchEntities();

    return record;
  }

  /**
   * Borra una entidad creada aquí que todavía no subió.
   *
   * Solo eso: lo que ya está en el servidor no se borra desde el dispositivo —
   * la app tampoco lo permite, y hacerlo dejaría al servidor con un registro que
   * nadie volvería a ver desde aquí.
   */
  async removeLocation(guid: string): Promise<boolean> {
    const record = await this.findLocation(guid);
    if (!record || record.SyncedToServer === '1') return false;

    await this.locations.delete(record.ID);
    this.revisions.touchEntities();
    return true;
  }

  async removeAsset(guid: string): Promise<boolean> {
    const record = await this.findAsset(guid);
    if (!record || record.SyncedToServer === '1') return false;

    await this.assets.delete(record.ID);
    this.revisions.touchEntities();
    return true;
  }

  /**
   * Envuelve las respuestas con la forma que guarda la app.
   *
   * `id` y `name` se repiten dentro del propio `jsonValues`: es redundante con
   * las columnas del registro, pero el servidor lee de ahí y quitarlo dejaría
   * las entidades creadas en la web sin nombre al llegar.
   */
  private wrap(guid: string, name: string, answers: readonly AnswerField[]): EntityValues {
    return { id: guid, name, fie: [...answers] };
  }

  private owner(): number | null {
    const user = this.auth.currentUser();
    return user ? resolveCatalogOwnerId(user) : null;
  }
}

/**
 * Los descriptivos de una entidad, a partir de lo respondido.
 *
 * Son los campos marcados con `pri`, igual que en una actividad. Es lo que se
 * enseña bajo el nombre en el listado, y lo que permite distinguir dos sedes
 * que se llaman parecido.
 */
export function titlesFrom(
  fields: readonly FormField[],
  read: (id: string) => unknown,
): { id: string; lab: string; val: string }[] {
  const titles: { id: string; lab: string; val: string }[] = [];

  for (const field of fields) {
    if (!field.pri) continue;

    const value = valueToText(read(field.id) as never);
    if (value) titles.push({ id: field.id, lab: field.lab, val: value });
  }

  return titles;
}

function decode(raw: unknown): unknown {
  if (!raw) return null;
  if (typeof raw !== 'string') return raw;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function blankLocation(): LocationForm {
  return {
    ID: 0,
    GUID: '',
    UserID: 0,
    WorkZoneID: '',
    Name: '',
    LocationID: '',
    LocationTypeGUID: '',
    LocationTypeGD: '',
    TagUID: '',
    Description: '',
    ContactName: '',
    Email: '',
    Phone: '',
    Fax: '',
    FullAddress: '',
    Street: '',
    City: '',
    State: '',
    PostalCode: '',
    Country: '',
    Latitude: '',
    Longitude: '',
    JSONTitle: '',
    jsonValues: '',
    jsonQuestion: '',
    jsonDescriptor: '',
    typeTitle: '',
    isDeleted: '0',
    SyncOn: '0',
    VTEntityID: 0,
    Upload: '0',
    CreateWithMovil: '1',
    SyncedToServer: '0',
  };
}

function blankAsset(): Asset {
  return {
    ID: 0,
    GUID: '',
    UserID: 0,
    Name: '',
    AssetID: 0,
    AssetTypeGUID: '',
    AssetTypeGD: '',
    TagUID: '',
    LocationID: 0,
    LocationGUID: '',
    Description: '',
    JSONTitle: '',
    Make: '',
    Model: '',
    SerialNumber: '',
    Latitude: '',
    Longitude: '',
    jsonValues: '',
    jsonQuestion: '',
    jsonDescriptor: '',
    typeTitle: '',
    isDeleted: '0',
    SyncOn: '0',
    VTEntityID: 0,
    Upload: '0',
    CreateWithMovil: '1',
    SyncedToServer: '0',
  };
}
