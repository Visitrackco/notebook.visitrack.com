import { Injectable, inject, signal } from '@angular/core';

import { SONIDO_DEL_TONO, SonidoDeAviso, TonoDeAviso } from '../forms/flujo-modelo';
import { AlertSoundService } from './alert-sound.service';

/** Qué se está contando. Define el color de la marca, el icono y el sonido. */
export type ToastTone = 'info' | 'success' | 'warning' | 'error';

/**
 * Qué suena en cada clase de aviso.
 *
 * Que **todos** suenen, y no solo unos pocos elegidos a mano, es a propósito: en
 * campo la pantalla se mira a ratos, y un mensaje que solo se ve es un mensaje
 * que se pierde. El que tenga que salir callado lo pide con `sonido: 'ninguno'`.
 *
 * El aviso y el error comparten sonido porque son tres y no cuatro; ver
 * `AlertSoundService` para el porqué.
 */
const SONIDO_DEL_TOAST: Record<ToastTone, SonidoDeAviso> = {
  info: 'info',
  success: 'ok',
  warning: 'alerta',
  error: 'alerta',
};

/**
 * Cómo se ve en pantalla el tono que decidió una regla del flujo.
 *
 * Son dos vocabularios distintos a propósito: el del motor describe **qué clase
 * de mensaje es** —lo decide quien diseña el flujo— y el de aquí describe cómo
 * se pinta. Traducir en un solo sitio evita que cada pantalla se invente la
 * suya.
 */
export function toneDelTono(tono: TonoDeAviso): ToastTone {
  switch (tono) {
    case 'ok':
      return 'success';

    case 'alerta':
      return 'warning';

    case 'error':
      return 'error';

    default:
      return 'info';
  }
}

/** El sonido que le toca a un tono del flujo. */
export function sonidoDelTono(tono: TonoDeAviso): SonidoDeAviso {
  return SONIDO_DEL_TONO[tono] ?? 'info';
}

/** Un aviso en pantalla. */
export interface Toast {
  id: number;
  title: string;

  /** Detalle: qué llegó exactamente, cuántos archivos, de dónde. */
  detail?: string;

  tone: ToastTone;
  icon: string;

  /** Botón opcional a la derecha. */
  action?: { label: string; run: () => void };

  /** Cuánto se queda. `0` lo deja hasta que se cierre a mano. */
  duration: number;

  /**
   * Qué suena al salir. Vacío significa el que le toca al tono.
   *
   * `'ninguno'` lo deja mudo: para el que acompaña a otro que ya sonó, o el que
   * se repite en cada página y acabaría cansando.
   */
  sonido?: SonidoDeAviso;
}

/** Cuánto dura por omisión. */
const DEFAULT_MS = 8000;

/**
 * Avisos emergentes.
 *
 * ## Para qué
 *
 * Contar lo que pasó **fuera de la pantalla que se está mirando**: una
 * sincronización que trajo consignas nuevas, unos archivos que terminaron de
 * descargarse. Sin esto, el usuario se entera al entrar en la pantalla
 * correspondiente — que es justo lo que no hace si no sabe que hay algo nuevo.
 *
 * ## Por qué no un diálogo
 *
 * Un diálogo interrumpe y exige responder. Esto es información, no una
 * pregunta: aparece abajo, se lee de reojo y se va solo. Solo lleva botón
 * cuando hay algo concreto que hacer con lo que se está contando.
 *
 * ## Se apilan, no se pisan
 *
 * Dos avisos seguidos —consignas nuevas y archivos descargados— son dos cosas
 * distintas, y reemplazar el primero por el segundo perdería la mitad de lo que
 * hay que contar.
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly sound = inject(AlertSoundService);

  private readonly items = signal<Toast[]>([]);

  readonly toasts = this.items.asReadonly();

  private nextId = 1;

  show(input: Omit<Toast, 'id' | 'icon' | 'duration'> & { icon?: string; duration?: number }): void {
    const toast: Toast = {
      id: this.nextId++,
      title: input.title,
      detail: input.detail,
      tone: input.tone,
      icon: input.icon ?? iconOf(input.tone),
      action: input.action,
      duration: input.duration ?? DEFAULT_MS,
      sonido: input.sonido,
    };

    this.items.update((current) => [...current, toast]);

    /*
     * Suena, y no se espera a que suene.
     *
     * El aviso tiene que aparecer aunque el navegador no deje reproducir nada
     * —pasa hasta que quien mira ha pulsado algo en la página— y aunque el
     * archivo tarde: lo que informa es el texto, el sonido solo hace que se
     * mire. Encadenarlos dejaría el mensaje esperando por el altavoz.
     */
    void this.sound.sonar(toast.sonido ?? SONIDO_DEL_TOAST[toast.tone]);

    if (toast.duration > 0) {
      setTimeout(() => this.dismiss(toast.id), toast.duration);
    }
  }

  /** Atajo para lo más común. */
  info(title: string, detail?: string): void {
    this.show({ title, detail, tone: 'info' });
  }

  success(title: string, detail?: string): void {
    this.show({ title, detail, tone: 'success' });
  }

  error(title: string, detail?: string): void {
    this.show({ title, detail, tone: 'error' });
  }

  /** Para lo que no está mal pero hay que mirar. */
  warning(title: string, detail?: string): void {
    this.show({ title, detail, tone: 'warning' });
  }

  dismiss(id: number): void {
    this.items.update((current) => current.filter((toast) => toast.id !== id));
  }
}

function iconOf(tone: ToastTone): string {
  switch (tone) {
    case 'success':
      return 'check';

    case 'warning':
    case 'error':
      return 'alert';

    default:
      return 'info';
  }
}
