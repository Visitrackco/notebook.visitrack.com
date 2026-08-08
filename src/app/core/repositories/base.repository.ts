import { inject } from '@angular/core';

import { DatabaseService } from '../database/database.service';

/** Criterios de una consulta sobre un store. */
export interface QueryOptions<T> {
  /** Índice por el que buscar. Si se omite, recorre por llave primaria. */
  index?: string;
  /** Valor exacto o rango sobre el índice. */
  range?: IDBValidKey | IDBKeyRange;
  /** Filtro adicional en memoria, para lo que el índice no puede expresar. */
  filter?: (item: T) => boolean;
  /** Máximo de registros a devolver. */
  limit?: number;
  /** Cuántos saltar antes de empezar a acumular (paginación). */
  offset?: number;
  /** 'next' ascendente (por defecto), 'prev' descendente. */
  direction?: IDBCursorDirection;
}

/**
 * Repositorio genérico sobre un object store.
 *
 * ## Por qué el patrón repositorio aquí
 *
 * Aísla al resto de la aplicación de que los datos vienen de IndexedDB. Los
 * componentes y servicios piden `usuarios activos` o `actividades pendientes`,
 * no cursores ni transacciones. Eso permite cambiar el motor de almacenamiento,
 * o poner una caché delante, sin tocar la UI.
 *
 * También es donde vive el conocimiento de **cómo se consulta cada entidad**:
 * qué índice usar, qué se filtra en memoria y qué reglas de negocio aplican al
 * leer. Repartido por los componentes, ese conocimiento se duplica y diverge.
 *
 * ## Cómo se extiende
 *
 * Cada entidad hereda de aquí y agrega sus consultas propias:
 *
 * ```ts
 * @Injectable({ providedIn: 'root' })
 * export class SurveyRepository extends BaseRepository<Survey> {
 *   protected readonly storeName = 'Surveys';
 *
 *   findActiveByUser(userId: number) {
 *     return this.query({
 *       index: 'byUserID',
 *       range: userId,
 *       filter: (s) => s.IsDeleted !== 1,
 *     });
 *   }
 * }
 * ```
 *
 * @typeParam T Tipo del modelo que guarda el store.
 */
export abstract class BaseRepository<T> {
  protected readonly db = inject(DatabaseService);

  /** Nombre del object store. Lo define cada repositorio concreto. */
  protected abstract readonly storeName: string;

  // ───────────────────────────────────────────────────────────────────────────
  // Lectura
  // ───────────────────────────────────────────────────────────────────────────

  /** Un registro por su llave primaria. `null` si no existe. */
  async getByKey(key: IDBValidKey): Promise<T | null> {
    return this.db.transaction(this.storeName, 'readonly', async (tx) => {
      const result = await this.db.request<T | undefined>(
        tx.objectStore(this.storeName).get(key),
      );
      return result ?? null;
    });
  }

  /** El primer registro que coincide con un índice. `null` si no hay ninguno. */
  async getByIndex(index: string, value: IDBValidKey): Promise<T | null> {
    return this.db.transaction(this.storeName, 'readonly', async (tx) => {
      const result = await this.db.request<T | undefined>(
        tx.objectStore(this.storeName).index(index).get(value),
      );
      return result ?? null;
    });
  }

  /** Todos los registros del store. Usar con cuidado en stores grandes. */
  async getAll(): Promise<T[]> {
    return this.db.transaction(this.storeName, 'readonly', (tx) =>
      this.db.request<T[]>(tx.objectStore(this.storeName).getAll()),
    );
  }

  /**
   * Consulta con índice, filtro y paginación.
   *
   * Recorre con cursor en vez de `getAll()` porque así se puede cortar apenas
   * se alcanza el `limit`: con `getAll()` el navegador materializa el store
   * entero en memoria antes de filtrar, y en un store como `ListsDet` —que
   * puede tener decenas de miles de ítems— eso congela la pestaña.
   */
  async query(options: QueryOptions<T> = {}): Promise<T[]> {
    const { index, range, filter, limit, offset = 0, direction = 'next' } = options;

    return this.db.transaction(this.storeName, 'readonly', async (tx) => {
      const store = tx.objectStore(this.storeName);
      const source: IDBObjectStore | IDBIndex = index ? store.index(index) : store;

      // Sin filtro ni paginación, getAll() es bastante más rápido que iterar.
      if (!filter && !offset && direction === 'next') {
        return this.db.request<T[]>(source.getAll(range ?? null, limit));
      }

      return new Promise<T[]>((resolve, reject) => {
        const results: T[] = [];
        let skipped = 0;

        const request = source.openCursor(range ?? null, direction);

        request.onsuccess = () => {
          const cursor = request.result;

          if (!cursor) {
            resolve(results);
            return;
          }

          const value = cursor.value as T;

          if (!filter || filter(value)) {
            if (skipped < offset) {
              skipped++;
            } else {
              results.push(value);
              if (limit !== undefined && results.length >= limit) {
                resolve(results);
                return;
              }
            }
          }

          cursor.continue();
        };

        request.onerror = () => reject(request.error);
      });
    });
  }

  /**
   * Cuántos registros coinciden.
   *
   * Sin `filter` usa el contador nativo del índice, que no lee los registros.
   * Con `filter` no queda otra que recorrer, porque IndexedDB no sabe evaluar
   * una condición arbitraria.
   */
  async count(options: Pick<QueryOptions<T>, 'index' | 'range' | 'filter'> = {}): Promise<number> {
    const { index, range, filter } = options;

    if (!filter) {
      return this.db.transaction(this.storeName, 'readonly', (tx) => {
        const store = tx.objectStore(this.storeName);
        const source: IDBObjectStore | IDBIndex = index ? store.index(index) : store;
        return this.db.request<number>(source.count(range ?? undefined));
      });
    }

    const items = await this.query({ index, range, filter });
    return items.length;
  }

  /** true si existe al menos un registro que coincida. */
  async exists(options: Pick<QueryOptions<T>, 'index' | 'range' | 'filter'> = {}): Promise<boolean> {
    const found = await this.query({ ...options, limit: 1 });
    return found.length > 0;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Escritura
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Una llave para un registro creado aquí.
   *
   * ## Por qué hace falta
   *
   * Los catálogos —ubicaciones, activos, ítems de lista— llevan como llave el
   * `ID` que asigna Visitrack, así que su store **no autoincrementa**: los
   * registros que bajan del servidor traen el suyo y hay que respetarlo. Pero
   * eso deja sin llave a lo que se crea en el navegador, y `put` falla con
   * «Evaluating the object store's key path did not yield a value» — sin llave
   * IndexedDB no sabe dónde ponerlo.
   *
   * Activar el autoincremento no es una opción: solo se puede fijar al crear el
   * store, y rehacerlo significaría borrar todo lo descargado.
   *
   * ## Por qué negativa
   *
   * Los identificadores de Visitrack son positivos. Uno negativo no puede
   * colisionar con ninguno hoy ni con ninguno que llegue mañana, y además se
   * reconoce de un vistazo: si aparece un `ID` negativo, ese registro nació en
   * este dispositivo y todavía no ha subido.
   *
   * Se toma el menor que haya y se resta uno, así que son consecutivos y el
   * orden de creación se conserva.
   */
  async nextLocalKey(): Promise<number> {
    return this.db.transaction(this.storeName, 'readonly', async (tx) => {
      const store = tx.objectStore(this.storeName);

      // El primero del recorrido ascendente es el menor: si es negativo, ese es
      // el último que se creó aquí.
      const cursor = await this.db.request<IDBCursorWithValue | null>(
        store.openCursor(null, 'next'),
      );

      const lowest = Number(cursor?.key ?? 0);
      return lowest < 0 ? lowest - 1 : -1;
    });
  }

  /** Inserta o reemplaza un registro. Devuelve su llave. */
  async put(item: T): Promise<IDBValidKey> {
    return this.db.transaction(this.storeName, 'readwrite', (tx) =>
      this.db.request<IDBValidKey>(tx.objectStore(this.storeName).put(item)),
    );
  }

  /**
   * Inserta o reemplaza muchos registros en UNA transacción.
   *
   * Es lo que usa la sincronización al bajar catálogos. Una transacción por
   * registro sería órdenes de magnitud más lento: el costo de IndexedDB está
   * en confirmar la transacción, no en cada `put`.
   */
  async putMany(items: readonly T[]): Promise<number> {
    if (items.length === 0) return 0;

    return this.db.transaction(this.storeName, 'readwrite', async (tx) => {
      const store = tx.objectStore(this.storeName);
      for (const item of items) {
        // Sin await por registro: se encolan todas y la transacción las
        // procesa en orden. Esperar una por una multiplica el tiempo total.
        store.put(item);
      }
      return items.length;
    });
  }

  /**
   * Inserta solo si la llave no existe. Devuelve la llave, o `null` si ya estaba.
   *
   * Útil para datos que llegan por sincronización y no deben pisar cambios
   * locales sin sincronizar.
   */
  async add(item: T): Promise<IDBValidKey | null> {
    try {
      return await this.db.transaction(this.storeName, 'readwrite', (tx) =>
        this.db.request<IDBValidKey>(tx.objectStore(this.storeName).add(item)),
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === 'ConstraintError') return null;
      throw error;
    }
  }

  /**
   * Aplica cambios parciales sobre un registro existente.
   *
   * Lee y escribe en la MISMA transacción: hacerlo en dos transacciones
   * separadas abre una ventana donde otra operación puede escribir en medio y
   * perderse.
   */
  async update(key: IDBValidKey, changes: Partial<T>): Promise<T | null> {
    return this.db.transaction(this.storeName, 'readwrite', async (tx) => {
      const store = tx.objectStore(this.storeName);
      const current = await this.db.request<T | undefined>(store.get(key));

      if (!current) return null;

      const updated = { ...current, ...changes } as T;
      store.put(updated);
      return updated;
    });
  }

  /** Elimina por llave primaria. */
  async delete(key: IDBValidKey): Promise<void> {
    await this.db.transaction(this.storeName, 'readwrite', (tx) =>
      this.db.request(tx.objectStore(this.storeName).delete(key)),
    );
  }

  /** Elimina todos los registros que coincidan. Devuelve cuántos borró. */
  async deleteWhere(options: QueryOptions<T>): Promise<number> {
    const items = await this.query(options);
    if (items.length === 0) return 0;

    const keyPath = await this.keyPath();

    return this.db.transaction(this.storeName, 'readwrite', async (tx) => {
      const store = tx.objectStore(this.storeName);
      for (const item of items) {
        const key = (item as Record<string, unknown>)[keyPath] as IDBValidKey;
        if (key !== undefined) store.delete(key);
      }
      return items.length;
    });
  }

  /** Vacía el store. */
  async clear(): Promise<void> {
    await this.db.clearStore(this.storeName);
  }

  /** Nombre del campo que actúa como llave primaria. */
  protected async keyPath(): Promise<string> {
    return this.db.transaction(this.storeName, 'readonly', (tx) => {
      const path = tx.objectStore(this.storeName).keyPath;
      return Array.isArray(path) ? path[0] : (path as string);
    });
  }
}
