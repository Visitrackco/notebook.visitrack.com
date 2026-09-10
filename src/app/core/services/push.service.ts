import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { apiBaseUrlDirecta } from '../config/api-base';
import { FIREBASE_CONFIG, VAPID_KEY } from '../config/firebase';
import { esModoPublico } from '../config/modo-publico';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { DeviceService } from './device.service';
import { ToastService } from './toast.service';

/** Hasta cuándo se calló la tira, en `localStorage`. */
const APLAZO_KEY = 'visitrack.pushPospuesto';

/** En qué punto está el permiso de este navegador. */
export type EstadoPush = 'sin-soporte' | 'apagado' | 'pidiendo' | 'encendido' | 'bloqueado';

/**
 * Notificaciones del navegador.
 *
 * ## Por qué hace falta un botón, y no se puede activar solo
 *
 * El navegador **solo concede el permiso a raíz de un gesto de la persona**.
 * Pedirlo al arrancar no es que quede feo: Chrome lo rechaza de plano si no
 * viene de un clic, y Firefox lo recuerda como «denegado» — con lo que la
 * siguiente vez ya no se puede ni preguntar. Por eso esto se dispara desde un
 * botón del perfil y no desde el arranque.
 *
 * ## Qué se guarda, y dónde
 *
 * Un **token por aparato**, no por persona: el mismo usuario con el teléfono y
 * el navegador abiertos son dos destinos distintos y el aviso tiene que llegar
 * a los dos. Se manda al servidor junto al `DeviceID` de este navegador —el
 * mismo con el que se abrió la sesión— para que al volver a registrarse se
 * reemplace el suyo en vez de acumular uno nuevo cada vez que Google lo rota.
 *
 * ## En un enlace público, no
 *
 * Quien abre un enlace no tiene cuenta ni va a volver: pedirle permiso para
 * notificaciones sería pedirle algo que no le sirve, en la primera pantalla que
 * ve.
 */
@Injectable({ providedIn: 'root' })
export class PushService {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly device = inject(DeviceService);
  private readonly toasts = inject(ToastService);

  readonly estado = signal<EstadoPush>(this.leerEstado());

  /** El token de este navegador, cuando ya se obtuvo. */
  readonly token = signal('');

  /** ¿Tiene sentido ofrecer el botón? */
  readonly sePuedeOfrecer = computed(() => this.estado() !== 'sin-soporte' && !esModoPublico());

  /** Cuándo se pospuso el aviso, para no repetirlo cada rato. */
  private readonly pospuestoHasta = signal(this.leerAplazo());

  /**
   * ¿Conviene ofrecer la tira ahora mismo?
   *
   * Solo con permiso **sin decidir**. Ni bloqueado —desde la aplicación no se
   * puede arreglar, y una tira que no lleva a ninguna parte se lee como que algo
   * está roto— ni ya encendido, obviamente.
   */
  readonly conviene = computed(
    () =>
      this.sePuedeOfrecer() && this.estado() === 'apagado' && Date.now() > this.pospuestoHasta(),
  );

  /**
   * «Ahora no»: se calla una semana.
   *
   * Ni para siempre ni hasta la próxima recarga. Lo primero deja fuera a quien
   * dijo que no un martes con prisa y el jueves lo habría querido; lo segundo
   * convierte la tira en algo que se cierra sin leer, y entonces no la activa
   * nadie.
   */
  posponer(): void {
    const dentroDeUnaSemana = Date.now() + 7 * 24 * 60 * 60 * 1000;

    this.pospuestoHasta.set(dentroDeUnaSemana);

    try {
      localStorage.setItem(APLAZO_KEY, String(dentroDeUnaSemana));
    } catch {
      // Sin almacenamiento vuelve a salir en la próxima carga. Es una molestia
      // pequeña, y la alternativa —no ofrecerla— es peor.
    }
  }

  private leerAplazo(): number {
    try {
      return Number(localStorage.getItem(APLAZO_KEY)) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Lo que se le dice a quien mira el ajuste.
   *
   * «Bloqueado» se cuenta aparte de «apagado» porque no se arregla igual: lo
   * primero se resuelve desde la aplicación y lo segundo solo desde la barra del
   * navegador, y sin decirlo la gente pulsa el botón una y otra vez.
   */
  readonly explicacion = computed(() => {
    switch (this.estado()) {
      case 'sin-soporte':
        return 'Este navegador no admite notificaciones.';

      case 'bloqueado':
        return 'Las bloqueaste en este navegador. Para volver a recibirlas hay que permitirlas desde el candado de la barra de direcciones.';

      case 'encendido':
        return 'Recibirás los avisos aunque tengas Visitrack cerrado.';

      case 'pidiendo':
        return 'Esperando a que respondas al navegador…';

      default:
        return 'Actívalas para enterarte de una consigna nueva sin tener que entrar a mirar.';
    }
  });

  private leerEstado(): EstadoPush {
    if (typeof Notification === 'undefined' || !('serviceWorker' in navigator)) {
      return 'sin-soporte';
    }

    if (Notification.permission === 'granted') return 'encendido';
    if (Notification.permission === 'denied') return 'bloqueado';

    return 'apagado';
  }

  /**
   * Pide permiso, saca el token y lo registra. **Desde un clic.**
   *
   * Nunca lanza: activar notificaciones es un extra, y que falle no puede
   * romper la pantalla desde la que se pulsó.
   */
  async activar(): Promise<boolean> {
    if (!this.sePuedeOfrecer()) return false;

    this.estado.set('pidiendo');

    try {
      const permiso = await Notification.requestPermission();

      if (permiso !== 'granted') {
        this.estado.set(permiso === 'denied' ? 'bloqueado' : 'apagado');
        return false;
      }

      const token = await this.pedirToken();

      if (!token) {
        this.estado.set('apagado');
        this.toasts.error('No se pudo activar', 'El navegador no entregó un identificador.');
        return false;
      }

      this.token.set(token);
      await this.registrar(token);

      this.estado.set('encendido');
      this.toasts.success('Notificaciones activadas');

      return true;
    } catch (error) {
      this.estado.set(this.leerEstado());

      console.warn('[Push] no se pudo activar', error);
      this.toasts.error('No se pudieron activar las notificaciones');

      return false;
    }
  }

  /**
   * Vuelve a registrar el token si ya había permiso.
   *
   * Se llama al entrar. Google **rota los tokens** —al reinstalar el navegador,
   * al limpiar los datos del sitio, o por su cuenta cada cierto tiempo— y uno
   * viejo deja de entregar sin avisar a nadie. Refrescarlo en cada sesión evita
   * el caso peor: alguien que cree tener las notificaciones activadas y lleva
   * semanas sin recibir ninguna.
   *
   * No pide permiso: si no lo hay, no hace nada. Eso es cosa del botón.
   */
  async refrescar(): Promise<void> {
    if (this.estado() !== 'encendido' || !this.auth.isAuthenticated()) return;

    try {
      const token = await this.pedirToken();

      if (!token) return;

      this.token.set(token);
      await this.registrar(token);
    } catch (error) {
      console.warn('[Push] no se pudo refrescar el token', error);
    }
  }

  /**
   * Empieza a escuchar los avisos que llegan **con la aplicación abierta**.
   *
   * ## Por qué hace falta, si ya hay un service worker
   *
   * Porque el service worker **no se entera** cuando la pestaña está a la vista:
   * `onBackgroundMessage` solo salta con la aplicación cerrada o en otra
   * pestaña. Sin esto, quien tiene Visitrack delante es justo el único que no
   * ve llegar la consigna — que es al revés de lo que uno esperaría.
   *
   * Se pinta con el mismo aviso flotante que el resto de la aplicación en vez de
   * con una notificación del sistema: sobre la pestaña que ya se está mirando,
   * una notificación del escritorio tapa lo que se está haciendo.
   *
   * Solo escucha una vez, aunque se llame varias.
   */
  private escuchando = false;

  async escuchar(): Promise<void> {
    if (this.escuchando || this.estado() !== 'encendido') return;

    try {
      const [{ initializeApp, getApps }, { getMessaging, onMessage, isSupported }] =
        await Promise.all([import('firebase/app'), import('firebase/messaging')]);

      if (!(await isSupported())) return;

      const app = getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);

      this.escuchando = true;

      onMessage(getMessaging(app), (mensaje) => {
        const aviso = mensaje.notification ?? {};
        const datos = (mensaje.data ?? {}) as Record<string, string>;

        /*
         * Tambien con la pestana delante sale la notificacion del sistema.
         *
         * Antes aqui se ensenaba un aviso flotante dentro de la pagina, con el
         * argumento de que una notificacion del escritorio tapa lo que se esta
         * mirando. Es cierto, pero se eligio mal: quien recibe un push espera un
         * push, y con la pestana abierta —que es la mitad del tiempo— parecia
         * que no llegaba nada.
         *
         * Si no se puede pintar —permiso denegado, sin service worker— se cae al
         * aviso flotante, que es mejor que quedarse callado.
         */
        void this.pintarAviso(aviso, datos);

        /*
         * Tambien en primer plano cuenta como entregado.
         *
         * Con la pestana a la vista el aviso no pasa por el service worker, asi
         * que su acuse no sale. Sin esto, justo los avisos que llegan mientras
         * alguien esta usando la aplicacion —los mas seguros de todos— saldrian
         * en la bandeja como no entregados.
         */
        void this.acusar(datos['ack'], 'entregado');
      });
    } catch (error) {
      console.warn('[Push] no se pudo escuchar en primer plano', error);
    }
  }

  /**
   * Pinta la notificacion del sistema para un aviso que llego en primer plano.
   *
   * ## Por que a traves del service worker y no con `new Notification`
   *
   * Porque el clic tiene que entrar por el `notificationclick` del worker, que
   * es quien navega al enlace **y quien acusa la apertura**. Con
   * `new Notification` el clic se queda en la pagina, el worker no se entera, y
   * `OpenedOn` no se llenaria nunca — justo el dato por el que existe la
   * bandeja.
   *
   * De paso queda identica a la que sale con la pestana cerrada: mismo icono,
   * misma imagen, misma etiqueta para no apilar repetidos. Dos aspectos
   * distintos segun donde estuviera mirando quien la recibe seria raro sin
   * motivo.
   *
   * Nunca lanza: si algo falla se ensena el aviso flotante de siempre.
   */
  private async pintarAviso(
    aviso: { title?: string; body?: string; image?: string },
    datos: Record<string, string>,
  ): Promise<void> {
    const titulo = aviso.title || datos['title'] || 'Visitrack';
    const cuerpo = aviso.body || datos['body'] || '';

    /*
     * Deja constancia de por donde entro.
     *
     * Un aviso llega por uno de dos caminos —esta pagina si la pestana esta
     * delante, el service worker si no— y hasta ahora los dos fallaban igual de
     * callados. Saber cual corrio es la mitad de la respuesta cuando no aparece
     * nada: este mensaje sale en la consola de la pagina, y el del worker en la
     * suya, que es otra.
     */
    console.log('[vt-push] llego en primer plano:', titulo, datos);

    try {
      if (
        typeof Notification === 'undefined' ||
        Notification.permission !== 'granted' ||
        !('serviceWorker' in navigator)
      ) {
        throw new Error('sin permiso o sin worker');
      }

      /*
       * El worker que ya esta registrado, no uno nuevo.
       *
       * `ready` espera al que quedo activo tras `pedirToken`, que es el de
       * Firebase. Registrar otro aqui crearia un segundo worker compitiendo por
       * el mismo alcance.
       */
      const registro = await navigator.serviceWorker.ready;

      const pintada = registro.showNotification(titulo, {
        body: cuerpo,
        icon: '/icon.png',
        badge: '/icon.png',

        // Los mismos datos que pone el worker, para que el clic sepa a donde ir
        // y con que llave acusar. Ver `firebase-messaging-sw.js`.
        data: {
          enlace: datos['enlace'] || '',
          tipo: datos['tipo'] || '',
          id: datos['id'] || '',
          ack: datos['ack'] || '',
        },

        // Con etiqueta no se apilan dos entregas del mismo aviso.
        ...(datos['id'] ? { tag: `vt-${datos['tipo'] || 'aviso'}-${datos['id']}` } : {}),
        ...(aviso.image || datos['image'] ? { image: aviso.image || datos['image'] } : {}),
      } as NotificationOptions);

      await pintada;

      console.log('[vt-push] pintada');
    } catch (error) {
      console.warn('[Push] no se pudo pintar la notificacion, se avisa dentro', error);

      this.toasts.info(titulo, cuerpo);
    }
  }

  /**
   * Avisa al servidor de que un aviso llego o se abrio.
   *
   * Lo autoriza `ack`, una llave propia de ese aviso que viaja dentro del
   * mensaje: no hace falta sesion, y por eso el mismo camino sirve aqui y en el
   * service worker, que no la tiene.
   *
   * Nunca lanza. Que no se pueda apuntar el acuse no puede estropear la llegada
   * del aviso, que es lo que de verdad importaba.
   */
  private async acusar(ack: string | undefined, evento: 'entregado' | 'abierto'): Promise<void> {
    if (!ack) return;

    try {
      await fetch(`${apiBaseUrlDirecta()}/public/push/acuse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ack, evento }),
      });
    } catch {
      // Sin red no se apunta, y ya esta.
    }
  }

  /**
   * El token de este navegador.
   *
   * El SDK se carga aquí dentro y no arriba a propósito: son unos cuantos
   * kilobytes que solo hacen falta si alguien va a usar notificaciones, y la
   * mayoría de quienes abren la aplicación no llegan nunca a esta pantalla.
   */
  private async pedirToken(): Promise<string> {
    const [{ initializeApp, getApps }, { getMessaging, getToken, isSupported }] = await Promise.all([
      import('firebase/app'),
      import('firebase/messaging'),
    ]);

    if (!(await isSupported())) {
      this.estado.set('sin-soporte');
      return '';
    }

    const app = getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);

    /*
     * El service worker se registra aquí, a mano.
     *
     * Si no, el SDK lo busca por su cuenta en `/firebase-messaging-sw.js`. Eso
     * funciona con `ng serve` y falla detrás de algunos servidores, y cuando
     * falla el error sale de dentro del SDK sin decir qué pasó. Registrándolo
     * aquí, el fallo aparece en esta línea.
     */
    const registro = await navigator.serviceWorker.register('firebase-messaging-sw.js');

    return getToken(getMessaging(app), {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: registro,
    });
  }

  /** Se lo cuenta al servidor, atado a este aparato. */
  private async registrar(token: string): Promise<void> {
    const usuario = this.auth.currentUser();

    if (!usuario) return;

    await firstValueFrom(
      this.api.put('/putMarkUser', {
        UserID: usuario.UserID,
        token,
        plataforma: 'web',

        // El mismo identificador con el que se abrió la sesión: es lo que
        // permite reemplazar el token de este navegador en vez de acumular uno
        // nuevo cada vez que Google lo rote.
        deviceId: usuario.DeviceID || this.device.getDeviceId(),
      }),
    );
  }
}
