import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';

/**
 * Estado de la conexión.
 *
 * ## Por qué no basta con `navigator.onLine`
 *
 * `navigator.onLine` solo dice si hay una interfaz de red activa. Devuelve
 * `true` con un wifi conectado que no llega a internet, con un portal cautivo
 * de hotel, o con VPN caída. Para una aplicación offline-first eso es
 * justamente el caso que importa: el usuario cree que está conectado, las
 * peticiones se cuelgan y nada explica por qué.
 *
 * Por eso se combinan dos señales:
 *  - `browserOnline`: lo que dice el navegador. Barato e inmediato.
 *  - `serverReachable`: si el backend respondió la última vez que se intentó.
 *
 * `isOnline` exige ambas. Un fallo de red marca el servidor como inalcanzable
 * sin esperar a la siguiente comprobación, así que la interfaz reacciona en el
 * mismo momento en que el usuario lo nota.
 */
@Injectable({ providedIn: 'root' })
export class ConnectivityService {
  private readonly destroyRef = inject(DestroyRef);

  /** Lo que reporta el navegador. */
  readonly browserOnline = signal(navigator.onLine);

  /**
   * Si el backend respondió la última vez. Empieza en `true` de forma optimista:
   * marcar todo como caído antes de intentar nada mostraría un aviso falso al
   * abrir la aplicación.
   */
  readonly serverReachable = signal(true);

  /** Última vez que el servidor respondió correctamente. */
  readonly lastServerContact = signal<Date | null>(null);

  /** Hay conexión utilizable de verdad. */
  readonly isOnline = computed(() => this.browserOnline() && this.serverReachable());

  /** Se trabaja sin conexión: los cambios se encolan. */
  readonly isOffline = computed(() => !this.isOnline());

  constructor() {
    const onOnline = () => {
      this.browserOnline.set(true);
      // El navegador recuperó la red, pero eso no garantiza que el servidor
      // responda. Se le da otra oportunidad y que el próximo intento decida.
      this.serverReachable.set(true);
    };

    const onOffline = () => this.browserOnline.set(false);

    globalThis.addEventListener('online', onOnline);
    globalThis.addEventListener('offline', onOffline);

    this.destroyRef.onDestroy(() => {
      globalThis.removeEventListener('online', onOnline);
      globalThis.removeEventListener('offline', onOffline);
    });
  }

  /** El servidor respondió. Lo llama el cliente HTTP tras cada éxito. */
  reportSuccess(): void {
    this.serverReachable.set(true);
    this.lastServerContact.set(new Date());
  }

  /**
   * Una petición falló por red o timeout.
   *
   * Solo debe llamarse ante fallos de transporte. Un 400 o un 401 significan
   * que el servidor está perfectamente vivo y respondió: marcar eso como
   * "sin conexión" mandaría al usuario a buscar un problema de red que no existe.
   */
  reportNetworkFailure(): void {
    this.serverReachable.set(false);
  }
}
