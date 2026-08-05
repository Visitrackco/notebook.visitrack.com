import {
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import { IconComponent } from '../../../../../shared/components/icon/icon.component';

/** Qué se está grabando. */
export type RecorderKind = 'audio' | 'video';

/**
 * Formatos que se intentan, en orden de preferencia.
 *
 * `MediaRecorder` no acepta el mismo contenedor en todos los navegadores: WebM
 * es el de Chrome y Firefox, y Safari solo produce MP4. Se prueba cuál admite
 * en vez de fijar uno, porque fijarlo deja la grabación rota en un navegador
 * entero sin más aviso que un error en consola.
 */
const AUDIO_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
const VIDEO_TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];

/**
 * Grabador de audio y de video.
 *
 * Los dos comparten todo menos la vista previa —el video se ve mientras se
 * graba, el audio no tiene nada que mostrar— y qué pistas se piden al
 * dispositivo, así que van juntos.
 *
 * ## Se puede escuchar antes de guardar
 *
 * Al parar, la grabación queda a la espera con un reproductor: se comprueba que
 * se oye y solo entonces se guarda. Sin ese paso, un micrófono tapado o un
 * ruido de fondo se descubren cuando ya nadie está en el sitio.
 */
@Component({
  selector: 'vt-media-recorder',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './media-recorder.component.html',
  styleUrl: './media-recorder.component.scss',
})
export class MediaRecorderComponent implements OnDestroy {
  readonly kind = input.required<RecorderKind>();

  readonly recorded = output<Blob>();
  readonly cancel = output<void>();

  private readonly videoRef = viewChild<ElementRef<HTMLVideoElement>>('video');

  readonly error = signal('');
  readonly ready = signal(false);
  readonly recording = signal(false);
  readonly seconds = signal(0);

  /** Grabación terminada, a la espera de guardarse o descartarse. */
  readonly result = signal<{ blob: Blob; url: string } | null>(null);

  /**
   * Señal, y no un campo suelto, para que el `<video>` pueda engancharse.
   *
   * La vista previa en vivo se destruye al terminar la grabación y vuelve si se
   * pulsa «Repetir». Al volver es un elemento nuevo y sin fuente: como señal,
   * un efecto la reengancha sola. Con un campo normal habría que acordarse de
   * reasignarla a mano en cada camino, y el que se olvidara dejaría la cámara
   * grabando contra una pantalla en negro.
   */
  private readonly stream = signal<MediaStream | null>(null);

  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private ticker?: ReturnType<typeof setInterval>;

  /**
   * La pantalla ya se cerró.
   *
   * `getUserMedia` tarda lo que tarde el usuario en conceder el permiso, y en
   * ese rato puede haberse ido. Sin esta marca, la promesa resolvía después y
   * dejaba el micrófono **abierto** con el componente ya destruido: el piloto
   * de grabación seguía encendido sin nada que lo apagara.
   */
  private closed = false;

  readonly isVideo = computed(() => this.kind() === 'video');

  readonly title = computed(() => (this.isVideo() ? 'Grabar video' : 'Grabar audio'));

  /** Duración en `m:ss`, que es como se lee un tiempo corto. */
  readonly elapsed = computed(() => {
    const total = this.seconds();
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  });

  constructor() {
    effect(() => {
      const kind = this.kind();

      /**
       * `untracked` no es decorativo.
       *
       * `open` acaba llamando a `stopEverything`, que lee el `viewChild` del
       * `<video>`. Leído dentro del efecto, ese `viewChild` quedaba registrado
       * como dependencia — y como el elemento se destruye al terminar la
       * grabación, el efecto se reejecutaba, volvía a abrir el dispositivo y
       * **borraba la grabación recién hecha**: no había vista previa, no se
       * podía guardar, y cámara y micrófono se quedaban encendidos.
       */
      untracked(() => void this.open(kind));
    });

    // Ata el flujo al elemento cada vez que alguno de los dos cambia. Es lo que
    // hace que «Repetir» vuelva a mostrar la imagen en vivo.
    effect(() => {
      const video = this.videoRef()?.nativeElement;
      const stream = this.stream();

      if (!video || !stream || video.srcObject === stream) return;

      // Segunda barrera contra el eco: si esto no está puesto, el altavoz
      // reproduce lo que el micrófono acaba de captar y todo se graba dos
      // veces. Se repite aquí, además del enlace de la plantilla, porque es
      // la línea que impide que un descuido futuro lo vuelva a romper.
      video.muted = true;
      video.volume = 0;

      video.srcObject = stream;
      void video.play().catch(() => undefined);
    });
  }

  ngOnDestroy(): void {
    this.closed = true;
    this.stopEverything();
  }

  private async open(kind: RecorderKind): Promise<void> {
    this.stopEverything();
    this.error.set('');

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      this.error.set('Este navegador no permite grabar.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        /**
         * El procesado de audio se pide explícitamente.
         *
         * Con `audio: true` a secas, el navegador **no garantiza** aplicarlo:
         * Chrome suele activarlo, Firefox y Safari no siempre. Los tres juntos
         * son lo que hace utilizable una grabación de campo:
         *
         * - `echoCancellation` descarta lo que sale por el altavoz, para que no
         *   vuelva a entrar por el micrófono.
         * - `noiseSuppression` quita el ruido constante — un motor, el viento,
         *   el aire acondicionado de una bodega.
         * - `autoGainControl` nivela la voz de quien habla lejos del equipo.
         */
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: kind === 'video' ? { facingMode: 'environment' } : false,
      });

      // Se cerró mientras se pedía el permiso: se apaga lo que acaba de
      // concederse y no se toca nada más.
      if (this.closed) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      // El `<video>` lo engancha el efecto del constructor, que además lo
      // reengancha si el elemento se destruye y vuelve.
      this.stream.set(stream);
      this.ready.set(true);
    } catch (error) {
      if (!this.closed) this.error.set(describeError(error, kind));
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Grabación
  // ───────────────────────────────────────────────────────────────────────────

  start(): void {
    const stream = this.stream();
    if (!stream || this.recording()) return;

    const mimeType = pickType(this.isVideo() ? VIDEO_TYPES : AUDIO_TYPES);

    try {
      this.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      this.error.set('Este navegador no admite ningún formato de grabación compatible.');
      return;
    }

    const recorder = this.recorder;
    this.chunks = [];
    this.seconds.set(0);

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };

    recorder.onstop = () => {
      // Se toma el tipo del `recorder` local: al llegar aquí, `this.recorder`
      // puede haberse puesto a null si entretanto se cerró la pantalla, y el
      // archivo acabaría guardado como `application/octet-stream` — sin tipo,
      // el navegador no sabe reproducirlo después.
      const blob = new Blob(this.chunks, {
        type: recorder.mimeType || 'application/octet-stream',
      });

      this.chunks = [];

      // Nada que enseñar: se cerró mientras el grabador vaciaba lo suyo.
      if (this.closed || blob.size === 0) return;

      this.result.set({ blob, url: URL.createObjectURL(blob) });
    };

    // Un trozo por segundo. Sin argumento, algunos navegadores no entregan nada
    // hasta el final y una parada brusca se lleva la grabación entera.
    recorder.start(1000);
    this.recording.set(true);
    this.ticker = setInterval(() => this.seconds.update((value) => value + 1), 1000);
  }

  stop(): void {
    if (!this.recording()) return;

    this.recorder?.stop();
    this.recording.set(false);
    clearInterval(this.ticker);
  }

  /** Descarta lo grabado y deja el dispositivo listo para repetir. */
  discard(): void {
    const current = this.result();
    if (current) URL.revokeObjectURL(current.url);

    this.result.set(null);
    this.seconds.set(0);
  }

  accept(): void {
    const current = this.result();
    if (!current) return;

    URL.revokeObjectURL(current.url);
    this.stopEverything();
    this.recorded.emit(current.blob);
  }

  close(): void {
    this.closed = true;
    this.stopEverything();
    this.cancel.emit();
  }

  /**
   * Suelta el micrófono y la cámara.
   *
   * Cada pista se para por separado: sin esto, el piloto del dispositivo sigue
   * encendido tras cerrar y el usuario no tiene forma de saber que ya no se
   * está grabando.
   */
  private stopEverything(): void {
    clearInterval(this.ticker);

    if (this.recorder?.state === 'recording') this.recorder.stop();
    this.recorder = null;

    this.stream()?.getTracks().forEach((track) => track.stop());
    this.stream.set(null);

    // Mientras el `<video>` conserve la referencia, algunos navegadores
    // mantienen viva la captura aunque las pistas estén paradas.
    const video = this.videoRef()?.nativeElement;
    if (video) video.srcObject = null;

    const current = this.result();
    if (current) URL.revokeObjectURL(current.url);

    this.recording.set(false);
    this.ready.set(false);
    this.result.set(null);
  }
}

/** El primer formato que el navegador admite. */
function pickType(candidates: string[]): string {
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
}

/** Traduce el error de permisos a algo accionable. */
function describeError(error: unknown, kind: RecorderKind): string {
  const name = error instanceof DOMException ? error.name : '';
  const device = kind === 'video' ? 'la cámara' : 'el micrófono';

  switch (name) {
    case 'NotAllowedError':
      return `No se concedió el permiso para usar ${device}. Habilítalo desde el icono de la barra de direcciones y vuelve a intentarlo.`;
    case 'NotFoundError':
      return `No se encontró ${device} en este dispositivo.`;
    case 'NotReadableError':
      return `Otra aplicación está usando ${device}. Ciérrala e inténtalo de nuevo.`;
    default:
      return `No se pudo acceder a ${device}. Comprueba que la página esté en HTTPS.`;
  }
}
