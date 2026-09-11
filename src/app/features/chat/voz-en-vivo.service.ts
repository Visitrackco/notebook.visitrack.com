import { Injectable, signal } from '@angular/core';

/** Lo que dura como mucho una transmisión. El servidor la corta igual. */
export const TOPE_DE_SEGUNDOS = 20;

/**
 * Cómo viaja el audio, dicho a quien escucha.
 *
 * Sonido en crudo: enteros de 16 bits con signo, un solo canal, en el orden de
 * bytes de la máquina —que en todo lo que existe hoy es el pequeño primero—.
 * Viaja en el aviso de que alguien empieza a hablar porque de esto depende cómo
 * se decodifica, y un teléfono y un navegador podrían no mandar lo mismo.
 */
export const FORMATO = 'pcm16';

/**
 * A cuántas muestras por segundo.
 *
 * Dieciséis mil es el estándar de la voz: por encima solo se gana lo que hace
 * falta para música, y cada paso de calidad se paga en tráfico sobre una red
 * móvil. A esta frecuencia un cuarto de segundo de voz son ocho kilobytes.
 */
const FRECUENCIA = 16000;

/**
 * Cuánto sonido se junta antes de mandarlo.
 *
 * Es el compromiso de todo esto. Más corto llega antes pero multiplica los
 * paquetes, y la cabecera de cada uno acaba pesando más que el sonido que
 * lleva; más largo ahorra tráfico y se nota como retraso al hablar. Cuatro mil
 * noventa y seis muestras son unos 256 ms, que es lo que usan las aplicaciones
 * que hacen esto y lo que aguanta una red mala.
 */
const MUESTRAS = 4096;

/**
 * Cuánto se acumula antes de empezar a sonar.
 *
 * Sin colchón, la primera porción que se retrase deja un hueco audible y el
 * audio se corta. Con medio segundo se absorbe el vaivén normal de una red sin
 * que la conversación se sienta lenta.
 */
const COLCHON = 0.5;

/**
 * Si se pierde más que esto, se vuelve a empezar en vez de acumular retraso.
 *
 * Cuando la red se atasca y luego suelta todo de golpe, las porciones se
 * agendan una detrás de otra y la voz acaba sonando varios segundos tarde: se
 * oye entera, pero ya no sirve para hablar. Pasado este margen se descarta lo
 * atrasado y se sigue desde ahora — en un walkie vale más perderse media
 * palabra que responder a destiempo.
 */
const RETRASO_MAXIMO = 2;

/** El `AudioContext` de Safari, que todavía va con prefijo. */
type ConAudio = typeof globalThis & {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
};

function claseDeAudio(): typeof AudioContext | undefined {
  const w = globalThis as ConAudio;

  return w.AudioContext ?? w.webkitAudioContext;
}

/**
 * El walkie-talkie en vivo: se oye **mientras** se habla.
 *
 * ## Cómo funciona, y por qué así
 *
 * Se captura sonido en crudo en porciones de un cuarto de segundo que salen por
 * el socket según se generan, y quien escucha las agenda una detrás de otra en
 * su tarjeta de sonido. La latencia queda alrededor de un segundo: el colchón,
 * la red y poco más.
 *
 * ## Por qué en crudo y no comprimido
 *
 * Porque **es lo único que hablan todos**. Antes esto grababa `webm/opus` con
 * `MediaRecorder` y lo pegaba con `MediaSource`, y eso traía dos problemas que
 * no se arreglan por separado:
 *
 * - **Safari no puede.** Ni grabar `webm` ni reproducirlo sobre la marcha. La
 *   función entera quedaba fuera en todos los iPhone.
 * - **El teléfono tampoco.** La aplicación de campo graba con las herramientas
 *   del sistema, que no producen fragmentos de `webm` pegables. Con el chat en
 *   el móvil, un formato que solo entienden dos navegadores deja de servir.
 *
 * En crudo no hay contenedor, ni cabecera, ni códec: cada porción vale por sí
 * sola y cualquiera la entiende. Cuesta tráfico —unos 32 kB por segundo— y a
 * cambio funciona en todas partes, que para veinte segundos de voz es el
 * cambio que compensa.
 */
@Injectable({ providedIn: 'root' })
export class VozEnVivoService {
  /** Si se está hablando ahora mismo, y cuánto se lleva. */
  readonly hablando = signal(false);
  readonly segundos = signal(0);

  /** Si está sonando alguien. */
  readonly oyendo = signal(false);

  /**
   * Que tan fuerte se esta hablando, de 0 a 1.
   *
   * Se mide aqui porque el sonido pasa por aqui y por ningun otro sitio, y asi
   * se mide una vez aunque lo miren tres pantallas. Es lo que mueve el circulo
   * de la pantalla de transmision: sin una senal del microfono, esa pantalla
   * diria «transmitiendo» igual con el microfono tapado, que es justo el error
   * que no puede pasar desapercibido.
   */
  readonly nivel = signal(0);

  // ── Lo que se habla ───────────────────────────────────────────────────────

  private micro: MediaStream | null = null;
  private ctxHabla: AudioContext | null = null;
  private nodo: ScriptProcessorNode | null = null;
  private reloj: ReturnType<typeof setInterval> | null = null;
  private corte: ReturnType<typeof setTimeout> | null = null;

  // ── Lo que se oye ─────────────────────────────────────────────────────────

  private ctxOye: AudioContext | null = null;
  private cursor = 0;
  private transmision = '';

  /**
   * Si este navegador puede hacerlo.
   *
   * Se pregunta por las dos mitades —capturar y reproducir— porque tener una
   * sin la otra no sirve de nada: se podría hablar y no oír, o al revés.
   *
   * Con sonido en crudo esto es que sí en todo lo que no sea un navegador de
   * hace diez años, Safari incluido.
   */
  sePuede(): boolean {
    if (typeof window === 'undefined') return false;

    return !!navigator.mediaDevices?.getUserMedia && !!claseDeAudio();
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
      this.micro = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Lo que trae cualquier aparato de manos libres, y lo que hace que se
          // entienda dentro de un coche o de una nave.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const Audio = claseDeAudio()!;

      /*
       * El contexto ya va a la frecuencia de salida.
       *
       * Pedirla aquí deja que el navegador remuestree por su cuenta lo que
       * entregue el micrófono —que suele ser 44.100 o 48.000— con su propio
       * código, que está mucho mejor hecho que cualquier cosa que se escriba a
       * mano aquí y no cuesta nada.
       */
      this.ctxHabla = new Audio({ sampleRate: FRECUENCIA });
      await this.ctxHabla.resume();

      const fuente = this.ctxHabla.createMediaStreamSource(this.micro);

      /*
       * `ScriptProcessorNode`, que está marcado como obsoleto desde hace años.
       *
       * Su relevo —`AudioWorklet`— corre en otro hilo y va mejor, pero necesita
       * cargarse desde un archivo aparte, y las páginas de esta aplicación se
       * sirven con una política que no deja traer código suelto. Para voz en
       * mono a 16 kHz la diferencia no se oye, y esto funciona hoy en todos los
       * navegadores. El día que haya que cambiarlo, solo cambia este trozo.
       */
      this.nodo = this.ctxHabla.createScriptProcessor(MUESTRAS, 1, 1);

      this.nodo.onaudioprocess = (e) => {
        const muestras = e.inputBuffer.getChannelData(0);

        this.medirElNivel(muestras);
        alTrozo(aEnteros(muestras));
      };

      /*
       * Y se conecta a un silencio, no a los altavoces.
       *
       * Un `ScriptProcessorNode` solo se ejecuta si su salida llega a algún
       * sitio, así que hay que enchufarlo. Enchufarlo a los altavoces
       * devolvería el micrófono por ellos: acoplamiento y pitido en cuanto
       * alguien hable sin auriculares.
       */
      const mudo = this.ctxHabla.createGain();
      mudo.gain.value = 0;

      fuente.connect(this.nodo);
      this.nodo.connect(mudo);
      mudo.connect(this.ctxHabla.destination);

      this.hablando.set(true);
      this.segundos.set(0);

      this.reloj = setInterval(() => this.segundos.update((n) => n + 1), 1000);

      /*
       * Y se corta solo al llegar al tope.
       *
       * Quien habla no mira el contador: está hablando. Sin esto, un botón que
       * se queda encendido en un bolsillo transmite hasta que se acabe la
       * batería, y de paso deja la sala muda para todos los demás.
       */
      this.corte = setTimeout(() => {
        this.parar();
        alTope();
      }, TOPE_DE_SEGUNDOS * 1000);

      return true;
    } catch {
      this.parar();

      return false;
    }
  }

  /**
   * Mide lo fuerte que viene esa porcion, para pintarla. Ver `nivel`.
   *
   * Se toma el valor medio en valor absoluto y no el pico: el pico salta con
   * cualquier golpe y hace parpadear el circulo sin relacion con lo que se esta
   * diciendo. La media sube y baja con la voz.
   *
   * Y se sube de golpe pero se baja despacio, que es lo que hace que se mueva
   * como se oye en vez de temblar entre silaba y silaba.
   */
  private medirElNivel(muestras: Float32Array): void {
    let suma = 0;
    let cuantas = 0;

    // Una de cada ocho: cuatro mil cuentas por porcion en vez de treinta y dos
    // mil, cuatro veces por segundo. Para mover un circulo no se nota.
    for (let i = 0; i < muestras.length; i += 8) {
      suma += Math.abs(muestras[i]);
      cuantas++;
    }

    if (!cuantas) return;

    const crudo = Math.min(1, (suma / cuantas) * 6);

    this.nivel.set(crudo > this.nivel() ? crudo : this.nivel() * 0.75 + crudo * 0.25);
  }

  /** Deja de transmitir. */
  parar(): void {
    if (this.reloj) clearInterval(this.reloj);
    if (this.corte) clearTimeout(this.corte);

    this.reloj = null;
    this.corte = null;

    if (this.nodo) {
      this.nodo.onaudioprocess = null;
      this.nodo.disconnect();
      this.nodo = null;
    }

    // El micrófono se suelta siempre: dejarlo abierto deja encendido el
    // indicador de grabación del navegador y del sistema, y eso alarma con
    // razón.
    for (const via of this.micro?.getTracks() ?? []) via.stop();
    this.micro = null;

    void this.ctxHabla?.close().catch(() => undefined);
    this.ctxHabla = null;

    this.hablando.set(false);
    this.segundos.set(0);
    this.nivel.set(0);
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

    const Audio = claseDeAudio();
    if (!Audio) return;

    this.transmision = id;
    this.ctxOye = new Audio({ sampleRate: FRECUENCIA });

    /*
     * El contexto puede nacer dormido.
     *
     * Los navegadores no dejan sonar nada hasta que la persona ha tocado la
     * página. Quien está en el chat ya la ha tocado, pero si no, esto falla en
     * silencio y no hay nada que hacer al respecto salvo no reventar.
     */
    void this.ctxOye.resume().catch(() => undefined);

    this.cursor = 0;
    this.oyendo.set(true);
  }

  /** Una porción que llega. Se agenda detrás de lo que ya está sonando. */
  oyeTrozo(id: string, trozo: ArrayBuffer): void {
    /*
     * Lo de otra transmisión se tira.
     *
     * Pasa al parar y volver a hablar enseguida: llegan porciones de la
     * anterior cuando ya empezó la siguiente. Agendarlas mezclaría dos voces en
     * el mismo hilo y no se entendería ninguna.
     */
    if (id !== this.transmision) return;

    const ctx = this.ctxOye;
    if (!ctx || !trozo.byteLength) return;

    try {
      const muestras = aDecimales(trozo);
      const bloque = ctx.createBuffer(1, muestras.length, FRECUENCIA);

      /*
       * Se copia sobre el canal, y no con `copyToChannel`.
       *
       * Hace lo mismo, pero `copyToChannel` exige que el `Float32Array` venga
       * de un `ArrayBuffer` y no de cualquier cosa parecida, y ese matiz del
       * comprobador de tipos cambia entre versiones. Esto no depende de eso.
       */
      bloque.getChannelData(0).set(muestras);

      const ahora = ctx.currentTime;

      // Lo atrasado se descarta en vez de agendarse detrás. Ver `RETRASO_MAXIMO`.
      if (this.cursor < ahora || this.cursor > ahora + RETRASO_MAXIMO) {
        this.cursor = ahora + COLCHON;
      }

      const fuente = ctx.createBufferSource();
      fuente.buffer = bloque;
      fuente.connect(ctx.destination);
      fuente.start(this.cursor);

      this.cursor += bloque.duration;
    } catch {
      // Una porción que no encaja no puede dejar muda la transmisión entera: se
      // descarta y se sigue con la siguiente.
    }
  }

  /** La transmisión terminó: se deja sonar lo que queda y se cierra. */
  terminaDeOir(id: string): void {
    if (id !== this.transmision) return;

    /*
     * Se espera a que termine lo agendado.
     *
     * Cerrar el contexto ahora cortaría el último segundo, que es el que
     * normalmente lleva el final de la frase. Lo que falta por sonar se sabe
     * exacto: es lo que va del cursor a ahora.
     */
    const falta = Math.max(0, this.cursor - (this.ctxOye?.currentTime ?? 0));

    this.transmision = '';
    this.oyendo.set(false);

    const ctx = this.ctxOye;
    this.ctxOye = null;

    setTimeout(() => void ctx?.close().catch(() => undefined), (falta + 0.2) * 1000);
  }

  /** Corta lo que esté sonando y suelta todo. */
  cortarLoQueSuena(): void {
    this.transmision = '';
    this.cursor = 0;

    void this.ctxOye?.close().catch(() => undefined);
    this.ctxOye = null;

    this.oyendo.set(false);
  }
}

/** De lo que da la tarjeta —decimales de -1 a 1— a enteros de 16 bits. */
function aEnteros(muestras: Float32Array): ArrayBuffer {
  const salida = new Int16Array(muestras.length);

  for (let i = 0; i < muestras.length; i++) {
    /*
     * Se recorta antes de convertir.
     *
     * Un valor por encima de uno —que pasa al hablar pegado al micrófono— se
     * saldría del entero y daría la vuelta al signo: en vez de saturar, el
     * sonido chasquea. Recortarlo suena a saturado, que es lo que la persona
     * espera cuando grita.
     */
    const v = Math.max(-1, Math.min(1, muestras[i]));

    salida[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }

  return salida.buffer as ArrayBuffer;
}

/** Y al revés, para poder reproducirlo. */
function aDecimales(trozo: ArrayBuffer): Float32Array {
  const enteros = new Int16Array(trozo);
  const salida = new Float32Array(enteros.length);

  for (let i = 0; i < enteros.length; i++) {
    salida[i] = enteros[i] / (enteros[i] < 0 ? 0x8000 : 0x7fff);
  }

  return salida;
}
