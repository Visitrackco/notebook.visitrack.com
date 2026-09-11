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

  /* Module, que es donde vive el chat. Ver `environment.ts`.
     (Este archivo hoy no lo usa el build: `angular.json` no tiene
     `fileReplacements`. Se mantiene al día igualmente.) */
  moduleUrl: 'https://module.visitrack.com',

  requestTimeout: 30,
  syncIntervalMinutes: 15,

  appVersion: '0.2.0',
};
