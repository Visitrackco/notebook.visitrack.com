import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { DatabaseService } from '../database/database.service';
import { UserRepository } from '../repositories/user.repository';
import { ApiService } from '../services/api.service';
import { ENTITY_HINTS, ENTITY_LABELS, ENTITY_ORDER, ENTITY_TO_STORE } from './entity-mappers';

/**
 * Resultado de comparar una entidad con el servidor.
 *
 * - `synced`   — los conteos coinciden.
 * - `outdated` — el servidor tiene más: faltan datos por descargar.
 * - `ahead`    — hay más local que en el servidor. Suele significar registros
 *                creados aquí que aún no subieron, o borrados en el servidor
 *                que no se propagaron.
 * - `unknown`  — todavía no se ha comparado.
 */
export type EntitySyncStatus = 'synced' | 'outdated' | 'ahead' | 'unknown';

/** Estado de una entidad, listo para pintar su tarjeta. */
export interface EntityCard {
  entity: number;
  label: string;
  hint: string;
  store: string;
  localCount: number;
  serverCount: number;
  status: EntitySyncStatus;
  /** Cuántos faltan por descargar. 0 si está al día. */
  missing: number;
  checkedAt: string;
}

/** Lo que el servidor espera por entidad en `/checkEntitySync`. */
interface Fingerprint {
  entity: string;
  userID: string;
  deviceID: string;
  count: number;
  maxVTEntityID: number;
  checksum: number;
}

/** Respuesta de `/checkEntitySync`. */
interface CheckResponse {
  status: boolean;
  data?: {
    entity: string | number;
    serverCount: number | string;
    serverMaxId?: number | string;
    serverChecksum?: number | string;
  }[];
  error?: string;
}

/**
 * Comparación de los datos locales contra el servidor.
 *
 * Es el semáforo de la pantalla de sincronización: dice, entidad por entidad,
 * si lo que hay en este navegador coincide con lo que el servidor cree que
 * debería haber.
 *
 * ## Se compara por conteo, no por checksum
 *
 * El móvil dejó de usar `maxId` y `checksum` cuando `VTEntityID` pasó a guardar
 * un GUID en vez de un número: un máximo sobre GUIDs no significa nada. Se
 * conservan los campos en la petición porque el endpoint los espera, pero la
 * decisión se toma solo con el conteo. Replicarlo igual aquí es lo que hace que
 * ambos clientes reporten lo mismo.
 */
@Injectable({ providedIn: 'root' })
export class EntityStatusService {
  private readonly db = inject(DatabaseService);
  private readonly api = inject(ApiService);
  private readonly users = inject(UserRepository);

  readonly cards = signal<EntityCard[]>([]);
  readonly checking = signal(false);
  readonly lastError = signal('');

  /**
   * Cuenta lo que hay guardado, sin consultar al servidor.
   *
   * Es lo que se muestra al abrir la pantalla: instantáneo y sin conexión.
   */
  async loadLocalCounts(): Promise<void> {
    const session = await this.users.getActiveSession();
    if (!session) return;

    const userId = this.effectiveUserId(session.CompanyID, session.UserID);
    const previous = new Map(this.cards().map((c) => [c.entity, c]));
    const cards: EntityCard[] = [];

    for (const entity of ENTITY_ORDER) {
      const store = ENTITY_TO_STORE[entity];
      const localCount = await this.countLocal(store, userId);
      const before = previous.get(entity);

      cards.push({
        entity,
        label: ENTITY_LABELS[entity] ?? `Entidad ${entity}`,
        hint: ENTITY_HINTS[entity] ?? '',
        store,
        localCount,
        // Se conserva lo que dijo el servidor la última vez para no perder el
        // estado al recontar en local.
        serverCount: before?.serverCount ?? 0,
        status: before?.status ?? 'unknown',
        missing: before?.missing ?? 0,
        checkedAt: before?.checkedAt ?? '',
      });
    }

    this.cards.set(cards);
  }

  /**
   * Pregunta al servidor cuántos registros debería tener cada entidad y compara.
   *
   * Necesita conexión. Guarda el resultado en `EntitySyncStatus` para poder
   * mostrarlo después sin volver a preguntar.
   */
  async checkAgainstServer(): Promise<boolean> {
    if (this.checking()) return false;

    const session = await this.users.getActiveSession();
    if (!session) return false;

    this.checking.set(true);
    this.lastError.set('');

    try {
      await this.loadLocalCounts();

      const fingerprints: Fingerprint[] = this.cards().map((card) => ({
        entity: String(card.entity),
        userID: session.UserID,
        deviceID: session.DeviceID ?? '',
        count: card.localCount,
        // El endpoint los exige, pero ya no deciden nada: ver la nota de clase.
        maxVTEntityID: 0,
        checksum: 0,
      }));

      const result = await firstValueFrom(
        this.api.post<CheckResponse>('/checkEntitySync', { data: fingerprints }),
      );

      if (!result?.status || !result.data) {
        this.lastError.set(result?.error ?? 'El servidor no pudo responder la comparación.');
        return false;
      }

      const serverCounts = new Map<number, number>();
      for (const item of result.data) {
        serverCounts.set(Number(item.entity), Number(item.serverCount) || 0);
      }

      const checkedAt = new Date().toISOString();

      this.cards.update((cards) =>
        cards.map((card) => {
          const serverCount = serverCounts.get(card.entity) ?? 0;
          return {
            ...card,
            serverCount,
            status: this.compare(card.localCount, serverCount),
            missing: Math.max(0, serverCount - card.localCount),
            checkedAt,
          };
        }),
      );

      await this.persist(session.UserID);
      return true;
    } catch (error) {
      const message =
        error && typeof error === 'object' && 'message' in error
          ? String((error as { message: unknown }).message)
          : 'No se pudo comparar con el servidor.';

      this.lastError.set(message);
      return false;
    } finally {
      this.checking.set(false);
    }
  }

  /**
   * Pide al servidor reenviar todo lo de una entidad.
   *
   * Es la salida cuando una entidad se queda corta y las sincronizaciones
   * normales no la completan: el servidor vuelve a poner sus registros en la
   * cola de entrega de este dispositivo.
   */
  async resetEntity(entity: number): Promise<boolean> {
    const session = await this.users.getActiveSession();
    if (!session) return false;

    try {
      // El endpoint exige los nombres en PascalCase; con otra capitalización
      // devuelve "Parámetros requeridos" aunque los valores sean correctos.
      const result = await firstValueFrom(
        this.api.post<{ status: boolean; error?: string }>('/resetEntitySync', {
          UserID: session.UserID,
          DeviceID: session.DeviceID ?? '',
          CompanyID: session.CompanyID,
          Entity: entity,
        }),
      );

      if (!result?.status) {
        this.lastError.set(result?.error ?? 'El servidor rechazó la solicitud.');
        return false;
      }

      return true;
    } catch (error) {
      this.lastError.set(
        error && typeof error === 'object' && 'message' in error
          ? String((error as { message: unknown }).message)
          : 'No se pudo solicitar el reenvío.',
      );
      return false;
    }
  }

  /** Vacía una entidad en local. La próxima descarga la vuelve a traer. */
  async clearEntity(entity: number): Promise<void> {
    const store = ENTITY_TO_STORE[entity];
    if (!store) return;

    await this.db.clearStore(store);
    await this.loadLocalCounts();
  }

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Cuenta los registros de un store descartando los marcados como eliminados.
   *
   * El campo de borrado **no es consistente entre entidades**: unas usan
   * `IsDeleted` numérico y otras `isDeleted` como texto, porque así llegan del
   * backend. Se comprueban ambos para que el conteo cuadre con el del servidor
   * y no aparezcan faltantes fantasma.
   */
  private async countLocal(store: string, userId: number): Promise<number> {
    if (!store) return 0;

    try {
      const rows = await this.db.transaction(store, 'readonly', (tx) => {
        const objectStore = tx.objectStore(store);

        if (objectStore.indexNames.contains('byUserID')) {
          return this.db.request<Record<string, unknown>[]>(
            objectStore.index('byUserID').getAll(userId),
          );
        }

        return this.db.request<Record<string, unknown>[]>(objectStore.getAll());
      });

      return rows.filter((row) => !this.isDeleted(row)).length;
    } catch (error) {
      console.warn(`[EntityStatus] No se pudo contar ${store}`, error);
      return 0;
    }
  }

  private isDeleted(row: Record<string, unknown>): boolean {
    const value = row['IsDeleted'] ?? row['isDeleted'];
    return value === 1 || value === '1' || value === true || value === 'true';
  }

  private compare(local: number, server: number): EntitySyncStatus {
    if (local === server) return 'synced';
    return server > local ? 'outdated' : 'ahead';
  }

  /** La compañía 3502 comparte los datos bajo un único usuario del servidor. */
  private effectiveUserId(companyId: number, userId: string): number {
    return companyId === 3502 ? 771295 : Number(userId) || 0;
  }

  /** Guarda la comparación para poder mostrarla sin conexión. */
  private async persist(userId: string): Promise<void> {
    try {
      const rows = this.cards().map((card) => ({
        Entity: String(card.entity),
        UserID: Number(userId) || 0,
        LocalCount: card.localCount,
        ServerCount: card.serverCount,
        LocalMax: 0,
        LocalChecksum: 0,
        CheckedAt: card.checkedAt,
      }));

      await this.db.transaction('EntitySyncStatus', 'readwrite', async (tx) => {
        const store = tx.objectStore('EntitySyncStatus');

        // Se reemplaza todo lo del usuario: acumular históricos aquí no aporta
        // y haría crecer el store sin límite.
        const existing = await this.db.request<Record<string, unknown>[]>(
          store.index('byUserID').getAll(Number(userId) || 0),
        );
        for (const row of existing) {
          if (row['ID'] !== undefined) store.delete(row['ID'] as IDBValidKey);
        }

        for (const row of rows) store.put(row);
      });
    } catch (error) {
      console.warn('[EntityStatus] No se pudo guardar la comparación', error);
    }
  }
}
