import {
  Component,
  ElementRef,
  OnDestroy,
  afterNextRender,
  inject,
  signal,
} from '@angular/core';

import { IconComponent } from '../icon/icon.component';

/**
 * Botón para volver al principio.
 *
 * ## Por qué hace falta
 *
 * Un formulario de cuarenta campos, un listado de trescientas sedes o una tabla
 * de registros dejan al usuario muy abajo. Sin esto, volver arriba —donde están
 * el buscador, las pestañas y el guardar— es desplazar a mano una pantalla
 * entera, y en un teléfono son varios gestos.
 *
 * ## Aparece solo cuando sirve
 *
 * Se muestra al pasar de una pantalla de desplazamiento. Antes de eso el
 * principio está a la vista y el botón solo taparía contenido.
 *
 * ## Encuentra por sí mismo qué se está desplazando
 *
 * Según la pantalla, lo que se mueve es la ventana o un panel interno. En vez
 * de que cada sitio le diga cuál es —y se equivoque el día que cambie el
 * armazón—, sube por sus ancestros buscando el primero que se desplaza de
 * verdad.
 */
@Component({
  selector: 'vt-to-top',
  standalone: true,
  imports: [IconComponent],
  template: `
    @if (visible()) {
      <button type="button" class="totop" (click)="up()" aria-label="Volver arriba" title="Volver arriba">
        <vt-icon name="chevron" [size]="20" />
      </button>
    }
  `,
  styles: [
    `
      .totop {
        position: fixed;
        right: var(--vt-space-4);
        bottom: var(--vt-space-4);
        z-index: 30;
        display: grid;
        place-items: center;
        width: 46px;
        height: 46px;
        color: var(--vt-on-brand);
        background: var(--vt-brand);
        border: 0;
        border-radius: var(--vt-radius-full);
        box-shadow: 0 6px 20px rgb(0 0 0 / 22%);
        /* El icono base apunta a la derecha; hacia arriba es un cuarto de giro
           en sentido contrario. */
        animation: totop-in 160ms ease-out;

        vt-icon {
          transform: rotate(-90deg);
        }

        &:hover {
          background: var(--vt-brand-dark);
        }
      }

      @keyframes totop-in {
        from {
          opacity: 0;
          transform: translateY(8px);
        }
      }

      /* En un teléfono se aparta del pulgar que usa la barra de guardado. */
      @media (max-width: 640px) {
        .totop {
          right: 12px;
          bottom: 84px;
          width: 42px;
          height: 42px;
        }
      }
    `,
  ],
})
export class ToTopComponent implements OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly visible = signal(false);

  /** Lo que se desplaza: un panel de la página o la ventana. */
  private scroller: HTMLElement | Window | null = null;

  private readonly onScroll = (): void => {
    this.visible.set(this.offset() > 400);
  };

  constructor() {
    afterNextRender(() => {
      this.scroller = findScroller(this.host.nativeElement);
      this.scroller.addEventListener('scroll', this.onScroll, { passive: true });
      this.onScroll();
    });
  }

  ngOnDestroy(): void {
    this.scroller?.removeEventListener('scroll', this.onScroll);
  }

  up(): void {
    this.scroller?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  private offset(): number {
    if (!this.scroller) return 0;

    return this.scroller instanceof Window ? this.scroller.scrollY : this.scroller.scrollTop;
  }
}

/**
 * El primer ancestro que de verdad se desplaza.
 *
 * «De verdad» importa: hay contenedores con `overflow: auto` cuyo contenido
 * cabe entero, y quedarse con el primero de esos dejaría el botón sin efecto.
 * Si ninguno califica, lo que se mueve es la ventana.
 */
function findScroller(element: HTMLElement): HTMLElement | Window {
  let node = element.parentElement;

  while (node && node !== document.body) {
    const overflow = getComputedStyle(node).overflowY;
    const scrolls = overflow === 'auto' || overflow === 'scroll';

    if (scrolls && node.scrollHeight > node.clientHeight + 4) return node;

    node = node.parentElement;
  }

  return window;
}
