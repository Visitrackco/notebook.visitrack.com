import { environment } from '../../../environments/environment';
import { esModoPublico, guidPublico } from './modo-publico';

/**
 * La dirección base del backend, según quién esté preguntando.
 *
 * ## Con sesión
 *
 * Lo de siempre: `apiUrl`, o `localApiUrl` cuando se trabaja contra la máquina
 * de desarrollo.
 *
 * ## Sin sesión, desde un enlace público
 *
 * Se le antepone `/public/enlace/<guid>`. Ahí vive una **lista blanca** de
 * rutas —las mismas de siempre, con el mismo nombre— que el servidor sirve sin
 * pedir sesión, plantando la compañía, el usuario y el formulario del enlace
 * sobre lo que venga en el cuerpo.
 *
 * Que el prefijo se ponga aquí y no ruta por ruta tiene dos consecuencias:
 *
 * - **Nada del cliente puede llamar a un endpoint que no esté en la lista.** Lo
 *   que no esté declarado ahí responde 404, y eso se ve la primera vez que se
 *   prueba en vez de descubrirse el día que alguien aprieta `AUTH_STRICT`.
 * - No hay una tabla de traducción de rutas que mantener: el cliente sigue
 *   pidiendo `/searchList` y `/createdSurveysAnswers` como siempre.
 *
 * Ojo con lo que esto **no** es: no es un control de seguridad. Quien tenga el
 * GUID puede escribir peticiones a mano igual. Lo que protege es el servidor;
 * esto solo hace que el cliente no tenga forma de equivocarse.
 */
export function apiBaseUrl(): string {
  if (!esModoPublico()) return apiBaseUrlDirecta();

  return `${apiBaseUrlDirecta()}/public/enlace/${guidPublico()}`;
}

/**
 * La direccion base **sin** el prefijo del enlace, siempre.
 *
 * Para lo que no vive detras de la lista blanca porque no le corresponde: hoy,
 * la llamada a un servicio externo que pide una regla de flujo. Esa se pide a
 * `/integrations/ejecutar`, la ruta de siempre, y quien dice de parte de quien
 * va es la cabecera `x-enlace` — ver [cabeceraDeEnlace].
 */
export function apiBaseUrlDirecta(): string {
  return environment.useLocalApi ? environment.localApiUrl : environment.apiUrl;
}

/**
 * La cabecera que identifica al enlace, cuando la pestaña sirve uno.
 *
 * ## Por que una cabecera y no un tramo de la direccion
 *
 * Porque es una credencial, y las credenciales van en cabeceras — igual que
 * `x-token`. Metido en la URL, el identificador del enlace se cuela en el
 * registro del servidor y en el de cualquier proxy por el que pase, ensucia la
 * direccion, y obliga a armar rutas distintas segun como se abrio el
 * formulario. Con la cabecera, la ruta es la misma en los dos casos.
 *
 * Fuera del modo publico devuelve un objeto vacio, asi que se puede repartir en
 * cualquier llamada sin preguntar antes.
 */
export function cabeceraDeEnlace(): Record<string, string> {
  return esModoPublico() ? { 'x-enlace': guidPublico() } : {};
}
