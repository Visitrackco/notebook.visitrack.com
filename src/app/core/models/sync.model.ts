/**
 * Modelos del subsistema de sincronización y de archivos binarios.
 */

/**
 * Entidades que reconoce el backend de sincronización.
 *
 * Los números NO son arbitrarios: son los códigos que usa `MOB_SyncByDevice`
 * en el servidor. Cambiarlos rompe la sincronización.
 */
export enum SyncEntity {
  Locations = 1,
  Assets = 12,
  WorkZones = 35,
  Surveys = 79,
  SurveyAnswers = 9,
  Lists = 7,
  ListsDet = 8,
  DispatchStatus = 0,
}

/** Nombre legible de cada entidad, para la pantalla de sincronización. */
export const SYNC_ENTITY_LABELS: Record<SyncEntity, string> = {
  [SyncEntity.Locations]: 'Ubicaciones',
  [SyncEntity.Assets]: 'Activos',
  [SyncEntity.WorkZones]: 'Zonas de trabajo',
  [SyncEntity.Surveys]: 'Formularios',
  [SyncEntity.SurveyAnswers]: 'Actividades',
  [SyncEntity.Lists]: 'Listas',
  [SyncEntity.ListsDet]: 'Datos de listas',
  [SyncEntity.DispatchStatus]: 'Estados',
};

/** Store local donde aterriza cada entidad al descargarse. */
export const SYNC_ENTITY_STORES: Record<SyncEntity, string> = {
  [SyncEntity.Locations]: 'LocationsForms',
  [SyncEntity.Assets]: 'Assets',
  [SyncEntity.WorkZones]: 'WorkZones',
  [SyncEntity.Surveys]: 'Surveys',
  [SyncEntity.SurveyAnswers]: 'SurveyAnswers',
  [SyncEntity.Lists]: 'Lists',
  [SyncEntity.ListsDet]: 'ListsDet',
  [SyncEntity.DispatchStatus]: 'DispatchStatus',
};

/** Estado de la sincronización en curso. */
export interface SyncControl {
  ID?: number;
  UserID: number;
  /** 1 mientras corre. */
  running: number;
  /** Última sincronización exitosa, en ISO. */
  lastDate: string;
  totalRecords: number;
  processedRecords: number;
  lastError: string;
  Msg: string;
}

/** Comparación de conteos local vs servidor, por entidad. */
export interface EntitySyncStatus {
  ID?: number;
  UserID: number;
  Entity: string;
  LocalCount: number;
  ServerCount: number;
  LocalMax: number;
  LocalChecksum: number;
  CheckedAt: string;
}

/** Entrada de la bitácora del agente de sincronización. */
export interface SyncAgentLogEntry {
  ID?: number;
  UserID: string;
  /** 'info' | 'success' | 'warning' | 'error' */
  Type: string;
  Title: string;
  Detail: string;
  CreatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cola de operaciones offline
// ─────────────────────────────────────────────────────────────────────────────

/** Qué se hizo con el registro mientras no había conexión. */
export type SyncOperation = 'create' | 'update' | 'delete';

/** En qué punto va una operación encolada. */
export type SyncQueueStatus = 'pending' | 'processing' | 'failed' | 'done';

/**
 * Operación hecha sin conexión, a la espera de subir.
 *
 * En el móvil cada tabla lleva su propia bandera (`Upload`, `SyncedToServer`,
 * `toSync`) y el orden de subida está codificado en el propio flujo. En web se
 * centraliza en una cola por dos razones: se puede mostrar en un solo lugar
 * TODO lo que falta por subir, y se respeta el orden real en que el usuario
 * hizo las cosas — que importa cuando una ubicación creada offline es el padre
 * de un activo creado después.
 */
export interface SyncQueueItem {
  ID?: number;
  UserID: string;
  /** Store afectado. */
  entity: string;
  operation: SyncOperation;
  /** GUID del registro, para poder localizarlo al confirmar. */
  recordGuid: string;
  /** Cuerpo que se enviará al servidor. */
  payload: unknown;
  status: SyncQueueStatus;
  /** Intentos fallidos. Sirve para espaciar reintentos y para dejar de insistir. */
  attempts: number;
  lastError: string;
  createdAt: string;
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Archivos binarios
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estado de un archivo respecto al almacenamiento definitivo (bucket de AWS).
 *
 * Existe porque que el servidor responda "recibido" NO significa que el archivo
 * esté publicado: un proceso los sube por tandas. Una actividad enviada en esa
 * ventana llegaría a Visitrack apuntando a archivos inexistentes.
 */
export enum BinaryState {
  /** Solo en el navegador, sin subir. Bloquea el envío de la actividad. */
  Pending = 0,
  /** El servidor lo recibió, falta que quede publicado. Bloquea el envío. */
  InRepository = 1,
  /** Confirmado en el bucket. Libera la actividad. */
  Online = 2,
  /**
   * El servidor lo descartó por tener el nombre mal formado. Nunca se publicará,
   * pero NO bloquea: esperar por él dejaría la actividad detenida para siempre.
   */
  Discarded = 3,
  /**
   * El archivo local ya no existe y nunca llegó al servidor. Tampoco bloquea,
   * por la misma razón; queda registrado para saber qué se perdió.
   */
  Unrecoverable = 4,
}

/** Tipo de archivo. Coincide con los códigos que espera el backend. */
export enum BinaryType {
  Image = 1,
  Signature = 2,
  Video = 3,
  Audio = 5,
  File = 6,
}

/**
 * De dónde salió un archivo.
 *
 * `device` es lo capturado aquí, que hay que subir. `server` es lo que llegó
 * **con una consigna** y ya vive en el servidor: se guarda para poder verlo y
 * descargarlo, pero no se sube — devolvérselo sería duplicarlo.
 *
 * Ausente significa `device`: es lo que eran todos antes de que existieran las
 * consignas con archivos.
 */
export type BinaryOrigin = 'device' | 'server';

/** Metadatos de un archivo capturado. El contenido va en `BinariesData`. */
export interface BinaryResource {
  ID?: number;
  GUID: string;
  UserID: string;
  /** GUID de la actividad a la que pertenece. */
  AnswerGUID: string;
  /** Campo del formulario que lo originó. */
  IDField: string;

  TypeBinarie: BinaryType;
  TypeID: number;
  Ext: string;
  Size: string;

  /** Quién lo puso aquí. Ver [BinaryOrigin]. */
  Origin?: BinaryOrigin;

  /**
   * En el móvil era la ruta del archivo. En web no hay rutas: se conserva por
   * compatibilidad de esquema y guarda el GUID que apunta a `BinariesData`.
   */
  base: string;

  Lat: string;
  Lng: string;
  tim: string;

  /** Bandera heredada: 1 cuando el servidor lo recibió. */
  IsSync: number;
  Uploaded: number;

  /** Estado real respecto al bucket. Es el que manda. */
  BinaryState: BinaryState;
  VerifyAttempts: number;
  VerifiedOn: string;
}

/** Contenido de un archivo. Se guarda aparte para no cargarlo al listar. */
export interface BinaryData {
  GUID: string;
  blob: Blob;
  mimeType: string;
  createdAt: string;
}
