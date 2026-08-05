/**
 * Esquema de la base de datos local (IndexedDB).
 *
 * Es el equivalente web del SQLite de la app móvil (`Visitrack.db`). Se
 * mantienen los MISMOS nombres de store y de campo que las tablas del móvil,
 * para que ambos clientes hablen el mismo idioma contra el backend y para poder
 * comparar datos entre plataformas sin traducir nada.
 *
 * ## Diferencias frente a SQLite que conviene tener presentes
 *
 * - IndexedDB **no tiene esquema de columnas**: guarda objetos completos. Lo que
 *   aquí se declara son los `keyPath` (llave primaria) y los índices, que es lo
 *   único que el motor necesita conocer de antemano. Los campos de cada
 *   registro viven en los modelos (`core/models`).
 * - **No hay JOIN.** Las consultas que en el móvil eran un `INNER JOIN` aquí se
 *   resuelven en el repositorio, leyendo de dos stores y combinando en memoria.
 *   Por eso todos los índices que se usarían como llave foránea están
 *   declarados.
 * - **No hay `AUTOINCREMENT` implícito**: se declara explícitamente con
 *   `autoIncrement`. Las entidades que vienen del servidor traen su propio `ID`,
 *   así que usan ese como llave y NO autoincrementan.
 *
 * ## Versionado
 *
 * `DB_VERSION` funciona igual que la versión del SQLite móvil: al subirla,
 * `onupgradeneeded` aplica las migraciones pendientes. **Nunca bajarla.**
 * Cada cambio de esquema debe:
 *   1. Subir `DB_VERSION`.
 *   2. Agregar el store o índice nuevo en `DB_SCHEMA`.
 *   3. Si hay que transformar datos existentes, agregar la migración en
 *      `migrations.ts` con el número de versión correspondiente.
 */

/** Nombre de la base local. */
export const DB_NAME = 'VisitrackWeb';

/**
 * Versión del esquema. Subir SIEMPRE que se agregue un store o un índice.
 *
 * Historial:
 *  - 1: esquema inicial (equivalente a la v65 del SQLite móvil).
 */
export const DB_VERSION = 1;

/** Definición de un índice secundario dentro de un store. */
export interface IndexDefinition {
  /** Nombre del índice. Por convención `by<Campo>`. */
  readonly name: string;
  /** Campo o campos que indexa. */
  readonly keyPath: string | string[];
  /** true si el valor debe ser único en todo el store. */
  readonly unique?: boolean;
  /**
   * Para keyPath de array: si es true, se crea una entrada por cada elemento
   * del array en vez de una sola con el array completo.
   */
  readonly multiEntry?: boolean;
}

/** Definición de un object store (equivalente a una tabla). */
export interface StoreDefinition {
  /** Nombre del store. Coincide con el de la tabla en el móvil. */
  readonly name: string;
  /** Campo que actúa como llave primaria. */
  readonly keyPath: string;
  /** true si la llave la genera IndexedDB (registros creados en el cliente). */
  readonly autoIncrement?: boolean;
  /** Índices secundarios. */
  readonly indexes?: readonly IndexDefinition[];
  /** Para qué sirve el store. Se usa en la documentación y en las herramientas. */
  readonly description: string;
}

/**
 * Índices que casi todos los catálogos descargados del servidor necesitan:
 * filtrar por usuario (cada cuenta ve solo lo suyo), por GUID (la llave con la
 * que el backend identifica el registro) y por estado de borrado.
 */
const CATALOG_INDEXES: readonly IndexDefinition[] = [
  { name: 'byUserID', keyPath: 'UserID' },
  { name: 'byGUID', keyPath: 'GUID' },
  { name: 'byIsDeleted', keyPath: 'IsDeleted' },
];

/**
 * Definición completa del esquema.
 *
 * El orden no importa para IndexedDB, pero se agrupan por dominio para que se
 * lea igual que el modelo mental del negocio.
 */
export const DB_SCHEMA: readonly StoreDefinition[] = [
  // ───────────────────────────────────────────────────────────────────────────
  // Sesión y usuario
  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'Users',
    keyPath: 'ID',
    autoIncrement: true,
    description:
      'Cuentas que han iniciado sesión en este navegador. `Session = "1"` marca la activa. ' +
      'Se conservan varias para poder cambiar de cuenta sin volver a escribir credenciales.',
    indexes: [
      { name: 'byLogin', keyPath: 'Login', unique: true },
      { name: 'byUserID', keyPath: 'UserID' },
      { name: 'bySession', keyPath: 'Session' },
      { name: 'byCompanyID', keyPath: 'CompanyID' },
    ],
  },
  {
    name: 'RolePermissions',
    keyPath: 'ID',
    autoIncrement: true,
    description: 'Permisos por módulo del rol de cada usuario. Alimenta la visibilidad del menú.',
    indexes: [
      { name: 'byUserID', keyPath: 'UserID' },
      { name: 'byModuleKey', keyPath: 'ModuleKey' },
    ],
  },
  {
    name: 'configUser',
    keyPath: 'ID',
    autoIncrement: true,
    description: 'Configuración que el servidor entrega por usuario (JSON crudo).',
    indexes: [{ name: 'byUserID', keyPath: 'UserID' }],
  },
  {
    name: 'appSettings',
    keyPath: 'key',
    description:
      'Preferencias locales. La llave es `"<clave>::<UserID>"`: con UserID vacío son ajustes ' +
      'del dispositivo (compartidos) y con UserID son de esa cuenta. Se separan porque una ' +
      'preferencia de un usuario NO puede aplicarse a otro que use el mismo navegador.',
    indexes: [
      { name: 'byUserID', keyPath: 'UserID' },
      { name: 'bySettingKey', keyPath: 'settingKey' },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Entidades del negocio (catálogos que bajan del servidor)
  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'WorkZones',
    keyPath: 'ID',
    description: 'Zonas de trabajo asignadas al usuario. Raíz de la jerarquía de ubicaciones.',
    indexes: [
      ...CATALOG_INDEXES,
      { name: 'byWorkZoneID', keyPath: 'WorkZoneID' },
    ],
  },
  {
    name: 'LocationsForms',
    keyPath: 'ID',
    description:
      'Ubicaciones (sedes, puntos, clientes). Pueden crearse desde el cliente: `CreateWithMovil` ' +
      'las marca y `SyncedToServer` indica si ya subieron.',
    indexes: [
      { name: 'byUserID', keyPath: 'UserID' },
      { name: 'byGUID', keyPath: 'GUID' },
      { name: 'byIsDeleted', keyPath: 'isDeleted' },
      { name: 'byWorkZoneID', keyPath: 'WorkZoneID' },
      { name: 'byLocationID', keyPath: 'LocationID' },
      { name: 'byLocationTypeGUID', keyPath: 'LocationTypeGUID' },
      { name: 'bySyncedToServer', keyPath: 'SyncedToServer' },
    ],
  },
  {
    name: 'LocationsTypes',
    keyPath: 'ID',
    description: 'Tipos de ubicación: definen los campos propios de cada ubicación.',
    indexes: [...CATALOG_INDEXES, { name: 'byCompanyID', keyPath: 'CompanyID' }],
  },
  {
    name: 'Assets',
    keyPath: 'ID',
    description: 'Activos: equipos o elementos que cuelgan de una ubicación.',
    indexes: [
      { name: 'byUserID', keyPath: 'UserID' },
      { name: 'byGUID', keyPath: 'GUID' },
      { name: 'byIsDeleted', keyPath: 'isDeleted' },
      { name: 'byLocationID', keyPath: 'LocationID' },
      { name: 'byAssetTypeGUID', keyPath: 'AssetTypeGUID' },
      { name: 'bySyncedToServer', keyPath: 'SyncedToServer' },
    ],
  },
  {
    name: 'AssetsTypes',
    keyPath: 'ID',
    description: 'Tipos de activo: definen los campos propios de cada activo.',
    indexes: [...CATALOG_INDEXES, { name: 'byCompanyID', keyPath: 'CompanyID' }],
  },
  {
    name: 'Divisions',
    keyPath: 'ID',
    description: 'Divisiones de la compañía.',
    indexes: [{ name: 'byUserID', keyPath: 'UserID' }, { name: 'byGUID', keyPath: 'GUID' }],
  },
  {
    name: 'Groups',
    keyPath: 'ID',
    description: 'Grupos de usuarios de la compañía.',
    indexes: [{ name: 'byUserID', keyPath: 'UserID' }, { name: 'byGUID', keyPath: 'GUID' }],
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Listas e ítems
  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'Lists',
    keyPath: 'ID',
    description:
      'Definición de listas desplegables. `IsForSync` indica si el usuario eligió bajar sus ' +
      'datos: una lista con miles de ítems solo se descarga si le sirve.',
    indexes: [
      ...CATALOG_INDEXES,
      { name: 'byListID', keyPath: 'ListID' },
      { name: 'byIsForSync', keyPath: 'IsForSync' },
      { name: 'byCompanyID', keyPath: 'CompanyID' },
    ],
  },
  {
    name: 'ListsDet',
    keyPath: 'ID',
    description: 'Ítems de cada lista. Es el store con más volumen de todos.',
    indexes: [
      ...CATALOG_INDEXES,
      { name: 'byListID', keyPath: 'ListID' },
      { name: 'byParentGUID', keyPath: 'ParentGUID' },
      { name: 'bySyncedToServer', keyPath: 'SyncedToServer' },
    ],
  },
  {
    name: 'ItemsTypes',
    keyPath: 'ID',
    description: 'Tipos de ítem de inventario.',
    indexes: [...CATALOG_INDEXES, { name: 'byCompanyID', keyPath: 'CompanyID' }],
  },
  {
    name: 'Items',
    keyPath: 'ID',
    description: 'Ítems de inventario.',
    indexes: [
      ...CATALOG_INDEXES,
      { name: 'byItemTypeID', keyPath: 'ItemTypeID' },
      { name: 'byLocationID', keyPath: 'LocationID' },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Formularios y actividades
  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'Surveys',
    keyPath: 'ID',
    description:
      'Definición de los formularios. `JSONQuestion` trae la estructura de campos que el motor ' +
      'de formularios interpreta.',
    indexes: [
      ...CATALOG_INDEXES,
      { name: 'bySurveyID', keyPath: 'SurveyID' },
      { name: 'byLocationTypeID', keyPath: 'LocationTypeID' },
    ],
  },
  {
    name: 'SurveyAnswers',
    keyPath: 'ID',
    autoIncrement: true,
    description:
      'Actividades: cada diligenciamiento de un formulario. `isSaved` lleva el estado de ' +
      'sincronización (0 sin guardar · 1 pendiente · 2 sincronizada · 3 esperando archivos) y ' +
      '`eraser = 1` marca las creadas en el cliente que nunca se guardaron.',
    indexes: [
      { name: 'byUserID', keyPath: 'UserID' },
      { name: 'byGUID', keyPath: 'GUID', unique: true },
      { name: 'bySurveyID', keyPath: 'SurveyID' },
      { name: 'byAnswerID', keyPath: 'AnswerID' },
      { name: 'byIsSaved', keyPath: 'isSaved' },
      { name: 'byEraser', keyPath: 'eraser' },
      { name: 'byParentGUID', keyPath: 'ParentGUID' },
      { name: 'byStatus', keyPath: 'Status' },
      { name: 'byLocationGUID', keyPath: 'LocationGUID' },
    ],
  },
  {
    name: 'DispatchStatus',
    keyPath: 'ID',
    description: 'Estados de despacho configurables por compañía (con su color).',
    indexes: [
      ...CATALOG_INDEXES,
      { name: 'byDispatchID', keyPath: 'DispatchID' },
      { name: 'byCompanyID', keyPath: 'CompanyID' },
    ],
  },
  {
    name: 'saveFields',
    keyPath: 'ID',
    autoIncrement: true,
    description:
      'Buffer de campos diligenciados que aún no se han volcado a la actividad. Permite que un ' +
      'formulario a medias sobreviva a un cierre inesperado del navegador.',
    indexes: [
      { name: 'byUserID', keyPath: 'UserID' },
      { name: 'byGUID', keyPath: 'GUID' },
      { name: 'byIdField', keyPath: 'idField' },
    ],
  },
  {
    name: 'ChangeLog',
    keyPath: 'ID',
    autoIncrement: true,
    description: 'Bitácora de cambios de estado de las actividades, para auditoría.',
    indexes: [
      { name: 'byUserID', keyPath: 'UserID' },
      { name: 'byGUID', keyPath: 'GUID' },
      { name: 'byAnswerID', keyPath: 'AnswerID' },
      { name: 'bySyncOn', keyPath: 'SyncOn' },
    ],
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Archivos binarios
  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'BinariesResources',
    keyPath: 'ID',
    autoIncrement: true,
    description:
      'Metadatos de cada archivo capturado (foto, firma, audio, documento). `BinaryState` sigue ' +
      'su recorrido: 0 pendiente · 1 recibido por el servidor · 2 confirmado en el bucket · ' +
      '3 descartado por el servidor · 4 no recuperable. Una actividad no se envía mientras ' +
      'tenga archivos en 0 o 1.',
    indexes: [
      { name: 'byUserID', keyPath: 'UserID' },
      { name: 'byGUID', keyPath: 'GUID', unique: true },
      { name: 'byAnswerGUID', keyPath: 'AnswerGUID' },
      { name: 'byIsSync', keyPath: 'IsSync' },
      { name: 'byBinaryState', keyPath: 'BinaryState' },
      { name: 'byIDField', keyPath: 'IDField' },
    ],
  },
  {
    name: 'BinariesData',
    keyPath: 'GUID',
    description:
      'El contenido real de cada archivo, como Blob. En el móvil esto vivía en el sistema de ' +
      'archivos y `BinariesResources.base` guardaba la ruta; en el navegador no hay rutas, así ' +
      'que el binario se guarda aquí y se relaciona por GUID. Se separa de los metadatos a ' +
      'propósito: listar archivos no debe cargar megabytes de imágenes en memoria.',
  },
  {
    name: 'Binaries',
    keyPath: 'ID',
    autoIncrement: true,
    description: 'Store heredado de binarios asociados a una actividad. Se conserva por compatibilidad.',
    indexes: [
      { name: 'byUserID', keyPath: 'UserID' },
      { name: 'byIDAnswer', keyPath: 'IDAnswer' },
    ],
  },
  {
    name: 'CustomSignatures',
    keyPath: 'ID',
    autoIncrement: true,
    description: 'Firmas guardadas por el usuario para reutilizar. No se borran con los binarios.',
    indexes: [{ name: 'byUserID', keyPath: 'UserID' }],
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Control de sincronización
  // ───────────────────────────────────────────────────────────────────────────
  {
    name: 'syncControl',
    keyPath: 'ID',
    autoIncrement: true,
    description: 'Estado de la sincronización en curso: si corre, progreso y último error.',
    indexes: [{ name: 'byUserID', keyPath: 'UserID' }],
  },
  {
    name: 'BinariesControl',
    keyPath: 'ID',
    autoIncrement: true,
    description: 'Progreso de la subida de archivos.',
    indexes: [{ name: 'byUserID', keyPath: 'UserID' }],
  },
  {
    name: 'EntitySyncStatus',
    keyPath: 'ID',
    autoIncrement: true,
    description:
      'Comparación local vs servidor por entidad. Alimenta el semáforo que avisa cuándo faltan ' +
      'datos por descargar.',
    indexes: [
      { name: 'byUserID', keyPath: 'UserID' },
      { name: 'byEntity', keyPath: 'Entity' },
    ],
  },
  {
    name: 'SyncAgentLog',
    keyPath: 'ID',
    autoIncrement: true,
    description: 'Bitácora legible del agente de sincronización, para diagnóstico del usuario.',
    indexes: [
      { name: 'byUserID', keyPath: 'UserID' },
      { name: 'byCreatedAt', keyPath: 'CreatedAt' },
    ],
  },
  {
    name: 'SyncQueue',
    keyPath: 'ID',
    autoIncrement: true,
    description:
      'Cola de operaciones hechas sin conexión que faltan por subir. No existe en el móvil ' +
      '(allí cada entidad tiene su propia bandera). En web se centraliza para poder reintentar ' +
      'en orden y ver en un solo lugar qué quedó pendiente.',
    indexes: [
      { name: 'byUserID', keyPath: 'UserID' },
      { name: 'byStatus', keyPath: 'status' },
      { name: 'byEntity', keyPath: 'entity' },
      { name: 'byCreatedAt', keyPath: 'createdAt' },
    ],
  },
];

/** Nombres de todos los stores, para validar y para las herramientas de diagnóstico. */
export const STORE_NAMES = DB_SCHEMA.map((s) => s.name);

/** Tipado de los nombres de store: evita typos al pedir un repositorio. */
export type StoreName = (typeof DB_SCHEMA)[number]['name'];
