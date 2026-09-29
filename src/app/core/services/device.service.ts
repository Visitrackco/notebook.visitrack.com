import { Injectable } from '@angular/core';

/** Clave donde vive el identificador del navegador. */
const DEVICE_ID_KEY = 'visitrack.deviceId';

/**
 * Identidad del navegador frente al backend.
 *
 * El backend usa el `DeviceID` para saber a qué dispositivo entregarle cada
 * registro: la cola de sincronización se replica **por dispositivo**. Si el
 * identificador cambiara entre sesiones, el servidor creería que es un
 * dispositivo nuevo y volvería a entregar todo desde cero.
 *
 * Se guarda en `localStorage` y no en IndexedDB a propósito: hace falta antes
 * de abrir la base (para poder autenticar), y es un único valor sin estructura.
 */
@Injectable({ providedIn: 'root' })
export class DeviceService {
  /**
   * Identificador estable de este navegador.
   *
   * Se genera la primera vez y se reutiliza siempre. Borrar los datos del sitio
   * lo pierde, y entonces el servidor tratará al navegador como uno nuevo — es
   * el mismo comportamiento que reinstalar la app en el teléfono.
   */
  getDeviceId(): string {
    let id = localStorage.getItem(DEVICE_ID_KEY);

    if (!id) {
      id = this.generateId();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }

    return id;
  }

  /**
   * Descripción del navegador y el sistema, para mostrarla en el perfil y
   * poder identificar el equipo en soporte.
   */
  getDeviceInfo(): { browser: string; os: string; description: string } {
    const ua = navigator.userAgent;

    const browser = this.detectBrowser(ua);
    const os = this.detectOs(ua);

    return { browser, os, description: `${browser} · ${os}` };
  }

  /**
   * `web-` y 16 caracteres aleatorios: 20 en total.
   *
   * El identificador viaja a los registros de la base —`ChangesLog`,
   * `SurveysAnswers.Sync_LastUpdatedBy`, versiones— y varias de esas columnas
   * son cortas: con 20 cabe en todas sin recortarse. 16 caracteres
   * hexadecimales son 64 bits al azar, de sobra para no repetirse.
   *
   * Solo afecta a los navegadores **nuevos**: el que ya tiene uno guardado lo
   * conserva, porque cambiarlo haría que el servidor lo tratara como otro
   * equipo y volviera a entregarle todo desde cero.
   */
  private generateId(): string {
    const bytes = new Uint8Array(8);

    // getRandomValues está hasta en contextos no seguros; Math.random queda de
    // respaldo para entornos sin crypto.
    if (globalThis.crypto?.getRandomValues) {
      globalThis.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }

    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `web-${hex}`;
  }

  private detectBrowser(ua: string): string {
    // El orden importa: Edge y Opera incluyen "Chrome" en su user agent, y
    // Chrome incluye "Safari". Se comprueba de más específico a más genérico.
    if (ua.includes('Edg/')) return 'Edge';
    if (ua.includes('OPR/') || ua.includes('Opera')) return 'Opera';
    if (ua.includes('Firefox/')) return 'Firefox';
    if (ua.includes('Chrome/')) return 'Chrome';
    if (ua.includes('Safari/')) return 'Safari';
    return 'Navegador';
  }

  private detectOs(ua: string): string {
    if (ua.includes('Windows NT 10.0')) return 'Windows';
    if (ua.includes('Windows')) return 'Windows';
    if (ua.includes('Android')) return 'Android';
    if (ua.includes('iPhone') || ua.includes('iPad')) return 'iOS';
    if (ua.includes('Mac OS X')) return 'macOS';
    if (ua.includes('Linux')) return 'Linux';
    return 'Sistema desconocido';
  }
}
