/**
 * Configuración de Firebase para las notificaciones del navegador.
 *
 * ## Por qué esto sí va en el repositorio
 *
 * Nada de aquí es un secreto. La configuración web de Firebase y la clave VAPID
 * **pública** viajan dentro del paquete que se descarga cualquiera que abra la
 * aplicación: esconderlas sería imposible y no protegería nada. Lo que autoriza
 * a mandar notificaciones es la cuenta de servicio, que vive **solo** en el
 * servidor (`cloud-server/credenciales/fcm.json`) y no sale de ahí.
 *
 * Lo que estas claves permiten es lo contrario de enviar: pedirle a Google un
 * token para **recibir**.
 *
 * ## El service worker las repite
 *
 * `public/firebase-messaging-sw.js` las lleva escritas otra vez, y no es un
 * descuido: un service worker corre fuera de la aplicación y no puede importar
 * nada de aquí. Si alguna vez cambian, hay que cambiarlas en los dos sitios.
 */
export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAo8ZBpAh7oR5oo4jpRXzl3PrMCXFT2ioU',
  authDomain: 'visitrack-enterprise.firebaseapp.com',
  projectId: 'visitrack-enterprise',
  storageBucket: 'visitrack-enterprise.firebasestorage.app',
  messagingSenderId: '275383308680',
  appId: '1:275383308680:web:ba2117c7f8f7dce48e2a3d',
};

/**
 * Clave pública del par VAPID, la que identifica a esta aplicación ante el
 * servicio de push del navegador. La privada se queda en la consola de Firebase.
 */
export const VAPID_KEY =
  'BBN9cbiX7gR_98GQ8h-HG9xbgllNgH7ZcAnMShJ5jbyb8HEDlAT3BWHAFiyq7eIoXhpVbc3wh0ZopjFmsqkr9ZY';
