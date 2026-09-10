/** Configuración de producción. */
export const environment = {
  production: true,

  apiUrl: 'https://vtmobileplus.visitrack.com',
  platformUrl: 'https://api.visitrack.com',
  localApiUrl: '',
  useLocalApi: false,


  /**
   * Servidor de archivos de la plataforma. Solo como respaldo.
   *
   * Los archivos se leen por `GET /dispatchFile` de la API: este dominio no
   * autoriza la lectura desde otro origen, así que el navegador no puede
   * guardarlos. Esta dirección sirve para abrir un archivo en una pestaña
   * cuando el puente no lo tiene.
   */
  binariesUrl: 'https://and.visitrack.com/WebResource.aspx',

  requestTimeout: 30,
  syncIntervalMinutes: 15,

  appVersion: '0.2.0',
};
