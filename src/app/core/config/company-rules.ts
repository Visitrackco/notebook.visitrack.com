/**
 * Reglas de negocio que dependen de la compañía.
 *
 * Están aquí, aisladas, porque son excepciones: no se derivan de ninguna
 * configuración del servidor sino de acuerdos con clientes concretos. Tenerlas
 * repartidas por los repositorios significa que la próxima excepción se copia
 * mal en uno de los quince sitios donde hacía falta.
 */

/**
 * Compañía cuyos catálogos cuelgan de una única cuenta compartida.
 *
 * Sus usuarios no tienen formularios ni ubicaciones propias: todos consultan
 * los del usuario [SHARED_CATALOG_OWNER].
 */
const SHARED_CATALOG_COMPANY = 3502;

/** Cuenta que posee los catálogos compartidos de [SHARED_CATALOG_COMPANY]. */
const SHARED_CATALOG_OWNER = 771295;

/**
 * Bajo qué `UserID` están guardados los catálogos que debe ver esta cuenta.
 *
 * Para casi todos es su propio identificador. La compañía compartida es la
 * excepción, y por eso conviene que ningún repositorio use `user.UserID` en
 * crudo al consultar formularios, ubicaciones o activos.
 */
export function resolveCatalogOwnerId(user: {
  UserID: string;
  CompanyID: number;
}): number {
  if (user.CompanyID === SHARED_CATALOG_COMPANY) return SHARED_CATALOG_OWNER;
  return Number(user.UserID) || 0;
}
