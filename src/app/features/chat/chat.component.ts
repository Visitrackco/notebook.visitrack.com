import { CommonModule } from '@angular/common';
import {
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { ChatSocketService } from './chat-socket.service';
import { FORMATO, TOPE_DE_SEGUNDOS, VozEnVivoService } from './voz-en-vivo.service';
import { ChatApi, MensajeDeSala, MiembroDeSala, SalaResumen } from './chat.api';

/**
 * El chat en el diligenciador.
 *
 * ## Qué se puede hacer aquí, y qué no
 *
 * Hablar en las salas a las que te han asignado, compartir fotos y archivos, y
 * ver quién está. **Administrar salas no**: eso se hace desde Module, que es
 * donde está quien coordina. Aquí no hay botón de crear sala a propósito —
 * ofrecerlo y que el servidor lo rechace sería peor que no ofrecerlo.
 *
 * ## De dónde salen los mensajes
 *
 * Se escriben por HTTP contra Module y llegan por el socket, que vive en la
 * raíz de la aplicación y no en esta pantalla: así un mensaje que llega
 * mientras diligencias un formulario se avisa igual. Ver `ChatSocketService`.
 */
@Component({
  selector: 'vt-chat',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.scss',
})
export class ChatComponent {
  private readonly api = inject(ChatApi);
  private readonly socket = inject(ChatSocketService);
  private readonly toasts = inject(ToastService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly ruta = inject(ActivatedRoute);
  private readonly voz = inject(VozEnVivoService);

  readonly TOPE_DE_SEGUNDOS = TOPE_DE_SEGUNDOS;

  /** Si este navegador puede transmitir y oír en vivo. Ver `VozEnVivoService`. */
  readonly hayVoz = this.voz.sePuede();

  /** Si estoy transmitiendo, y cuánto llevo. */
  readonly hablandoYo = this.voz.hablando;
  readonly segundosHablando = this.voz.segundos;

  /** Si se está oyendo a alguien. */
  readonly oyendoVoz = this.voz.oyendo;

  /** Quién tiene la palabra, si no soy yo. */
  readonly hablaOtro = computed(() => {
    const sala = this.abierta();
    const quien = this.socket.hablando();

    return sala && quien && quien.salaId === sala.id && quien.userId !== this.yoId ? quien : null;
  });

  readonly salas = signal<SalaResumen[]>([]);
  readonly abierta = signal<SalaResumen | null>(null);
  readonly mensajes = signal<MensajeDeSala[]>([]);
  readonly gente = signal<MiembroDeSala[]>([]);

  readonly cargandoSalas = signal(true);
  readonly cargandoSala = signal(false);

  readonly texto = signal('');
  readonly conectado = this.socket.conectado;

  /**
   * Quien esta escribiendo en la sala abierta.
   *
   * Se lee de lo que trae el socket y se filtra por la sala de ahora: el
   * servicio guarda todas las salas porque el aviso llega estes donde estes.
   */
  readonly escribiendoAqui = computed(() => {
    const sala = this.abierta();

    return sala ? (this.socket.escribiendo()[sala.id] ?? []) : [];
  });

  /** Cuantos estan mirando esta misma conversacion ahora. */
  readonly mirandoAqui = computed(() => {
    const sala = this.abierta();

    return sala ? (this.socket.mirando()[sala.id] ?? []).length : 0;
  });

  private readonly caja = viewChild<ElementRef<HTMLDivElement>>('caja');

  /** Quién soy, para saber de qué lado va cada burbuja. */
  private readonly yoId = Number(this.auth.currentUser()?.UserID ?? 0);

  /** El número más alto que ya está pintado. Con esto se pide lo que falta. */
  private ultimoVisto = 0;

  constructor() {
    void this.cargarSalas();
    /*
     * La zona horaria, una vez.
     *
     * Si falla se queda en cero, o sea UTC: preferible ensenar la hora de
     * Greenwich que restar horas al azar, porque lo primero se nota y lo
     * segundo se lee como correcto estando mal.
     */
    void this.api
      .zona()
      .then((z) => this.desfase.set(Number(z?.minutos ?? 0)))
      .catch(() => undefined);


    /*
     * La sala de la dirección.
     *
     * `/chat/12` abre la doce. Es lo que hace que el aviso de dentro y la
     * notificación del teléfono puedan llevar a una sala concreta en vez de a
     * la lista — con seis salas, «tienes un mensaje» sin decir dónde obliga a
     * ir abriéndolas una a una.
     */
    effect(() => {
      const pedida = Number(this.ruta.snapshot.paramMap.get('salaId') ?? 0);
      const lista = this.salas();

      if (!pedida || !lista.length) return;

      untracked(() => {
        if (this.abierta()?.id === pedida) return;

        const suya = lista.find((s) => s.id === pedida);
        if (suya) void this.abrir(suya, false);
      });
    });

    // Lo que llega por el socket, si es de la sala abierta.
    effect(() => {
      const m = this.socket.mensaje();
      if (!m) return;

      untracked(() => {
        if (this.abierta()?.id !== m.salaId) {
          this.subirElContador(m.salaId);

          return;
        }

        this.agregarMensaje(m);
      });
    });

    // Alguien entró, salió o cambió de ventana.
    effect(() => {
      const p = this.socket.presencia();
      if (!p) return;

      untracked(() => {
        if (this.abierta()?.id !== p.salaId) return;

        this.gente.update((lista) =>
          lista.map((uno) =>
            uno.userId === p.userId ? { ...uno, estado: p.estado, clientes: p.clientes } : uno,
          ),
        );
      });
    });

    /*
     * Lo que llega de una transmisión de voz.
     *
     * El reproductor se prepara al empezar y no al recibir la primera porción:
     * montarlo entonces ya es tarde y se pierde el principio, que en un walkie
     * suele ser el nombre de a quién se llama.
     */
    effect(() => {
      const v = this.socket.vozEmpieza();
      if (!v) return;

      untracked(() => {
        if (this.abierta()?.id !== v.salaId) return;

        /*
         * Solo lo que este navegador sabe decodificar.
         *
         * Todos los clientes mandan sonido en crudo, pero durante un despliegue
         * puede quedar uno viejo transmitiendo en `webm`. Intentar oírlo daría
         * ruido blanco a todo volumen, que es bastante peor que silencio.
         */
        if (v.formato && v.formato !== FORMATO) return;

        this.voz.empiezaAOir(v.id);
      });
    });

    effect(() => {
      const v = this.socket.vozTrozo();
      if (!v) return;

      untracked(() => {
        if (this.abierta()?.id === v.salaId) this.voz.oyeTrozo(v.id, v.trozo);
      });
    });

    effect(() => {
      const v = this.socket.vozFin();
      if (!v) return;

      untracked(() => this.voz.terminaDeOir(v.id));
    });

    /*
     * Al recuperar la conexión, se pide lo que falta.
     *
     * El socket solo trae lo que llega **mientras está conectado**. Sin esto,
     * un túnel o un cambio de red dejan un agujero en la conversación que no se
     * ve: los mensajes de antes están, los de después también, y los del medio
     * no aparecen hasta recargar.
     */
    effect(() => {
      const vivo = this.socket.conectado();

      untracked(() => {
        if (vivo && this.abierta()) void this.ponerseAlDia();
      });
    });
  }

  // ── Salas ─────────────────────────────────────────────────────────────────

  async cargarSalas(): Promise<void> {
    this.cargandoSalas.set(true);

    try {
      this.salas.set(await this.api.salas());
    } catch {
      this.toasts.show({ title: 'No se pudieron cargar las salas.', tone: 'error' });
    } finally {
      this.cargandoSalas.set(false);
    }
  }

  async abrir(sala: SalaResumen, navegar = true): Promise<void> {
    this.abierta.set(sala);
    this.cargandoSala.set(true);
    this.mensajes.set([]);
    this.gente.set([]);

    // La dirección refleja dónde estás: así se puede compartir el enlace de una
    // sala y recargar sin acabar en la lista.
    if (navegar) void this.router.navigate(['/chat', sala.id]);

    this.socket.leidaLaSala(sala.id);

    try {
      const [mensajes, gente] = await Promise.all([
        this.api.ultimos(sala.id),
        this.api.miembros(sala.id),
      ]);

      this.mensajes.set(mensajes);
      this.gente.set(gente);
      this.ultimoVisto = mensajes.at(-1)?.seq ?? 0;

      /*
       * El socket entra en la sala, ademas de la presencia.
       *
       * Al conectar ya se entro en las salas de entonces; esto cubre las que
       * cambiaron desde entonces y deja constancia en la consola de cuantas
       * conexiones hay dentro. Ver `entrarALaSala`.
       */
      this.socket.entrarALaSala(sala.id);
      this.socket.pedirPresencia(sala.id);

      /*
       * Se corta lo que sonara de la sala anterior y se engancha a esta.
       *
       * Si alguien está hablando ahora mismo, el servidor manda la cabecera y
       * se oye desde ya; sin esto habría que esperar a la siguiente
       * transmisión, que es justo cuando te estaban llamando.
       */
      this.voz.cortarLoQueSuena();
      this.socket.engancharmeALaVoz(sala.id);

      await this.marcarLeidoTodo();
      this.bajarDelTodo();
    } catch {
      this.toasts.show({ title: 'No se pudo abrir la sala.', tone: 'error' });
    } finally {
      this.cargandoSala.set(false);
    }
  }

  /** Pide lo que haya después de lo último pintado. Ver el efecto de reconexión. */
  private async ponerseAlDia(): Promise<void> {
    const sala = this.abierta();
    if (!sala) return;

    try {
      for (const m of await this.api.desde(sala.id, this.ultimoVisto)) this.agregarMensaje(m);
    } catch {
      // Sin ruido: si no se pudo, el siguiente mensaje o abrir la sala lo
      // arreglan. Un error aquí solo diría «algo no se pudo» sin nada que hacer.
    }
  }

  // ── Mensajes ──────────────────────────────────────────────────────────────

  async enviar(): Promise<void> {
    const sala = this.abierta();
    const texto = this.texto().trim();

    if (!sala || !texto) return;

    /*
     * Un identificador propio, puesto aquí.
     *
     * Viaja con el mensaje y vuelve en la respuesta. Sin él, reintentar un
     * envío que sí llegó pero cuya respuesta se perdió escribe el mensaje dos
     * veces; con él, el servidor devuelve el de la primera vez.
     */
    const clientId = crypto.randomUUID();

    this.texto.set('');

    /*
     * La burbuja sale ya, marcada como en camino.
     *
     * Esperando a la respuesta, entre pulsar y verla pasa todo lo que tarde la
     * red con el campo ya vacío: parece que no se envió y se escribe otra vez.
     * El `seq` provisional la deja al final hasta que llegue el de verdad.
     */
    this.agregarMensaje({
      id: 0,
      salaId: sala.id,
      seq: Number.MAX_SAFE_INTEGER,
      userId: this.yoId,
      autor: 'Yo',
      tipo: 'texto',
      texto,
      segundos: 0,
      clientId,
      creadoEn: new Date().toISOString(),
      adjuntos: [],
      enviando: true,
    });

    try {
      this.agregarMensaje(await this.api.escribir(sala.id, { texto, clientId, tipo: 'texto' }));
    } catch {
      // Se quita la burbuja en camino y se devuelve lo escrito: perderlo por un
      // fallo de red es lo que hace que la gente escriba en otro sitio y pegue.
      this.mensajes.update((lista) => lista.filter((m) => m.clientId !== clientId));
      this.texto.set(texto);

      this.toasts.show({ title: 'No se pudo enviar. Inténtalo otra vez.', tone: 'error' });
    }
  }

  async adjuntar(evento: Event): Promise<void> {
    const sala = this.abierta();
    const entrada = evento.target as HTMLInputElement;
    const archivo = entrada.files?.[0];

    if (!sala || !archivo) return;

    entrada.value = '';

    try {
      const ficha = await this.api.subirAdjunto(sala.id, archivo);

      this.agregarMensaje(
        await this.api.escribir(sala.id, {
          tipo: 'archivo',
          clientId: crypto.randomUUID(),
          texto: this.texto().trim(),
          adjuntos: [ficha],
        }),
      );

      this.texto.set('');
    } catch {
      this.toasts.show({ title: 'No se pudo compartir el archivo.', tone: 'error' });
    }
  }

  /** Abre o descarga un adjunto pidiendo su dirección en ese momento. */
  async abrirAdjunto(adjuntoId: number, descargar = false): Promise<void> {
    try {
      const { url } = await this.api.direccionDe(adjuntoId, descargar);

      window.open(url, '_blank', 'noopener');
    } catch {
      this.toasts.show({ title: 'No se pudo abrir el archivo.', tone: 'error' });
    }
  }

  /**
   * Avisa de que se esta escribiendo, sin mandar uno por tecla.
   *
   * Se manda el primero y despues como mucho uno cada dos segundos. Sin esa
   * pausa, escribir una frase manda treinta paquetes para decir lo mismo — y
   * con la sala llena eso es trafico de mas en todos los aparatos.
   *
   * Y se dice que se dejo de escribir cuando la casilla se queda vacia: es lo
   * que pasa al enviar, y sin eso el aviso se quedaria puesto hasta caducar.
   */
  alEscribirTexto(valor: string): void {
    this.texto.set(valor);

    const sala = this.abierta();
    if (!sala) return;

    if (!valor.trim()) {
      this.socket.avisarQueEscribo(sala.id, false);
      this.ultimoAviso = 0;

      return;
    }

    const ahora = Date.now();
    if (ahora - this.ultimoAviso < 2000) return;

    this.ultimoAviso = ahora;
    this.socket.avisarQueEscribo(sala.id, true);
  }

  /** Cuando se avisó por última vez. Ver [alEscribirTexto]. */
  private ultimoAviso = 0;

  // ── El walkie-talkie ──────────────────────────────────────────────────────

  /**
   * Empieza a transmitir. Se oye mientras hablas.
   *
   * El turno se pide al servidor y **se espera su respuesta** antes de abrir el
   * micrófono: lo que se transmite sale en el acto, así que grabando antes de
   * tenerlo, lo primero que dijeras se perdería o se mezclaría con quien ya
   * estaba hablando.
   */
  /**
   * El boton del walkie: se pulsa para empezar y se vuelve a pulsar para parar.
   *
   * ## Por que no es mantener pulsado
   *
   * Porque mantener obliga a tener el dedo o el raton quieto encima mientras se
   * habla, y hablar es justo cuando se esta mirando otra cosa —una foto, un
   * formulario, la calle—. Al minimo desvio se soltaba y la frase se cortaba a
   * la mitad sin que nadie lo notara hasta que el otro contestaba «no te oi».
   *
   * Con pulsar y volver a pulsar, la transmision dura lo que se quiera decir. Y
   * si se olvida cerrarla, se corta sola al llegar al tope, que es lo que evita
   * que un boton pulsado en un bolsillo deje la sala muda.
   */
  alternarHabla(): void {
    if (this.hablandoYo()) {
      this.dejarDeHablar();

      return;
    }

    void this.empezarAHablar();
  }

  async empezarAHablar(): Promise<void> {
    const sala = this.abierta();
    if (!sala || this.hablandoYo()) return;

    if (!this.hayVoz) {
      this.toasts.show({
        title: 'Este navegador no puede transmitir voz. Prueba con Chrome o Edge.',
        tone: 'warning',
      });

      return;
    }

    const r = await this.socket.empezarAHablar(sala.id);

    if (!r.ok) {
      this.toasts.show({
        title: r.motivo ? `No se puede hablar: ${r.motivo}.` : 'No se pudo hablar.',
        tone: 'info',
      });

      return;
    }

    const pudo = await this.voz.empezar(
      (trozo) => this.socket.mandarTrozoDeVoz(sala.id, trozo),
      () => {
        // El servidor aguanta el turno cinco segundos mas que el tope, por si
        // el aviso se pierde. Mandarlo aqui devuelve la palabra en el acto en
        // vez de dejar a la sala esperando a que caduque.
        this.socket.terminarDeHablar(sala.id);

        this.toasts.show({
          title: `Se cortó a los ${TOPE_DE_SEGUNDOS} segundos.`,
          tone: 'info',
        });
      },
    );

    if (!pudo) {
      this.socket.terminarDeHablar(sala.id);
      this.toasts.show({ title: 'No se pudo usar el micrófono.', tone: 'error' });
    }
  }

  /** Soltar: se cierra la transmisión. No hay nada que mandar, ya salió todo. */
  dejarDeHablar(): void {
    const sala = this.abierta();
    if (!sala || !this.hablandoYo()) return;

    this.voz.parar();
    this.socket.terminarDeHablar(sala.id);
  }

  alTeclear(evento: KeyboardEvent): void {
    // Con Mayús salta de línea. `keydown.enter` de Angular dispara también con
    // Shift pulsado, así que se mira a mano.
    if (evento.key !== 'Enter' || evento.shiftKey) return;

    evento.preventDefault();
    void this.enviar();
  }

  // ── Lo de dentro ──────────────────────────────────────────────────────────

  /**
   * Mete un mensaje en la lista, sin repetirlo.
   *
   * El mismo mensaje llega dos veces a quien lo escribe: por la respuesta de su
   * petición y por el socket. Se reconoce por su número —que pone el servidor y
   * es único por sala— o por el identificador del cliente, que es lo que
   * empareja la burbuja en camino con la definitiva.
   */
  private agregarMensaje(nuevo: MensajeDeSala): void {
    this.mensajes.update((lista) => {
      const donde = lista.findIndex(
        (m) =>
          (!nuevo.enviando && m.seq === nuevo.seq) ||
          (!!nuevo.clientId && m.clientId === nuevo.clientId),
      );

      if (donde < 0) return [...lista, nuevo].sort((a, b) => a.seq - b.seq);

      const copia = [...lista];
      copia[donde] = nuevo;

      return copia.sort((a, b) => a.seq - b.seq);
    });

    if (!nuevo.enviando) this.ultimoVisto = Math.max(this.ultimoVisto, nuevo.seq);

    void this.marcarLeidoTodo();
    this.bajarDelTodo();
  }

  private subirElContador(salaId: number): void {
    this.salas.update((lista) =>
      lista.map((s) => (s.id === salaId ? { ...s, sinLeer: s.sinLeer + 1 } : s)),
    );
  }

  private async marcarLeidoTodo(): Promise<void> {
    const sala = this.abierta();

    // Las burbujas en camino llevan un número inventado para ordenar al final:
    // apuntarlo como leído mandaría al servidor un mensaje que no existe.
    const ultimo = this.mensajes().filter((m) => !m.enviando).at(-1)?.seq ?? 0;

    if (!sala || !ultimo) return;

    this.salas.update((lista) => lista.map((s) => (s.id === sala.id ? { ...s, sinLeer: 0 } : s)));

    try {
      await this.api.marcarLeido(sala.id, ultimo);
    } catch {
      // Lo peor que pasa es que el contador vuelva a salir al recargar.
    }
  }

  /**
   * Baja la caja del todo.
   *
   * En el siguiente hueco del navegador y no ahora: en este instante el mensaje
   * todavía no está pintado, así que medir daría la altura de antes y la caja
   * se quedaría un renglón corta.
   */
  private bajarDelTodo(): void {
    setTimeout(() => {
      const caja = this.caja()?.nativeElement;
      if (caja) caja.scrollTop = caja.scrollHeight;
    });
  }

  // ── Cómo se lee cada cosa ─────────────────────────────────────────────────

  esMio(m: MensajeDeSala): boolean {
    return m.userId === this.yoId;
  }

  comoSeVe(estado?: string): string {
    if (estado === 'activo') return 'Conectado';
    if (estado === 'ausente') return 'Abierto, sin mirar';

    return 'Desconectado';
  }

  comoPesa(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;

    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  /** La zona de quien mira, en minutos respecto a UTC. Ver `aLaHora`. */
  private readonly desfase = signal(0);

  /**
   * La hora de un mensaje, en la zona de quien mira.
   *
   * ## Por que no se usa la hora del navegador
   *
   * Porque esa es la del **aparato**, no la de la persona. Quien viaja, quien
   * tiene el portatil mal configurado o quien entra desde un equipo prestado
   * veria las horas movidas — y en un chat eso se confunde con que el mensaje
   * llego tarde, que es justo lo que no puede pasar.
   *
   * El servidor guarda en UTC y dice cuantos minutos hay que sumar segun el
   * `UTCCode` de la persona, con su horario de verano si lo tiene. Aqui solo se
   * suma y se pinta.
   *
   * Se formatea con `getUTCHours` **despues** de haber sumado el desfase: usar
   * `getHours` volveria a aplicar la zona del navegador encima y correria la
   * hora dos veces, que es el fallo clasico de esto.
   */
  aLaHora(cuando: string): string {
    if (!cuando) return '';

    const t = new Date(cuando);
    if (Number.isNaN(t.getTime())) return '';

    const suya = new Date(t.getTime() + this.desfase() * 60_000);
    const dos = (n: number) => String(n).padStart(2, '0');

    return `${dos(suya.getUTCHours())}:${dos(suya.getUTCMinutes())}`;
  }

  /** La inicial de una sala, para su bola. */
  inicialDe(nombre: string): string {
    return (nombre.trim()[0] ?? '?').toUpperCase();
  }

  readonly hayAlgo = computed(() => this.salas().length > 0);
}
