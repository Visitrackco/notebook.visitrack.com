/**
 * Configuración de desarrollo.
 *
 * Los endpoints son los mismos que usa la app móvil, para que ambos clientes
 * hablen con el mismo backend y los datos sean comparables.
 */
export const environment = {
  production: false,

  /** Servicios de sincronización y autenticación (Node). */
  apiUrl: 'https://vtmobileplus.visitrack.com',

  /** API de la plataforma Visitrack (.NET). */
  platformUrl: 'https://api.visitrack.com',

  /** Backend local, para desarrollo contra la máquina de trabajo. */
  localApiUrl: 'http://localhost:100',

  /**
   * Si es true, todas las llamadas van a `localApiUrl`.
   * Cambiar a mano cuando se trabaje contra el servidor local.
   */
  useLocalApi: false,

  /** Segundos antes de dar por perdida una petición. */
  requestTimeout: 30,

  /** Cada cuántos minutos intenta sincronizar sola la aplicación. */
  syncIntervalMinutes: 15,

  /** Versión mostrada en el perfil. */
  appVersion: '0.1.0',
};
