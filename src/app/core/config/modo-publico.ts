/**
 * Modo público: un formulario abierto desde un enlace, sin sesión.
 *
 * ## Qué cambia
 *
 * Una sola cosa, y de ahí sale todo lo demás: **la aplicación abre otra base de
 * IndexedDB**. En modo público se trabaja contra `VisitrackPublico` en vez de
 * `VisitrackWeb`, y en ella se siembra —en línea, al abrir el enlace— lo que la
 * sesión habría sincronizado: el usuario, el formulario, su flujo, sus listas y
 * las entidades que el enlace fijó.
 *
 * A partir de ahí el resto del código funciona sin enterarse. `AuthService`
 * encuentra su sesión, `ActivityService` crea la actividad, `FlujoService` lee
 * el flujo y `FormRunnerComponent` pinta el mismo formulario de siempre —con
 * sus obligatorios, sus tablas de detalle y sus validaciones—, porque ninguno
 * de ellos pregunta de dónde salieron los datos.
 *
 * La alternativa era copiar el renderizador y recortarlo. Eso habría funcionado
 * el primer día y habría empezado a diferir del original en el segundo.
 *
 * ## Por qué `sessionStorage` y no `localStorage`
 *
 * Porque `sessionStorage` es **por pestaña**, y ese es exactamente el
 * aislamiento que hace falta: alguien puede tener su sesión de Visitrack
 * abierta en una pestaña y un enlace público en otra, y las dos cosas no pueden
 * mezclarse ni pisarse — ni los borradores, ni los archivos, ni las colas de
 * subida. Con `localStorage`, abrir un enlace habría vuelto pública también la
 * pestaña donde alguien estaba trabajando.
 *
 * ## Por qué se decide antes de arrancar
 *
 * `main.ts` lo activa **antes** de `bootstrapApplication`. La apertura de la
 * base es perezosa pero no controlada: cualquier servicio que se instancie
 * durante el arranque podría abrirla antes de que un guardia tuviera ocasión de
 * decidir nada, y para entonces ya sería la base equivocada. Decidirlo en el
 * arranque no deja ninguna ventana.
 */

/** Dónde se recuerda el GUID del enlace durante la vida de la pestaña. */
const CLAVE = 'vt.enlace-publico';

/**
 * Y dónde se recuerda su color de fondo.
 *
 * ## Por qué hace falta guardarlo
 *
 * El color llega al resolver el enlace, y eso solo pasa en `#/e/<guid>`. Desde
 * ahí se navega a la actividad, y **recargar esa página no vuelve a resolver
 * nada**: la sesión ya está sembrada, así que la aplicación arranca sin pasar
 * por la pantalla del enlace y el color, que solo vivía en memoria, se perdía.
 * El síntoma era exacto: se ve al abrir el enlace y desaparece al refrescar.
 *
 * ## Por qué en `sessionStorage` y no en `localStorage`
 *
 * Por lo mismo que el GUID: `sessionStorage` es **por pestaña**. En
 * `localStorage` el fondo del enlace se le colaría a la sesión que esa persona
 * tenga abierta al lado, que es justo lo que este modo evita.
 */
const CLAVE_FONDO = 'vt.enlace-publico.fondo';

/**
 * Y el nombre de la compañia dueña del enlace.
 *
 * Por lo mismo que el fondo: llega al resolver el enlace, y recargar la
 * actividad no vuelve a resolverlo. Sin apuntarlo, el banner pasaba a rotular
 * «Compañia 3502» —un numero interno— en cuanto alguien pulsaba F5.
 */
const CLAVE_COMPANIA = 'vt.enlace-publico.compania';

/**
 * El tramo de la dirección que abre un enlace.
 *
 * Corto a propósito: la dirección ya lleva un GUID de 36 caracteres, y estas se
 * pegan en correos, se meten en códigos QR y a veces se dictan por teléfono.
 *
 * Detrás va **solo el GUID de la fila** y nada más — ni el formulario, ni la
 * compañía, ni quien la llena. Quien recibe el enlace no puede deducir de la
 * dirección qué hay al otro lado; eso lo resuelve el servidor.
 */
export const RUTA_ENLACE = 'e';

/**
 * Un GUID con la forma que emite Module. Nada más se acepta.
 *
 * Se comprueba aquí y no solo en el servidor porque de esto depende **qué base
 * se abre**: una cadena cualquiera en la dirección no puede llegar a activar el
 * modo público, o bastaría con escribir `#/e/loquesea` para dejar la pestaña
 * apuntando a la base equivocada.
 */
function guidValido(guid: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    guid,
  );
}

/**
 * Lee el GUID de la dirección, si la dirección es la de un enlace.
 *
 * Trabaja sobre `location.hash` porque la aplicación usa rutas con hash (ver
 * `app.config.ts`): la ruta viaja en el fragmento y el navegador nunca la manda
 * al servidor.
 */
export function guidDeLaDireccion(href: string = window.location.href): string {
  const hash = href.includes('#') ? href.slice(href.indexOf('#') + 1) : '';

  // Se corta en `?` y en `/` para quedarse con el GUID limpio: la dirección
  // puede traer parámetros detrás, y un enlace copiado a mano a veces trae una
  // barra de más al final.
  const partes = hash.split('?')[0].split('/').filter(Boolean);

  if (partes[0] !== RUTA_ENLACE) return '';

  const guid = (partes[1] ?? '').toLowerCase();

  return guidValido(guid) ? guid : '';
}

/**
 * Enciende el modo público para esta pestaña.
 *
 * Se llama desde `main.ts` con lo que traiga la dirección. Si la dirección no
 * es la de un enlace **no se apaga nada**: navegar dentro del formulario cambia
 * el hash a `#/formularios/...`, y apagarlo ahí dejaría la pestaña leyendo la
 * base de la sesión a mitad de un diligenciamiento.
 */
export function activarModoPublicoSiToca(href: string = window.location.href): void {
  const guid = guidDeLaDireccion(href);

  if (!guid) return;

  try {
    sessionStorage.setItem(CLAVE, guid);
  } catch {
    /*
     * Un navegador puede negar el almacenamiento —modo privado estricto, o una
     * política de la empresa—. No se puede hacer nada al respecto aquí, y
     * lanzar dejaría la pantalla en blanco sin decir por qué. La pantalla del
     * enlace comprueba el modo y explica lo que pasa.
     */
  }
}

/** El GUID del enlace que abrió esta pestaña, o cadena vacía. */
export function guidPublico(): string {
  try {
    return sessionStorage.getItem(CLAVE) ?? '';
  } catch {
    return '';
  }
}

/** ¿Esta pestaña está sirviendo un enlace público? */
export function esModoPublico(): boolean {
  return guidPublico() !== '';
}

/*
 * ─── Cómo se sale del modo público ──────────────────────────────────────────
 *
 * Cerrando la pestaña. No hay función para apagarlo, y no es un olvido.
 *
 * Hubo una —se llamaba al pulsar «salir» en la pantalla de cierre— y dejó de
 * tener sentido cuando ese botón pasó a ofrecer llenar otra respuesta: quien
 * abre un enlace no vino de la aplicación, así que «devolverlo» a ella lo
 * planta delante de una pantalla de acceso con una cuenta que no tiene.
 *
 * Como todo esto vive en `sessionStorage`, cerrar la pestaña lo limpia solo. Y
 * un enlace se abre en su propia pestaña —llega por correo o por un código QR—,
 * así que ese es el gesto natural y no hace falta enseñar ninguno.
 *
 * Lo que **no** se borra al cerrar es la base pública: si quedó una respuesta
 * sin subir, se recupera abriendo otra vez el mismo enlace en este navegador.
 */

/**
 * Apunta el color de fondo que trae el enlace, para que sobreviva a un F5.
 *
 * Se guarda ya normalizado por quien llama: aquí no se valida otra vez porque
 * de vuelta se vuelve a comprobar, y un valor raro en el almacenamiento no
 * puede llegar a pintarse.
 */
export function guardarCompaniaDelEnlace(nombre: string): void {
  try {
    if (nombre) sessionStorage.setItem(CLAVE_COMPANIA, nombre);
    else sessionStorage.removeItem(CLAVE_COMPANIA);
  } catch {
    // Sin almacenamiento se rotula con lo que haya. Es un rotulo, no un dato.
  }
}

/** El nombre de la compañia del enlace, o cadena vacia. */
export function companiaDelEnlace(): string {
  try {
    return sessionStorage.getItem(CLAVE_COMPANIA) ?? '';
  } catch {
    return '';
  }
}

export function guardarFondoDelEnlace(hex: string): void {
  try {
    if (hex) sessionStorage.setItem(CLAVE_FONDO, hex);
    else sessionStorage.removeItem(CLAVE_FONDO);
  } catch {
    // Sin almacenamiento el color dura lo que dure la página. Se asume: es
    // decoración, y la alternativa sería no abrir el formulario.
  }
}

/** El color de fondo del enlace que abrió esta pestaña, o cadena vacía. */
export function fondoDelEnlace(): string {
  try {
    return sessionStorage.getItem(CLAVE_FONDO) ?? '';
  } catch {
    return '';
  }
}
