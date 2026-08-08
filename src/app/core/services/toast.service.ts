import { Injectable, signal } from '@angular/core';

/** Qué se está contando. Define el color de la marca y el icono. */
export type ToastTone = 'info' | 'success' | 'warning' | 'error';

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
    };

    this.items.update((current) => [...current, toast]);

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
