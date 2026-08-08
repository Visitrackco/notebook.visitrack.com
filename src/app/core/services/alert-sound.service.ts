import { Injectable } from '@angular/core';

/** Dónde se busca el sonido, si alguien deja uno propio. */
const SOUND_URL = 'sounds/alert.mp3';

/** Preferencia guardada. Ausente significa «con sonido». */
const MUTED_KEY = 'vt.sound.muted';

/**
 * El aviso sonoro de que falta algo por responder.
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
 * Si existe `public/sounds/alert.mp3` se usa ese, para que cada instalación
 * pueda poner el suyo. Si no, el tono se **sintetiza**: dos notas cortas
 * descendentes, que es como suena una advertencia sin resultar alarmante.
 * Depender solo del archivo significaría que el aviso desaparece en silencio el
 * día que alguien lo borre del despliegue, y nadie se enteraría.
 *
 * ## Sobre el permiso del navegador
 *
 * Los navegadores no dejan sonar nada hasta que el usuario ha interactuado con
 * la página. Aquí no es problema: el aviso siempre nace de pulsar «Guardar».
 */
@Injectable({ providedIn: 'root' })
export class AlertSoundService {
  /** El archivo, si lo hay. `null` mientras no se ha intentado. */
  private buffer: AudioBuffer | null = null;
  private context: AudioContext | null = null;

  /** Ya se intentó cargar el archivo (haya salido bien o no). */
  private loaded = false;

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
   * Suena el aviso de que llegó algo.
   *
   * Dos notas **ascendentes**, al revés que la advertencia: la dirección del
   * tono es lo que distingue «tienes trabajo nuevo» de «te falta algo», sin
   * que nadie tenga que aprenderse ningún sonido.
   */
  async notify(): Promise<void> {
    if (this.muted) return;

    try {
      const context = this.ensureContext();
      if (context.state === 'suspended') await context.resume();

      this.play(context, [
        { freq: 587, at: 0 },
        { freq: 880, at: 0.14 },
      ]);
    } catch (error) {
      console.warn('[Sonido] no se pudo reproducir el aviso', error);
    }
  }

  /** Suena el aviso de obligatorios sin responder. */
  async warn(): Promise<void> {
    if (this.muted) return;

    try {
      const context = this.ensureContext();

      // Suspendido tras una pausa del navegador: sin reanudarlo, todo lo que
      // se programe no suena y no hay ningún error que lo delate.
      if (context.state === 'suspended') await context.resume();

      await this.load(context);

      if (this.buffer) {
        const source = context.createBufferSource();
        source.buffer = this.buffer;
        source.connect(context.destination);
        source.start();
        return;
      }

      this.synthesize(context);
    } catch (error) {
      // Que no suene nunca puede impedir guardar: el aviso visual sigue ahí.
      console.warn('[Sonido] no se pudo reproducir el aviso', error);
    }
  }

  private ensureContext(): AudioContext {
    this.context ??= new AudioContext();
    return this.context;
  }

  private async load(context: AudioContext): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;

    try {
      const response = await fetch(SOUND_URL);
      if (!response.ok) return;

      this.buffer = await context.decodeAudioData(await response.arrayBuffer());
    } catch {
      // No hay archivo: se usa el tono sintetizado.
    }
  }

  /**
   * Dos notas cortas descendentes.
   *
   * Una onda triangular y no cuadrada: la cuadrada es estridente en el altavoz
   * de un teléfono. El volumen entra y sale con una rampa —nunca de golpe—
   * porque un corte seco produce un chasquido audible.
   */
  private synthesize(context: AudioContext): void {
    this.play(context, [
      { freq: 660, at: 0 },
      { freq: 440, at: 0.18 },
    ]);
  }

  /** Toca una secuencia corta de notas. */
  private play(context: AudioContext, notes: { freq: number; at: number }[]): void {
    const start = context.currentTime;

    for (const note of notes) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();

      oscillator.type = 'triangle';
      oscillator.frequency.value = note.freq;

      const from = start + note.at;
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
