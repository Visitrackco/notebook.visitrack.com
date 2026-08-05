import { Component, ElementRef, computed, effect, input, output, signal, viewChild } from '@angular/core';

import { IconComponent } from '../../../../../shared/components/icon/icon.component';

/** Qué se está mirando. */
export type ViewerKind = 'image' | 'video';

/** Límites del zoom. Son los mismos que usa el visor de la app. */
const MIN_SCALE = 0.5;
const MAX_SCALE = 5;

/** Escala del doble toque. */
const DOUBLE_TAP_SCALE = 2.5;

/**
 * Visor a pantalla grande de una fotografía, una firma o un video.
 *
 * ## Por qué hace falta
 *
 * Dentro del formulario la evidencia se ve en miniatura, y en una miniatura no
 * se distingue un número de serie ni se lee una firma. Este visor es donde se
 * comprueba que lo capturado sirve — antes de irse del sitio, que es cuando
 * todavía se puede repetir.
 *
 * ## El zoom
 *
 * Tres formas de llegar al mismo sitio, porque el dispositivo cambia: rueda del
 * ratón, pellizco con dos dedos y doble toque. Las tres amplían **hacia el
 * punto señalado** y no hacia el centro de la imagen; ampliar al centro obliga
 * a arrastrar después hasta encontrar otra vez lo que se quería mirar.
 */
@Component({
  selector: 'vt-media-viewer',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './media-viewer.component.html',
  styleUrl: './media-viewer.component.scss',
})
export class MediaViewerComponent {
  readonly kind = input.required<ViewerKind>();
  readonly src = input.required<string>();
  readonly title = input('');

  /** Texto secundario: quién firmó, el tamaño del archivo. */
  readonly caption = input('');

  /** Fondo blanco para las firmas, que se guardan sobre blanco. */
  readonly onWhite = input(false);

  readonly close = output<void>();
  readonly download = output<void>();

  private readonly stageRef = viewChild<ElementRef<HTMLElement>>('stage');
  private readonly mediaRef = viewChild<ElementRef<HTMLElement>>('media');

  readonly scale = signal(1);
  readonly offset = signal({ x: 0, y: 0 });

  readonly isImage = computed(() => this.kind() === 'image');
  readonly zoomed = computed(() => this.scale() > 1.02);
  readonly percent = computed(() => `${Math.round(this.scale() * 100)} %`);

  /** La imagen está ampliada o desplazada: hay algo que restablecer. */
  readonly moved = computed(() => {
    const { x, y } = this.offset();
    return this.zoomed() || Math.abs(x) > 1 || Math.abs(y) > 1;
  });

  /** Transformación del contenido. El orden importa: primero mover, luego ampliar. */
  readonly transform = computed(() => {
    const { x, y } = this.offset();
    return `translate(${x}px, ${y}px) scale(${this.scale()})`;
  });

  /** Punteros activos, para distinguir el arrastre del pellizco. */
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinchStart = 0;
  private scaleStart = 1;
  private last: { x: number; y: number } | null = null;

  constructor() {
    // Al cambiar de archivo se vuelve al encuadre inicial: heredar el zoom de
    // la foto anterior deja la siguiente abierta por una esquina cualquiera.
    effect(() => {
      this.src();
      this.reset();
    });
  }

  reset(): void {
    this.scale.set(1);
    this.offset.set({ x: 0, y: 0 });
  }

  /** Amplía o reduce sin mover el punto que está bajo el cursor. */
  zoomAt(factor: number, clientX: number, clientY: number): void {
    const stage = this.stageRef()?.nativeElement;
    if (!stage) return;

    const current = this.scale();
    const next = clamp(current * factor, MIN_SCALE, MAX_SCALE);
    if (next === current) return;

    const rect = stage.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const { x, y } = this.offset();
    const ratio = next / current;

    // El punto señalado se queda donde está: se compensa el desplazamiento que
    // el propio cambio de escala habría provocado.
    this.scale.set(next);
    this.moveTo(
      clientX - centerX - (clientX - centerX - x) * ratio,
      clientY - centerY - (clientY - centerY - y) * ratio,
    );
  }

  /**
   * Coloca la imagen sin dejar que se escape de la vista.
   *
   * Se puede arrastrar **siempre**, con zoom o sin él: una foto que en la
   * miniatura salía cortada se termina de ver asomándose, y obligar a ampliar
   * primero para poder moverla es un paso que no aporta nada.
   *
   * Lo que sí se impide es sacarla del todo. El límite deja recorrer el
   * excedente que produce el zoom más un tercio de la ventana de margen: hay
   * juego de sobra para asomarse a un borde, pero la imagen nunca desaparece
   * dejando un rectángulo negro sin nada que agarrar.
   */
  private moveTo(x: number, y: number): void {
    const stage = this.stageRef()?.nativeElement;
    const media = this.mediaRef()?.nativeElement;

    if (!stage || !media) {
      this.offset.set({ x, y });
      return;
    }

    const scale = this.scale();
    const overflowX = Math.max(0, (media.offsetWidth * scale - stage.clientWidth) / 2);
    const overflowY = Math.max(0, (media.offsetHeight * scale - stage.clientHeight) / 2);

    const slackX = overflowX + stage.clientWidth / 3;
    const slackY = overflowY + stage.clientHeight / 3;

    this.offset.set({ x: clamp(x, -slackX, slackX), y: clamp(y, -slackY, slackY) });
  }

  /** Zoom con los botones: hacia el centro, que es lo que se está mirando. */
  step(factor: number): void {
    const stage = this.stageRef()?.nativeElement;
    if (!stage) return;

    const rect = stage.getBoundingClientRect();
    this.zoomAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  onWheel(event: WheelEvent): void {
    if (!this.isImage()) return;

    event.preventDefault();
    this.zoomAt(event.deltaY < 0 ? 1.15 : 1 / 1.15, event.clientX, event.clientY);
  }

  /** Doble toque: alterna entre el tamaño original y 2,5×. */
  onDoubleClick(event: MouseEvent): void {
    if (!this.isImage()) return;

    if (this.zoomed()) {
      this.reset();
      return;
    }

    this.zoomAt(DOUBLE_TAP_SCALE / this.scale(), event.clientX, event.clientY);
  }

  // ── Arrastre y pellizco ──────────────────────────────────────────────────────

  onPointerDown(event: PointerEvent): void {
    if (!this.isImage()) return;

    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (this.pointers.size === 2) {
      this.pinchStart = this.spread();
      this.scaleStart = this.scale();
    } else {
      this.last = { x: event.clientX, y: event.clientY };
    }
  }

  onPointerMove(event: PointerEvent): void {
    if (!this.pointers.has(event.pointerId)) return;

    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (this.pointers.size === 2) {
      const spread = this.spread();
      if (this.pinchStart === 0) return;

      const target = clamp((this.scaleStart * spread) / this.pinchStart, MIN_SCALE, MAX_SCALE);
      const center = this.center();

      this.zoomAt(target / this.scale(), center.x, center.y);
      return;
    }

    if (!this.last) return;

    const dx = event.clientX - this.last.x;
    const dy = event.clientY - this.last.y;
    this.last = { x: event.clientX, y: event.clientY };

    const { x, y } = this.offset();
    this.moveTo(x + dx, y + dy);
  }

  onPointerUp(event: PointerEvent): void {
    this.pointers.delete(event.pointerId);
    this.last = null;

    if (this.pointers.size < 2) this.pinchStart = 0;
  }

  /** Distancia entre los dos dedos. */
  private spread(): number {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return 0;

    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /** Punto medio entre los dos dedos. */
  private center(): { x: number; y: number } {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return { x: 0, y: 0 };

    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  /** Escape cierra, como en cualquier ventana modal. */
  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') this.close.emit();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
