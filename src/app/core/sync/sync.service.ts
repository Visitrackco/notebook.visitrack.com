import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { environment } from '../../../environments/environment';
import { ApiFetchService } from '../services/api-fetch.service';
import { DatabaseService } from '../database/database.service';
import { UserConfig } from '../models/entities.model';
import { UserConfigRepository } from '../repositories/entity.repositories';
import { UserRepository } from '../repositories/user.repository';
import { ConnectivityService } from '../services/connectivity.service';
import {
  ENTITY_MAPPERS,
  ENTITY_TO_STORE,
  SyncItem,
  isDeletedRecord,
} from './entity-mappers';
import { DispatchFilesService } from './dispatch-files.service';
import { AlertSoundService } from '../services/alert-sound.service';
import { ToastService } from '../services/toast.service';
import { BrillantexMailService } from '../rules/brillantex-mail.service';

/** Fase en la que va la descarga. */
export type SyncPhase = 'idle' | 'connecting' | 'downloading' | 'done' | 'error' | 'cancelled';

/** Estado observable de la sincronización. */
export interface SyncState {
  phase: SyncPhase;
  /** Cuántos registros anunció el servidor en la cabecera `x-total`. */
  total: number;
  /** Cuántos se han guardado. */
  processed: number;
  /** Cuántos entraron en cada entidad, para el detalle por tarjeta. */
  byEntity: Record<number, number>;
  message: string;
}

/** Cómo quedó el alta de este equipo en el servidor. */
export interface PrepareResult {
  /** Filas nuevas: lo que le correspondía y este equipo no tenía. */
  added: number;
  /** Filas cuyo estado de borrado cambió. */
  updated: number;
  /** Filas que se volvieron a marcar por petición expresa. */
  restored: number;
  /** Lo que le queda por bajar en total. */
  pending: number;
}

/** Cuántos registros se acumulan antes de escribir en la base. */
const BATCH_SIZE = 200;

/** Reintentos si el stream se corta a mitad. */
/** Entidad de las actividades asignadas desde la plataforma. */
const DISPATCH_ENTITY = 9;

const MAX_RETRIES = 3;

/**
 * Descarga y guardado de datos, réplica del motor de la app móvil.
 *
 * ## Cómo funciona la descarga
 *
 * `GET /getSyncNew` no devuelve un JSON completo: **emite una línea por
 * registro** a medida que los lee de la base. Eso permite empezar a guardar
 * antes de que termine la transferencia, y es lo que hace viable descargar
 * decenas de miles de ítems sin agotar la memoria.
 *
 * En Dart eso se resuelve con `LineSplitter`; aquí con el lector del `body` del
 * `fetch` y un decodificador incremental. La parte delicada es que un fragmento
 * de red **puede cortar una línea por la mitad**, así que el resto se conserva
 * y se une con el fragmento siguiente.
 *
 * ## Por qué se guarda por lotes
 *
 * Escribir registro a registro haría una transacción de IndexedDB por cada uno,
 * y el costo está en confirmar la transacción, no en el `put`. Se acumulan
 * [BATCH_SIZE] y se escriben juntos, agrupados por store.
 *
 * ## Confirmación al servidor
 *
 * Tras guardar cada lote se avisa con `/ackSync` qué `syncId` quedaron
 * persistidos. Si esa llamada falla no se reintenta: el servidor los seguirá
 * marcando como pendientes y volverán en la próxima sincronización. Guardar dos
 * veces el mismo registro es inofensivo porque el guardado es idempotente.
 */
@Injectable({ providedIn: 'root' })
export class SyncService {
  private readonly db = inject(DatabaseService);
  private readonly api = inject(ApiFetchService);
  private readonly brillantexMail = inject(BrillantexMailService);
  private readonly users = inject(UserRepository);
  private readonly configs = inject(UserConfigRepository);
  private readonly connectivity = inject(ConnectivityService);
  private readonly dispatchFiles = inject(DispatchFilesService);
  private readonly toasts = inject(ToastService);
  private readonly sound = inject(AlertSoundService);
  private readonly router = inject(Router);

  /**
   * Cómo quedó la última preparación del equipo.
   *
   * A la vista en la pantalla de sincronización: cuando no baja nada, lo
   * primero que hay que poder distinguir es si al usuario **no le corresponde
   * nada** o si simplemente no se llegó a marcar para este dispositivo.
   */
  readonly lastPrepare = signal<PrepareResult | null>(null);

  readonly state = signal<SyncState>({
    phase: 'idle',
    total: 0,
    processed: 0,
    byEntity: {},
    message: '',
  });

  readonly isRunning = computed(() => {
    const phase = this.state().phase;
    return phase === 'connecting' || phase === 'downloading';
  });

  /** Porcentaje completado. 0 cuando el servidor no anunció un total. */
  readonly progress = computed(() => {
    const { total, processed } = this.state();
    return total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  });

  /** Permite cortar la descarga en curso. */
  private controller: AbortController | null = null;

  /**
   * Descarga todo lo que el servidor tenga pendiente para este dispositivo.
   *
   * Devuelve cuántos registros se guardaron.
   */
  async download(): Promise<number> {
    if (this.isRunning()) return 0;

    const session = await this.users.getActiveSession();
    if (!session) {
      this.fail('No hay una sesión activa.');
      return 0;
    }

    if (this.connectivity.isOffline()) {
      this.fail('Sin conexión. Conéctate para descargar tus datos.');
      return 0;
    }

    // La compañía 3502 comparte los datos bajo un único usuario en el servidor.
    const effectiveUserId =
      session.CompanyID === 3502 ? 771295 : Number(session.UserID) || 0;

    /**
     * Antes de bajar nada, este equipo tiene que estar dado de alta.
     *
     * Hay dos tablas del otro lado: una dice **qué le corresponde al usuario** y
     * otra **qué le falta por bajar a cada equipo**. La descarga solo mira la
     * segunda, y un equipo nuevo —un navegador recién estrenado— no tiene ni
     * una fila ahí: se conecta, no encuentra nada y entra vacío, con la sesión
     * perfectamente iniciada. Desde fuera parece que la sincronización no
     * sirve.
     *
     * `prepareDevice` le copia lo que le toca. Es idempotente, así que se llama
     * en cada descarga sin coste: lo que ya está no se vuelve a marcar.
     *
     * Si falla no se detiene la descarga — puede que el equipo ya estuviera
     * preparado de antes, y quedarse sin sincronizar por esto sería peor.
     */
    try {
      const ready = await this.prepareDevice(session.UserID, session.DeviceID);

      // Se deja dicho en la consola: es la primera pregunta cuando alguien
      // sincroniza y no baja nada, y sin esto hay que adivinar si el problema
      // es que no le corresponde nada o que no llegó a marcarse.
      console.info(
        `[Sync] equipo ${session.DeviceID} preparado · ${ready.added} nuevos · ` +
          `${ready.pending} por bajar`,
      );

      this.lastPrepare.set(ready);
    } catch (error) {
      console.warn('[Sync] no se pudo preparar el dispositivo', error);
      this.lastPrepare.set(null);
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const saved = await this.runDownload(session.UserID, session.DeviceID, effectiveUserId, attempt);

        /**
         * Los archivos que traen las consignas se buscan al terminar.
         *
         * Después y no durante: la descarga de datos es lo que decide si la
         * sincronización sirvió de algo, y un servidor de archivos lento no
         * puede retrasarla. Si falla, no se toca el resultado — el trabajo ya
         * está en el dispositivo y los archivos siguen alcanzables por su
         * dirección.
         */
        let files = 0;

        try {
          files = await this.dispatchFiles.syncAll();
        } catch (error) {
          console.warn('[Sync] no se pudieron traer los archivos de las consignas', error);
        }

        /**
         * La configuración por usuario, que decide qué módulos están activos.
         *
         * También al final y también sin poder tumbar la sincronización: si no
         * llega, los permisos se resuelven como estaban — permitiendo, que es
         * el criterio de la app cuando no sabe.
         */
        /**
         * El correo de Brillantex, si la compañía es la suya.
         *
         * Al final y sin poder tumbar la sincronización: manda los informes de
         * las inspecciones terminadas cuyas fotos ya están confirmadas. Es el
         * momento natural — acaba de subirse y confirmarse lo que faltaba, que
         * es justo lo que las tenía retenidas. El propio servicio se descarta
         * solo si el usuario no es de esa compañía.
         */
        try {
          await this.brillantexMail.run();
        } catch (error) {
          console.warn('[Sync] no se pudo enviar el correo de Brillantex', error);
        }

        try {
          await this.downloadUserConfig(session.UserID, session.CompanyID, effectiveUserId);
        } catch (error) {
          console.warn('[Sync] no se pudo traer la configuración del usuario', error);
        }

        // Los duplicados que dejó la versión anterior. Ver [dropLocalDuplicates].
        try {
          await this.dropLocalDuplicates();
        } catch (error) {
          console.warn('[Sync] no se pudieron limpiar los duplicados', error);
        }

        this.announceDispatches(files);

        this.state.update((s) => ({
          ...s,
          phase: 'done',
          message: saved > 0 ? `${saved} registros actualizados` : 'Ya tienes todo al día',
        }));

        await this.markLastSync(session.UserID);
        return saved;
      } catch (error) {
        if (this.state().phase === 'cancelled') return this.state().processed;

        const isLast = attempt === MAX_RETRIES;
        console.warn(`[Sync] Intento ${attempt}/${MAX_RETRIES} falló`, error);

        if (isLast) {
          this.fail(
            error instanceof Error
              ? error.message
              : 'No se pudo completar la descarga.',
          );
          return this.state().processed;
        }

        // Espera creciente: si el servidor está saturado, insistir de inmediato
        // solo empeora las cosas.
        await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
      }
    }

    return 0;
  }

  /** Corta la descarga en curso. */
  cancel(): void {
    if (!this.isRunning()) return;

    this.controller?.abort();
    this.state.update((s) => ({
      ...s,
      phase: 'cancelled',
      message: 'Descarga cancelada. Lo ya guardado se conserva.',
    }));
  }

  // ───────────────────────────────────────────────────────────────────────────

  private async runDownload(
    userId: string,
    deviceId: string,
    effectiveUserId: number,
    attempt: number,
  ): Promise<number> {
    this.controller = new AbortController();

    this.state.set({
      phase: 'connecting',
      total: 0,
      processed: 0,
      byEntity: {},
      message: attempt === 1 ? 'Conectando…' : `Reintentando (${attempt}/${MAX_RETRIES})…`,
    });

    const base = environment.useLocalApi ? environment.localApiUrl : environment.apiUrl;
    const url = `${base}/getSyncNew?id=${encodeURIComponent(userId)}&deviceid=${encodeURIComponent(deviceId)}`;

    const response = await this.api.fetch(url, { signal: this.controller.signal });

    if (!response.ok) {
      throw new Error(`El servidor respondió ${response.status}.`);
    }
    if (!response.body) {
      throw new Error('El servidor no envió datos.');
    }

    const total = Number(response.headers.get('x-total') ?? 0) || 0;

    this.state.update((s) => ({
      ...s,
      phase: 'downloading',
      total,
      message: 'Descargando datos…',
    }));

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let pending = '';
    let buffer: SyncItem[] = [];
    let saved = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        // `stream: true` conserva los bytes de un carácter partido entre dos
        // fragmentos; sin él, los acentos llegan corrompidos.
        pending += decoder.decode(value, { stream: true });

        const lines = pending.split('\n');
        // La última puede estar incompleta: se guarda para el próximo fragmento.
        pending = lines.pop() ?? '';

        for (const line of lines) {
          const item = this.parseLine(line);
          if (item) buffer.push(...item);
        }

        if (buffer.length >= BATCH_SIZE) {
          saved += await this.saveBatch(buffer, effectiveUserId);
          void this.ackBatch(buffer, userId, deviceId);
          buffer = [];
        }
      }

      // Lo que quedó sin cerrar al terminar el stream.
      const tail = this.parseLine(pending);
      if (tail) buffer.push(...tail);

      if (buffer.length > 0) {
        saved += await this.saveBatch(buffer, effectiveUserId);
        void this.ackBatch(buffer, userId, deviceId);
      }

      return saved;
    } finally {
      reader.releaseLock();
      this.controller = null;
    }
  }

  /**
   * Convierte una línea del stream en registros.
   *
   * El servidor enmarca la salida como un arreglo JSON, así que hay líneas que
   * son solo `[`, `]` o una coma de separación. Devuelve `null` para todo lo
   * que no aporte datos.
   */
  private parseLine(line: string): SyncItem[] | null {
    let clean = line.trim();

    if (!clean || clean === '[' || clean === ']') return null;
    if (clean.endsWith(',')) clean = clean.slice(0, -1);
    if (!clean) return null;

    try {
      const parsed = JSON.parse(clean);

      if (Array.isArray(parsed)) return parsed as SyncItem[];
      if (parsed && typeof parsed === 'object') return [parsed as SyncItem];

      return null;
    } catch {
      // Una línea corrupta no puede tumbar toda la sincronización: se descarta
      // y el registro volverá en la próxima, porque no se confirmará su syncId.
      return null;
    }
  }

  /**
   * Guarda un lote, agrupado por store.
   *
   * Se agrupa porque una transacción de IndexedDB abarca los stores que se le
   * declaran: hacer una por entidad es mucho más rápido que una por registro, y
   * más seguro que una sola sobre todos los stores.
   */
  private async saveBatch(items: SyncItem[], userId: number): Promise<number> {
    const upsertsByStore = new Map<string, Record<string, unknown>[]>();
    const deletesByStore = new Map<string, Record<string, unknown>[]>();
    const counts: Record<number, number> = {};

    for (const item of items) {
      const store = ENTITY_TO_STORE[item.entity];
      const mapper = ENTITY_MAPPERS[item.entity];

      if (!store || !mapper || !item.data) continue;

      const mapped = mapper(item.data, userId);
      const target = isDeletedRecord(item.data) ? deletesByStore : upsertsByStore;

      if (!target.has(store)) target.set(store, []);
      target.get(store)!.push(mapped);

      counts[item.entity] = (counts[item.entity] ?? 0) + 1;
    }

    let saved = 0;

    for (const [store, records] of upsertsByStore) {
      saved += await this.putRecords(store, records);
    }

    for (const [store, records] of deletesByStore) {
      await this.deleteRecords(store, records, userId);
    }

    this.state.update((s) => {
      const byEntity = { ...s.byEntity };
      for (const [entity, count] of Object.entries(counts)) {
        byEntity[Number(entity)] = (byEntity[Number(entity)] ?? 0) + count;
      }

      return {
        ...s,
        processed: s.processed + items.length,
        byEntity,
        message: s.total
          ? `Guardando ${s.processed + items.length} de ${s.total}…`
          : `Guardando ${s.processed + items.length} registros…`,
      };
    });

    return saved;
  }

  /**
   * Inserta o reemplaza registros conservando la llave existente.
   *
   * Los stores con llave autoincremental —`SurveyAnswers`— no traen `ID` del
   * servidor, así que se busca por GUID el registro previo para actualizarlo en
   * vez de crear un duplicado en cada sincronización.
   */
  private async putRecords(store: string, records: Record<string, unknown>[]): Promise<number> {
    return this.db.transaction(store, 'readwrite', async (tx) => {
      const objectStore = tx.objectStore(store);

      /**
       * El GUID manda sobre la llave, en todos los almacenes que lo tengan.
       *
       * Antes esto solo se hacía en los que autoincrementan, y ahí estaba el
       * fallo: los catálogos —ubicaciones, activos, ítems— **no**
       * autoincrementan, porque su llave es el `ID` que asigna Visitrack. Un
       * registro creado aquí lleva mientras tanto una llave local negativa; al
       * bajar del servidor con su `ID` de verdad, se guardaba **al lado** del
       * local en vez de sustituirlo, y la entidad aparecía dos veces.
       *
       * Lo que identifica a un registro entre los dos lados es su GUID, así que
       * es por ahí por donde hay que buscarlo.
       */
      const hasGuidIndex = objectStore.indexNames.contains('byGUID');

      for (const record of records) {
        if (hasGuidIndex) {
          const guid = String(record['GUID'] ?? '');

          if (guid) {
            const existing = await this.db.request<Record<string, unknown> | undefined>(
              objectStore.index('byGUID').get(guid),
            );

            if (existing?.['ID'] !== undefined) {
              const previous = existing['ID'] as IDBValidKey;
              const incoming = record['ID'];

              /**
               * Lo que aún no ha subido no se pisa.
               *
               * Si el registro local tiene cambios sin mandar, el servidor
               * todavía no los conoce: su versión es la de antes de editarlo.
               * Sobrescribirlo con ella borraría el trabajo del usuario sin
               * dejar rastro — y encima marcándolo como sincronizado.
               *
               * Se conserva el contenido local y se adopta solo la identidad
               * que trae el servidor, que es lo único que faltaba.
               */
              if (isPendingLocal(existing)) {
                const identity = incoming ?? previous;
                for (const key of Object.keys(existing)) record[key] = existing[key];
                record['ID'] = identity;
              }

              // En los que autoincrementan la llave la puso IndexedDB y hay que
              // respetarla; en los demás manda la del servidor, y la fila vieja
              // sobra.
              if (incoming === undefined || objectStore.autoIncrement) {
                record['ID'] = previous;
              } else if (previous !== incoming) {
                objectStore.delete(previous);
              }
            }
          }
        }

        objectStore.put(record);
      }

      return records.length;
    });
  }

  /**
   * Elimina los registros que el servidor marcó como borrados.
   *
   * Se busca por GUID porque es la llave que el servidor conoce; el `ID` local
   * puede no coincidir en los stores autoincrementales.
   */
  private async deleteRecords(
    store: string,
    records: Record<string, unknown>[],
    userId: number,
  ): Promise<void> {
    await this.db.transaction(store, 'readwrite', async (tx) => {
      const objectStore = tx.objectStore(store);
      const hasGuidIndex = objectStore.indexNames.contains('byGUID');

      for (const record of records) {
        const guid = String(record['GUID'] ?? '');

        if (guid && hasGuidIndex) {
          const existing = await this.db.request<Record<string, unknown> | undefined>(
            objectStore.index('byGUID').get(guid),
          );

          // Solo se borra si es del usuario: dos cuentas en el mismo navegador
          // comparten store y no deben pisarse entre ellas.
          if (existing && Number(existing['UserID']) === userId) {
            const key = existing[objectStore.keyPath as string];
            if (key !== undefined) objectStore.delete(key as IDBValidKey);
          }
          continue;
        }

        if (record['ID'] !== undefined) objectStore.delete(record['ID'] as IDBValidKey);
      }
    });
  }

  /**
   * Confirma al servidor qué registros quedaron guardados.
   *
   * El endpoint espera los IDs **agrupados por entidad**
   * (`items: [{entity, ids: []}]`), no una lista plana de `syncId`. Se agrupan
   * igual que en `_ackBatch` del móvil para que ambos clientes confirmen del
   * mismo modo.
   *
   * No se espera ni se reintenta: si falla, el servidor los reenvía en la
   * próxima sincronización y volverán a guardarse sin causar duplicados.
   */
  private async ackBatch(items: SyncItem[], userId: string, deviceId: string): Promise<void> {
    const grouped = new Map<number, number[]>();

    for (const item of items) {
      if (typeof item.entity !== 'number' || !item.data) continue;

      const id = Number(item.data['ID']);
      if (!Number.isFinite(id)) continue;

      if (!grouped.has(item.entity)) grouped.set(item.entity, []);
      grouped.get(item.entity)!.push(id);
    }

    if (grouped.size === 0) return;

    try {
      const base = environment.useLocalApi ? environment.localApiUrl : environment.apiUrl;

      await this.api.fetch(`${base}/ackSync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          UserID: userId,
          DeviceID: deviceId,
          items: [...grouped].map(([entity, ids]) => ({ entity, ids })),
        }),
      });
    } catch {
      // Silencioso a propósito: ver la nota del método.
    }
  }

  /**
   * Avisa de las consignas que acaban de llegar.
   *
   * Con aviso en pantalla **y** sonido: quien sincroniza suele estar haciendo
   * otra cosa mientras tanto —o mirando otra pestaña— y un cambio silencioso en
   * el número del menú no se ve. El trabajo asignado es justo lo que no puede
   * pasar desapercibido.
   *
   * Solo cuando llega algo: una sincronización que no trae consignas no tiene
   * nada que contar, y avisar de eso enseñaría a ignorar el aviso.
   */
  private announceDispatches(files: number): void {
    const received = this.state().byEntity[DISPATCH_ENTITY] ?? 0;
    if (received === 0) return;

    const detail = files > 0
      ? `Se descargaron ${files} ${files === 1 ? 'archivo adjunto' : 'archivos adjuntos'}.`
      : 'Revisa qué te asignaron y desde dónde empezar.';

    this.toasts.show({
      title:
        received === 1
          ? 'Llegó una consigna nueva'
          : `Llegaron ${received} consignas nuevas`,
      detail,
      tone: 'info',
      icon: 'send',
      action: {
        label: 'Ver',
        run: () => void this.router.navigate(['/consignas']),
      },
    });

    void this.sound.notify();
  }

  /**
   * Retira las copias locales de entidades que ya bajaron del servidor.
   *
   * Un registro creado aquí lleva una llave negativa hasta que sube; cuando
   * vuelve con su `ID` de Visitrack pasa a tener la suya, y la vieja sobra. La
   * escritura ya se encarga de eso —ver [putRecords]— pero **no de las que
   * quedaron duplicadas antes de arreglarlo**, y esas no desaparecen solas.
   *
   * Solo se recorren las llaves negativas: son las únicas que pueden ser una
   * copia local, así que esto son unas pocas filas aunque el catálogo tenga
   * decenas de miles.
   *
   * Lo que todavía no ha subido no se toca: es la única copia que existe de un
   * trabajo que nadie más tiene.
   */
  private async dropLocalDuplicates(): Promise<void> {
    for (const store of ['LocationsForms', 'Assets', 'ListsDet']) {
      await this.db.transaction(store, 'readwrite', async (tx) => {
        const objectStore = tx.objectStore(store);
        if (!objectStore.indexNames.contains('byGUID')) return;

        const locals = await this.db.request<Record<string, unknown>[]>(
          objectStore.getAll(IDBKeyRange.upperBound(-1)),
        );

        for (const local of locals ?? []) {
          if (isPendingLocal(local)) continue;

          const guid = String(local['GUID'] ?? '');
          if (!guid) continue;

          // Se recorren todas las filas con ese GUID: si hay alguna con llave
          // del servidor, esta copia ya no hace falta.
          const twins = await this.db.request<Record<string, unknown>[]>(
            objectStore.index('byGUID').getAll(guid),
          );

          const fromServer = (twins ?? []).some((twin) => Number(twin['ID']) > 0);
          if (fromServer) objectStore.delete(local['ID'] as IDBValidKey);
        }
      });
    }
  }

  /**
   * Trae la configuración de módulos del usuario.
   *
   * Es lo que en la app decide, para algunas compañías, si se pueden crear
   * ítems de lista desde un formulario. Se guarda como el JSON crudo: el
   * catálogo de módulos lo define la plataforma.
   */
  private async downloadUserConfig(
    userId: string,
    companyId: number,
    ownerId: number,
  ): Promise<void> {
    const base = environment.useLocalApi ? environment.localApiUrl : environment.apiUrl;

    const url =
      `${base}/getUsersModuleByUserIdAndCompanyId` +
      `?userId=${encodeURIComponent(userId)}&companyId=${encodeURIComponent(String(companyId))}`;

    const reply = await this.api.fetch(url);
    if (!reply.ok) return;

    const response = (await reply.json()) as { status?: boolean; response?: unknown };
    if (response?.status !== true) return;

    const existing = await this.configs.findByUser(ownerId);

    const record: UserConfig = {
      ...(existing ?? { UserID: ownerId }),
      UserID: ownerId,
      config: JSON.stringify(response.response ?? []),
      lastDate: new Date().toISOString(),
    };

    if (!existing) delete (record as { ID?: number }).ID;

    await this.configs.put(record);
  }

  /**
   * Da de alta este equipo para que el servidor sepa qué mandarle.
   *
   * @param full vuelve a marcar como pendiente **todo**, incluso lo ya bajado.
   *   Es la respuesta a «se me perdieron los datos».
   */
  async prepareDevice(
    userId: string,
    deviceId: string,
    full = false,
  ): Promise<PrepareResult> {
    const base = environment.useLocalApi ? environment.localApiUrl : environment.apiUrl;

    const reply = await this.api.fetch(`${base}/prepareDevice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ UserID: userId, DeviceID: deviceId, reset: full }),
    });

    if (!reply.ok) throw new Error(`El servidor respondió ${reply.status}.`);

    const result = (await reply.json()) as {
      status?: boolean;
      message?: string;
      response?: PrepareResult;
    };

    if (result?.status !== true) {
      throw new Error(result?.message ?? 'No se pudo preparar el dispositivo.');
    }

    return result.response ?? { added: 0, updated: 0, restored: 0, pending: 0 };
  }

  /**
   * Vuelve a marcar **todo** como pendiente para este equipo.
   *
   * Es la respuesta a «sincronizo y no me baja nada»: no toca los datos, solo
   * le dice al servidor que este dispositivo se lo tiene que volver a mandar.
   */
  async resyncEverything(): Promise<PrepareResult | null> {
    const session = await this.users.getActiveSession();
    if (!session) return null;

    const result = await this.prepareDevice(session.UserID, session.DeviceID, true);
    this.lastPrepare.set(result);

    return result;
  }

  private async markLastSync(userId: string): Promise<void> {
    try {
      const user = await this.users.getByIndex('byUserID', userId);
      if (user?.ID) {
        await this.users.update(user.ID, { LogoCheckDate: user.LogoCheckDate });
      }
    } catch {
      // El sello de última sincronización es informativo.
    }
  }

  private fail(message: string): void {
    this.state.update((s) => ({ ...s, phase: 'error', message }));
  }
}

/**
 * ¿Este registro local tiene cambios que el servidor todavía no conoce?
 *
 * Solo los catálogos que se pueden crear o editar desde el cliente llevan estas
 * marcas; en el resto la respuesta es que no, y el registro del servidor manda
 * sin discusión.
 */
function isPendingLocal(record: Record<string, unknown>): boolean {
  return record['CreateWithMovil'] === '1' && record['Upload'] !== '1';
}
