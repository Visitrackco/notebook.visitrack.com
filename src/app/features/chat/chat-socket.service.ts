import { DestroyRef, Injectable, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Socket, io } from 'socket.io-client';

import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { MensajeDeSala } from './chat.api';

/** Cómo se ve a alguien en una sala. */
export interface PresenciaDeUno {
  salaId: number;
  userId: number;
  estado: 'activo' | 'ausente' | 'desconectado';
  clientes: string[];
}

/**
 * La conexión viva del chat, para toda la aplicación.
 *
 * ## Por qué vive aquí y no en la pantalla del chat
 *
 * Porque la mayor parte del tiempo no se está en el chat. Si el socket se
 * montara con la pantalla, llegar un mensaje mientras diligencias un formulario
 * no se notaría hasta que alguien fuera a mirar — y eso es justo lo que hace
 * que un chat de trabajo no se use.
 *
 * Estando en la raíz, el aviso llega estés donde estés, y al tocarlo se abre la
 * sala. El push del teléfono cubre el caso de tener la ventana detrás; esto
 * cubre el de estar dentro pero en otra pantalla.
 *
 * ## Qué trae, y qué no decide
 *
 * Trae mensajes **ya escritos**. No es por donde se escribe: eso va por HTTP,
 * que falla cuando falla. Si el socket se cae, lo peor que pasa es que haya que
 * entrar al chat para ver lo nuevo.
 */
@Injectable({ providedIn: 'root' })
export class ChatSocketService {
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly router = inject(Router);
  private readonly destroy = inject(DestroyRef);

  private socket: Socket | null = null;

  readonly conectado = signal(false);

  /** El último mensaje que llegó. La sala abierta lo recoge. */
  readonly mensaje = signal<MensajeDeSala | null>(null);

  /** El último cambio de presencia. */
  readonly presencia = signal<PresenciaDeUno | null>(null);

  /** Cuántos mensajes hay sin leer por sala, para el punto del menú. */
  readonly sinLeerPorSala = signal<Record<number, number>>({});

  /** Cuántos sin leer en total. Lo mira la navegación. */
  readonly sinLeer = signal(0);


  /** El token con el que se monto la conexion de ahora. Ver [mismoToken]. */
  private tokenPuesto: string | null = null;

  /**
   * Si el token es el mismo con el que ya se conecto.
   *
   * ## Por que hace falta
   *
   * El efecto se dispara con **cada cambio de la sesion**, y la sesion se
   * vuelve a escribir por cosas que no son entrar ni salir: al rehidratarla al
   * arrancar, al renovar el token, al refrescar el usuario. Cada una de esas
   * deja un objeto nuevo aunque el token sea el mismo.
   *
   * Y si en alguno de esos instantes la sesion pasa por nula —cosa que ocurre
   * al rehidratar— el efecto llamaba a `desconectar()`, que tira el socket a
   * medio saludo. La peticion que ya iba en camino llegaba con un `sid` que el
   * servidor acababa de olvidar, y contestaba **«Session ID unknown»**. Desde
   * fuera parecia un problema del servidor, y el servidor estaba bien: se
   * comprobo con doce saludos seguidos contra produccion, los doce correctos.
   *
   * Comparando el valor y no la identidad del objeto, la conexion se monta una
   * vez y solo se rehace cuando de verdad cambia quien eres.
   */
  private mismoToken(token: string): boolean {
    if (this.tokenPuesto === token) return true;

    this.tokenPuesto = token;

    return false;
  }
  constructor() {
    /*
     * Se conecta con la sesión y se corta cuando se cierra.
     *
     * Mirando el token en vez de conectar al arrancar, entrar y salir de la
     * cuenta hace lo correcto sin que nadie tenga que acordarse de llamar a
     * `desconectar()` desde la pantalla de salida. Y sobre todo: el socket no
     * sobrevive a cerrar sesión con la sesión de quien acaba de salir.
     */
    effect(() => {
      const token = this.auth.currentUser()?.Token ?? '';

      // `conectar` y `desconectar` solo se llaman cuando el token **cambia de
      // verdad**. Ver `mismoToken`.
      if (this.mismoToken(token)) return;

      if (token) this.conectar(token);
      else this.desconectar();
    });

    this.destroy.onDestroy(() => this.desconectar());

    /*
     * Y se dice si la ventana está delante.
     *
     * Es lo que decide si el servidor manda notificación al teléfono: con la
     * pestaña detrás no se está mirando, y quien escribe espera respuesta.
     */
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        this.socket?.emit('activo', { activo: document.visibilityState === 'visible' });
      });
    }
  }

  private conectar(token: string): void {
    if (this.socket) return;

    this.socket = io(environment.moduleUrl, {
      path: '/socket.io',

      // La credencial va en el saludo, **no en la dirección**: en la URL se
      // cuela en el registro del servidor y en el de cualquier proxy.
      auth: { token, cliente: 'web' },

      /*
       * Primero polling y despues, si se puede, WebSocket.
       *
       * Es el orden de fabrica de socket.io y hay que dejarlo. Poniendo
       * `['websocket', 'polling']` se intenta el WebSocket **de entrada**, y
       * donde hay un proxy que no reenvia la cabecera `Upgrade` —IIS sin el
       * modulo, o cualquier intermediario de una red corporativa— eso falla con
       * «WebSocket is closed before the connection is established» y la
       * pantalla se queda diciendo que no hay conexion en vivo.
       *
       * Con el orden bueno, el saludo entra por peticiones normales, que pasan
       * por cualquier sitio, y la conexion **se sube sola** a WebSocket cuando
       * el camino lo permite. Poder caerse a polling es justo la razon por la
       * que se eligio socket.io en vez de `ws` pelado; forzar el orden anulaba
       * lo unico que se vino a buscar.
       */
      transports: ['polling', 'websocket'],
    });

    this.socket.on('connect', () => this.conectado.set(true));
    this.socket.on('disconnect', () => this.conectado.set(false));
    this.socket.on('sesion:invalida', () => this.desconectar());

    this.socket.on('mensaje', (m: MensajeDeSala) => {
      this.mensaje.set(m);
      this.avisarSiNoEstasEnLaSala(m);
    });

    this.socket.on('presencia:uno', (p: PresenciaDeUno) => this.presencia.set(p));
  }

  private desconectar(): void {
    this.socket?.disconnect();
    this.socket = null;
    this.tokenPuesto = null;

    this.conectado.set(false);
    this.sinLeerPorSala.set({});
    this.sinLeer.set(0);
  }

  /**
   * El aviso de dentro, cuando el mensaje llega y no estás en esa sala.
   *
   * ## Cuándo NO sale
   *
   * Cuando ya estás mirando esa conversación: el mensaje aparece delante y un
   * aviso encima sería ruido. Y cuando el mensaje es tuyo, que es fácil de
   * olvidar y se nota enseguida.
   *
   * Al tocarlo se abre la sala. Un aviso que solo informa obliga a buscar de
   * qué sala hablaba, y con seis salas eso es peor que no avisar.
   */
  private avisarSiNoEstasEnLaSala(m: MensajeDeSala): void {
    const yo = Number(this.auth.currentUser()?.UserID ?? 0);
    if (m.userId === yo) return;

    if (this.router.url.startsWith(`/chat/${m.salaId}`)) return;

    this.sinLeerPorSala.update((antes) => ({
      ...antes,
      [m.salaId]: (antes[m.salaId] ?? 0) + 1,
    }));

    this.sinLeer.update((n) => n + 1);

    this.toasts.show({
      title: `${m.autor}: ${this.comoSeLee(m)}`,
      tone: 'info',
      action: { label: 'Abrir', run: () => void this.router.navigate(['/chat', m.salaId]) },
    });
  }

  /** Se olvida lo pendiente de una sala al entrar en ella. */
  leidaLaSala(salaId: number): void {
    this.sinLeerPorSala.update((antes) => {
      const pendientes = antes[salaId] ?? 0;
      if (!pendientes) return antes;

      this.sinLeer.update((n) => Math.max(0, n - pendientes));

      const resto = { ...antes };
      delete resto[salaId];

      return resto;
    });
  }

  /**
   * Cómo se lee un mensaje en un aviso.
   *
   * Un adjunto no tiene texto, y un aviso vacío se ve como un fallo. Se dice
   * que llegó algo y de qué clase, que es lo que decide si vale la pena dejar
   * lo que estás haciendo.
   */
  private comoSeLee(m: MensajeDeSala): string {
    if (m.tipo === 'voz') return `nota de voz (${m.segundos}s)`;
    if (m.tipo === 'archivo') return m.adjuntos?.[0]?.nombre ?? 'ha compartido un archivo';

    return String(m.texto ?? '').slice(0, 90) || 'mensaje nuevo';
  }


  /**
   * Entra en la sala y dice cuantos hay dentro.
   *
   * ## Por que se pide al abrir, si ya se entro al conectar
   *
   * Porque al conectar se entra en las salas **de ese momento**. Si te agregan
   * despues, o la conexion se rehizo antes de que la sala existiera, te quedas
   * conectado y fuera: el chat parece vivo y no llega nada. Pidiendolo tambien
   * aqui, el caso corriente —abro la sala, hablo— repara ese hueco solo.
   *
   * La cuenta se escribe en la consola **del navegador** a proposito. Los
   * registros del servidor van a la maquina y bajo IIS no se ven desde ningun
   * sitio; aqui se leen donde esta quien prueba. Un «0» dice que no entro y un
   * «2» dice que el reparto tiene a quien llegar.
   */
  entrarALaSala(salaId: number): void {
    this.socket?.emit(
      'sala:entrar',
      { salaId },
      (r: { dentro?: boolean; conexiones?: number }) => {
        console.log(
          `[chat] sala ${salaId}: ${r?.dentro ? 'dentro' : 'FUERA'} · ` +
            `${r?.conexiones ?? 0} conexiones en la sala`,
        );
      },
    );
  }
  /** Pide la lista entera de quién está en una sala. */
  pedirPresencia(salaId: number): void {
    this.socket?.emit('presencia:pedir', { salaId });
  }
}
