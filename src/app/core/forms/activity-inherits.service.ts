import { Injectable, inject } from '@angular/core';

import { resolveCatalogOwnerId } from '../config/company-rules';
import { SurveyAnswer } from '../models/entities.model';
import { AssetRepository, LocationRepository } from '../repositories/entity.repositories';
import { AuthService } from '../services/auth.service';
import { InheritedSource } from './inherited-defaults';

/**
 * La ubicación y el activo de una actividad, para los campos que heredan.
 *
 * ## Por qué hace falta
 *
 * Un campo puede tener como valor por defecto un dato de la sede o del equipo
 * que se está inspeccionando —la dirección, el NIT, la placa—. Quien diseña el
 * formulario lo marca en el campo y no vuelve a preocuparse: al abrir la
 * actividad tiene que aparecer escrito.
 *
 * Resolver eso pide dos cosas, y solo la segunda estaba: el motor sabe *qué*
 * dato leer ([resolveInheritedDefault]), pero alguien tiene que darle *de dónde*
 * leerlo. Las tablas de detalle lo hacían por su cuenta —cada fila nace de un
 * ítem y lo tiene a mano—; el formulario principal no lo hacía nadie, así que
 * sus campos heredados salían en blanco.
 *
 * ## De dónde salen los registros
 *
 * De la base local, por el identificador que la actividad guarda. Es lo mismo
 * que hace la app: releer la ubicación en el momento de abrir, y no confiar en
 * una copia vieja — entre que se creó la actividad y se diligencia, la sede
 * pudo cambiar de dirección o de contacto.
 */
@Injectable({ providedIn: 'root' })
export class ActivityInheritsService {
  private readonly auth = inject(AuthService);
  private readonly locations = inject(LocationRepository);
  private readonly assets = inject(AssetRepository);

  /**
   * Los registros de los que hereda una actividad.
   *
   * Nunca falla: sin sesión, sin ubicación o con una ubicación que ya no está
   * descargada, devuelve lo que tenga. Un campo sin heredar queda vacío para
   * que lo llene quien responde, que es mucho mejor que no poder abrir el
   * formulario.
   *
   * `itemsInfo` se queda fuera a propósito: una actividad no nace de un ítem de
   * lista —eso solo pasa dentro de una tabla de detalle, que arma su propia
   * fuente con la fila.
   */
  async forAnswer(answer: SurveyAnswer, questions: unknown): Promise<InheritedSource> {
    // La mayoría de formularios no heredan nada, y buscar la sede sin que nadie
    // vaya a usarla retrasa el dibujado por gusto. La comprobación se hace
    // sobre el esquema en crudo porque es un vistazo a un texto, mucho más
    // barato que recorrer páginas y campos.
    if (!inheritsAnything(questions)) return {};

    const user = this.auth.currentUser();
    if (!user) return {};

    const owner = resolveCatalogOwnerId(user);
    if (!owner) return {};

    // El GUID como respaldo: una sede creada aquí todavía no tiene
    // identificador del servidor —lo asigna Visitrack al sincronizar— y la
    // actividad la guarda con `LocationID` en cero. Los repositorios buscan por
    // las dos cosas, así que basta con darles la que sirva.
    const locationId = usable(answer.LocationID) || usable(answer.LocationGUID);
    const assetId = usable(answer.AssetID) || usable(answer.AssetGUID);

    // Las dos búsquedas van juntas: son independientes y cada una recorre su
    // propio almacén, así que en serie solo se sumarían esperas.
    const [location, asset] = await Promise.all([
      this.find(() => this.locations.findByLocationId(owner, locationId), locationId),
      this.find(() => this.assets.findByAssetId(owner, assetId), assetId),
    ]);

    const source: InheritedSource = {};
    if (location) source.LocationInfo = location;
    if (asset) source.AssetInfo = asset;

    return source;
  }

  /** Busca solo si hay identificador, y traga el fallo de la base local. */
  private async find<T>(buscar: () => Promise<T | null>, id: string): Promise<T | null> {
    if (!id) return null;

    try {
      return await buscar();
    } catch (error) {
      console.warn('[Herencia] no se pudo leer el registro relacionado', error);
      return null;
    }
  }
}

/** El identificador si de verdad señala a algo. */
function usable(valor: unknown): string {
  const texto = String(valor ?? '').trim();
  return texto && texto !== '0' ? texto : '';
}

/**
 * ¿Algún campo de este formulario hereda?
 *
 * Se busca la bandera en el esquema sin interpretarlo. Un falso positivo —la
 * palabra aparece pero desactivada— solo cuesta dos lecturas locales que no se
 * usan; un falso negativo dejaría campos en blanco, y por eso la expresión
 * acepta las tres formas en que la bandera llega escrita.
 */
function inheritsAnything(questions: unknown): boolean {
  if (!questions) return false;

  const texto = typeof questions === 'string' ? questions : JSON.stringify(questions);

  // Dos familias: la de las banderas y la de los `ASS_…`, que se reconocen por
  // el prefijo y pueden venir sin ninguna bandera puesta.
  return (
    /"default(?:IsLocation|IsAsset|IsList|IsItem)Field"\s*:\s*(?:true|1|"1")/.test(texto) ||
    /ASS_[A-Z]/i.test(texto)
  );
}
