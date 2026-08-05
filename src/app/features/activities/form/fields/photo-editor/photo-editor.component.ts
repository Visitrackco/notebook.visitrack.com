import {
  Component,
  ElementRef,
  computed,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { ConfirmDialogComponent } from '../../../../../shared/components/confirm-dialog/confirm-dialog.component';
import { IconComponent } from '../../../../../shared/components/icon/icon.component';

/** Un trazo dibujado sobre la foto. */
interface Stroke {
  color: string;
  width: number;
  /** Puntos en coordenadas de la imagen, no del lienzo. */
  points: { x: number; y: number }[];
}

/** Recorte pendiente, en coordenadas de la imagen. */
interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Herramienta activa. */
type Tool = 'draw' | 'crop';

/** Colores de trazo. Los mismos de la app. */
const COLORS = [
  '#f44336',
  '#2196f3',
  '#4caf50',
  '#ffeb3b',
  '#ff9800',
  '#9c27b0',
  '#ffffff',
  '#000000',
];

/** Grosores de trazo, en píxeles de la imagen. */
const WIDTHS = [2, 4, 8, 12];

/**
 * Calidad del JPEG al exportar.
 *
 * 0.85 es donde la compresión deja de notarse a simple vista y el archivo pesa
 * la mitad. En un formulario con quince fotos que hay que subir con mala
 * cobertura, esa mitad es la diferencia entre terminar la visita y no hacerlo.
 */
const JPEG_QUALITY = 0.85;

/**
 * Lado máximo de la imagen exportada.
 *
 * Las cámaras de móvil entregan doce megapíxeles; para documentar una
 * inspección sobra con 1600 px de lado largo, y el archivo pasa de varios
 * megabytes a unos pocos cientos de kilobytes.
 */
const MAX_SIDE = 1600;

/**
 * Editor de fotos.
 *
 * Replica el de la app: dibujar encima, rotar, recortar, deshacer. Es lo que
 * convierte una foto en evidencia útil — señalar la fuga concreta, tapar lo que
 * no viene al caso, enderezar lo que salió torcido.
 *
 * ## Los trazos van en coordenadas de la imagen
 *
 * No del lienzo. El lienzo se escala al espacio disponible, y si los trazos se
 * guardaran en sus coordenadas, cambiar el tamaño de la ventana los movería
 * respecto a la foto. Guardándolos en coordenadas de la imagen, el dibujo queda
 * pegado a lo que señala.
 *
 * ## Rotar y recortar descartan los trazos
 *
 * Igual que en la app, y se avisa antes. Transformar las coordenadas de cada
 * trazo al rotar es posible, pero con recortes sucesivos acumula error y acaba
 * moviendo las marcas de sitio — que es justo lo que no puede pasar cuando una
 * marca señala un defecto concreto.
 */
@Component({
  selector: 'vt-photo-editor',
  standalone: true,
  imports: [ConfirmDialogComponent, IconComponent],
  templateUrl: './photo-editor.component.html',
  styleUrl: './photo-editor.component.scss',
})
export class PhotoEditorComponent {
  /** Imagen a editar. */
  readonly source = input.required<Blob>();

  /** Se emite con la imagen final. */
  readonly save = output<Blob>();
  readonly cancel = output<void>();

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('canvas');

  readonly colors = COLORS;
  readonly widths = WIDTHS;

  readonly tool = signal<Tool>('draw');
  readonly color = signal(COLORS[0]);
  readonly width = signal(WIDTHS[1]);
  readonly rotation = signal(0);
  readonly saving = signal(false);
  readonly askingDiscard = signal(false);

  private readonly strokes = signal<Stroke[]>([]);
  private readonly crop = signal<CropRect | null>(null);

  /** La imagen ya decodificada. */
  private image: HTMLImageElement | null = null;
  private sourceUrl = '';

  /** Trazo o recorte en curso. */
  private drawing: Stroke | null = null;
  private cropStart: { x: number; y: number } | null = null;

  /** Acción que espera confirmación por haber trazos. */
  private pending: (() => void) | null = null;

  readonly hasStrokes = computed(() => this.strokes().length > 0);
  readonly hasCrop = computed(() => this.crop() !== null);
  readonly canUndo = computed(() => this.strokes().length > 0);

  constructor() {
    effect(() => {
      const blob = this.source();
      void this.load(blob);
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Carga y dibujo
  // ───────────────────────────────────────────────────────────────────────────

  private async load(blob: Blob): Promise<void> {
    if (this.sourceUrl) URL.revokeObjectURL(this.sourceUrl);

    this.sourceUrl = URL.createObjectURL(blob);
    this.image = await loadImage(this.sourceUrl);

    this.strokes.set([]);
    this.crop.set(null);
    this.rotation.set(0);
    this.render();
  }

  /**
   * Redibuja el lienzo.
   *
   * Se hace a mano y no con `effect` sobre los signals porque el dibujo ocurre
   * decenas de veces por segundo mientras se arrastra el dedo: pasar por el
   * ciclo de detección de cambios en cada punto se nota en el trazo.
   */
  private render(): void {
    const canvas = this.canvasRef()?.nativeElement;
    const image = this.image;
    if (!canvas || !image) return;

    const rotated = this.rotation() % 180 !== 0;
    const area = this.crop() ?? { x: 0, y: 0, w: image.naturalWidth, h: image.naturalHeight };

    canvas.width = rotated ? area.h : area.w;
    canvas.height = rotated ? area.w : area.h;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((this.rotation() * Math.PI) / 180);
    ctx.drawImage(image, area.x, area.y, area.w, area.h, -area.w / 2, -area.h / 2, area.w, area.h);
    ctx.restore();

    // Los trazos se pintan sin rotar: se capturaron sobre la vista actual, y
    // rotar o recortar los descarta antes de llegar aquí.
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const stroke of [...this.strokes(), ...(this.drawing ? [this.drawing] : [])]) {
      if (stroke.points.length === 0) continue;

      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);

      for (const point of stroke.points.slice(1)) ctx.lineTo(point.x, point.y);

      // Un toque sin arrastre no dibuja línea: se marca con un punto para que
      // señalar algo pequeño no exija hacer un garabato.
      if (stroke.points.length === 1) ctx.lineTo(stroke.points[0].x + 0.1, stroke.points[0].y);

      ctx.stroke();
    }

    if (this.cropStart && this.tool() === 'crop') this.drawCropOverlay(ctx, canvas);
  }

  /** Rectángulo de recorte en curso, con el resto atenuado. */
  private drawCropOverlay(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
    const rect = this.pendingCrop;
    if (!rect) return;

    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.fill('evenodd');

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    ctx.restore();
  }

  private pendingCrop: CropRect | null = null;

  // ───────────────────────────────────────────────────────────────────────────
  // Puntero
  // ───────────────────────────────────────────────────────────────────────────

  onPointerDown(event: PointerEvent): void {
    const point = this.toCanvasPoint(event);
    if (!point) return;

    (event.target as HTMLElement).setPointerCapture(event.pointerId);

    if (this.tool() === 'crop') {
      this.cropStart = point;
      this.pendingCrop = { x: point.x, y: point.y, w: 0, h: 0 };
      return;
    }

    this.drawing = { color: this.color(), width: this.width(), points: [point] };
    this.render();
  }

  onPointerMove(event: PointerEvent): void {
    const point = this.toCanvasPoint(event);
    if (!point) return;

    if (this.tool() === 'crop') {
      if (!this.cropStart) return;

      this.pendingCrop = {
        x: Math.min(this.cropStart.x, point.x),
        y: Math.min(this.cropStart.y, point.y),
        w: Math.abs(point.x - this.cropStart.x),
        h: Math.abs(point.y - this.cropStart.y),
      };
      this.render();
      return;
    }

    if (!this.drawing) return;
    this.drawing.points.push(point);
    this.render();
  }

  onPointerUp(): void {
    if (this.tool() === 'crop') {
      this.cropStart = null;
      this.render();
      return;
    }

    if (!this.drawing) return;

    this.strokes.update((current) => [...current, this.drawing as Stroke]);
    this.drawing = null;
    this.render();
  }

  /**
   * Coordenadas del puntero dentro del lienzo.
   *
   * El lienzo se muestra escalado para caber en pantalla, así que hay que
   * convertir de píxeles de pantalla a píxeles del lienzo. Sin esa conversión
   * el trazo aparece desplazado respecto al dedo, y tanto más cuanto mayor sea
   * la foto.
   */
  private toCanvasPoint(event: PointerEvent): { x: number; y: number } | null {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Herramientas
  // ───────────────────────────────────────────────────────────────────────────

  setTool(tool: Tool): void {
    this.tool.set(tool);
    this.cropStart = null;
    this.pendingCrop = null;
    this.render();
  }

  undo(): void {
    this.strokes.update((current) => current.slice(0, -1));
    this.render();
  }

  clearStrokes(): void {
    this.strokes.set([]);
    this.render();
  }

  /** Gira 90°. Con trazos encima, pregunta antes. */
  rotate(): void {
    this.withStrokeCheck(() => {
      this.rotation.update((value) => (value + 90) % 360);
      this.strokes.set([]);
      this.render();
    });
  }

  /** Aplica el recorte marcado. */
  applyCrop(): void {
    const rect = this.pendingCrop;
    if (!rect || rect.w < 10 || rect.h < 10) return;

    this.withStrokeCheck(() => {
      const current = this.crop();
      const base = current ?? { x: 0, y: 0, w: 0, h: 0 };

      // El recorte se acumula sobre el anterior: las coordenadas del rectángulo
      // son relativas a lo que se está viendo, no a la imagen original.
      this.crop.set({
        x: base.x + rect.x,
        y: base.y + rect.y,
        w: rect.w,
        h: rect.h,
      });

      this.strokes.set([]);
      this.pendingCrop = null;
      this.cropStart = null;
      this.rotation.set(0);
      this.tool.set('draw');
      this.render();
    });
  }

  /** Deshace el recorte y vuelve a la imagen completa. */
  resetCrop(): void {
    this.withStrokeCheck(() => {
      this.crop.set(null);
      this.strokes.set([]);
      this.pendingCrop = null;
      this.render();
    });
  }

  /**
   * Ejecuta una acción que invalida los trazos, preguntando si los hay.
   *
   * Perder marcas sin avisar es perder trabajo: quien señaló tres defectos y
   * después endereza la foto no espera encontrarse la imagen limpia.
   */
  private withStrokeCheck(action: () => void): void {
    if (!this.hasStrokes()) {
      action();
      return;
    }

    this.pending = action;
    this.askingDiscard.set(true);
  }

  confirmDiscard(): void {
    this.askingDiscard.set(false);
    this.pending?.();
    this.pending = null;
  }

  cancelDiscard(): void {
    this.askingDiscard.set(false);
    this.pending = null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Salida
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Exporta la imagen editada.
   *
   * Se reduce el lado largo y se comprime a JPEG: lo que sale de aquí va a
   * subirse por la red del sitio, que suele ser mala. El lienzo ya contiene el
   * resultado con la rotación, el recorte y los trazos aplicados.
   */
  async exportImage(): Promise<void> {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas || this.saving()) return;

    this.saving.set(true);

    try {
      const scale = Math.min(1, MAX_SIDE / Math.max(canvas.width, canvas.height));

      const target = document.createElement('canvas');
      target.width = Math.round(canvas.width * scale);
      target.height = Math.round(canvas.height * scale);

      const ctx = target.getContext('2d');
      if (!ctx) return;

      // Suavizado alto: al reducir sin él, las líneas finas de un equipo o el
      // texto de una placa salen dentados.
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(canvas, 0, 0, target.width, target.height);

      const blob = await new Promise<Blob | null>((resolve) =>
        target.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
      );

      if (blob) this.save.emit(blob);
    } finally {
      this.saving.set(false);
    }
  }

  close(): void {
    if (this.sourceUrl) {
      URL.revokeObjectURL(this.sourceUrl);
      this.sourceUrl = '';
    }
    this.cancel.emit();
  }
}

/** Decodifica una imagen desde una URL de objeto. */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('No se pudo leer la imagen.'));
    image.src = url;
  });
}
