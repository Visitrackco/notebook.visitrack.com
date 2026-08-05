import {
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { IconComponent } from '../../../../../shared/components/icon/icon.component';

/** Un trazo de la firma, en coordenadas del lienzo. */
type Stroke = { x: number; y: number }[];

/**
 * Qué cuenta como una firma y no como un garabato.
 *
 * Los tres se exigen a la vez porque cada uno solo cierra una puerta:
 *
 * - **Recorrido**: la suma de lo que se movió el dedo. Un toque suelto o dos
 *   puntitos no llegan; una rúbrica corta, sí.
 * - **Ancho**: una firma avanza en horizontal. Un trazo vertical de 200 píxeles
 *   tiene recorrido de sobra pero es una raya, no un nombre.
 * - **Alto**: descarta la línea recta de quien pasa el dedo de lado a lado sin
 *   levantar, que cumpliría recorrido y ancho.
 *
 * Los valores son deliberadamente bajos. Esto no juzga la caligrafía de nadie:
 * solo evita que un roce accidental de la pantalla quede archivado como la
 * firma de conformidad de una inspección.
 */
const MIN_PATH = 160;
const MIN_WIDTH = 70;
const MIN_HEIGHT = 14;

/**
 * Lienzo de firma.
 *
 * ## Por qué fondo blanco y no transparente
 *
 * El PNG se envía a Visitrack y acaba embebido en informes y PDF, que suelen
 * tener fondo claro pero no siempre. Una firma con fondo transparente sobre un
 * fondo oscuro desaparece; con fondo blanco se ve siempre, que es lo que se
 * espera de un documento firmado.
 *
 * ## El nombre es obligatorio, y va primero
 *
 * Se guarda en el campo `sig` del valor, igual que en la app, y sin él no se
 * puede guardar: una firma sin nombre obliga a adivinar quién firmó, y en una
 * inspección eso es justo lo que se está documentando.
 *
 * Va **encima** del lienzo por el mismo motivo que en la app: pedirlo después
 * de firmar es pedirlo cuando la persona ya devolvió el dispositivo.
 */
@Component({
  selector: 'vt-signature-pad',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './signature-pad.component.html',
  styleUrl: './signature-pad.component.scss',
})
export class SignaturePadComponent implements OnDestroy {
  readonly signed = output<{ blob: Blob; name: string }>();
  readonly cancel = output<void>();

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly nameRef = viewChild<ElementRef<HTMLInputElement>>('nameInput');

  readonly name = signal('');
  readonly saving = signal(false);

  /** Se intentó guardar sin nombre: a partir de ahí se señala el campo. */
  readonly nameTouched = signal(false);

  private readonly strokes = signal<Stroke[]>([]);
  private current: Stroke | null = null;

  readonly hasSignature = computed(() => this.strokes().length > 0);
  readonly hasName = computed(() => this.name().trim().length > 0);

  /** Falta el nombre y ya se avisó de ello. */
  readonly nameMissing = computed(() => this.nameTouched() && !this.hasName());

  /** Medidas del trazo: recorrido y caja que ocupa. */
  private readonly metrics = computed(() => measure(this.strokes()));

  /** El trazo tiene entidad suficiente para pasar por una firma. */
  readonly validSignature = computed(() => {
    const { path, width, height } = this.metrics();
    return path >= MIN_PATH && width >= MIN_WIDTH && height >= MIN_HEIGHT;
  });

  /**
   * Lo lleno que está el trazo respecto a lo que se pide, de 0 a 1.
   *
   * Se enseña como una barra: sin ella, un botón apagado que no dice cuánto
   * falta se lee como que la aplicación no funciona.
   */
  readonly quality = computed(() => {
    const { path, width, height } = this.metrics();

    return Math.min(
      1,
      Math.min(path / MIN_PATH, Math.min(width / MIN_WIDTH, height / MIN_HEIGHT)),
    );
  });

  readonly canSave = computed(() => this.validSignature() && this.hasName() && !this.saving());

  private observer?: ResizeObserver;

  constructor() {
    effect(() => {
      const canvas = this.canvasRef()?.nativeElement;
      if (!canvas) return;

      this.resize(canvas);

      /**
       * El lienzo se reajusta cuando cambia de tamaño.
       *
       * No es hipotético: al aparecer el aviso de «falta el nombre», el área de
       * firma se encoge unos píxeles. Sin reajustar, el mapa de bits conserva
       * el tamaño anterior y el trazo deja de salir bajo el dedo —se dibuja
       * desplazado hacia abajo, cada vez más según se firma—.
       */
      this.observer?.disconnect();
      this.observer = new ResizeObserver(() => this.resize(canvas));
      this.observer.observe(canvas);
    });
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }

  /**
   * Ajusta el lienzo a su tamaño real en pantalla.
   *
   * Un `<canvas>` tiene dos tamaños —el del elemento y el de su mapa de bits— y
   * si no coinciden, el trazo sale desplazado y borroso. Se multiplica por
   * `devicePixelRatio` para que en pantallas densas la firma no se vea dentada.
   */
  private resize(canvas: HTMLCanvasElement): void {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;

    const ratio = window.devicePixelRatio || 1;
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;

    const ctx = canvas.getContext('2d');
    ctx?.scale(ratio, ratio);

    this.render();
  }

  private render(): void {
    const canvas = this.canvasRef()?.nativeElement;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    ctx.strokeStyle = '#0f1216';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const stroke of [...this.strokes(), ...(this.current ? [this.current] : [])]) {
      if (stroke.length === 0) continue;

      ctx.beginPath();
      ctx.moveTo(stroke[0].x, stroke[0].y);
      for (const point of stroke.slice(1)) ctx.lineTo(point.x, point.y);

      // Un punto suelto no dibuja línea: se alarga lo mínimo para que quede
      // marca, y así un acento o un punto de la firma no se pierden.
      if (stroke.length === 1) ctx.lineTo(stroke[0].x + 0.1, stroke[0].y);

      ctx.stroke();
    }
  }

  // ── Trazo ──────────────────────────────────────────────────────────────────

  onPointerDown(event: PointerEvent): void {
    const point = this.toPoint(event);
    if (!point) return;

    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    this.current = [point];
    this.render();
  }

  onPointerMove(event: PointerEvent): void {
    if (!this.current) return;

    const point = this.toPoint(event);
    if (!point) return;

    this.current.push(point);
    this.render();
  }

  onPointerUp(): void {
    if (!this.current) return;

    this.strokes.update((current) => [...current, this.current as Stroke]);
    this.current = null;
    this.render();
  }

  private toPoint(event: PointerEvent): { x: number; y: number } | null {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  clear(): void {
    this.strokes.set([]);
    this.current = null;
    this.render();
  }

  onName(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
  }

  /**
   * Entrega la firma como PNG, recortada a lo que se dibujó.
   *
   * Sin nombre no sale: se señala el campo en lugar de guardar. El botón ya
   * está deshabilitado en ese caso, pero la comprobación se repite aquí porque
   * un formulario puede enviarse con la tecla Intro sin pasar por el botón.
   */
  async accept(): Promise<void> {
    if (!this.canvasRef() || !this.validSignature() || this.saving()) return;

    if (!this.hasName()) {
      this.nameTouched.set(true);
      this.nameRef()?.nativeElement.focus();
      return;
    }

    this.saving.set(true);

    try {
      const cropped = this.crop();
      if (!cropped) return;

      const blob = await new Promise<Blob | null>((resolve) =>
        cropped.toBlob(resolve, 'image/png'),
      );

      if (blob) this.signed.emit({ blob, name: this.name().trim() });
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Recorta el lienzo a la zona firmada.
   *
   * El área de firma es grande —hace falta para firmar cómodo, sobre todo con
   * el dedo—, pero casi siempre se usa una parte pequeña. Exportarla entera
   * guardaba un PNG con un trazo diminuto perdido en un rectángulo blanco: en
   * el informe la firma salía ilegible y ocupando una página.
   *
   * Se recorta a los límites reales del trazo con un margen holgado, así la
   * firma llena el espacio que le den después.
   */
  private crop(): HTMLCanvasElement | null {
    const source = this.canvasRef()?.nativeElement;
    if (!source) return null;

    const strokes = this.strokes();
    if (strokes.length === 0) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const stroke of strokes) {
      for (const point of stroke) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      }
    }

    // El margen cubre el grosor del trazo —que se pinta centrado en la línea y
    // se saldría del recorte— y deja aire alrededor.
    const pad = 18;
    const ratio = window.devicePixelRatio || 1;

    const x = Math.max(0, minX - pad);
    const y = Math.max(0, minY - pad);
    const width = Math.min(source.width / ratio, maxX + pad) - x;
    const height = Math.min(source.height / ratio, maxY + pad) - y;

    if (width <= 0 || height <= 0) return null;

    const target = document.createElement('canvas');
    target.width = Math.round(width * ratio);
    target.height = Math.round(height * ratio);

    const ctx = target.getContext('2d');
    if (!ctx) return null;

    // El fondo se repinta: el recorte del original ya lo trae, pero si el
    // margen se sale del lienzo quedarían bandas transparentes.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, target.width, target.height);

    ctx.drawImage(
      source,
      x * ratio,
      y * ratio,
      width * ratio,
      height * ratio,
      0,
      0,
      target.width,
      target.height,
    );

    return target;
  }
}

/**
 * Recorrido del trazo y caja que ocupa.
 *
 * El recorrido es la suma de las distancias entre puntos consecutivos, no la
 * diagonal de la caja: una firma con vueltas recorre mucho en poco espacio, y
 * medirla por su caja la penalizaría por ser compacta.
 */
function measure(strokes: readonly Stroke[]): { path: number; width: number; height: number } {
  let path = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const stroke of strokes) {
    stroke.forEach((point, index) => {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);

      if (index > 0) {
        const previous = stroke[index - 1];
        path += Math.hypot(point.x - previous.x, point.y - previous.y);
      }
    });
  }

  if (!Number.isFinite(minX)) return { path: 0, width: 0, height: 0 };

  return { path, width: maxX - minX, height: maxY - minY };
}
