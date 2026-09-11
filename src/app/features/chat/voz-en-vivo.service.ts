import { Injectable, signal } from '@angular/core';

/** Lo que dura como mucho una transmisión. El servidor la corta igual. */
export const TOPE_DE_SEGUNDOS = 20;

/**
 * Cada cuánto sale una porción de audio.
 *
 * Es el compromiso de todo esto. Más corto llega antes pero multiplica los
 * paquetes y la cabecera de cada uno pesa más que el sonido que lleva; más
 * largo ahorra tráfico y se nota como retraso al hablar. Un cuarto de segundo
 * es lo que usan las aplicaciones que hacen esto, y en una red mala aguanta.
 */
const CADA_MS = 250;

/**
 * Cuánto se acumula antes de empezar a sonar.
 *
 * Sin colchón, la primera porción que se retrase deja un hueco audible y el
 * audio se corta. Con medio segundo se absorbe el vaivén normal de una red sin
 * que la conversación se sienta lenta.
 */
const COLCHON_MS = 500;

/** El formato que se graba. Ver `sePuede`. */
const FORMATO = 'audio/webm;codecs=opus';

/**
 * El walkie-talkie en vivo: se oye **mientras** se habla.
 *
 * ## Cómo funciona, y por qué así
 *
 * Se graba en porciones de un cuarto de segundo que salen por el socket según
 * se generan, y quien escucha las va pegando en un reproductor que ya está
 * sonando. La latencia queda alrededor de un segundo: el colchón, la red y lo
 * que tarde el navegador en decodificar.
 *
 * ## La cabecera
 *
 * Lo que graba el navegador es un contenedor, no sonido suelto: **la primera
 * porción lleva la cabecera** —qué códec, a qué frecuencia— y las siguientes
 * solo traen audio. Por eso el servidor guarda esa primera y se la manda a
 * quien llegue tarde. Sin ella, lo que recibe no se puede decodificar y no
 * suena nada, sin ningún error que lo explique.
 *
 * ## Dónde no funciona
 *
 * En Safari. No admite `audio/webm` ni en grabación ni en `MediaSource`, y no
 * hay un formato que sirva para las dos cosas en todos los navegadores. Ahí
 * `sePuede()` devuelve `false` y quien llama se queda con la nota de voz de
 * siempre —grabar y mandar al soltar—, que funciona en todas partes. Eso es
 * deliberado: media función en todos lados vale más que la función entera en
 * unos pocos.
 */
@Injectable({ providedIn: 'root' })
export class VozEnVivoService {
  /** Si se está hablando ahora mismo, y cuánto se lleva. */
  readonly hablando = signal(false);
  readonly segundos = signal(0);

  /** Si está sonando alguien. */
  readonly oyendo = signal(false);

  private grabadora: MediaRecorder | null = null;
  private reloj: ReturnType<typeof setInterval> | null = null;
  private corte: ReturnType<typeof setTimeout> | null = null;

  // ── Lo que se oye ─────────────────────────────────────────────────────────

  private audio: HTMLAudioElement | null = null;
  private fuente: MediaSource | null = null;
  private buffer: SourceBuffer | null = null;
  private readonly cola: ArrayBuffer[] = [];
  private transmision = '';

  /**
   * Si este navegador puede hacerlo.
   *
   * Se pregunta por las dos mitades —grabar y reproducir sobre la marcha—
   * porque tener una sin la otra no sirve de nada: se podría hablar y no oír, o
   * al revés.
   */
  sePuede(): boolean {
    if (typeof window === 'undefined') return false;

    const graba =
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== 'undefined' &&
      MediaRecorder.isTypeSupported?.(FORMATO);

    const suena =
      typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported?.(FORMATO);

    return !!graba && !!suena;
  }

  // ── Hablar ────────────────────────────────────────────────────────────────

  /**
   * Empieza a transmitir. Cada porción se entrega a `alTrozo`.
   *
   * Devuelve `false` si no se pudo: sin micrófono, sin permiso, o porque este
   * navegador no sirve. No lanza — que no se pueda hablar no puede tumbar el
   * chat.
   */
  async empezar(alTrozo: (trozo: ArrayBuffer) => void, alTope: () => void): Promise<boolean> {
    if (this.hablando() || !this.sePuede()) return false;

    try {
      const pista = await navigator.mediaDevices.getUserMedia({ audio: true });

      this.grabadora = new MediaRecorder(pista, { mimeType: FORMATO });

      this.grabadora.ondataavailable = (e) => {
        if (!e.data?.size) return;

        // `arrayBuffer()` es asíncrono: las porciones podrían adelantarse entre
        // sí. Se encadenan para que salgan en el orden en que se grabaron, que
        // es lo único que permite pegarlas al otro lado.
        this.enOrden = this.enOrden
          .then(() => e.data.arrayBuffer())
          .then((datos) => alTrozo(datos))
          .catch(() => undefined);
      };

      this.grabadora.start(CADA_MS);
      this.hablando.set(true);
      this.segundos.set(0);

      this.reloj = setInterval(() => this.segundos.update((n) => n + 1), 1000);

      /*
       * Y se corta solo al llegar al tope.
       *
       * Quien habla no mira el contador: está hablando. Sin esto, un botón que
       * se queda pulsado en un bolsillo transmite hasta que se acabe la
       * batería, y de paso deja la sala muda para todos los demás.
       */
      this.corte = setTimeout(() => {
        this.parar();
        alTope();
      }, TOPE_DE_SEGUNDOS * 1000);

      return true;
    } catch {
      this.limpiarGrabacion();

      return false;
    }
  }

  /** Encadena las porciones para que salgan en orden. Ver `empezar`. */
  private enOrden: Promise<void> = Promise.resolve();

  /** Deja de transmitir. */
  parar(): void {
    const grabadora = this.grabadora;
    if (!grabadora) return;

    try {
      grabadora.stop();
    } catch {
      // Ya estaba parada.
    }

    // El micrófono se suelta siempre: dejarlo abierto deja encendido el
    // indicador de grabación del navegador y del sistema, y eso alarma con
    // razón.
    for (const via of grabadora.stream?.getTracks() ?? []) via.stop();

    this.limpiarGrabacion();
  }

  private limpiarGrabacion(): void {
    if (this.reloj) clearInterval(this.reloj);
    if (this.corte) clearTimeout(this.corte);

    this.reloj = null;
    this.corte = null;
    this.grabadora = null;

    this.hablando.set(false);
    this.segundos.set(0);
  }

  // ── Oír ───────────────────────────────────────────────────────────────────

  /**
   * Prepara el reproductor para una transmisión que empieza.
   *
   * Se monta **antes** de que llegue la primera porción: hacerlo al recibirla
   * significa perderse el principio, que en un walkie suele ser el nombre de a
   * quién se llama.
   */
  empiezaAOir(id: string): void {
    this.cortarLoQueSuena();

    this.transmision = id;
    this.fuente = new MediaSource();
    this.audio = new Audio(URL.createObjectURL(this.fuente));

    this.fuente.addEventListener('sourceopen', () => {
      try {
        this.buffer = this.fuente!.addSourceBuffer(FORMATO);
        this.buffer.addEventListener('updateend', () => this.vaciarCola());

        this.vaciarCola();
      } catch {
        this.cortarLoQueSuena();
      }
    });

    this.oyendo.set(true);
  }

  /** Una porción que llega. Se pega a lo que ya está sonando. */
  oyeTrozo(id: string, trozo: ArrayBuffer): void {
    /*
     * Lo de otra transmisión se tira.
     *
     * Pasa al soltar y volver a pulsar enseguida: llegan porciones de la
     * anterior cuando ya empezó la siguiente. Pegarlas mezclaría dos voces en
     * un mismo flujo y no se entendería ninguna.
     */
    if (id !== this.transmision) return;

    this.cola.push(trozo);
    this.vaciarCola();
  }

  /** La transmisión terminó: se deja sonar lo que queda y se cierra. */
  terminaDeOir(id: string): void {
    if (id !== this.transmision) return;

    this.finPedido = true;
    this.vaciarCola();
  }

  private finPedido = false;

  /**
   * Mete en el reproductor lo que haya en la cola.
   *
   * De una en una: `SourceBuffer` solo admite una porción a la vez y avisa con
   * `updateend` cuando puede recibir la siguiente. Empujar sin esperar lanza un
   * error y corta el audio.
   */
  private vaciarCola(): void {
    const buffer = this.buffer;
    if (!buffer || buffer.updating) return;

    const trozo = this.cola.shift();

    if (!trozo) {
      // Nada pendiente: si ya se pidió el final, se cierra.
      if (this.finPedido && this.fuente?.readyState === 'open') {
        try {
          this.fuente.endOfStream();
        } catch {
          // Ya estaba cerrado.
        }
      }

      return;
    }

    try {
      buffer.appendBuffer(trozo);
    } catch {
      // Una porción que no encaja no puede dejar muda la transmisión entera:
      // se descarta y se sigue con la siguiente.
      this.vaciarCola();

      return;
    }

    /*
     * Se empieza a sonar cuando hay colchón.
     *
     * `play()` en la primera porción suena medio segundo y se queda esperando:
     * el audio se entrecorta desde el principio y parece que la red va mal
     * cuando lo que falta es margen.
     */
    const audio = this.audio;

    if (audio?.paused && (this.fuente?.duration ?? 0) * 1000 >= COLCHON_MS) {
      void audio.play().catch(() => undefined);
    }
  }

  /** Corta lo que esté sonando y suelta todo. */
  cortarLoQueSuena(): void {
    this.cola.length = 0;
    this.finPedido = false;
    this.transmision = '';

    try {
      this.audio?.pause();

      if (this.audio?.src) URL.revokeObjectURL(this.audio.src);
    } catch {
      // Da igual: se está soltando.
    }

    this.audio = null;
    this.buffer = null;
    this.fuente = null;

    this.oyendo.set(false);
  }
}
