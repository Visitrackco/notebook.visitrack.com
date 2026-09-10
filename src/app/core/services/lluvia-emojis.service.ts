import { Injectable, signal } from '@angular/core';

import { Animacion } from '../forms/flujo-modelo';

/** Una carita con su trayectoria ya sorteada. */
export interface Carita {
  figura: string;

  /** Dónde sale, como porcentaje del ancho de la pantalla. */
  x: number;

  /** Cuánto espera antes de salir, en segundos. */
  retraso: number;

  /** El tamaño de letra con el que se pinta, en píxeles. */
  tamano: number;

  /** Cuánto se va a los lados mientras sube, en píxeles. */
  vaiven: number;

  /** Cuánto se ladea, en grados. */
  giro: number;

  /*
   * ─── Los estilos, ya armados ────────────────────────────────────────────
   *
   * Se guardan aquí, en la carita, en vez de calcularse en la plantilla.
   *
   * La plantilla los pedía con `[style]="estiloDelViaje(carita, lluvia)"`, y
   * una llamada a un método en una plantilla se ejecuta **en cada ciclo de
   * detección de cambios**. Devolviendo un objeto nuevo cada vez, Angular veía
   * un valor distinto y volvía a escribir los estilos en el DOM: con cien
   * caritas, doscientos elementos reescritos por ciclo.
   *
   * Y aquí los ciclos son constantes: la aplicación va sin Zone.js, así que la
   * detección la disparan las señales — y al escribir en un campo se mueven
   * varias por tecla. De ahí que teclear con una lluvia en pantalla se sintiera
   * pastoso: no era la animación, que la lleva el compositor, sino las
   * doscientas escrituras de estilo que iban por delante.
   *
   * Calculados al nacer, la referencia no cambia nunca, Angular no encuentra
   * nada que actualizar y la lluvia deja de costar por fotograma.
   */

  /** Dónde sale, cuándo y cuánto tarda en llegar arriba. */
  estiloViaje: Record<string, string>;

  /** El meneo de esa misma carita mientras sube. */
  estiloVaiven: Record<string, string>;
}

/** Una lluvia en marcha. */
export interface Lluvia {
  id: number;
  caritas: Carita[];

  /** Lo que dura el viaje de una carita, en segundos. */
  segundos: number;
}

/**
 * Tope de caritas a la vez.
 *
 * Son objetos animándose encima de un formulario que se está diligenciando, y
 * el navegador no es el único que tiene que ir fluido: por debajo hay campos
 * que se guardan solos con cada tecla. Una regla mal configurada pidiendo mil
 * no puede dejar la pantalla pegada.
 *
 * Cien, que es el mismo tope que ya aplica el motor y el mismo que respeta la
 * app. Recortar aquí a menos sería que la misma regla lanzara ochenta caritas en
 * el navegador y cien en el teléfono, y lo que se promete es que un formulario
 * se comporte igual en los dos sitios — también en lo que se ve.
 */
const TOPE_CARITAS = 100;

/** Y un tope de duración, por lo mismo. */
const TOPE_SEGUNDOS = 10;

/**
 * Cuánto se escalonan las salidas, como fracción de la duración.
 *
 * Salir todas a la vez es una franja, no una lluvia.
 */
const ESCALON = 0.45;

/**
 * Las caritas que suben por la pantalla cuando una regla del flujo lo pide.
 *
 * ## Qué hace y qué no
 *
 * Este servicio **lanza**. Decidir si una animación es nueva o es la misma de
 * la evaluación anterior no es cosa suya: el resultado del motor es un estado y
 * no un suceso —el flujo se recalcula con cada tecla y la misma animación sale
 * igual mientras su condición siga cumpliéndose—, así que quien mira ese estado
 * es quien sabe cuándo aparece una. Ver el efecto de las animaciones en
 * `FormRunnerComponent`, que es donde se lleva la cuenta, igual que con los
 * avisos.
 *
 * ## Por qué el azar se sortea aquí y no al pintar
 *
 * Porque tiene que sortearse **una sola vez**. Calculando la posición en cada
 * repintado, cada carita aparecería en un sitio distinto cada vez que Angular
 * revisara la plantilla: en vez de subir, parpadearían por toda la pantalla.
 * Aquí cada una recibe su trayectoria al nacer y luego solo la recorre.
 */
@Injectable({ providedIn: 'root' })
export class LluviaEmojisService {
  private readonly enMarcha = signal<Lluvia[]>([]);

  readonly lluvias = this.enMarcha.asReadonly();

  private siguienteId = 1;

  /** Lanza una lluvia con lo que anotó el motor. */
  lanzar(animacion: Animacion): void {
    const figuras = enFiguras(animacion?.figuras ?? '');

    // Una regla sin emojis no anima nada, y no es un error: es una regla a
    // medio configurar, y el formulario tiene que seguir funcionando igual.
    if (!figuras.length) return;

    const cuantas = acotar(animacion?.cuantas, 1, TOPE_CARITAS, 20);
    const segundos = acotar(animacion?.segundos, 1, TOPE_SEGUNDOS, 3);

    const lluvia: Lluvia = {
      id: this.siguienteId++,
      segundos,
      caritas: Array.from({ length: cuantas }, (_, i) =>
        nuevaCarita(figuras[i % figuras.length], segundos),
      ),
    };

    this.enMarcha.update((actuales) => [...actuales, lluvia]);

    /*
     * Y se quita sola.
     *
     * Sin esto quedarían cientos de nodos parados en el borde de arriba, uno
     * por cada vez que se cumplió la regla, encima de un formulario que puede
     * estar abierto una hora. Se espera lo que dura el viaje más lo que tarda
     * en salir la última.
     */
    setTimeout(
      () => this.enMarcha.update((actuales) => actuales.filter((l) => l.id !== lluvia.id)),
      (segundos * (1 + ESCALON) + 0.2) * 1000,
    );
  }
}

/**
 * Sortea una carita y le deja los estilos ya armados.
 *
 * Todo lo aleatorio ocurre aquí y una sola vez. Ver la nota de `Carita`: es lo
 * que permite que la plantilla se limite a leer y no a calcular.
 */
function nuevaCarita(figura: string, segundos: number): Carita {
  // Hasta el 94 % y no el 100: el borde izquierdo de la carita es lo que se
  // coloca, así que las que salieran al final se irían enteras fuera de la
  // pantalla y esa parte de la lluvia no se vería nunca.
  const x = Math.random() * 94;
  const retraso = Math.random() * ESCALON * segundos;
  const tamano = 22 + Math.random() * 20;

  // El vaivén es lo que hace que parezca que flotan y no que las dispara un
  // cañón.
  const vaiven = 12 + Math.random() * 26;
  const giro = (Math.random() - 0.5) * 34;

  return {
    figura,
    x,
    retraso,
    tamano,
    vaiven,
    giro,

    estiloViaje: {
      left: `${x}%`,
      'font-size': `${tamano}px`,
      'animation-duration': `${segundos}s`,
      'animation-delay': `${retraso}s`,
    },

    /*
     * Tres idas y venidas repartidas en todo el viaje: menos parece que va
     * tiesa, y más, que le está dando algo.
     */
    estiloVaiven: {
      '--lluvia-vaiven': `${vaiven}px`,
      '--lluvia-giro': `${giro}deg`,
      'animation-duration': `${segundos / 3}s`,
      'animation-delay': `${retraso}s`,
      'animation-iteration-count': '3',
    },
  };
}

/**
 * Parte «🎉🙂» en las dos caritas que son.
 *
 * No se puede cortar por caracteres: un emoji ocupa dos unidades en una cadena
 * de JavaScript y muchos llevan además modificadores de color de piel o uniones
 * de varios símbolos en uno. `Intl.Segmenter` agrupa lo que el usuario ve como
 * un solo símbolo, que es justamente lo que aquí hace falta; donde no exista,
 * `Array.from` al menos respeta los pares sustitutos y no parte el emoji por la
 * mitad dejando basura en pantalla.
 */
function enFiguras(texto: string): string[] {
  const limpio = String(texto ?? '');
  if (!limpio.trim()) return [];

  const trozos =
    typeof Intl !== 'undefined' && 'Segmenter' in Intl
      ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(limpio)].map(
          (s) => s.segment,
        )
      : Array.from(limpio);

  return trozos.filter((c) => c.trim().length > 0);
}

/** Un número de la configuración, dentro de lo razonable. */
function acotar(crudo: unknown, minimo: number, maximo: number, porOmision: number): number {
  const n = Number(crudo);

  return Number.isFinite(n) && n > 0
    ? Math.min(maximo, Math.max(minimo, Math.round(n)))
    : porOmision;
}
