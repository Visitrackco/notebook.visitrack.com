/**
 * Modelos de las entidades de negocio que se sincronizan desde Visitrack.
 *
 * Conservan el nombre y la forma exacta de las tablas del móvil. Muchos campos
 * llegan como `string` aunque su contenido sea numérico o booleano ('0' / '1'):
 * se respeta tal cual para no introducir conversiones que después habría que
 * revertir al subir los datos.
 *
 * Los campos `json*` vienen como texto JSON sin parsear. Se dejan crudos porque
 * parsearlos al guardar multiplicaría el costo de la sincronización, y la mayor
 * parte del tiempo no se usan; cada repositorio los parsea cuando los necesita.
 */

/** Campos comunes a todo catálogo descargado del servidor. */
export interface SyncableEntity {
  /** Llave local. Para catálogos coincide con el ID del servidor. */
  ID: number;
  /** GUID del registro en Visitrack. */
  GUID: string;
  /** Usuario dueño de la copia local. */
  UserID: number;
  /** 1 si fue eliminado en el servidor. */
  IsDeleted?: number;
  /** 1 cuando el registro ya fue confirmado contra el servidor. */
  SyncOn?: number;
  /** ID de la entidad en la tabla de sincronización del servidor. */
  VTEntityID?: number;
}

/** Zona de trabajo: agrupa ubicaciones y define qué ve cada usuario. */
export interface WorkZone extends SyncableEntity {
  Name: string;
  Code: string;
  WorkZoneID: number;
}

/** Ubicación (sede, punto, cliente). */
export interface LocationForm {
  ID: number;
  GUID: string;
  UserID: number;
  WorkZoneID: string;
  Name: string;
  LocationID: string;
  LocationTypeGUID: string;
  LocationTypeGD: string;
  TagUID: string;

  Description: string;
  ContactName: string;
  Email: string;
  Phone: string;
  Fax: string;

  FullAddress: string;
  Street: string;
  City: string;
  State: string;
  PostalCode: string;
  Country: string;

  Latitude: string;
  Longitude: string;

  /** Descriptivos ya resueltos, para los listados (JSON sin parsear). */
  JSONTitle?: string;

  CreatedOn?: string;
  UpdatedOn?: string;

  /** Valores de los campos propios del tipo de ubicación (JSON sin parsear). */
  jsonValues: string;
  /** Estructura de esos campos (JSON sin parsear). */
  jsonQuestion: string;
  /** Qué campos se muestran como descriptivos (JSON sin parsear). */
  jsonDescriptor: string;
  typeTitle: string;

  /** '1' si fue eliminada en el servidor. */
  isDeleted: string;
  SyncOn: string;
  VTEntityID: number;

  /** '1' cuando ya se subió al servidor. */
  Upload: string;
  /** '1' si se creó desde el cliente y no bajó del servidor. */
  CreateWithMovil: string;
  /** '1' una vez confirmada en el servidor. Nunca se revierte a '0'. */
  SyncedToServer: string;
}

/** Activo: equipo o elemento que pertenece a una ubicación. */
export interface Asset {
  ID: number;
  GUID: string;
  UserID: number;
  Name: string;
  AssetID: number;
  AssetTypeGUID: string;
  AssetTypeGD: string;
  TagUID: string;
  LocationID: number;

  /**
   * GUID de la ubicación a la que pertenece.
   *
   * Existe porque `LocationID` es el identificador **del servidor**, y una
   * ubicación creada en este dispositivo todavía no tiene ninguno: el activo
   * quedaba con `LocationID = 0` y se perdía de qué sede colgaba. Con el GUID,
   * la subida puede rellenar el identificador de verdad cuando su ubicación
   * llegue a Visitrack.
   */
  LocationGUID?: string;

  Description: string;

  JSONTitle: string;
  Latitude: string;
  Longitude: string;
  jsonValues: string;
  jsonQuestion: string;
  jsonDescriptor: string;
  typeTitle: string;

  CreatedOn?: string;
  UpdatedOn?: string;

  Make: string;
  Model: string;
  SerialNumber: string;

  isDeleted: string;
  SyncOn: string;
  VTEntityID: number;
  Upload: string;
  CreateWithMovil: string;
  SyncedToServer: string;
}

/** Tipo de entidad (ubicación o activo): define sus campos propios. */
export interface EntityType extends SyncableEntity {
  CompanyID: string;
  Name: string;
  EntityType?: string;
  jsonFields: string;
  FlatForm: string;
  jsonDescriptors: string;
  jsonDependencies?: string;
  Sect: string;
  IsReadOnly?: number;
  /** Solo en tipos de activo. */
  LocationTypeID?: string;
  RFIDEnabled?: number;
}

/** Definición de un formulario. */
export interface Survey extends SyncableEntity {
  SurveyID: string;
  Title: string;
  Description: string;
  CategoryID: number;
  LocationTypeID: number;
  /** 1 si el formulario exige elegir un activo. */
  hasAsset: number;
  AssetTypeID: number;

  /** Estructura de páginas y campos del formulario (JSON sin parsear). */
  JSONQuestion: string;
  /** Campos que se muestran como resumen en el listado (JSON sin parsear). */
  JSONDescriptors: string;
  JSONDispatchFields: string;

  /** Política de borrado automático: 1 minutos, 2 horas, 3 días. */
  DeviceMaintType: number;
  DeviceMaintValue: number;

  StatusEnabled: number;
  /**
   * Si el formulario deja crear actividades a mano.
   *
   * Apagado, solo recibe consignas: sigue funcionando cuando alguien se lo
   * despacha, pero deja de ofrecerse en «nueva actividad». Nulo en el servidor
   * es «nadie lo ha tocado», y eso se lee como 1.
   */
  CreateEnabled: number;
  isStatusBar: number;
  /** Estados de despacho permitidos. Vacío = todos. */
  JSONStatuses: string;

  hasBranding: number;
  jsonBranding: string;
  IsDownloadPDF: string;
}

/** Actividad: un diligenciamiento de un formulario. */
export interface SurveyAnswer {
  ID?: number;
  GUID: string;
  SurveyID: string;
  UserID: string;
  CompanyID: string;

  /** Resumen de campos para el listado (JSON sin parsear). */
  Titles: string;
  /** Respuestas del formulario (JSON sin parsear). */
  Fields: string;

  /** Consecutivo asignado por el servidor. */
  AnswerID: string | null;
  Consecutive?: string;

  LocationTypeID: string;
  LocationID: string;
  LocationGUID: string;
  LocationName: string;

  AssetID: string;
  AssetGUID: string;
  AssetName: string;

  WorkZoneID: string;

  Latitude: string;
  Longitude: string;
  Accuracy: string;

  CreatedOn: string;
  UpdatedOn: string;
  CompletedOn: string;
  Received: string;

  /**
   * Estado de sincronización:
   *  0 sin guardar · 1 pendiente · 2 sincronizada · 3 esperando archivos.
   *
   * El 3 existe porque una actividad con fotos no puede enviarse hasta que
   * éstas estén confirmadas en el bucket; si no, llegaría con imágenes rotas.
   */
  isSaved: number;
  toSync: number;
  IsUpload: string;
  SyncOn: string;

  /** Estado de despacho de la actividad. */
  Status: string;
  StatusInternal: string;

  /** Actividad padre cuando viene de un formulario vinculado. */
  ParentGUID: string;

  /** '1' si fue asignada desde la plataforma (no creada aquí). */
  Sheduled: string;

  IsMovilDeleted: number;
  DeletingPolicy: number;
  IsDelete: string;

  /**
   * 1 = creada en el cliente y nunca guardada (descartable).
   * 0 = guardada, o descargada del servidor. Nunca se descarta.
   */
  eraser: number;

  /** Mensaje para el usuario sobre el estado de la actividad. */
  Msg: string;

  VTEntityID?: number;
}

/** Estado de despacho configurable por compañía. */
export interface DispatchStatus extends SyncableEntity {
  CompanyID: number;
  DispatchID: number;
  Name: string;
  BaseStatusID: number;
  IconID: number;
  isSystemCreated: number;
  /** Color en formato entero de Flutter (0xAARRGGBB). Hay que convertirlo a CSS. */
  Color: string;
  IsCompleted: number;
  origId: number;
  IsDeviceEnabled: number;
}

/** Definición de una lista desplegable. */
export interface ListDefinition extends SyncableEntity {
  CompanyID: string;
  Name: string;
  Description: string;
  CategoryID: string;
  LocationTypeID: string;
  jsonFields: string;
  FlatForm: string;
  jsonDescriptors: string;
  isValueList: string;
  hasParent: string;
  ParentID: string;
  ListTypeID: string;
  ListEntity: string;
  ListID: string;
  OptionalListDet: string;
  hasItems: string;
  ItemTypeID: string;
  hasLocations: string;
  hasAssets: string;
  AssetTypeID: string;
  isAllAssetTypes: string;
  hasUsers: string;

  Sect: string;
  ListIDBD: string;
  /** 1 si el usuario eligió descargar los ítems de esta lista. */
  IsForSync: number;
  /** Cuántos ítems tiene en el servidor. */
  total: number;
}

/** Ítem de una lista. */
export interface ListDetail extends SyncableEntity {
  CompanyID: string;
  ListID: string;
  Name: string;
  Value: string;
  jsonValues: string;
  TagUID: string;
  RefID: string;
  LocationID: string;
  AssetID: string;
  ItemID: string;
  SurveyAnswerGUID: string;
  FieldID: string;
  ListDetGUID: string;
  ListDetName: string;
  JSONTilte: string;
  LocationGUID: string;
  ParentGUID: string;
  UserIDD: string;
  ListIDBD: string;
  CreatedOn: string;
  UpdatedOn: string;
  Upload: string;
  CreateWithMovil: string;
  Save: string;
  SyncedToServer: string;
}

/** Tipo de ítem de inventario. */
export interface ItemType extends SyncableEntity {
  CompanyID: string;
  Name: string;
  RFIDEnabled: number;
  jsonFields: string;
  FlatForm: string;
  jsonDescriptors: string;
  Sect: string;
  ListIDBD: string;
  IsForSync: number;
}

/** Ítem de inventario. */
export interface Item extends SyncableEntity {
  CompanyID: string;
  LocationID: string;
  AssetID: string;
  ListDetID: string;
  ItemTypeID: string;
  Name: string;
  Price: string;
  Cost: string;
  Description: string;
  jsonValues: string;
  RefID: string;
  TagUID: string;
  JSONTilte: string;
  ItemIDBD: string;
}

/** División de la compañía. */
export interface Division {
  ID: number;
  Name: string;
  GUID: string;
  DivisionID: number;
  UserID: number;
  UpdateOn: string;
}

/** Grupo de usuarios. */
export interface Group {
  ID: number;
  Name: string;
  GUID: string;
  GroupID: number;
  UserID: number;
  UpdateOn: string;
}

/**
 * Configuración por usuario que entrega el servidor.
 *
 * `config` es el JSON crudo: una lista de `{modulo, active}`. Se guarda sin
 * interpretar, igual que en la app — el catálogo de módulos lo define la
 * plataforma y darle forma aquí obligaría a seguirle el paso a cada uno.
 */
export interface UserConfig {
  ID?: number;
  UserID: number;
  config: string;
  lastDate: string;
}

/** Permiso de un módulo para el rol del usuario. */
export interface RolePermission {
  ID?: number;
  UserID: string;
  RoleID: number;
  RoleName: string;
  RoleCode: string;
  /** Módulo al que aplica: 'forms', 'locations', 'sync'… */
  ModuleKey: string;
  /** Acción permitida: 'view', 'create', 'edit', 'delete'… */
  PermissionCode: string;
}
