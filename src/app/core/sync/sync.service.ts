import { Injectable, computed, inject, signal } from '@angular/core';

import { environment } from '../../../environments/environment';
import { DatabaseService } from '../database/database.service';
import { UserRepository } from '../repositories/user.repository';
import { ConnectivityService } from '../services/connectivity.service';
import {
  ENTITY_MAPPERS,
  ENTITY_TO_STORE,
  SyncItem,
  isDeletedRecord,
} from './entity-mappers';

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

/** Cuántos registros se acumulan antes de escribir en la base. */
const BATCH_SIZE = 200;

/** Reintentos si el stream se corta a mitad. */
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
  private readonly users = inject(UserRepository);
  private readonly connectivity = inject(ConnectivityService);

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

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const saved = await this.runDownload(session.UserID, session.DeviceID, effectiveUserId, attempt);

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

    const response = await fetch(url, { signal: this.controller.signal });

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
      const needsLookup = objectStore.autoIncrement && objectStore.indexNames.contains('byGUID');

      for (const record of records) {
        if (needsLookup) {
          const guid = String(record['GUID'] ?? '');
          if (guid) {
            const existing = await this.db.request<Record<string, unknown> | undefined>(
              objectStore.index('byGUID').get(guid),
            );
            if (existing?.['ID'] !== undefined) record['ID'] = existing['ID'];
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

      await fetch(`${base}/ackSync`, {
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
