import { Injectable, computed, inject, signal } from '@angular/core';

import { environment } from '../../../environments/environment';
import { DatabaseService } from '../database/database.service';
import { DataRevisionService } from '../sync/data-revision.service';
import { SyncService } from '../sync/sync.service';
import { AuthService } from './auth.service';
import { DeviceService } from './device.service';

/** En qué punto está la vinculación. Los nombres son los del servidor. */
export type LinkState =
  | 'inactivo'
  | 'pendiente'
  | 'reclamado'
  | 'transfiriendo'
  /** Trayendo del servidor los catálogos que la cuenta necesita. */
  | 'sincronizando'
  | 'listo'
  | 'caducado'
  | 'error';

/** El equipo que entregó los datos. */
export interface LinkedPhone {
  id: string;
  name: string;
  os: string;
  model: string;
}

/** Lo que se guarda de una vinculación pasada. */
export interface LinkRecord {
  phone: LinkedPhone;
  at: string;
  records: number;
  files: number;
}

/** Un lote tal como lo dejó el teléfono. */
interface LinkBatch {
  kind: string;
  records: Record<string, unknown>[];
}

/**
 * Dónde va cada lote.
 *
 * **Todos se escriben tal cual, sin mapeador.** Los mapeadores de la
 * sincronización traducen lo que manda **el servidor**, que tiene otra forma:
 * `mapLocation` toma el `ID` del servidor como `LocationID` y busca un
 * `LocationTypeID` que en el teléfono no existe con ese nombre. Pasarle por ahí
 * una fila del teléfono no la traduce — la estropea, y en silencio.
 *
 * Aquí no hace falta traducir nada: las tablas del teléfono y las del navegador
 * tienen **las mismas columnas**, porque las dos son copias locales de lo mismo
 * y se diseñaron así a propósito.
 */
const LINK_STORES: Record<string, string> = {
  '1': 'LocationsForms',
  '8': 'ListsDet',
  '9': 'SurveyAnswers',
  '12': 'Assets',
  binaries: 'BinariesResources',
  changelog: 'ChangeLog',
};

/** Cada cuánto se le pregunta al servidor en qué va. */
const POLL_MS = 2000;

/** Dónde se recuerda el último teléfono vinculado. */
const LINKED_KEY = 'vt.link.last';

/**
 * Traer al navegador el trabajo que está en el teléfono.
 *
 * ## Qué resuelve
 *
 * El navegador solo ve lo que está en Visitrack. Quien lleva días en campo
 * tiene en su teléfono actividades a medias, ubicaciones que creó y fotos que
 * no han podido subir por falta de señal — y nada de eso existe aquí, así que
 * no hay forma de continuar ese trabajo desde un computador.
 *
 * Vincular lo traspasa: esta pantalla enseña un código, el teléfono lo escanea
 * y entrega lo suyo.
 *
 * ## Lo que llega se escribe tal cual
 *
 * Sin traducir. Las tablas del teléfono y las del navegador tienen las mismas
 * columnas —las dos son copias locales de lo mismo— así que no hay nada que
 * convertir. Los mapeadores de la sincronización sirven para lo que manda el
 * **servidor**, que sí tiene otra forma; usarlos aquí no traduciría una fila
 * del teléfono, la estropearía.
 *
 * ## Nada se marca como subido
 *
 * Lo que llegó pendiente sigue pendiente. El teléfono conserva su copia, así
 * que los dos equipos tienen lo mismo por subir y el primero que lo haga gana
 * — el GUID es el mismo y el servidor no duplica. Marcarlo como resuelto aquí
 * dejaría el trabajo sin dueño si este navegador nunca llegara a subirlo.
 */
@Injectable({ providedIn: 'root' })
export class DeviceLinkService {
  private readonly db = inject(DatabaseService);
  private readonly device = inject(DeviceService);
  private readonly revisions = inject(DataRevisionService);
  private readonly auth = inject(AuthService);
  private readonly sync = inject(SyncService);

  readonly state = signal<LinkState>('inactivo');
  readonly code = signal('');
  readonly expiresAt = signal<Date | null>(null);
  readonly phone = signal<LinkedPhone | null>(null);
  readonly error = signal('');

  /** Cuántos registros y archivos se han escrito ya. */
  readonly savedRecords = signal(0);
  readonly savedFiles = signal(0);

  /** Cuántos anunció el teléfono, para poder medir el avance. */
  readonly totalBatches = signal(0);
  readonly totalFiles = signal(0);

  readonly active = computed(
    () => this.state() !== 'inactivo' && this.state() !== 'caducado' && this.state() !== 'error',
  );

  readonly done = computed(() => this.state() === 'listo');

  /**
   * Cuánto se ha hecho, de 0 a 1.
   *
   * Los lotes pesan lo mismo que los archivos a efectos de barra: no es exacto
   * —un archivo tarda más que un lote— pero una barra que avanza a saltos
   * desiguales se lee peor que una que avanza despacio y sin sorpresas.
   */
  readonly progress = computed(() => {
    const total = this.totalBatches() + this.totalFiles();
    if (total === 0) return 0;

    return Math.min(1, (this.cursorSignal() + this.savedFiles()) / total);
  });

  /** Cuántos registros venían ya en este equipo y no se tocaron. */
  readonly skipped = signal(0);

  /** Cuántos ya estaban pero el teléfono los tenía más nuevos. */
  readonly updated = signal(0);

  private readonly cursorSignal = signal(0);

  private timer?: ReturnType<typeof setTimeout>;
  private cursor = 0;

  /**
   * Lo que se ha escrito en esta vinculación.
   *
   * Se apunta para poder **deshacerlo**. Un traspaso que falla a la mitad deja
   * la base con parte de un conjunto, y eso es peor que no haber empezado: no
   * hay forma de saber qué falta, y lo que hay parece completo.
   */
  private written: { store: string; key: IDBValidKey }[] = [];

  /**
   * La sesión de este navegador nació de esta vinculación.
   *
   * Importa al cancelar: si el traspaso no llega a completarse hay que salir,
   * porque se entró por una puerta que no terminó de abrirse. Si ya había
   * sesión antes, no se toca — el usuario estaba trabajando aquí.
   */
  private sessionFromLink = false;

  private get baseUrl(): string {
    return environment.useLocalApi ? environment.localApiUrl : environment.apiUrl;
  }

  /** El último teléfono que entregó datos aquí. */
  lastLink(): LinkRecord | null {
    try {
      const raw = localStorage.getItem(LINKED_KEY);
      return raw ? (JSON.parse(raw) as LinkRecord) : null;
    } catch {
      return null;
    }
  }

  /**
   * Pide un código y empieza a esperar al teléfono.
   *
   * El navegador se identifica con su propio `DeviceID` —el mismo que ya usa
   * para sincronizar— y con la descripción del navegador y el sistema. No es
   * para autenticarse: es lo que el teléfono enseña antes de aceptar, para que
   * quien escanea sepa a qué equipo le va a entregar sus datos.
   */
  async start(): Promise<void> {
    this.reset();
    this.state.set('pendiente');

    try {
      const info = this.device.getDeviceInfo();

      const reply = await fetch(`${this.baseUrl}/link/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device: {
            id: this.device.getDeviceId(),
            name: info.browser,
            os: info.os,
            model: info.description,
          },
        }),
      });

      const result = (await reply.json()) as {
        status?: boolean;
        error?: string;
        response?: { code: string; expiresAt: string };
      };

      if (result?.status !== true || !result.response?.code) {
        throw new Error(result?.error ?? 'El servidor no entregó un código.');
      }

      this.code.set(result.response.code);
      this.expiresAt.set(new Date(result.response.expiresAt));

      this.poll();
    } catch (error) {
      this.fail(error, 'No se pudo iniciar la vinculación.');
    }
  }

  /** Cancela la espera. El código caduca solo. */
  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.state.set('inactivo');
  }

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Pregunta en qué va y recoge lo que haya.
   *
   * Se recoge **mientras el teléfono sigue enviando**, no al final: así el
   * traspaso avanza a la vista y una transferencia larga no parece colgada.
   */
  private poll(): void {
    clearTimeout(this.timer);

    this.timer = setTimeout(async () => {
      try {
        const reply = await fetch(
          `${this.baseUrl}/link/status?code=${encodeURIComponent(this.code())}`,
        );

        const result = (await reply.json()) as {
          response?: {
            state: LinkState;
            phone: LinkedPhone | null;
            batches: number;
            files: number;
            error?: string;
          };
        };

        const info = result?.response;

        if (!info || info.state === 'caducado') {
          // Si ya se habia escrito algo, se deshace: un traspaso que caduca a
          // la mitad deja lo mismo que uno que falla.
          if (this.written.length > 0) {
            await this.abort('El traspaso se interrumpió y no se guardó nada.');
            return;
          }

          this.state.set('caducado');
          this.error.set(info?.error ?? 'El código caducó. Genera uno nuevo.');
          return;
        }

        this.state.set(info.state);
        if (info.phone) this.phone.set(info.phone);

        this.totalBatches.set(info.batches);
        this.totalFiles.set(info.files);

        try {
          if (info.batches > this.cursor) await this.drain();

          if (info.state === 'listo' && this.cursor >= info.batches) {
            await this.finish(info);
            return;
          }
        } catch (error) {
          /**
           * Escribir falló: se cancela entero.
           *
           * Distinto de un fallo de red al preguntar el estado. Aquí ya se
           * estaba tocando la base, y seguir dejaría un conjunto a medias que
           * parece completo.
           */
          console.error('[Vincular] fallo al recibir', error);

          await this.abort(
            'El traspaso se canceló y no se guardó nada. Vuelve a intentarlo con un código nuevo.',
          );
          return;
        }

        this.poll();
      } catch (error) {
        // Un fallo de red al preguntar el estado no cancela nada: el servidor
        // guarda lo que el teléfono ya dejó y en la vuelta siguiente se sigue
        // donde iba.
        console.warn('[Vincular] no se pudo consultar el estado', error);
        this.poll();
      }
    }, POLL_MS);
  }

  /** Trae los lotes que faltan y los escribe. */
  private async drain(): Promise<void> {
    for (;;) {
      const reply = await fetch(
        `${this.baseUrl}/link/pull?code=${encodeURIComponent(this.code())}&from=${this.cursor}`,
      );

      const result = (await reply.json()) as {
        status?: boolean;
        response?: { batches: LinkBatch[]; next: number };
      };

      const batches = result?.response?.batches ?? [];
      if (batches.length === 0) return;

      for (const batch of batches) await this.writeBatch(batch);

      this.cursor = result.response?.next ?? this.cursor + batches.length;
      this.cursorSignal.set(this.cursor);
    }
  }

  /**
   * Escribe un lote en la base local.
   *
   * `kind` dice de qué entidad es, con los mismos números que la
   * sincronización. Un lote de una entidad que este navegador no conoce se
   * ignora en vez de romper el traspaso: prefiero perder una tabla nueva a
   * perder las nueve que sí entiendo.
   */
  private async writeBatch(batch: LinkBatch): Promise<void> {
    /**
     * La sesión no se escribe como un lote más.
     *
     * Entra por [AuthService], que es quien sabe encender una sesión y avisar
     * al resto de la aplicación. Escribirla a mano en el almacén dejaría la
     * base con una sesión que la aplicación no sabe que existe.
     */
    if (batch.kind === 'session') {
      await this.adoptSession(batch.records[0]);
      return;
    }

    const store = LINK_STORES[batch.kind];

    if (!store) {
      console.warn('[Vincular] lote de un tipo desconocido', batch.kind);
      return;
    }

    /**
     * Un registro que falla **detiene el traspaso**.
     *
     * Dejar pasar un fallo dejaría al usuario con un conjunto al que le falta
     * algo, sin que nada lo diga. Es preferible cancelar entero y que lo vuelva
     * a intentar — para eso está el deshacer.
     */
    for (const raw of batch.records) {
      const saved = await this.putByGuid(store, { ...raw });
      if (saved) this.savedRecords.update((count) => count + 1);
    }

    this.revisions.touchAll();
  }

  /**
   * Guarda respetando el GUID.
   *
   * Es la misma regla que la descarga: lo que identifica un registro entre dos
   * equipos es su GUID, no su llave local. Sin esto, un registro que ya
   * estuviera aquí aparecería dos veces.
   */
  private async putByGuid(store: string, record: Record<string, unknown>): Promise<boolean> {
    return this.db.transaction(store, 'readwrite', async (tx) => {
      const objectStore = tx.objectStore(store);
      const guid = String(record['GUID'] ?? '');

      if (guid && objectStore.indexNames.contains('byGUID')) {
        const existing = await this.db.request<Record<string, unknown> | undefined>(
          objectStore.index('byGUID').get(guid),
        );

        /**
         * Lo que ya está aquí solo se toca si el teléfono lo tiene más nuevo.
         *
         * Es la única regla que satisface las dos cosas que hacen falta:
         *
         * - **No duplicar ni rehacer.** El GUID es el mismo registro en los dos
         *   equipos; traerlo otra vez sin más no aportaría nada.
         * - **No perder cambios.** Si en el teléfono se le cambió el estado, o
         *   se respondió un campo más, esa versión es la buena y tiene que
         *   llegar. Saltarla siempre —como se hacía— dejaba el navegador con la
         *   copia vieja y sin forma de enterarse.
         *
         * Decide la fecha de modificación, no quién habló primero. Así una
         * actividad que se está editando **aquí** tampoco se pisa con una copia
         * anterior del teléfono.
         */
        if (existing) {
          if (!isNewer(record, existing)) {
            this.skipped.update((count) => count + 1);
            return false;
          }

          // Se conserva la llave local: es el mismo registro, no uno nuevo.
          record['ID'] = existing['ID'];

          await this.db.request(objectStore.put(record));
          this.updated.update((count) => count + 1);

          return false;
        }
      }

      // Sin `ID` propio, la llave la pone IndexedDB y hay que recogerla para
      // poder deshacerlo si el traspaso falla más adelante.
      const key = await this.db.request<IDBValidKey>(objectStore.put(record));

      this.written.push({ store, key });
      return true;
    });
  }

  /**
   * Trae los archivos que el teléfono dejó sin subir.
   *
   * Solo esos. Los que ya estaban en Visitrack no viajan: este navegador los
   * baja por su cuenta con el puente de archivos, igual que hace con los de una
   * consigna. Mandarlos por aquí sería mover megas que ya están a un clic.
   */
  /**
   * Entra a la cuenta del telefono, si aqui no habia nadie.
   *
   * Es lo que permite vincular desde la pantalla de inicio: la cuenta ya esta
   * autenticada en el telefono y lo que viaja es esa autenticacion.
   *
   * **Si ya habia sesion no se toca nada.** Cambiar de usuario a mitad de un
   * traspaso dejaria los datos que ya entraron colgando de una cuenta y los
   * siguientes de otra. Y si el telefono trae una cuenta distinta de la que
   * esta trabajando aqui, se cancela: son dos personas, y mezclarlas seria
   * mucho peor que no vincular.
   */
  private async adoptSession(raw: unknown): Promise<void> {
    const record = (raw ?? {}) as Record<string, unknown>;
    const incoming = String(record['UserID'] ?? '').trim();

    if (!incoming) return;

    const current = this.auth.currentUser();

    if (current) {
      if (String(current.UserID) !== incoming) {
        throw new Error(
          'El teléfono tiene la sesión de otra persona. Cierra sesión aquí antes de vincular.',
        );
      }

      return;
    }

    await this.auth.adoptFromLink(record);
    this.sessionFromLink = true;
  }

  private async pullFiles(): Promise<void> {
    /**
     * Qué hay que bajar lo dice el servidor.
     *
     * Antes se deducía de la tabla de archivos del propio navegador —los que no
     * estuvieran confirmados en el bucket— y eso fallaba justo en el caso más
     * común: si la actividad ya existía aquí, sus fichas también, ninguna
     * cumplía la condición y **nadie iba a por los archivos** que el teléfono
     * acababa de dejar.
     *
     * El servidor sabe exactamente qué tiene guardado. Preguntárselo quita la
     * adivinanza.
     */
    let staged: { guid: string }[] = [];

    try {
      const reply = await fetch(
        `${this.baseUrl}/link/files?code=${encodeURIComponent(this.code())}`,
      );

      const result = (await reply.json()) as {
        status?: boolean;
        response?: { files: { guid: string }[] };
      };

      staged = result?.response?.files ?? [];
    } catch (error) {
      console.warn('[Vincular] no se pudo consultar los archivos', error);
      return;
    }

    for (const file of staged) {
      const guid = String(file.guid ?? '');
      if (!guid) continue;

      // Lo que ya está aquí no se vuelve a bajar: puede venir de una
      // vinculación anterior o de haberlo abierto desde una consigna.
      if (await this.hasBlob(guid)) continue;

      try {
        const reply = await fetch(
          `${this.baseUrl}/link/file?code=${encodeURIComponent(this.code())}&guid=${encodeURIComponent(guid)}`,
        );

        if (!reply.ok) continue;

        const blob = await reply.blob();
        if (blob.size === 0) continue;

        await this.db.transaction('BinariesData', 'readwrite', (tx) =>
          this.db.request(
            tx.objectStore('BinariesData').put({
              GUID: guid,
              blob,
              savedOn: new Date().toISOString(),
            }),
          ),
        );

        this.savedFiles.update((count) => count + 1);
      } catch (error) {
        console.warn('[Vincular] no se pudo traer un archivo', guid, error);
      }
    }
  }

  /** ¿El contenido de este archivo ya está en el equipo? */
  private async hasBlob(guid: string): Promise<boolean> {
    try {
      const found = await this.db.transaction('BinariesData', 'readonly', (tx) =>
        this.db.request<{ blob?: Blob } | undefined>(tx.objectStore('BinariesData').get(guid)),
      );

      return Boolean(found?.blob);
    } catch {
      return false;
    }
  }

  /** Cierra el traspaso y deja constancia de quién lo hizo. */
  private async finish(info: { files: number }): Promise<void> {
    if (info.files > 0) await this.pullFiles();

    const record: LinkRecord = {
      phone: this.phone() ?? { id: '', name: '', os: '', model: '' },
      at: new Date().toISOString(),
      records: this.savedRecords(),
      files: this.savedFiles(),
    };

    try {
      localStorage.setItem(LINKED_KEY, JSON.stringify(record));
    } catch {
      // Sin almacenamiento el traspaso sirvió igual; solo se pierde el registro
      // de quién lo hizo.
    }

    // A partir de aqui ya no hay nada que deshacer: el traspaso llego entero.
    this.written = [];
    this.sessionFromLink = false;

    this.revisions.touchAll();

    /**
     * Se descarga del servidor antes de dejar entrar. Siempre.
     *
     * Con sesión nueva es evidente: el navegador tiene lo que le mandó el
     * teléfono y **nada más** —ni formularios, ni tipos de ubicación, ni
     * listas— y las actividades que acaban de llegar no sabrían ni con qué
     * formulario dibujarse.
     *
     * Con sesión ya iniciada también hace falta, aunque menos evidente: el
     * teléfono puede haber subido una actividad que aquí todavía no está, y esa
     * no viene por el traspaso —ya está en Visitrack— sino por la descarga. Sin
     * este paso, quien vincula ve llegar lo pendiente y **no** lo que ya subió,
     * que es justo lo contrario de lo que espera.
     *
     * Va aquí y no al entrar por dos razones. Una, que aquí hay una pantalla
     * contándolo: entrar a una aplicación vacía que se llena sola a los treinta
     * segundos se vive como que algo falló. Y dos, que si la descarga falla
     * conviene saberlo antes de haber empezado a trabajar.
     *
     * Lo que trajo el teléfono no corre peligro: la descarga respeta lo que
     * está pendiente de subir —ver `SyncService.putRecords`— y lo que ya existe
     * se reconoce por su GUID.
     */
    this.state.set('sincronizando');

    try {
      await this.sync.download();
    } catch (error) {
      // Que falle no invalida el traspaso: los datos del teléfono ya están
      // aquí. Se entra igual y la aplicación reintentará la descarga sola.
      console.warn('[Vincular] no se pudo descargar tras vincular', error);
    }

    this.state.set('listo');
  }

  /**
   * Deshace lo que este traspaso escribió.
   *
   * Solo lo suyo: se borra por la llave que devolvió cada escritura, así que lo
   * que ya estaba en el equipo —que además nunca se tocó— se queda donde
   * estaba. Un traspaso cancelado tiene que dejar el navegador como lo
   * encontró.
   */
  private async rollback(): Promise<void> {
    for (const entry of [...this.written].reverse()) {
      try {
        await this.db.transaction(entry.store, 'readwrite', (tx) =>
          this.db.request(tx.objectStore(entry.store).delete(entry.key)),
        );
      } catch (error) {
        console.warn('[Vincular] no se pudo deshacer un registro', error);
      }
    }

    this.written = [];
    this.savedRecords.set(0);
    this.savedFiles.set(0);
    this.revisions.touchAll();
  }

  /**
   * Cancela el traspaso, deja el equipo como estaba y lo cuenta.
   *
   * Si la sesión la creó esta misma vinculación, también se cierra: quedarse
   * dentro de una cuenta a la que se entró por un traspaso que no llegó a
   * completarse sería estar en una sesión que nadie autorizó del todo.
   */
  private async abort(reason: string): Promise<void> {
    clearTimeout(this.timer);

    await this.rollback();

    this.state.set('error');
    this.error.set(reason);

    if (this.sessionFromLink) {
      this.sessionFromLink = false;
      await this.auth.logout();
    }
  }

  private reset(): void {
    clearTimeout(this.timer);

    this.written = [];
    this.skipped.set(0);
    this.updated.set(0);
    this.cursorSignal.set(0);

    this.code.set('');
    this.expiresAt.set(null);
    this.phone.set(null);
    this.error.set('');
    this.savedRecords.set(0);
    this.savedFiles.set(0);
    this.totalBatches.set(0);
    this.totalFiles.set(0);
    this.cursor = 0;
  }

  private fail(error: unknown, fallback: string): void {
    console.error('[Vincular]', error);
    this.state.set('error');
    this.error.set(error instanceof Error ? error.message : fallback);
  }
}

/**
 * ¿La copia que llega es posterior a la que ya está?
 *
 * Se mira `UpdatedOn` y, si falta, `CreatedOn`. Ante la duda —fechas
 * ilegibles, o exactamente iguales— **no** se considera más nueva: en un empate
 * es preferible conservar lo que hay que arriesgarse a pisar un cambio que el
 * teléfono todavía no conocía.
 */
function isNewer(incoming: Record<string, unknown>, existing: Record<string, unknown>): boolean {
  const when = (row: Record<string, unknown>) => {
    const value = String(row['UpdatedOn'] ?? row['CreatedOn'] ?? '').trim();
    const time = Date.parse(value);

    return Number.isFinite(time) ? time : 0;
  };

  const left = when(incoming);
  const right = when(existing);

  return left > 0 && left > right;
}
