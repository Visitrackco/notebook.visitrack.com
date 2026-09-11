/*
 * El trabajador que recibe las notificaciones con la aplicación cerrada.
 *
 * ## Por qué es un archivo suelto y no parte del paquete
 *
 * Un service worker corre **fuera** de la aplicación: sigue vivo con todas las
 * pestañas cerradas, que es justamente cuando hace falta. No puede importar
 * nada de `src/`, así que la configuración va escrita aquí otra vez. Si algún
 * día cambia, hay que cambiarla también en `core/config/firebase.ts`.
 *
 * Vive en `public/`, que Angular copia a la raíz del sitio: el navegador exige
 * que este archivo esté en `/firebase-messaging-sw.js` para poder darle alcance
 * sobre toda la aplicación.
 *
 * ## Las versiones van fijadas
 *
 * `importScripts` trae el SDK de la red la primera vez y el navegador lo
 * guarda. Sin número de versión, Google serviría la última el día que cambie
 * algo y esto dejaría de funcionar sin que nadie hubiera tocado nada.
 */
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyAo8ZBpAh7oR5oo4jpRXzl3PrMCXFT2ioU',
  authDomain: 'visitrack-enterprise.firebaseapp.com',
  projectId: 'visitrack-enterprise',
  storageBucket: 'visitrack-enterprise.firebasestorage.app',
  messagingSenderId: '275383308680',
  appId: '1:275383308680:web:ba2117c7f8f7dce48e2a3d',
});

const messaging = firebase.messaging();

/**
 * La direccion del backend, escrita otra vez.
 *
 * Por lo mismo que la configuracion de arriba: un service worker no puede
 * importar nada de `src/`, asi que `environment.apiUrl` no esta a su alcance. Si
 * algun dia cambia, hay que cambiarla tambien en `environments/`.
 */
const API = 'https://vtmobileplus.visitrack.com';

/**
 * Avisa al servidor de que este aviso llego, o de que lo abrieron.
 *
 * ## Por que puede hacerlo el trabajador, que no tiene sesion
 *
 * Porque no manda el identificador de la fila, sino `ack`: una llave propia de
 * ese aviso que viaja dentro del mensaje y no sirve para nada mas. Con el `ID` a
 * secas, cualquiera podria ir contando de uno en adelante y marcar como leidos
 * los avisos de otras companias.
 *
 * ## Nunca estorba
 *
 * Si falla —sin red, servidor caido— no pasa nada: el aviso ya se enseno o ya se
 * abrio, y lo unico que se pierde es el apunte. Que un acuse roto impidiera
 * abrir la notificacion seria cambiar algo util por algo que solo mira.
 */
function acusar(ack, evento) {
  if (!ack) return Promise.resolve();

  return fetch(`${API}/public/push/acuse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ack, evento }),

    /*
     * Sin credenciales.
     *
     * La ruta es publica y no las mira; mandarlas solo obligaria al servidor a
     * responder con `Access-Control-Allow-Origin` exacto en vez de `*`, y esto
     * sale desde un trabajador cuyo origen no siempre es el que se espera.
     */
    credentials: 'omit',
    keepalive: true,
  }).catch(() => {});
}

/**
 * Un aviso que llega con la aplicación cerrada o en otra pestaña.
 *
 * Se pinta a mano en vez de dejar que el navegador lo haga solo porque así se
 * puede llevar el enlace dentro: sin él, tocar la notificación abre la
 * aplicación por donde estuviera y no por donde el aviso decía.
 */
messaging.onBackgroundMessage((payload) => {
  const datos = payload.data || {};
  const aviso = payload.notification || {};

  const titulo = aviso.title || datos.title || 'Visitrack';

  /*
   * Deja constancia de que el worker se desperto.
   *
   * Sin esto, un aviso que llega y no se pinta es indistinguible de uno que no
   * llego: los dos se ven igual —nada en pantalla— y el unico sitio donde se
   * puede separar es aqui. Se mira en DevTools > Application > Service Workers
   * > «inspect», que abre la consola **del worker**, que no es la de la pagina.
   */
  console.log('[vt-push] llego en segundo plano:', titulo, datos);

  /*
   * **Se devuelve la promesa.** No es un detalle de estilo.
   *
   * Un service worker se puede matar en cuanto el manejador retorna. Sin
   * devolver nada, `showNotification` quedaba a medio camino y el navegador
   * apagaba al trabajador antes de pintar: **la notificacion no salia nunca**.
   *
   * Y el fallo era invisible desde el servidor, porque el acuse si llegaba —va
   * con `keepalive: true`, que le deja sobrevivir a la muerte del worker—. O
   * sea que la fila decia «entregado» y en la pantalla no habia aparecido nada.
   */
  return Promise.all([
    // El `catch` no es adorno: `showNotification` rechaza en silencio cuando el
    // permiso esta revocado o cuando una opcion no le gusta, y ese motivo era
    // justo lo que no habia forma de ver.
    self.registration.showNotification(titulo, {
      body: aviso.body || datos.body || '',

      /* El icono de la aplicación. El grande —la imagen del aviso— llega en
         `image` y lo pone quien manda; éste es el de la marca y no cambia. */
      icon: '/icon.png',
      badge: '/icon.png',
      image: aviso.image || datos.image || undefined,

      /*
       * Con `tag` no se apilan cinco avisos de lo mismo.
       *
       * Cuando el servidor reintenta, o cuando dos reglas piden el aviso de la
       * misma actividad, el teléfono acaba con una columna de notificaciones
       * idénticas. Con la etiqueta, la nueva reemplaza a la anterior.
       */
      tag: datos.id ? `vt-${datos.tipo || 'aviso'}-${datos.id}` : undefined,

      // `ack` viaja hasta aqui para poder volver cuando toquen el aviso.
      data: {
        enlace: datos.enlace || '',
        tipo: datos.tipo || '',
        id: datos.id || '',
        ack: datos.ack || '',
      },
    })
      .then(() => console.log('[vt-push] pintada'))
      .catch((e) => console.error('[vt-push] NO se pudo pintar:', e && e.message, e)),

    /*
     * Que se enseno, no que se leyo.
     *
     * Este es el momento exacto en que el aviso aparece en la pantalla del
     * aparato, y es lo mas cerca que se puede estar de «le llego» sin
     * preguntarle a la persona. Que lo haya *visto* es otra cosa, y esa la
     * contesta el `notificationclick` de abajo.
     */
    acusar(datos.ack, 'entregado'),
  ]);
});

/**
 * El destino del aviso, siempre completo.
 *
 * ## Por que no vale la direccion tal como llega
 *
 * Porque quien manda el aviso escribe un destino de la aplicacion —`chat/12`—,
 * sin la barra de delante. Abriendo una ventana nueva eso funciona: se resuelve
 * contra la raiz del sitio. Pero cuando **ya hay una pestana abierta** —que es
 * la mitad de las veces— se resuelve contra la direccion que esa pestana tenga
 * puesta, y desde `/formularios/3` el aviso del chat llevaba a
 * `/formularios/chat/12`, que no existe: la notificacion se abria en una
 * pantalla en blanco.
 *
 * Resolviendolo aqui contra el origen las dos vias acaban en el mismo sitio, y
 * quien manda el aviso puede seguir escribiendo el destino como le resulta
 * natural.
 *
 * Vacio sigue siendo vacio: sin destino, tocar el aviso solo trae la pestana al
 * frente. Ver el comentario de abajo.
 */
function aDondeVa(enlace) {
  if (!enlace) return '';

  try {
    return new URL(enlace, self.registration.scope).href;
  } catch (e) {
    // Una direccion que no se puede leer no puede impedir abrir el aviso: se
    // trae la pestana al frente y ya.
    return '';
  }
}

/**
 * Al tocar el aviso.
 *
 * Si ya hay una pestaña de Visitrack abierta se **reutiliza** en vez de abrir
 * otra: quien tiene el formulario a medias no quiere una segunda pestaña con lo
 * mismo, quiere la suya. Solo si no hay ninguna se abre una nueva.
 */
self.addEventListener('notificationclick', (evento) => {
  evento.notification.close();

  const datos = evento.notification.data || {};

  /*
   * Vacio es vacio, y no «llevame al inicio».
   *
   * Aqui habia `datos.enlace || '/'`, y con eso el enlace era **siempre**
   * verdadero: tocar cualquier aviso navegaba, aunque la regla no hubiera
   * configurado ningun destino. Mientras los avisos solo salian con la pestana
   * de fondo se notaba poco; ahora tambien salen en primer plano, y eso
   * significaba sacar a alguien de un formulario a medio llenar por tocar una
   * notificacion.
   *
   * Sin enlace, tocarla solo trae la pestana al frente — que es exactamente lo
   * que uno espera de un aviso que no dice a donde ir.
   */
  const enlace = aDondeVa(datos.enlace);

  evento.waitUntil(
    /*
     * El acuse va **dentro** del `waitUntil`, junto a la navegacion.
     *
     * Suelto, el navegador puede dormir al trabajador en cuanto termina el
     * manejador y matar la peticion a medias: el aviso quedaria abierto sin que
     * nadie lo supiera, que es justo el dato por el que se hizo todo esto.
     */
    acusar(datos.ack, 'abierto').then(() =>
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((pestanas) => {
      for (const pestana of pestanas) {
        if ('focus' in pestana) {
          if (enlace && 'navigate' in pestana) pestana.navigate(enlace).catch(() => {});
          return pestana.focus();
        }
      }

      /*
       * Una ventana nueva si tiene que abrirse en algun sitio.
       *
       * Aqui si hace falta el `/`: no hay ninguna pestana que traer al frente,
       * asi que abrirla en blanco no serviria de nada.
       */
      return self.clients.openWindow(enlace || '/');
    })),
  );
});
