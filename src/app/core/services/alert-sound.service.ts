import { Injectable } from '@angular/core';

import type { SonidoDeAviso } from '../forms/flujo-modelo';

/** Preferencia guardada. Ausente significa «con sonido». */
const MUTED_KEY = 'vt.sound.muted';

/** Los sonidos que de verdad suenan: `ninguno` es la ausencia de sonido. */
type SonidoQueSuena = Exclude<SonidoDeAviso, 'ninguno'>;

/**
 * Las notas de cada sonido. La forma es lo que los distingue, no el timbre.
 *
 * - **info**: dos notas **subiendo**. Neutro, corto, no reclama nada.
 * - **ok**: una tríada mayor —do, mi, sol— y **tres** notas en vez de dos. El
 *   número es lo que lo separa del resto sin tener que mirar la pantalla.
 * - **alerta**: dos notas **bajando**. La dirección del tono es lo que dice
 *   «algo va mal» sin que nadie tenga que aprenderse ningún sonido.
 */
const NOTAS: Record<SonidoQueSuena, { freq: number; at: number }[]> = {
  info: [
    { freq: 587, at: 0 },
    { freq: 880, at: 0.14 },
  ],
  ok: [
    { freq: 523, at: 0 },
    { freq: 659, at: 0.1 },
    { freq: 784, at: 0.2 },
  ],
  alerta: [
    { freq: 660, at: 0 },
    { freq: 440, at: 0.18 },
  ],
};

/**
 * Dónde se busca el archivo de cada sonido, si alguien deja uno propio.
 *
 * La alerta acepta además el nombre viejo, `alert.mp3`: era el único que había
 * y hay despliegues que ya lo tienen puesto. Renombrarlo dejaría muda una
 * instalación que hoy suena, y nadie relacionaría el silencio con esto.
 */
const ARCHIVOS: Record<SonidoQueSuena, string[]> = {
  info: ['sounds/info.mp3'],
  ok: ['sounds/ok.mp3'],
  alerta: ['sounds/alerta.mp3', 'sounds/alert.mp3'],
};

/**
 * Cuánto tiene que pasar para repetir el mismo sonido, en milisegundos.
 *
 * Cuatro avisos que aparecen a la vez —lo normal al abrir un formulario con
 * varias reglas— sonarían como un atropello, y de eso no se entiende nada. Se
 * oye el primero y los demás salen callados: la información está en la
 * pantalla, el sonido solo sirve para que se mire.
 */
const ESPERA_ENTRE_IGUALES = 700;

/**
 * Los sonidos de la aplicación.
 *
 * ## Por qué suena
 *
 * En campo, el teléfono o la tableta van en la mano y la pantalla se mira a
 * ratos: se pulsa «Guardar», se levanta la vista y se da por hecho que quedó
 * registrado. Un aviso que solo es visual se pierde justo en ese momento — y lo
 * que se pierde con él es una actividad incompleta que nadie va a volver a
 * abrir.
 *
 * ## Por qué hay dos formas de sonar
 *
 * Si existe el archivo —`public/sounds/ok.mp3` y compañía— se usa ese, para que
 * cada instalación pueda poner el suyo. Si no, el tono se **sintetiza**.
 * Depender solo del archivo significaría que el aviso desaparece en silencio el
 * día que alguien lo borre del despliegue, y nadie se enteraría.
 *
 * ## Por qué son tres y no uno por cada cosa que pasa
 *
 * Un sonido solo sirve si se reconoce sin pensarlo. Con tres se distingue «va
 * bien», «ojo con esto» y «entérate»; con seis parecidos no se distingue
 * ninguno y la gente acaba silenciando la aplicación entera, que es peor que no
 * tener sonido: entonces tampoco se oye lo que sí importaba. Por eso el error y
 * la alerta comparten el suyo.
 *
 * ## Sobre el permiso del navegador
 *
 * Los navegadores no dejan sonar nada hasta que quien mira ha interactuado con
 * la página. Casi nunca estorba —los avisos nacen de pulsar algo— pero uno que
 * salga nada más abrir puede quedarse mudo. No se compensa de ninguna manera:
 * es el navegador protegiendo a quien lo usa, y forzarlo no está en nuestra
 * mano.
 */
@Injectable({ providedIn: 'root' })
export class AlertSoundService {
  /** El archivo de cada sonido, si lo hay. Ausente: todavía no se intentó. */
  private readonly buffers = new Map<string, AudioBuffer | null>();

  private context: AudioContext | null = null;

  /** Cuándo sonó cada uno por última vez. Ver [ESPERA_ENTRE_IGUALES]. */
  private readonly ultimaVez = new Map<string, number>();

  get muted(): boolean {
    try {
      return localStorage.getItem(MUTED_KEY) === '1';
    } catch {
      return false;
    }
  }

  set muted(value: boolean) {
    try {
      localStorage.setItem(MUTED_KEY, value ? '1' : '0');
    } catch {
      // Sin almacenamiento —modo privado, permisos— el sonido queda encendido,
      // que es el comportamiento por omisión.
    }
  }

  /**
   * Suena lo que se pida.
   *
   * Es la única puerta: los tres atajos de abajo pasan por aquí. Nunca lanza
   * hacia arriba —que no suene no puede impedir guardar ni avisar— y el aviso
   * visual sigue estando de todas formas.
   */
  async sonar(sonido: SonidoDeAviso): Promise<void> {
    if (sonido === 'ninguno' || this.muted) return;

    // El mismo sonido dos veces seguidas es uno: ver [ESPERA_ENTRE_IGUALES].
    const ahora = Date.now();
    if (ahora - (this.ultimaVez.get(sonido) ?? 0) < ESPERA_ENTRE_IGUALES) return;
    this.ultimaVez.set(sonido, ahora);

    try {
      const context = this.ensureContext();

      // Suspendido tras una pausa del navegador: sin reanudarlo, todo lo que se
      // programe no suena y no hay ningún error que lo delate.
      if (context.state === 'suspended') await context.resume();

      const archivo = await this.archivoDe(context, sonido);

      if (archivo) {
        const source = context.createBufferSource();
        source.buffer = archivo;
        source.connect(context.destination);
        source.start();
        return;
      }

      this.tocar(context, NOTAS[sonido]);
    } catch (error) {
      console.warn('[Sonido] no se pudo reproducir', sonido, error);
    }
  }

  /** Llegó algo: dos notas subiendo. */
  notify(): Promise<void> {
    return this.sonar('info');
  }

  /** Salió bien: la tríada. */
  success(): Promise<void> {
    return this.sonar('ok');
  }

  /** Falta algo, o algo salió mal: dos notas bajando. */
  warn(): Promise<void> {
    return this.sonar('alerta');
  }

  private ensureContext(): AudioContext {
    this.context ??= new AudioContext();
    return this.context;
  }

  /** El archivo propio de la instalación, si lo dejaron puesto. */
  private async archivoDe(
    context: AudioContext,
    sonido: SonidoQueSuena,
  ): Promise<AudioBuffer | null> {
    if (this.buffers.has(sonido)) return this.buffers.get(sonido) ?? null;

    // Se apunta antes de buscarlo: si no hay archivo, no se vuelve a pedir en
    // cada aviso. Un 404 por mensaje llenaría de ruido la consola y la red.
    this.buffers.set(sonido, null);

    for (const url of ARCHIVOS[sonido]) {
      try {
        const response = await fetch(url);
        if (!response.ok) continue;

        const buffer = await context.decodeAudioData(await response.arrayBuffer());

        this.buffers.set(sonido, buffer);
        return buffer;
      } catch {
        // No está, o no se pudo descifrar: se prueba el siguiente nombre y, si
        // no queda ninguno, se sintetiza.
      }
    }

    return null;
  }

  /**
   * Toca una secuencia corta de notas.
   *
   * Una onda triangular y no cuadrada: la cuadrada es estridente en el altavoz
   * de un teléfono. El volumen entra y sale con una rampa —nunca de golpe—
   * porque un corte seco produce un chasquido audible.
   */
  private tocar(context: AudioContext, notas: { freq: number; at: number }[]): void {
    const start = context.currentTime;

    for (const nota of notas) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();

      oscillator.type = 'triangle';
      oscillator.frequency.value = nota.freq;

      const from = start + nota.at;
      const to = from + 0.16;

      gain.gain.setValueAtTime(0, from);
      gain.gain.linearRampToValueAtTime(0.18, from + 0.02);
      gain.gain.linearRampToValueAtTime(0, to);

      oscillator.connect(gain).connect(context.destination);
      oscillator.start(from);
      oscillator.stop(to + 0.02);
    }
  }
}
