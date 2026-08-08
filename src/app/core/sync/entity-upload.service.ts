import { Injectable, inject, signal } from '@angular/core';

import { resolveCatalogOwnerId } from '../config/company-rules';
import { Asset, ListDetail, LocationForm, SurveyAnswer } from '../models/entities.model';
import {
  AssetRepository,
  ListDetailRepository,
  LocationRepository,
  WorkZoneRepository,
} from '../repositories/entity.repositories';
import { SurveyAnswerRepository } from '../repositories/survey-answer.repository';
import { AuthService } from '../services/auth.service';
import { ConnectivityService } from '../services/connectivity.service';
import { DataRevisionService } from './data-revision.service';
import { EntityStatusService } from './entity-status.service';
import { UploadApiService } from './upload-api.service';

/** Cómo terminó una corrida. */
export interface EntityUploadSummary {
  locations: number;
  assets: number;
  items: number;

  /** Quedaron para la siguiente vuelta porque su padre aún no ha subido. */
  deferred: number;

  failed: number;
  message: string;
}

/**
 * Lleva a Visitrack las ubicaciones, activos e ítems de lista creados aquí.
 *
 * ## Por qué esto va antes que las actividades
 *
 * Una actividad creada contra una sede que se dio de alta en este dispositivo
 * **no lleva el identificador de la sede**: lleva su GUID, porque el
 * identificador lo asigna el servidor y todavía no existe. Si esa actividad
 * sube primero, en Visitrack queda apuntando a un identificador que no
 * corresponde a nada — y nada la corrige después: el registro ya está creado,
 * parece completo, y nadie lo vuelve a mirar.
 *
 * Lo mismo con un ítem de lista elegido en una tabla de detalle: la respuesta
 * guarda su `ListDetGUID`, y si el ítem no llegó, la actividad referencia algo
 * que del otro lado no existe.
 *
 * Por eso el orden **no es una optimización, es la regla**: primero las
 * entidades, después las actividades. Y una actividad que todavía dependa de
 * algo sin subir no sale — ver `blockersOf`.
 *
 * ## El orden entre las propias entidades
 *
 * 1. **Ubicaciones.** No dependen de nadie.
 * 2. **Activos.** Cuelgan de una sede: si la suya se creó aquí y aún no ha
 *    subido, el activo espera. Subirlo sin su `LocationID` real lo dejaría
 *    colgando de la nada.
 * 3. **Ítems de lista.** Pueden colgar de otro ítem (`ParentGUID`) o estar
 *    ligados a una sede o a un activo. Se ordenan padres primero y se aplazan
 *    los que apunten a algo que sigue pendiente.
 *
 * Lo que se aplaza no es un fallo: vuelve a intentarse en la corrida siguiente,
 * cuando su padre ya esté arriba.
 *
 * ## Qué pasa al subir
 *
 * El servidor devuelve el identificador de verdad y con él se reescribe todo lo
 * que llevaba el GUID en su lugar: la propia entidad, las actividades que la
 * referencian y los activos que colgaban de ella. Es lo mismo que hace la app
 * en `updateLocationIDFromServer`.
 */
@Injectable({ providedIn: 'root' })
export class EntityUploadService {
  private readonly locations = inject(LocationRepository);
  private readonly assets = inject(AssetRepository);
  private readonly details = inject(ListDetailRepository);
  private readonly zones = inject(WorkZoneRepository);
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly api = inject(UploadApiService);
  private readonly auth = inject(AuthService);
  private readonly connectivity = inject(ConnectivityService);
  private readonly revisions = inject(DataRevisionService);
  private readonly status = inject(EntityStatusService);

  /** Hay una corrida en marcha. */
  readonly running = signal(false);

  readonly lastSummary = signal<EntityUploadSummary | null>(null);

  /**
   * El servidor no tiene los endpoints desplegados.
   *
   * Se recuerda para no machacarlo con una corrida por minuto que va a fallar
   * igual, y para poder decirlo en la pantalla de sincronización en vez de
   * dejar las entidades pendientes sin explicación.
   */
  readonly notImplemented = signal(false);

  /**
   * Lo pendiente, leído una sola vez.
   *
   * Lo usa quien va a preguntar por muchas actividades seguidas: sin esto, una
   * cola de treinta actividades recorría las tres tablas treinta veces para
   * llegar siempre a la misma respuesta.
   */
  async snapshot(): Promise<PendingEntities> {
    return this.collect();
  }

  /** Cuántas entidades siguen sin llegar a Visitrack. */
  async pendingCount(): Promise<number> {
    const pending = await this.collect();
    return pending.locations.length + pending.assets.length + pending.items.length;
  }

  /**
   * Sube lo que haya pendiente.
   *
   * Es idempotente y silenciosa: si no hay nada, no consulta nada.
   */
  async run(): Promise<EntityUploadSummary> {
    if (this.running()) return this.lastSummary() ?? empty('Ya hay una subida en curso.');
    if (!this.auth.currentUser()) return empty('No hay una sesión activa.');
    if (!this.connectivity.isOnline()) return empty('Sin conexión.');

    this.running.set(true);

    try {
      const pending = await this.collect();

      if (pending.locations.length + pending.assets.length + pending.items.length === 0) {
        const summary = empty('No hay entidades pendientes.');
        this.lastSummary.set(summary);
        return summary;
      }

      const done = { locations: 0, assets: 0, items: 0, deferred: 0, failed: 0 };

      await this.pushLocations(pending.locations, done);

      /**
       * Los activos se releen después de subir las ubicaciones.
       *
       * La lista de arriba se tomó antes, cuando sus sedes todavía no tenían
       * identificador de Visitrack. Usarla dejaría en espera a un activo cuya
       * ubicación acaba de subir **en esta misma vuelta**, y habría que esperar
       * al ciclo siguiente sin ninguna razón.
       */
      const assets = done.locations > 0 ? (await this.collect()).assets : pending.assets;

      await this.pushAssets(assets, done);
      await this.pushItems(pending.items, done);

      if (done.locations + done.assets + done.items > 0) {
        this.revisions.touchEntities();

        /**
         * Los totales se vuelven a comparar contra el servidor.
         *
         * Acaban de cambiar **de los dos lados**: aquí, porque los registros
         * dejaron de estar pendientes; y allá, porque son nuevos. La pantalla
         * de sincronización guarda el último conteo, así que sin esto seguiría
         * enseñando el de antes de subir — con el catálogo local «por delante»
         * del servidor y un semáforo en rojo que ya no significa nada.
         *
         * Va después de subir y no antes, y sin poder tumbar la corrida: que
         * los números tarden en cuadrar es un inconveniente; que un fallo al
         * consultarlos deshaga una subida que sí funcionó, no.
         */
        try {
          await this.status.loadLocalCounts();
          await this.status.checkAgainstServer();
        } catch (error) {
          console.warn('[Entidades] no se pudieron actualizar los totales', error);
        }
      }

      const summary: EntityUploadSummary = { ...done, message: describe(done) };

      this.lastSummary.set(summary);
      return summary;
    } finally {
      this.running.set(false);
    }
  }

  /**
   * Por qué esta actividad todavía no puede salir.
   *
   * Devuelve el motivo o cadena vacía. Se mira **antes de enviarla**, no como
   * aviso posterior: una vez creada en Visitrack con un GUID donde debería ir
   * un identificador, ya no hay vuelta atrás.
   */
  async blockersOf(answer: SurveyAnswer, snapshot?: PendingEntities): Promise<string> {
    const pending = snapshot ?? (await this.collect());

    const locationGuids = new Set(pending.locations.map((row) => row.GUID));
    const assetGuids = new Set(pending.assets.map((row) => row.GUID));
    const itemGuids = new Set(pending.items.map((row) => row.GUID));

    const location = String(answer.LocationGUID ?? '') || String(answer.LocationID ?? '');
    const asset = String(answer.AssetGUID ?? '') || String(answer.AssetID ?? '');

    if (location && locationGuids.has(location)) {
      return 'Esperando a que suba la ubicación creada en este dispositivo.';
    }

    if (asset && assetGuids.has(asset)) {
      return 'Esperando a que suba el activo creado en este dispositivo.';
    }

    /**
     * Los ítems de lista que la actividad referencia.
     *
     * Se buscan sobre el texto de las respuestas y no recorriendo su estructura
     * campo a campo: un ítem puede aparecer en un desplegable, en una fila de
     * tabla de detalle o en una fila de una tabla anidada, y cada sitio lo
     * guarda con un nombre distinto (`id`, `ListDetGUID`, `MasterListDetGUID`).
     * Buscar el GUID en el texto los cubre todos y no puede quedarse corto.
     */
    if (itemGuids.size > 0) {
      const text = String(answer.Fields ?? '');

      for (const guid of itemGuids) {
        if (guid && text.includes(guid)) {
          return 'Esperando a que suban los ítems de lista creados en este dispositivo.';
        }
      }
    }

    return '';
  }

  /**
   * Se asegura de que lo que esta actividad necesita esté arriba.
   *
   * Intenta subirlo y vuelve a comprobar. Devuelve el motivo si sigue sin poder
   * salir. Es lo que llama el envío de cada actividad, así que cubre los tres
   * caminos por igual: guardar, el botón de reintentar y la corrida automática.
   */
  async ensureFor(answer: SurveyAnswer): Promise<string> {
    const blocked = await this.blockersOf(answer);
    if (!blocked) return '';

    // Si el servidor no tiene los endpoints, insistir no cambia nada y dejaría
    // la actividad retenida para siempre sin decir por qué.
    if (this.notImplemented()) {
      return 'El servidor todavía no acepta entidades creadas desde el dispositivo.';
    }

    await this.run();
    return this.blockersOf(answer);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Cada familia
  // ───────────────────────────────────────────────────────────────────────────

  private async pushLocations(rows: LocationForm[], done: Counters): Promise<void> {
    // La compañía sale de la sesión: el registro local no la guarda, porque
    // todo lo que hay en el dispositivo es de la compañía de quien entró.
    const companyId = String(this.auth.currentUser()?.CompanyID ?? '');

    for (const row of rows) {
      /**
       * La zona de trabajo es obligatoria para el servidor.
       *
       * Si la ubicación no la trae se resuelve ahora —de la sesión, o de la
       * primera zona descargada— y **se guarda en el registro**: sin eso, cada
       * intento volvería a resolverla y el mismo rechazo se repetiría cada
       * minuto sin dejar rastro de por qué.
       */
      const zone = await this.resolveWorkZone(row);

      if (!zone) {
        console.warn('[Entidades] la ubicación no tiene zona de trabajo', row.GUID);
        done.failed++;
        continue;
      }

      if (zone !== String(row.WorkZoneID ?? '')) {
        await this.locations.update(row.ID, { WorkZoneID: zone });
      }

      const result = await this.api.createLocation({
        GUID: row.GUID,
        Name: row.Name ?? '',
        LocationTypeID: row.LocationTypeGUID ?? '',
        WorkZoneID: zone,
        CompanyID: companyId,
        UserID: row.UserID,
        jsonValues: fieldsOf(row.jsonValues),
        Latitude: row.Latitude ?? '',
        Longitude: row.Longitude ?? '',
        ContactName: row.ContactName ?? '',
        Email: row.Email ?? '',
        Phone: row.Phone ?? '',
        Fax: row.Fax ?? '',
        Description: row.Description ?? '',
        FullAddress: row.FullAddress ?? '',
        Street: row.Street ?? '',
        City: row.City ?? '',
        State: row.State ?? '',
        PostalCode: row.PostalCode ?? '',
        Country: row.Country ?? '',
        TagUID: row.TagUID ?? '',
      });

      if (!this.accept(result, done)) continue;

      const serverId = result.serverId ?? '';

      await this.locations.update(row.ID, {
        LocationID: serverId || row.LocationID,
        Upload: '1',
        SyncOn: '1',
        SyncedToServer: '1',
      });

      // Y ahora todo lo que llevaba el GUID donde va el identificador.
      if (serverId) {
        await this.relabelAnswers(row.GUID, { LocationID: serverId });
        await this.relabelAssets(row.GUID, serverId);
      }

      done.locations++;
    }
  }

  private async pushAssets(rows: Asset[], done: Counters): Promise<void> {
    for (const row of rows) {
      /**
       * Un activo no sube sin la sede a la que pertenece.
       *
       * `LocationID` en cero significa que su ubicación se creó aquí y todavía
       * no tiene identificador. Subirlo así lo dejaría colgando de la nada, y
       * eso en Visitrack no se puede arreglar desde el dispositivo.
       */
      if (!row.LocationID) {
        done.deferred++;
        continue;
      }

      const result = await this.api.createAsset({
        GUID: row.GUID,
        Name: row.Name ?? '',
        AssetTypeID: assetTypeOf(row),
        LocationID: row.LocationID,
        CompanyID: String(this.auth.currentUser()?.CompanyID ?? ''),
        UserID: row.UserID,
        jsonValues: fieldsOf(row.jsonValues),
        JSONTitle: row.JSONTitle ?? '',
        Latitude: row.Latitude ?? '',
        Longitude: row.Longitude ?? '',
        Description: row.Description ?? '',
        Make: row.Make ?? '',
        Model: row.Model ?? '',
        SerialNumber: row.SerialNumber ?? '',
        TagUID: row.TagUID ?? '',
      });

      if (!this.accept(result, done)) continue;

      const serverId = result.serverId ?? '';

      await this.assets.update(row.ID, {
        AssetID: Number(serverId) || row.AssetID,
        Upload: '1',
        SyncOn: '1',
        SyncedToServer: '1',
      });

      if (serverId) await this.relabelAnswers(row.GUID, { AssetID: serverId });

      done.assets++;
    }
  }

  private async pushItems(rows: ListDetail[], done: Counters): Promise<void> {
    const pendingGuids = new Set(rows.map((row) => row.GUID));

    for (const row of order(rows)) {
      /**
       * Un ítem no sube antes que aquello de lo que cuelga.
       *
       * Su padre puede ser otro ítem de la misma tanda —listas encadenadas— y
       * el servidor lo rechazaría, o peor: lo aceptaría huérfano.
       */
      const parent = String(row.ParentGUID ?? '');

      if (parent && pendingGuids.has(parent)) {
        done.deferred++;
        continue;
      }

      const result = await this.api.createListItem({ ...row } as Record<string, unknown>);
      if (!this.accept(result, done)) continue;

      await this.details.update(row.ID, { Upload: '1', SyncedToServer: '1' });

      pendingGuids.delete(row.GUID);
      done.items++;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * ¿Se puede seguir tras esta respuesta?
   *
   * Un endpoint que no existe detiene la corrida entera: los siguientes van a
   * fallar igual, y machacar el servidor con veinte llamadas para el mismo 404
   * no ayuda a nadie.
   */
  private accept(
    result: { ok: boolean; notImplemented?: boolean; error?: string },
    done: Counters,
  ): boolean {
    if (result.ok) return true;

    if (result.notImplemented) this.notImplemented.set(true);
    else console.warn('[Entidades] el servidor rechazó el registro', result.error);

    done.failed++;
    return false;
  }

  /** Reescribe el identificador en las actividades que llevaban el GUID. */
  private async relabelAnswers(
    guid: string,
    changes: { LocationID?: string; AssetID?: string },
  ): Promise<void> {
    const user = this.auth.currentUser();
    if (!user) return;

    const all = await this.answers.query({ index: 'byUserID', range: user.UserID });

    for (const answer of all) {
      if (answer.ID == null) continue;

      const matches = changes.LocationID
        ? answer.LocationGUID === guid || String(answer.LocationID) === guid
        : answer.AssetGUID === guid || String(answer.AssetID) === guid;

      if (matches) await this.answers.update(answer.ID, changes);
    }
  }

  /**
   * Y en todo lo que colgaba de esa ubicación sin haber subido.
   *
   * Los activos por su `LocationGUID`, y los ítems de lista que nacieron
   * ligados a la sede — que llevan el GUID donde va el identificador, igual que
   * la actividad. Sin reescribirlos llegan a Visitrack apuntando a algo que
   * allí no significa nada.
   */
  private async relabelAssets(locationGuid: string, serverId: string): Promise<void> {
    const user = this.auth.currentUser();
    if (!user) return;

    const owner = resolveCatalogOwnerId(user);

    for (const asset of await this.assets.findPendingUpload(owner)) {
      if (asset.LocationGUID === locationGuid && asset.ID != null) {
        await this.assets.update(asset.ID, { LocationID: Number(serverId) || 0 });
      }
    }

    for (const item of await this.details.findPendingUpload(owner)) {
      if (item.ID == null) continue;

      const matches =
        String(item.LocationID) === locationGuid || item.LocationGUID === locationGuid;

      if (matches) {
        await this.details.update(item.ID, {
          LocationID: serverId,
          LocationGUID: locationGuid,
        });
      }
    }
  }

  /**
   * La zona de trabajo de una ubicación.
   *
   * La suya si la tiene; si no, la de la sesión; si no, la primera descargada.
   * Es el mismo orden que `resolveWorkZoneID` en la app — y hace falta porque
   * el editor no la pregunta y el servidor la exige.
   */
  private async resolveWorkZone(row: LocationForm): Promise<string> {
    const own = String(row.WorkZoneID ?? '').trim();
    if (own && own !== '0') return own;

    const user = this.auth.currentUser();
    const fromSession = String(user?.WorkZoneID ?? '').trim();
    if (fromSession && fromSession !== '0') return fromSession;

    if (!user) return '';

    const zones = await this.zones.findByUser(resolveCatalogOwnerId(user));
    return String(zones[0]?.WorkZoneID ?? '').trim();
  }

  /** Todo lo que falta por subir, de las tres familias. */
  private async collect(): Promise<PendingEntities> {
    const user = this.auth.currentUser();

    if (!user) return { locations: [], assets: [], items: [] };

    /**
     * Con el propietario del catálogo, no con el usuario.
     *
     * Es el mismo con el que se escribieron: en las compañías que comparten
     * catálogo, las entidades cuelgan de un usuario común y buscarlas por quien
     * entró no devolvería ninguna.
     */
    const owner = resolveCatalogOwnerId(user);

    const [locations, assets, items] = await Promise.all([
      this.locations.findPendingUpload(owner),
      this.assets.findPendingUpload(owner),
      this.details.findPendingUpload(owner),
    ]);

    // Los ítems solo cuentan cuando el usuario los dio por creados: uno a medias
    // —`Save` en cero— es un borrador del formulario de alta, no algo que deba
    // llegar a Visitrack.
    return { locations, assets, items: items.filter((item) => item.Save === '1') };
  }
}

/** Lo que falta por subir, de las tres familias. */
export interface PendingEntities {
  locations: LocationForm[];
  assets: Asset[];
  items: ListDetail[];
}

interface Counters {
  locations: number;
  assets: number;
  items: number;
  deferred: number;
  failed: number;
}

/**
 * Los ítems, padres antes que hijos.
 *
 * Una sola pasada de ordenación basta para el encadenado normal —departamento,
 * ciudad, barrio— y lo que quede desordenado se aplaza y sube en la corrida
 * siguiente. Resolver el árbol completo aquí sería precisión que nadie
 * necesita: el caso de más de tres niveles no existe en la práctica.
 */
function order(rows: readonly ListDetail[]): ListDetail[] {
  return [...rows].sort((left, right) => depth(left, rows) - depth(right, rows));
}

function depth(row: ListDetail, rows: readonly ListDetail[]): number {
  let level = 0;
  let current = row;

  // El tope corta cualquier ciclo: un `ParentGUID` que apunte hacia arriba en
  // redondo colgaría el proceso, y un dato corrupto no puede parar la subida.
  while (level < 10) {
    const parent = rows.find((candidate) => candidate.GUID === current.ParentGUID);
    if (!parent) return level;

    current = parent;
    level++;
  }

  return level;
}

function describe(done: Counters): string {
  const parts: string[] = [];

  if (done.locations > 0) parts.push(`${done.locations} ubicación(es)`);
  if (done.assets > 0) parts.push(`${done.assets} activo(s)`);
  if (done.items > 0) parts.push(`${done.items} ítem(s) de lista`);

  if (parts.length === 0) {
    if (done.failed > 0) return 'No se pudo subir ninguna entidad.';
    return done.deferred > 0 ? 'Las entidades esperan a su registro padre.' : 'Nada que subir.';
  }

  const sent = `${parts.join(' · ')} subidas`;
  return done.deferred > 0 ? `${sent} · ${done.deferred} en espera de su padre` : sent;
}

function empty(message: string): EntityUploadSummary {
  return { locations: 0, assets: 0, items: 0, deferred: 0, failed: 0, message };
}

/**
 * Los campos de una entidad, como los espera el servidor.
 *
 * En el dispositivo se guardan envueltos —`{id, name, fie: [...]}`— porque es
 * lo que necesitan los descriptivos para mostrarse. El servidor espera **solo
 * el arreglo**: mandarle el envoltorio le llega como un objeto donde espera una
 * lista, y guarda una entidad sin ninguno de sus datos. La app desenvuelve
 * exactamente igual antes de subir.
 */
function fieldsOf(raw: string | undefined): string {
  if (!raw) return '[]';

  try {
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) return JSON.stringify(parsed);
    if (parsed && Array.isArray(parsed.fie)) return JSON.stringify(parsed.fie);

    return '[]';
  } catch {
    return '[]';
  }
}

/**
 * El tipo de activo, como identificador.
 *
 * `AssetTypeGUID` guarda el identificador numérico y `AssetTypeGD` el GUID —los
 * nombres están cruzados, y así vienen del servidor—. Si el primero no es un
 * número se usa el segundo, igual que en la app.
 */
function assetTypeOf(row: Asset): string {
  const id = String(row.AssetTypeGUID ?? '').trim();
  if (id && Number.isFinite(Number(id))) return id;

  return String(row.AssetTypeGD ?? '').trim() || id;
}
