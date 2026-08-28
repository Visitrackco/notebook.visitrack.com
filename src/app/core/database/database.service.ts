import { Injectable, signal } from '@angular/core';

import { DB_NAME, DB_SCHEMA, DB_VERSION, StoreDefinition } from './schema';

/**
 * Acceso de bajo nivel a IndexedDB.
 *
 * Es el equivalente del `DBProvider` del móvil: **todo** lo que toca la base
 * local pasa por aquí. Los repositorios (`core/repositories`) se apoyan en este
 * servicio y son los únicos que deberían usarlo; los componentes nunca lo
 * inyectan directamente.
 *
 * ## Por qué envolver IndexedDB
 *
 * La API nativa es basada en eventos (`onsuccess` / `onerror`) y muy verbosa.
 * Este servicio la convierte en promesas y concentra en un solo lugar tres
 * cosas que de otro modo se repetirían en cada consulta: la apertura perezosa
 * con control de concurrencia, el manejo de transacciones, y el bloqueo por
 * actualización de esquema.
 *
 * ## Concurrencia en la apertura
 *
 * Varias llamadas simultáneas al arrancar la app (sesión, permisos, contadores)
 * pedirían la base a la vez. Se guarda la promesa de apertura en curso y todas
 * esperan la misma, en vez de disparar varias conexiones.
 */
@Injectable({ providedIn: 'root' })
export class DatabaseService {
  private db: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase> | null = null;

  /**
   * Otra pestaña tiene abierta una versión anterior y bloquea la actualización
   * del esquema. La UI lo usa para pedirle al usuario que cierre las demás.
   */
  readonly upgradeBlocked = signal(false);

  /** true cuando la base ya está abierta y lista para consultas. */
  readonly ready = signal(false);

  // ───────────────────────────────────────────────────────────────────────────
  // Apertura y esquema
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Devuelve la conexión, abriéndola la primera vez.
   *
   * Aplica el esquema en `onupgradeneeded`: crea los stores e índices que
   * falten. Es incremental — un store que ya existe no se toca, así que subir
   * `DB_VERSION` para agregar un índice no borra datos.
   */
  async open(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    if (this.opening) return this.opening;

    this.opening = new Promise<IDBDatabase>((resolve, reject) => {
      if (!('indexedDB' in globalThis)) {
        reject(new Error('Este navegador no soporta almacenamiento local (IndexedDB).'));
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = request.result;
        const transaction = request.transaction;
        if (!transaction) return;

        console.info(
          `[DB] Actualizando esquema: v${event.oldVersion} → v${event.newVersion}`,
        );

        for (const store of DB_SCHEMA) {
          this.applyStore(db, transaction, store);
        }
      };

      request.onsuccess = () => {
        const db = request.result;

        // Otra pestaña subió la versión: esta conexión quedó obsoleta y hay que
        // cerrarla, o bloquearía la actualización de la otra.
        db.onversionchange = () => {
          db.close();
          this.db = null;
          this.ready.set(false);
          this.upgradeBlocked.set(true);
        };

        this.db = db;
        this.ready.set(true);
        this.upgradeBlocked.set(false);
        resolve(db);
      };

      request.onerror = () => {
        this.opening = null;
        reject(request.error ?? new Error('No se pudo abrir la base de datos local.'));
      };

      // Hay otra pestaña con una versión anterior abierta. No es un error: se
      // resolverá sola cuando la cierren, pero hay que avisarle al usuario
      // porque desde su punto de vista la app "no carga".
      request.onblocked = () => {
        this.upgradeBlocked.set(true);
      };
    });

    return this.opening;
  }

  /** Crea el store y sus índices si faltan. Nunca borra lo que ya existe. */
  private applyStore(
    db: IDBDatabase,
    transaction: IDBTransaction,
    definition: StoreDefinition,
  ): void {
    let store: IDBObjectStore;

    if (db.objectStoreNames.contains(definition.name)) {
      store = transaction.objectStore(definition.name);
    } else {
      store = db.createObjectStore(definition.name, {
        keyPath: definition.keyPath,
        autoIncrement: definition.autoIncrement ?? false,
      });
    }

    for (const index of definition.indexes ?? []) {
      if (store.indexNames.contains(index.name)) continue;

      store.createIndex(index.name, index.keyPath, {
        unique: index.unique ?? false,
        multiEntry: index.multiEntry ?? false,
      });
    }
  }

  /** Cierra la conexión. Se usa al cerrar sesión y en las pruebas. */
  close(): void {
    this.db?.close();
    this.db = null;
    this.opening = null;
    this.ready.set(false);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Transacciones
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Ejecuta [work] dentro de una transacción y resuelve cuando ésta se confirma.
   *
   * Espera al evento `complete`, no al resultado de [work]: una transacción de
   * IndexedDB puede abortar DESPUÉS de que la última operación respondió (por
   * cuota agotada, por ejemplo). Resolver antes daría por escrito algo que
   * terminó revertido.
   */
  async transaction<T>(
    stores: string | string[],
    mode: IDBTransactionMode,
    work: (tx: IDBTransaction) => Promise<T> | T,
  ): Promise<T> {
    const db = await this.open();
    const names = Array.isArray(stores) ? stores : [stores];

    return new Promise<T>((resolve, reject) => {
      let result: T;
      let failed = false;

      const tx = db.transaction(names, mode);

      tx.oncomplete = () => {
        if (!failed) resolve(result);
      };
      tx.onerror = () => reject(tx.error ?? new Error('La transacción falló.'));
      tx.onabort = () => reject(tx.error ?? new Error('La transacción fue abortada.'));

      Promise.resolve(work(tx))
        .then((value) => {
          result = value;
        })
        .catch((error) => {
          failed = true;
          try {
            tx.abort();
          } catch {
            // Ya estaba abortada o terminada.
          }
          reject(error);
        });
    });
  }

  /** Convierte una petición de IndexedDB en promesa. */
  request<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Error en la petición.'));
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Utilidades de diagnóstico
  // ───────────────────────────────────────────────────────────────────────────

  /** Cuántos registros hay en cada store. Alimenta la pantalla de sincronización. */
  /**
   * Cuántos registros hay **de una persona** en cada tienda.
   *
   * `counts()` cuenta todo lo que hay en la base, y en este navegador puede
   * haber datos de varias cuentas: la aplicación permite cambiar de usuario sin
   * borrar lo del anterior, precisamente para no obligar a descargarlo todo de
   * nuevo al volver. Sumarlos hacía que el inicio anunciara formularios y
   * ubicaciones que esta sesión no puede abrir.
   *
   * Se cuenta por el índice `byUserID`, que existe en casi todas las tiendas.
   * Donde no existe —las de configuración, que no son de nadie en particular—
   * se cuenta entero, que ahí sí es la respuesta correcta.
   */
  async countsForUser(userId: string): Promise<Record<string, number>> {
    const db = await this.open();
    const names = Array.from(db.objectStoreNames);
    if (names.length === 0) return {};

    return this.transaction(names, 'readonly', async (tx) => {
      const result: Record<string, number> = {};

      for (const name of names) {
        const store = tx.objectStore(name);

        if (!store.indexNames.contains('byUserID')) {
          result[name] = await this.request(store.count());
          continue;
        }

        const indice = store.index('byUserID');
        let n = await this.request(indice.count(userId));

        /*
         * IndexedDB indexa por tipo: la clave '766688' y la clave 766688 son
         * distintas y no se encuentran entre sí. Según de dónde venga la fila
         * —del inicio de sesión o de la sincronización— el identificador puede
         * haberse guardado como texto o como número, así que si por un lado no
         * aparece nada se prueba por el otro antes de dar cero por bueno.
         */
        if (n === 0) {
          const comoNumero = Number(userId);
          if (Number.isFinite(comoNumero) && userId !== '') {
            n = await this.request(indice.count(comoNumero));
          }
        }

        result[name] = n;
      }

      return result;
    });
  }

  async counts(): Promise<Record<string, number>> {
    const db = await this.open();
    const names = Array.from(db.objectStoreNames);
    if (names.length === 0) return {};

    return this.transaction(names, 'readonly', async (tx) => {
      const result: Record<string, number> = {};
      for (const name of names) {
        result[name] = await this.request(tx.objectStore(name).count());
      }
      return result;
    });
  }

  /**
   * Espacio usado y disponible, en bytes.
   *
   * El navegador puede purgar IndexedDB si el disco se llena, así que conviene
   * poder avisar antes de que eso pase. `null` si el navegador no lo expone.
   */
  async storageEstimate(): Promise<{ usage: number; quota: number } | null> {
    if (!navigator.storage?.estimate) return null;

    const { usage, quota } = await navigator.storage.estimate();
    if (usage === undefined || quota === undefined) return null;

    return { usage, quota };
  }

  /**
   * Pide almacenamiento persistente para que el navegador no borre los datos
   * al quedarse sin espacio.
   *
   * Es clave para el modo offline: sin esto, el navegador puede purgar la base
   * y el usuario perdería actividades sin sincronizar. Devuelve si se concedió.
   */
  async requestPersistentStorage(): Promise<boolean> {
    if (!navigator.storage?.persist) return false;

    try {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  }

  /** Vacía un store. Se usa al reiniciar la sincronización de una entidad. */
  async clearStore(name: string): Promise<void> {
    await this.transaction(name, 'readwrite', (tx) =>
      this.request(tx.objectStore(name).clear()),
    );
  }

  /**
   * Borra la base completa. Solo para "cerrar sesión y limpiar todo" o para
   * recuperarse de una base corrupta.
   */
  async deleteDatabase(): Promise<void> {
    this.close();

    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(new Error('Hay otras pestañas abiertas. Ciérralas e inténtalo de nuevo.')),
        undefined;
    });
  }
}
