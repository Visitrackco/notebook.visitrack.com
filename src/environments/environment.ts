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



  /**
   * De dónde se leen los archivos que ya están en el servidor.
   *
   * Es el mismo recurso que usa la plataforma para enseñar una foto:
   * `?e=PICTURE&id=<guid>`. Se pide por identificador y no por su ruta en el
   * bucket porque una consigna no trae la extensión del archivo, y sin ella no
   * se puede construir la clave de S3.
   */
  /**
   * Servidor de archivos de la plataforma. Hoy solo como **respaldo**.
   *
   * Los archivos se leen por `GET /dispatchFile` de la API, que es lo unico
   * que el navegador puede leer de verdad: este dominio no autoriza la lectura
   * desde otro origen. Esta direccion se sigue usando para abrir un archivo en
   * una pestana cuando el puente no lo tiene.
   */
  binariesUrl: 'https://and.visitrack.com/WebResource.aspx',

  /**
   * Module, que es donde vive el chat.
   *
   * Es **otro backend**: el resto de esta aplicación habla con `apiUrl`
   * —cloud-server— y el chat es lo único que sale hacia aquí. Module reconoce
   * nuestra sesión porque comparte base de datos y tiene la llave de
   * cloud-server en una variable aparte; ver `sesion-de-campo.ts` allí.
   */
  moduleUrl: 'https://module.visitrack.com',

  /** Segundos antes de dar por perdida una petición. */
  requestTimeout: 30,

  /** Cada cuántos minutos intenta sincronizar sola la aplicación. */
  syncIntervalMinutes: 15,

  /** Versión mostrada en el perfil. */
  appVersion: '0.2.0',
}; 
