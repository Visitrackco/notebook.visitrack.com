/**
 * Traducción de lo que envía el servidor a lo que se guarda localmente.
 *
 * Son la réplica de los `_map*` de `DBsqlite.dart`. **Deben mantenerse
 * idénticos**: si el móvil y la web guardan campos distintos, los mismos datos
 * se ven diferentes según el dispositivo y los conteos dejan de cuadrar.
 *
 * ## Particularidades que no son errores
 *
 * - `VTEntityID` guarda el **GUID**, no un número, pese a su nombre. Así llega
 *   del backend y así lo espera la comparación con el servidor.
 * - `LocationTypeGUID` recibe el `LocationTypeID` y `LocationTypeGD` recibe el
 *   GUID: los nombres están cruzados en el móvil y se respeta el cruce.
 * - `JSONTilte` va con el typo. Es el nombre real de la columna en el backend.
 * - `SyncedToServer` se fija en '1' porque un registro que llega del servidor,
 *   por definición, ya está en el servidor.
 */

/** Códigos de entidad del backend. No son arbitrarios: los define `MOB_SyncByDevice`. */
export const ENTITY_TO_STORE: Record<number, string> = {
  0: 'DispatchStatus',
  1: 'LocationsForms',
  2: 'LocationsTypes',
  7: 'Lists',
  8: 'ListsDet',
  9: 'SurveyAnswers',
  10: 'AssetsTypes',
  12: 'Assets',
  14: 'ItemsTypes',
  15: 'Items',
  35: 'WorkZones',
  79: 'Surveys',
  100: 'Workflows',
};

/** Nombre legible de cada entidad, para la interfaz. */
export const ENTITY_LABELS: Record<number, string> = {
  0: 'Estados de despacho',
  1: 'Ubicaciones',
  2: 'Tipos de ubicación',
  7: 'Listas',
  8: 'Datos de listas',
  9: 'Consignas',
  10: 'Tipos de activo',
  12: 'Activos',
  14: 'Tipos de ítem',
  15: 'Ítems',
  35: 'Zonas de trabajo',
  79: 'Formularios',
  100: 'Flujos de formularios',
};

/** Qué contiene cada entidad, en una línea, para la tarjeta. */
export const ENTITY_HINTS: Record<number, string> = {
  0: 'Los estados que puede tener una actividad',
  1: 'Sedes, puntos y clientes donde trabajas',
  2: 'Definen los campos propios de cada ubicación',
  7: 'Las listas desplegables de los formularios',
  8: 'Las opciones de cada lista',
  9: 'Actividades asignadas desde la plataforma',
  10: 'Definen los campos propios de cada activo',
  12: 'Equipos y elementos de cada ubicación',
  14: 'Definen los campos de los ítems de inventario',
  15: 'Ítems de inventario',
  35: 'Agrupan las ubicaciones que puedes ver',
  79: 'Los formularios que puedes diligenciar',
  100: 'La lógica configurable de cada formulario',
};

/**
 * Entidades que se muestran y se comprueban en la pantalla de sincronización.
 *
 * Van de lo general a lo particular —zonas antes que ubicaciones, listas antes
 * que sus datos— porque así se lee la jerarquía del negocio.
 *
 * **Las actividades (9) quedan fuera a propósito**: el módulo de formularios
 * todavía no existe, así que mostrar su conteo solo añadiría una fila que el
 * usuario no puede usar. Siguen mapeándose y guardándose si llegan en el
 * stream; basta con volver a incluirlas aquí cuando el módulo esté listo.
 *
 * Los flujos (100) van justo detrás de los formularios: son su lógica, y
 * cuando un formulario no se comporta como debería, lo primero que hay que
 * poder mirar es si sus flujos llegaron.
 */
export const ENTITY_ORDER: number[] = [35, 1, 2, 12, 10, 79, 100, 0, 7, 8, 14, 15];

/** Un registro tal como llega en el stream de sincronización. */
export interface SyncItem {
  entity: number;
  data: Record<string, unknown>;
  syncId?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades de conversión
// ─────────────────────────────────────────────────────────────────────────────

/** Texto, con cadena vacía en vez de `null`/`undefined`. */
const s = (value: unknown, fallback = ''): string =>
  value === null || value === undefined ? fallback : String(value);

/** Entero, con 0 cuando el valor no es numérico. */
const n = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
};

/**
 * Bandera a 1 / 0.
 *
 * El backend manda el mismo dato como `1`, `'1'` o `true` según la entidad y el
 * origen, así que hay que aceptar las tres formas.
 */
const flag = (value: unknown): number =>
  value === 1 || value === '1' || value === true ? 1 : 0;

/** Bandera como texto '1' / '0', que es como la guardan algunas entidades. */
const flagText = (value: unknown): string => (flag(value) === 1 ? '1' : '0');

/** true si el registro viene marcado como eliminado, en cualquiera de sus formas. */
export function isDeletedRecord(raw: Record<string, unknown>): boolean {
  return (
    flag(raw['MOBDeleted']) === 1 ||
    flag(raw['IsDeleted']) === 1 ||
    flag(raw['isDeleted']) === 1
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapeadores
// ─────────────────────────────────────────────────────────────────────────────

type Raw = Record<string, unknown>;
type Mapper = (raw: Raw, userId: number) => Record<string, unknown>;

const mapLocation: Mapper = (r, userId) => ({
  ID: n(r['ID']),
  WorkZoneID: s(r['WorkZoneID']),
  Name: s(r['Name']),
  GUID: s(r['GUID']),
  LocationID: s(r['ID']),
  // Cruzados a propósito: así los guarda el móvil.
  LocationTypeGUID: s(r['LocationTypeID']),
  LocationTypeGD: s(r['LocationTypeGUID']),
  TagUID: s(r['TagUID']),
  Description: s(r['Description']),
  ContactName: s(r['ContactName']),
  Email: s(r['Email']),
  Phone: s(r['Phone']),
  Fax: s(r['Fax']),
  FullAddress: s(r['FullAddress']),
  Street: s(r['Street']),
  City: s(r['City']),
  State: s(r['State']),
  PostalCode: s(r['PostalCode']),
  Country: s(r['Country']),
  Latitude: s(r['Latitude']),
  Longitude: s(r['Longitude']),
  jsonValues: s(r['jsonValues']),
  jsonQuestion: s(r['jsonQuestion']),
  typeTitle: s(r['typeTitle']),
  jsonDescriptor: s(r['jsonDescriptor']),
  UserID: userId,
  isDeleted: flagText(r['isDeleted']),
  SyncOn: '0',
  VTEntityID: s(r['GUID']),
  Upload: '0',
  CreateWithMovil: '0',
  SyncedToServer: '1',
});

const mapAsset: Mapper = (r, userId) => ({
  ID: n(r['ID']),
  Name: s(r['Name']),
  GUID: s(r['GUID']),
  AssetID: n(r['ID']),
  AssetTypeGUID: s(r['AssetTypeID']),
  AssetTypeGD: s(r['AssetTypeGUID']),
  TagUID: s(r['TagUID']),
  LocationID: n(r['LocationID']),
  Description: s(r['Description']),
  JSONTitle: s(r['JSONTitle']),
  Latitude: s(r['Latitude'], '0'),
  Longitude: s(r['Longitude'], '0'),
  jsonValues: s(r['jsonValues'], '[]'),
  jsonQuestion: s(r['jsonQuestion']),
  typeTitle: s(r['typeTitle']),
  jsonDescriptor: s(r['jsonDescriptor']),
  Make: s(r['Make']),
  Model: s(r['Model']),
  SerialNumber: s(r['SerialNumber']),
  UserID: userId,
  isDeleted: flagText(r['IsDeleted']),
  SyncOn: '0',
  VTEntityID: s(r['GUID']),
  Upload: '0',
  CreateWithMovil: '0',
  SyncedToServer: '1',
});

const mapWorkZone: Mapper = (r, userId) => ({
  ID: n(r['ID']),
  Name: s(r['Name']),
  Code: s(r['Code']),
  GUID: s(r['GUID']),
  WorkZoneID: n(r['ID']),
  UserID: userId,
  IsDeleted: flag(r['IsDeleted']),
  SyncOn: 0,
  VTEntityID: s(r['GUID']),
});

const mapSurvey: Mapper = (r, userId) => ({
  ID: n(r['ID']),
  SurveyID: s(r['ID']),
  Title: s(r['Title']),
  GUID: s(r['GUID']),
  CategoryID: n(r['CategoryID']),
  LocationTypeID: n(r['LocationTypeID']),
  hasAsset: n(r['hasAsset']),
  AssetTypeID: n(r['AssetTypeID']),
  Description: s(r['Description']),
  // El backend usa el plural en unos despliegues y el singular en otros.
  JSONQuestion: s(r['JSONQuestions'] ?? r['JSONQuestion']),
  JSONDescriptors: s(r['JSONDescriptors']),
  JSONDispatchFields: s(r['JSONDispatchFields']),
  DeviceMaintType: n(r['DeviceMaintType']),
  DeviceMaintValue: n(r['DeviceMaintValue']),
  StatusEnabled: n(r['StatusEnabled']),
  // Nulo o ausente es «nadie lo ha tocado» = si. `n()` lo pasaria a 0, que
  // apagaria la creacion de actividades en todos los formularios de golpe.
  CreateEnabled: r['CreateEnabled'] === null || r['CreateEnabled'] === undefined
    ? 1
    : n(r['CreateEnabled']),
  isStatusBar: n(r['isStatusBar']),
  JSONStatuses:
    typeof r['JSONStatuses'] === 'string'
      ? r['JSONStatuses']
      : r['JSONStatuses']
        ? JSON.stringify(r['JSONStatuses'])
        : '',
  jsonBranding: s(r['jsonBranding']),
  hasBranding: n(r['hasBranding']),
  IsDownloadPDF: flagText(r['IsDownloadPDF']),
  UserID: userId,
  IsDeleted: flag(r['IsDeleted']),
  SyncOn: 0,
  VTEntityID: s(r['GUID']),
});

/**
 * Un flujo de trabajo (entidad 100).
 *
 * Réplica de `_mapWorkflow` en `DBsqlite.dart`. `UserID` es de quien
 * sincroniza —así se filtra igual que todo lo demás— y el usuario al que va
 * dirigido el flujo, cuando lo tiene, va en `WorkflowUserID`. Son dos cosas
 * distintas: mezclarlas haría que un flujo dirigido a una persona pareciese
 * suyo en cualquier navegador.
 */
const mapWorkflow: Mapper = (r, userId) => ({
  ID: n(r['ID']),
  CompanyID: n(r['CompanyID']),
  SurveyID: n(r['SurveyID']),
  SurveyGUID: s(r['SurveyGUID']),
  WorkflowUserID: r['UserID'] === null || r['UserID'] === undefined ? null : n(r['UserID']),
  Name: s(r['Name']),
  JSONFlow: s(r['JSONFlow']),
  IsActive: flag(r['IsActive']),
  GUID: '',
  UserID: userId,
  IsDeleted: flag(r['IsDeleted']),
  CreatedOn: s(r['CreatedOn']),
  UpdatedOn: s(r['UpdatedOn']),
  SyncOn: 1,
});

const mapList: Mapper = (r, userId) => ({
  ID: n(r['ID']),
  CompanyID: s(r['CompanyID']),
  Name: s(r['Name']),
  Description: s(r['Description']),
  CategoryID: s(r['CategoryID']),
  LocationTypeID: s(r['LocationTypeID']),
  jsonFields: s(r['jsonFields']),
  FlatForm: s(r['FlatForm']),
  jsonDescriptors: s(r['jsonDescriptors']),
  isValueList: s(r['isValueList']),
  hasParent: s(r['hasParent']),
  ParentID: s(r['ParentID']),
  ListTypeID: s(r['ListTypeID']),
  ListEntity: s(r['ListEntity']),
  ListID: s(r['ListID']),
  OptionalListDet: s(r['OptionalListDet']),
  hasItems: s(r['hasItems']),
  ItemTypeID: s(r['ItemTypeID']),
  hasLocations: s(r['hasLocations']),
  hasAssets: s(r['hasAssets']),
  AssetTypeID: s(r['AssetTypeID']),
  isAllAssetTypes: s(r['isAllAssetTypes']),
  hasUsers: s(r['hasUsers']),
  Sect: s(r['Sect']),
  ListIDBD: s(r['ID']),
  GUID: s(r['GUID']),
  UserID: userId,
  IsDeleted: flag(r['IsDeleted']),
  SyncOn: 0,
  IsForSync: n(r['IsForSync']),
  total: n(r['total']),
  VTEntityID: s(r['GUID']),
});

const mapListDetail: Mapper = (r, userId) => ({
  ID: n(r['ID']),
  CompanyID: s(r['CompanyID']),
  LocationID: s(r['LocationID']),
  AssetID: s(r['AssetID']),
  ItemID: s(r['ItemID']),
  ListID: s(r['ListID']),
  Name: s(r['Name']),
  Value: s(r['Value']),
  jsonValues: s(r['jsonValues']),
  TagUID: s(r['TagUID']),
  RefID: s(r['RefID']),
  SurveyAnswerGUID: s(r['SurveyAnswerGUID']),
  FieldID: s(r['FieldID']),
  ListDetGUID: s(r['ListDetGUID']),
  ListDetName: s(r['ListDetName']),
  JSONTilte: s(r['JSONTilte']),
  LocationGUID: s(r['LocationGUID']),
  ParentGUID: s(r['ParentGUID']),
  UserIDD: String(userId),
  ListIDBD: s(r['ID']),
  GUID: s(r['GUID']),
  UserID: userId,
  IsDeleted: flag(r['IsDeleted']),
  Upload: '0',
  CreatedOn: s(r['CreatedOn']),
  UpdatedOn: s(r['UpdatedOn']),
  CreateWithMovil: '0',
  Save: '0',
  SyncOn: 0,
  VTEntityID: s(r['GUID']),
  SyncedToServer: '1',
});

const mapItemType: Mapper = (r, userId) => ({
  ID: n(r['ID']),
  CompanyID: s(r['CompanyID']),
  Name: s(r['Name']),
  RFIDEnabled: n(r['RFIDEnabled']),
  jsonFields: s(r['jsonFields']),
  FlatForm: s(r['FlatForm']),
  jsonDescriptors: s(r['jsonDescriptors']),
  Sect: s(r['Sect']),
  ListIDBD: s(r['ID']),
  GUID: s(r['GUID']),
  UserID: userId,
  IsDeleted: flag(r['IsDeleted']),
  SyncOn: 0,
  IsForSync: n(r['IsForSync']),
  VTEntityID: s(r['GUID']),
});

const mapItem: Mapper = (r, userId) => ({
  ID: n(r['ID']),
  CompanyID: s(r['CompanyID']),
  LocationID: s(r['LocationID']),
  AssetID: s(r['AssetID']),
  ListDetID: s(r['ListDetID']),
  ItemTypeID: s(r['ItemTypeID']),
  Name: s(r['Name']),
  Price: s(r['Price']),
  Cost: s(r['Cost']),
  Description: s(r['Description']),
  jsonValues: s(r['jsonValues']),
  RefID: s(r['RefID']),
  TagUID: s(r['TagUID']),
  JSONTilte: s(r['JSONTilte']),
  ItemIDBD: s(r['ID']),
  GUID: s(r['GUID']),
  UserID: userId,
  IsDeleted: flag(r['IsDeleted']),
  SyncOn: 0,
  VTEntityID: s(r['GUID']),
});

const mapDispatchStatus: Mapper = (r, userId) => ({
  ID: n(r['ID']),
  CompanyID: n(r['CompanyID']),
  DispatchID: n(r['ID']),
  Name: s(r['Name']),
  BaseStatusID: n(r['BaseStatusID']),
  IconID: n(r['IconID']),
  isSystemCreated: flag(r['isSystemCreated']),
  Color: s(r['Color']),
  IsCompleted: flag(r['IsCompleted']),
  origId: n(r['origId']),
  IsDeviceEnabled: flag(r['IsDeviceEnabled']),
  GUID: s(r['GUID']),
  UserID: userId,
  IsDeleted: flag(r['IsDeleted']),
  SyncOn: 0,
  VTEntityID: s(r['GUID']),
});

const mapEntityType: Mapper = (r, userId) => ({
  ID: n(r['ID']),
  CompanyID: s(r['CompanyID']),
  Name: s(r['Name']),
  EntityType: s(r['EntityType']),
  RFIDEnabled: flag(r['RFIDEnabled']),
  LocationTypeID: s(r['LocationTypeID']),
  jsonFields: s(r['jsonFields']),
  FlatForm: s(r['FlatForm']),
  jsonDescriptors: s(r['jsonDescriptors']),
  jsonDependencies: s(r['jsonDependencies']),
  CreatedOn: s(r['CreatedOn']),
  LastUpdatedOn: s(r['LastUpdatedOn']),
  GUID: s(r['GUID']),
  IsDefault: flag(r['IsDefault']),
  IsDeleted: flag(r['IsDeleted']),
  DeletedOn: s(r['DeletedOn']),
  DeletedBy: s(r['DeletedBy']),
  LinkedToQB: flag(r['LinkedToQB']),
  LinkedToRFID: flag(r['LinkedToRFID']),
  IsReadOnly: flag(r['IsReadOnly']),
  Sect: s(r['Sect']),
  origID: n(r['origID']),
  JSONProperties: s(r['JSONProperties']),
  UserID: userId,
  SyncOn: 0,
  VTEntityID: s(r['GUID']),
});

/**
 * Actividad asignada desde la plataforma.
 *
 * `isSaved: 2` y `eraser: 0` porque llega ya sincronizada y **nunca** puede
 * descartarse como borrador: es trabajo asignado, no algo que el usuario
 * empezó y dejó a medias.
 */
const mapSurveyAnswer: Mapper = (r, userId) => ({
  SurveyID: s(r['SurveyID']),
  Titles: s(r['JSONTitle'], '[]'),
  Fields: s(r['JSONAnswers'], '[]'),
  GUID: s(r['GUID']),
  AnswerID: s(r['IDLoc'] ?? r['ID']),
  CompanyID: s(r['CompanyID']),
  LocationTypeID: s(r['LocationTypeID']),
  LocationID: s(r['LocationID']),
  LocationGUID: s(r['LocationGUID']),
  LocationName: s(r['LocationName']),
  AssetID: s(r['AssetID']),
  AssetGUID: s(r['AssetGUID']),
  AssetName: s(r['AssetName']),
  WorkZoneID: s(r['WorkZoneID']),
  Latitude: '',
  Longitude: '',
  Accuracy: '',
  CreatedOn: s(r['CreatedOn']),
  UpdatedOn: s(r['UpdatedOn']),
  CompletedOn: s(r['CompletedOn']),
  Received: new Date().toISOString(),
  IsMovilDeleted: 0,
  DeletingPolicy: 0,
  UserID: String(userId),
  isSaved: 2,
  toSync: 0,
  Status: s(r['CompanyStatusID']),
  StatusInternal: '5',
  ParentGUID: s(r['ParentGUID']),
  Sheduled: '1',
  SyncOn: '0',
  IsUpload: '1',
  IsDelete: '0',
  Msg: '',
  eraser: 0,
  Consecutive: s(r['Consecutive']),
  VTEntityID: s(r['GUID']),
});

/** Mapeador de cada entidad. Sin entrada aquí, el registro se descarta. */
export const ENTITY_MAPPERS: Record<number, Mapper> = {
  0: mapDispatchStatus,
  1: mapLocation,
  2: mapEntityType,
  7: mapList,
  8: mapListDetail,
  9: mapSurveyAnswer,
  10: mapEntityType,
  12: mapAsset,
  14: mapItemType,
  15: mapItem,
  35: mapWorkZone,
  79: mapSurvey,
  100: mapWorkflow,
};
