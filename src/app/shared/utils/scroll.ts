/**
 * Desplazamiento propio, más corto que el del navegador.
 *
 * ## Por qué no `scrollIntoView({ behavior: 'smooth' })`
 *
 * El desplazamiento nativo dura lo que el navegador decide —medio segundo largo
 * cuando la distancia es grande— y no se puede ajustar. En un formulario, ese
 * medio segundo se repite cada vez que se entra y se sale de una fila de una
 * tabla de detalle: al agregar cinco registros, son cinco esperas mirando cómo
 * la pantalla se desliza sola antes de poder seguir.
 *
 * Con doscientos milisegundos el movimiento **se sigue viendo** —que es lo que
 * evita perder de vista dónde se estaba— pero no se espera.
 */

/** Cuánto dura el desplazamiento por omisión. */
const DURATION = 200;

/**
 * El contenedor que puede desplazarse alrededor de un elemento.
 *
 * Se busca hacia arriba hasta encontrar uno que **pueda** desplazarse: tener
 * `overflow: auto` no basta si el contenido cabe entero, y en ese caso mover su
 * `scrollTop` no haría nada mientras el que sí se mueve es la página.
 */
function scrollerOf(element: HTMLElement): HTMLElement {
  let parent = element.parentElement;

  while (parent) {
    const style = getComputedStyle(parent);
    const scrolls = /(auto|scroll|overlay)/.test(style.overflowY);

    if (scrolls && parent.scrollHeight > parent.clientHeight) return parent;

    parent = parent.parentElement;
  }

  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}

/** Suave al final: arranca rápido y frena, que es como se lee un movimiento corto. */
function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Lleva el elemento al centro de su contenedor.
 *
 * @param duration en milisegundos. Con `0` salta sin animación.
 */
export function scrollToCenter(element: HTMLElement, duration = DURATION): void {
  const scroller = scrollerOf(element);

  /**
   * Quien pidió menos movimiento no lo pidió solo para las transiciones.
   *
   * La hoja de estilos ya anula el desplazamiento suave del navegador con
   * `prefers-reduced-motion`. Una animación escrita a mano se salta esa regla
   * —la hace JavaScript, no CSS—, así que hay que consultarla aquí también.
   */
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const isPage = scroller === document.documentElement || scroller === document.body;

  const viewport = isPage ? window.innerHeight : scroller.clientHeight;
  const containerTop = isPage ? 0 : scroller.getBoundingClientRect().top;

  const offset = element.getBoundingClientRect().top - containerTop;
  const target = scroller.scrollTop + offset - (viewport - element.offsetHeight) / 2;

  const max = scroller.scrollHeight - scroller.clientHeight;
  const to = Math.max(0, Math.min(target, max));
  const from = scroller.scrollTop;

  if (still || duration <= 0 || Math.abs(to - from) < 2) {
    scroller.scrollTop = to;
    return;
  }

  /**
   * Quien pida uno nuevo mientras este corre, gana.
   *
   * Sin esto, la corrección que se hace tras un repintado pelearía con el
   * desplazamiento en curso y el resultado sería un temblor.
   */
  const token = Symbol('scroll');
  (scroller as unknown as { __vtScroll?: symbol }).__vtScroll = token;

  const start = performance.now();

  const step = (now: number) => {
    if ((scroller as unknown as { __vtScroll?: symbol }).__vtScroll !== token) return;

    const progress = Math.min(1, (now - start) / duration);

    scroller.scrollTop = from + (to - from) * easeOut(progress);

    if (progress < 1) requestAnimationFrame(step);
  };

  requestAnimationFrame(step);
}
