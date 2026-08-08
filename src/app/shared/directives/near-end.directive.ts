import { Directive, ElementRef, OnDestroy, afterNextRender, inject, output } from '@angular/core';

/**
 * Avisa cuando este elemento está a punto de entrar en pantalla.
 *
 * ## Para qué
 *
 * Para cargar más registros al llegar al final de una lista sin botones de
 * página. Se pone un elemento vacío al final del listado y este avisa cuando
 * falta poco para alcanzarlo.
 *
 * ## Por qué observar y no escuchar el desplazamiento
 *
 * Un `scroll` dispara decenas de veces por segundo y obliga a medir posiciones
 * a mano —y a saber **cuál** de los contenedores de la página es el que se
 * desplaza—. El observador de intersección lo resuelve el navegador, fuera del
 * hilo de la interfaz, y funciona igual esté el desplazamiento en la ventana o
 * en un panel interno.
 *
 * El margen de 300 píxeles hace que la carga empiece **antes** de llegar al
 * borde: así, cuando el usuario termina de bajar, lo siguiente ya está puesto y
 * no ve el salto.
 *
 * ```html
 * @if (hasMore()) {
 *   <div vtNearEnd (reached)="showMore()"></div>
 * }
 * ```
 */
@Directive({
  selector: '[vtNearEnd]',
  standalone: true,
})
export class NearEndDirective implements OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly reached = output<void>();

  private observer?: IntersectionObserver;

  constructor() {
    // Tras el primer dibujado: antes, el elemento no tiene sitio en la página y
    // el observador lo daría por visible al instante.
    afterNextRender(() => {
      this.observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) this.reached.emit();
        },
        { rootMargin: '300px' },
      );

      this.observer.observe(this.host.nativeElement);
    });
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }
}
