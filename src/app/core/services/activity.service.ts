import { Injectable, inject, signal } from '@angular/core';

import { resolveCatalogOwnerId } from '../config/company-rules';
import { Asset, LocationForm, Survey, SurveyAnswer } from '../models/entities.model';
import {
  AssetRepository,
  AssetTypeRepository,
  LocationRepository,
  LocationTypeRepository,
  SurveyRepository,
} from '../repositories/entity.repositories';
import { BinaryResourceRepository } from '../repositories/binary.repository';
import { SurveyAnswerRepository } from '../repositories/survey-answer.repository';
import { AuthService } from './auth.service';
import { BinaryStorageService } from './binary-storage.service';
import { DraftPolicyService } from './draft-policy.service';

/**
 * Qué pantalla toca antes de poder diligenciar.
 *
 * - `location`: falta elegir la ubicación.
 * - `asset`: falta elegir el activo.
 * - `form`: ya está todo, se abre el formulario.
 */
export type ActivityStep = 'location' | 'asset' | 'form';

/** Lo que un formulario exige antes de dejarse diligenciar. */
export interface SurveyRequirements {
  requiresLocation: boolean;
  requiresAsset: boolean;
  /** GUID del tipo de ubicación que se debe elegir. */
  locationTypeGuid: string;
  /** GUID del tipo de activo que se debe elegir. */
  assetTypeGuid: string;
}

/**
 * ¿Este campo pide de verdad una ubicación?
 *
 * `LocationTypeID` llega unas veces como número y otras como texto, según haya
 * bajado del servidor o se haya escrito en el cliente. Comparar contra `0` a
 * secas da falsos negativos con `'0'` y falsos positivos con `''`, así que se
 * normaliza: hay requisito cuando el valor existe y no es cero.
 */
function isMeaningfulTypeId(value: unknown): boolean {
  const text = (value ?? '').toString().trim();
  if (!text || text === '0') return false;

  const numeric = Number(text);
  // Los GUID no son números: si no se puede convertir, es un identificador
  // válido y por tanto sí hay requisito.
  return Number.isNaN(numeric) ? true : numeric > 0;
}

/** Qué exige un formulario antes de abrirse. */
export function readRequirements(survey: Survey): SurveyRequirements {
  return {
    requiresLocation: isMeaningfulTypeId(survey.LocationTypeID),
    requiresAsset: Number(survey.hasAsset) === 1,
    locationTypeGuid: (survey.LocationTypeID ?? '').toString(),
    assetTypeGuid: (survey.AssetTypeID ?? '').toString(),
  };
}

/**
 * Siguiente paso para una actividad.
 *
 * Es **la** regla del flujo de apertura, y por eso es una función pura y no
 * está repartida entre los componentes: en la app móvil esta decisión estaba
 * escrita cuatro veces con anidamientos distintos —al crear, al abrir con
 * ubicación, al abrir sin ella, al volver del selector— y bastaba con corregir
 * una para que las otras tres quedaran desalineadas.
 *
 * Se apoya en lo que la actividad **ya tiene guardado**, no en por dónde venía
 * el usuario: alguien que abandonó el flujo a mitad de camino y vuelve a entrar
 * retoma justo donde lo dejó, sin que se le vuelva a preguntar lo ya resuelto.
 */
export function resolveNextStep(
  requirements: SurveyRequirements,
  answer: Pick<SurveyAnswer, 'LocationID' | 'AssetID' | 'AssetName'>,
): ActivityStep {
  if (requirements.requiresLocation && !answer.LocationID) return 'location';

  if (requirements.requiresAsset) {
    // El nombre también cuenta: un activo con identificador pero sin nombre es
    // una asociación a medias que dejaría la ficha sin nada que mostrar.
    const hasAsset = Boolean(answer.AssetID) && Boolean(answer.AssetName);
    if (!hasAsset) return 'asset';
  }

  return 'form';
}

/**
 * Actividades: creación, asociación de ubicación y activo, y mantenimiento.
 *
 * Es el equivalente del `FormProvider` del móvil en lo que respecta al ciclo de
 * vida de una actividad. Los componentes no escriben en el repositorio
 * directamente: pasan por aquí, y así cada escritura avisa al resto de la
 * interfaz sin que nadie tenga que acordarse de hacerlo.
 */
@Injectable({ providedIn: 'root' })
export class ActivityService {
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly surveys = inject(SurveyRepository);
  private readonly locations = inject(LocationRepository);
  private readonly locationTypes = inject(LocationTypeRepository);
  private readonly assets = inject(AssetRepository);
  private readonly assetTypes = inject(AssetTypeRepository);
  private readonly binaries = inject(BinaryResourceRepository);
  private readonly binaryStorage = inject(BinaryStorageService);
  private readonly drafts = inject(DraftPolicyService);
  private readonly auth = inject(AuthService);

  /**
   * Contador que sube con cada cambio en las actividades.
   *
   * Las pantallas lo leen en un `effect` para recargarse. Es un contador y no
   * un booleano porque dos cambios seguidos deben producir dos recargas: con un
   * booleano el segundo pasaría inadvertido si el primero no se ha consumido.
   */
  readonly revision = signal(0);

  /** Avisa de que algo cambió. Lo llaman también los flujos externos. */
  notifyChanged(): void {
    this.revision.update((value) => value + 1);
  }

  private get userId(): string {
    return this.auth.currentUser()?.UserID ?? '';
  }

  /** `UserID` bajo el que están los catálogos de esta cuenta. */
  private get ownerId(): number {
    const user = this.auth.currentUser();
    return user ? resolveCatalogOwnerId(user) : 0;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Consulta
  // ───────────────────────────────────────────────────────────────────────────

  /** Formulario por su `SurveyID`. */
  async findSurvey(surveyId: string): Promise<Survey | null> {
    return this.surveys.findBySurveyId(surveyId);
  }

  /** Actividades del formulario, con el estado de despacho ya resuelto. */
  async listBySurvey(surveyId: string): Promise<SurveyAnswer[]> {
    return this.answers.findBySurvey(this.userId, surveyId);
  }

  async findByGuid(guid: string): Promise<SurveyAnswer | null> {
    return this.answers.findByGuid(guid);
  }

  /** La ubicación asociada a una actividad, si la tiene. */
  async locationOf(answer: SurveyAnswer): Promise<LocationForm | null> {
    if (!answer.LocationID) return null;
    return this.locations.findByLocationId(this.ownerId, answer.LocationID);
  }

  /** El activo asociado a una actividad, si lo tiene. */
  async assetOf(answer: SurveyAnswer): Promise<Asset | null> {
    if (!answer.AssetID) return null;
    return this.assets.findByAssetId(this.ownerId, answer.AssetID);
  }

  // ── Catálogos para los selectores ──────────────────────────────────────────
  //
  // Pasan por aquí, y no por los repositorios directamente, para que la regla
  // de la compañía con catálogos compartidos viva en un solo sitio. Un
  // componente que resolviera el `UserID` por su cuenta le mostraría una lista
  // vacía a esos usuarios.

  /** Ubicaciones de un tipo, paginadas y alfabéticas. */
  async listLocations(
    typeGuid: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<LocationForm[]> {
    return this.locations.findByType(this.ownerId, typeGuid, options);
  }

  async countLocations(typeGuid: string): Promise<number> {
    return this.locations.countByType(this.ownerId, typeGuid);
  }

  /** Activos de un tipo dentro de una ubicación. */
  async listAssets(
    typeGuid: string,
    locationId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<Asset[]> {
    return this.assets.findByTypeAndLocation(this.ownerId, typeGuid, locationId, options);
  }

  async countAssets(typeGuid: string, locationId: string): Promise<number> {
    return this.assets.countByTypeAndLocation(this.ownerId, typeGuid, locationId);
  }

  /** Nombre del tipo de ubicación, para titular el selector. */
  async locationTypeName(guid: string): Promise<string> {
    return this.locationTypes.nameOf(guid);
  }

  /** Nombre del tipo de activo. */
  async assetTypeName(guid: string): Promise<string> {
    return this.assetTypes.nameOf(guid);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Ciclo de vida
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Crea una actividad para este formulario y la deja guardada.
   *
   * Queda en la lista de inmediato, antes de que el usuario elija ubicación o
   * llegue al formulario. Es deliberado: si abandona el flujo a medias, la
   * actividad está ahí y puede retomarla, en vez de haberse esfumado sin dejar
   * rastro de que llegó a existir.
   */
  async create(survey: Survey): Promise<SurveyAnswer> {
    const user = this.auth.currentUser();
    if (!user) throw new Error('No hay una sesión activa.');

    const answer = await this.answers.createDraft({
      survey,
      userId: user.UserID,
      companyId: user.CompanyID,
    });

    this.notifyChanged();
    return answer;
  }

  /** Asocia la ubicación elegida y avisa al resto de la interfaz. */
  async attachLocation(answer: SurveyAnswer, location: LocationForm): Promise<SurveyAnswer | null> {
    if (answer.ID == null) return null;

    const updated = await this.answers.attachLocation(answer.ID, location);
    this.notifyChanged();
    return updated;
  }

  /** Asocia el activo elegido. */
  async attachAsset(answer: SurveyAnswer, asset: Asset): Promise<SurveyAnswer | null> {
    if (answer.ID == null) return null;

    const updated = await this.answers.attachAsset(answer.ID, asset);
    this.notifyChanged();
    return updated;
  }

  /**
   * Elimina una actividad y sus archivos.
   *
   * @returns 'flagged' cuando ya había subido y solo se marcó para que el
   *   borrado llegue a Visitrack en la próxima sincronización.
   */
  async remove(answer: SurveyAnswer): Promise<'deleted' | 'flagged'> {
    const result = await this.answers.remove(answer);

    // Los archivos se van con ella en los dos casos: los del servidor ya no le
    // sirven a nadie, y los locales solo ocuparían espacio sin dueño. Se borra
    // por el servicio de almacenamiento y no por el repositorio para que se
    // lleve también el contenido, que vive en otro store.
    await this.binaryStorage.removeByAnswer(answer.GUID);

    this.notifyChanged();
    return result;
  }

  // ── Archivos de la actividad ───────────────────────────────────────────────

  /** Cuántos archivos tiene la actividad. */
  async countBinaries(answerGuid: string): Promise<number> {
    return this.binaries.countByAnswer(answerGuid);
  }

  /**
   * Cuántos archivos impiden enviarla.
   *
   * Se consulta antes de eliminar: borrar una actividad con archivos a medio
   * subir deja huérfano lo que ya llegó al servidor.
   */
  async countBlockingBinaries(answerGuid: string): Promise<number> {
    return this.binaries.countBlockingByAnswer(answerGuid);
  }

  /**
   * Devuelve los archivos de la actividad al estado inicial para que se vuelvan
   * a subir. Es la salida cuando alguno se quedó atascado.
   */
  async reprocessBinaries(answerGuid: string): Promise<number> {
    const count = await this.binaries.markPendingByAnswer(answerGuid);
    if (count > 0) this.notifyChanged();
    return count;
  }

  /**
   * Dirección del PDF de una actividad.
   *
   * Lo genera el servidor a partir del GUID, así que basta con abrirlo: no hay
   * nada que descargar ni que guardar en este lado.
   */
  pdfUrl(answerGuid: string): string {
    return `https://vtmobileplus.visitrack.com/pdf2?GUID=${encodeURIComponent(answerGuid)}`;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Mantenimiento
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Limpieza que corre al entrar al listado y al refrescar.
   *
   * Junta las dos formas de limpiar borradores porque siempre van juntas y
   * separarlas solo lograba que alguna pantalla llamara a una y olvidara la
   * otra: la caducidad por tiempo y el barrido de los que quedaron huérfanos
   * tras un cierre abrupto.
   *
   * @returns cuántas actividades se eliminaron.
   */
  async runMaintenance(exceptGuid?: string): Promise<number> {
    let removed = 0;

    try {
      removed += await this.drafts.purgeExpired();
      removed += await this.drafts.cleanupOrphans(exceptGuid);
    } catch (error) {
      // La limpieza es oportunista: que falle no puede impedir ver la lista.
      console.error('[Activity] falló la limpieza de borradores', error);
    }

    if (removed > 0) this.notifyChanged();
    return removed;
  }
}
