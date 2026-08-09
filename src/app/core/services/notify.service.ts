import { Injectable, inject, signal } from '@angular/core';

import { AlertSoundService } from './alert-sound.service';
import { ToastService } from './toast.service';

/**
 * Icono que acompaña a la notificación del sistema.
 *
 * El favicon porque es lo único que hay hoy en `public/`. Si algún día se
 * agregan iconos de aplicación, este es el sitio donde cambiarlo.
 */
const ICON = '/favicon.ico';

/**
 * Avisos que tienen que llegar aunque no se esté mirando la aplicación.
 *
 * ## Por qué no basta con un aviso dentro de la pantalla
 *
 * La subida de actividades corre sola cada quince minutos. Cuando termina, casi
 * nunca hay nadie mirando esta pestaña: el usuario está en el correo, en otra
 * aplicación, o el navegador está minimizado. Un aviso que solo vive dentro de
 * la página se muestra y se va sin que nadie lo vea, y la pregunta que quedaba
 * sin responder —*¿ya subió lo que tenía pendiente?*— sigue sin responderse.
 *
 * ## La regla
 *
 * - **Con la pestaña a la vista** se usa el aviso de dentro: es donde está
 *   mirando el usuario, y una notificación del sistema encima de la aplicación
 *   que ya lo está diciendo sobra.
 * - **Con la pestaña oculta** se usa la del sistema, si hay permiso.
 * - **Sin permiso** queda el aviso de dentro, que seguirá ahí al volver.
 *
 * ## El permiso se pide en un gesto, no al arrancar
 *
 * Pedirlo nada más abrir la aplicación es la forma más rápida de que lo
 * denieguen: nadie concede lo que no sabe para qué es. Se pide la primera vez
 * que alguien pulsa «Subir ahora», que es justo cuando la respuesta a *¿para
 * qué?* está a la vista.
 */
@Injectable({ providedIn: 'root' })
export class NotifyService {
  private readonly toast = inject(ToastService);
  private readonly sound = inject(AlertSoundService);

  /** Si el navegador admite notificaciones del sistema. */
  readonly supported = typeof Notification !== 'undefined';

  /** Estado del permiso, para poder enseñarlo en la interfaz. */
  readonly permission = signal<NotificationPermission | 'unsupported'>(
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
  );

  /**
   * Pide el permiso. Hay que llamarlo desde un gesto del usuario.
   *
   * @returns si quedó concedido.
   */
  async enable(): Promise<boolean> {
    if (!this.supported) return false;

    // Denegado no se vuelve a preguntar: el navegador ya no muestra el diálogo
    // y el usuario tendría que cambiarlo desde la configuración del sitio.
    if (Notification.permission !== 'default') {
      this.permission.set(Notification.permission);
      return Notification.permission === 'granted';
    }

    try {
      const result = await Notification.requestPermission();

      this.permission.set(result);
      return result === 'granted';
    } catch (error) {
      console.warn('[Avisos] no se pudo pedir el permiso', error);
      return false;
    }
  }

  /**
   * Anuncia algo que salió bien: suena y se ve.
   *
   * @param title  qué pasó, en pocas palabras.
   * @param detail el detalle, si lo hay.
   */
  async success(title: string, detail = ''): Promise<void> {
    void this.sound.success();
    this.show(title, detail, 'success');
  }

  /** Lo mismo, para algo que salió mal. */
  async failure(title: string, detail = ''): Promise<void> {
    void this.sound.warn();
    this.show(title, detail, 'error');
  }

  /**
   * Dónde se enseña el aviso.
   *
   * El `tag` reemplaza la notificación anterior en vez de apilar una por
   * corrida: al volver al equipo después de una hora, seis avisos idénticos de
   * subida no dicen más que uno.
   */
  private show(title: string, detail: string, tone: 'success' | 'error'): void {
    const hidden = typeof document !== 'undefined' && document.hidden;

    if (hidden && this.supported && Notification.permission === 'granted') {
      try {
        new Notification(title, { body: detail, icon: ICON, tag: 'vt-sync' });
        return;
      } catch (error) {
        // Algunos navegadores solo permiten crearlas desde el service worker.
        // Si falla, queda el aviso de dentro, que es el que verá al volver.
        console.warn('[Avisos] no se pudo mostrar la notificación', error);
      }
    }

    if (tone === 'success') this.toast.success(title, detail);
    else this.toast.error(title, detail);
  }
}
