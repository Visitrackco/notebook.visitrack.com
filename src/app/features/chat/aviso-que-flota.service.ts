import { Injectable, signal } from '@angular/core';

import { MensajeDeSala } from './chat.api';

/**
 * Cuánto se queda un aviso antes de irse solo.
 *
 * Lo que se tarda en leer un nombre y media frase mirando de reojo. Más tiempo y
 * se convierte en algo que hay que quitar; menos y no da tiempo.
 */
const LO_QUE_DURA = 4200;

/**
 * Y cuánto, cuando hay más esperando.
 *
 * Con cola, cada aviso cede sitio antes: cinco mensajes a cuatro segundos son
 * veintiún segundos de burbujas subiendo, y para entonces quien las mira ya no
 * las lee, las aguanta. A la mitad se sigue leyendo el nombre y el principio de
 * la frase, que es a lo que vienen.
 */
const LO_QUE_DURA_CON_COLA = 2200;

/**
 * Cuántos avisos esperan turno como mucho.
 *
 * Cuando la sala se anima llegan quince mensajes en un minuto. Enseñarlos todos
 * convierte la pantalla en un desfile que no deja trabajar; para saber cuántos
 * quedan pendientes ya está el contador por sala.
 *
 * Al llenarse se tira **el más viejo de los que esperan**, nunca el que está
 * puesto: en una conversación lo último dicho es lo que importa, y descartar lo
 * nuevo para conservar lo viejo es justo al revés de lo que se quiere.
 */
const CUANTOS_CABEN = 4;

/** Lo que el aviso enseña en pantalla. */
export interface AvisoPuesto {
  /**
   * Distinta en cada aviso, incluso si el mensaje se repite.
   *
   * La plantilla la usa para rastrear el nodo: sin una clave que cambie, Angular
   * reaprovecha el elemento anterior y la animación no vuelve a arrancar — el
   * segundo aviso aparecía ya arriba y desvanecido, donde murió el primero.
   */
  clave: string;
  salaId: number;
  autor: string;
  inicial: string;
  resumen: string;
  duracionMs: number;
}

/**
 * La cola del aviso flotante del chat.
 *
 * ## Qué problema resuelve
 *
 * Antes esto era un toast de la pila general: un rectángulo abajo a la derecha,
 * ocho segundos, con la frase entera «Ana: ya llegué al punto» y un botón
 * «Abrir». Funcionaba, pero se apilaba sin tope —cinco mensajes eran cinco
 * rectángulos ocupando media columna durante ocho segundos— y se leía igual que
 * un error de guardado o un aviso de sesión: la misma caja para «se cayó la
 * sincronización» que para «te escribieron».
 *
 * Esto se distingue de un vistazo por la forma: redonda, con la inicial de quien
 * escribió, subiendo por el costado. No hay que leerla para saber qué es.
 *
 * ## Por qué una cola y no reemplazar ni apilar
 *
 * Reemplazando, con tres mensajes seguidos —lo normal cuando alguien escribe de
 * corrido— solo se llega a leer el último; los otros salen y desaparecen antes
 * de que la vista llegue a ellos, que es peor que no haberlos anunciado.
 * Apilando, tres burbujas a la vez tapan media ventana y hay que leerlas todas
 * de golpe. Una cada vez y en orden.
 *
 * ## Quién decide si un mensaje llega hasta aquí
 *
 * `ChatSocketService`, que es quien sabe de quién es el mensaje y qué sala está
 * en la dirección. Aquí solo se decide lo que depende de la ventana —ver
 * `laPestanaEstaDelante`— y el turno de cada uno.
 */
@Injectable({ providedIn: 'root' })
export class AvisoQueFlotaService {
  /** Los que esperan turno. El que está puesto ya salió de aquí. */
  private readonly cola: MensajeDeSala[] = [];

  private reloj: ReturnType<typeof setTimeout> | null = null;

  /** Para que dos mensajes iguales no compartan clave. Ver `AvisoPuesto`. */
  private cuantosVan = 0;

  /** El que se está viendo ahora, si hay alguno. */
  readonly puesto = signal<AvisoPuesto | null>(null);

  /**
   * Mete un mensaje en la cola y, si no había nada puesto, lo saca ya.
   *
   * Se llama solo con mensajes que ya pasaron el filtro de «no es mío y no es de
   * la sala que tengo delante».
   */
  encolar(m: MensajeDeSala): void {
    if (!this.laPestanaEstaDelante()) return;

    this.cola.push(m);

    // Y si se desborda, se va el más viejo de los que esperan. Ver
    // `CUANTOS_CABEN`.
    while (this.cola.length > CUANTOS_CABEN) this.cola.shift();

    if (!this.puesto()) this.mostrarElSiguiente();
  }

  /**
   * Se tocó el aviso: se va con toda la cola por delante.
   *
   * Tocarlo lleva a la sala, así que los que esperaban ya no tienen nada que
   * anunciar: seguirían saliendo encima de la conversación que se acaba de
   * abrir, y varios de ellos serían de esa misma sala.
   */
  tocado(): void {
    this.cola.length = 0;
    this.parar();
    this.puesto.set(null);
  }

  /** Saca el primero de la cola. Con la cola vacía, deja la pantalla limpia. */
  private mostrarElSiguiente(): void {
    this.parar();

    const m = this.cola.shift();

    if (!m) {
      this.puesto.set(null);

      return;
    }

    // La duración se decide **al mostrarse**: el que sale sin nadie detrás se
    // queda el tiempo largo aunque después se llene la cola.
    const duracionMs = this.cola.length === 0 ? LO_QUE_DURA : LO_QUE_DURA_CON_COLA;

    this.cuantosVan += 1;

    const autor = (m.autor ?? '').trim();

    this.puesto.set({
      clave: `${m.salaId}-${m.id}-${this.cuantosVan}`,
      salaId: m.salaId,
      autor: autor || 'Mensaje nuevo',
      inicial: autor ? autor[0].toUpperCase() : '?',
      resumen: unTrozo(m),
      duracionMs,
    });

    this.reloj = setTimeout(() => this.mostrarElSiguiente(), duracionMs);
  }

  private parar(): void {
    if (this.reloj === null) return;

    clearTimeout(this.reloj);
    this.reloj = null;
  }

  /**
   * Con la pestaña detrás, nada.
   *
   * Ahí manda la notificación del navegador, que es la que se ve cuando esta
   * ventana no está delante. Pintar además una burbuja sobre una página que
   * nadie mira no avisa a nadie y, peor, deja al volver un desfile de avisos
   * viejos encima de lo que se estaba haciendo.
   */
  private laPestanaEstaDelante(): boolean {
    return document.visibilityState !== 'hidden';
  }
}

/**
 * Un pedazo del mensaje, o qué clase de mensaje es.
 *
 * Un adjunto no tiene texto, y una línea vacía debajo del nombre se lee como que
 * algo falló. Se dice qué llegó, que es lo que decide si merece la pena abrirlo
 * ahora.
 *
 * En `actividad` el texto es el GUID y nada más —ver `MensajeDeSala.tipo`—, así
 * que pintarlo sería enseñar un identificador que para quien lee no significa
 * nada.
 */
function unTrozo(m: MensajeDeSala): string {
  if (m.tipo === 'voz') return `Nota de voz (${m.segundos}s)`;
  if (m.tipo === 'actividad') return 'Compartió una actividad';
  if (m.tipo === 'archivo') return m.adjuntos?.[0]?.nombre ?? 'Compartió un archivo';

  const texto = String(m.texto ?? '').trim();

  if (!texto) return 'Mensaje nuevo';

  return texto.length > 90 ? `${texto.slice(0, 90)}…` : texto;
}
