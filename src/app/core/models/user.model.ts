/**
 * Cuenta de usuario almacenada localmente.
 *
 * Refleja la tabla `Users` del móvil. Los campos conservan el PascalCase del
 * backend a propósito: así lo que llega del servidor se guarda sin traducir y
 * cualquier discrepancia se ve de inmediato al comparar con la app móvil.
 */
export interface User {
  /** Llave local autoincremental. No es el ID del servidor. */
  ID?: number;

  /** Identificador del usuario en Visitrack. Es el que viaja en las peticiones. */
  UserID: string;

  /** GUID del usuario en el servidor. */
  GUID: string;

  /** Compañía a la que pertenece. Filtra prácticamente todos los datos. */
  CompanyID: number;

  FirstName: string;
  LastName: string;
  Email: string;

  /** Usuario de acceso, siempre en minúsculas. */
  Login: string;

  /**
   * Contraseña, guardada para poder reautenticar en segundo plano sin volver a
   * pedirla. Ver la nota de seguridad en `auth.service.ts`.
   */
  Password: string;

  /** Token de acceso que autentica las llamadas al backend. */
  Token: string;

  UTCCode: string;
  DefaultLanguage: string;

  GroupID: number;
  DivisionID: number;

  /** '1' si la cuenta está activa en Visitrack. */
  Active: string;

  WorkZoneID: number | null;

  apiref1: string;

  /** '1' en la cuenta con sesión abierta en este navegador. Solo una a la vez. */
  Session: string;

  /** Estado operativo del usuario (disponible, en ruta, etc.). */
  StatusID: string;

  Phone: string;

  /** Identificador del navegador. Equivale al DeviceID del teléfono. */
  DeviceID: string;

  /** Logo de la compañía en base64, cacheado para funcionar sin conexión. */
  LogoCompany?: string;
  /** Hash del logo, para saber si cambió sin descargarlo de nuevo. */
  LogoHash?: string;
  /** Última verificación del logo, en ISO. */
  LogoCheckDate?: string;
}

/** Permiso que el backend entrega junto con el rol del usuario. */
export interface LoginPermission {
  moduleKey: string;
  permissionCode: string;
}

/**
 * Datos del usuario tal como los devuelve `sp_LoginAndUpdateDevice_Detailed`,
 * más el rol y los permisos que el controlador agrega.
 *
 * Se declara con índice abierto porque el procedimiento almacenado puede
 * devolver columnas adicionales según la compañía; se toman las conocidas y el
 * resto se ignora sin romper el tipado.
 */
export interface LoginUserData {
  ID: number | string;
  GUID: string;
  CompanyID: number;
  FirstName: string;
  LastName: string;
  Email: string;
  AccessToken: string;
  UTCCode?: string;
  Active?: string | number | boolean;
  Phone?: string;
  StatusID?: string | number;
  DefaultLanguage?: string;
  WorkZoneID?: number;
  GroupID?: number;
  DivisionID?: number;

  RoleID?: number;
  RoleName?: string;
  RoleCode?: string;
  permissions?: LoginPermission[];

  [key: string]: unknown;
}

/**
 * Respuesta de `GET /loginTemp`.
 *
 * El backend envuelve los datos en `response`, no en `body`. Se acepta también
 * `body` por si algún despliegue antiguo usa ese nombre — el costo es una línea
 * y evita que un cambio de servidor tumbe el acceso.
 */
export interface LoginResponse {
  status: boolean;
  response?: LoginUserData;
  body?: LoginUserData;
  DefaultLanguage?: string;
  message?: string;
  error?: string;
}

/** Nombre completo listo para mostrar. */
export function fullName(user: Pick<User, 'FirstName' | 'LastName'>): string {
  return `${user.FirstName ?? ''} ${user.LastName ?? ''}`.trim();
}

/**
 * Iniciales para el avatar.
 *
 * Toma la primera letra del nombre y la del apellido; si solo hay una palabra,
 * usa su primera letra. Nunca devuelve vacío: cae a '?' para que el avatar no
 * quede en blanco.
 */
export function initials(user: Pick<User, 'FirstName' | 'LastName'>): string {
  const first = (user.FirstName ?? '').trim();
  const last = (user.LastName ?? '').trim();

  const a = first.charAt(0);
  const b = last.charAt(0);

  const result = `${a}${b}`.toUpperCase().trim();
  return result || '?';
}
