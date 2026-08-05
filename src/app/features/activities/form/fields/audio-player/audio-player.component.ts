import { Component, ElementRef, computed, effect, input, signal, viewChild } from '@angular/core';

import { IconComponent } from '../../../../../shared/components/icon/icon.component';

/**
 * Reproductor de una grabación.
 *
 * ## Por qué no `<audio controls>`
 *
 * El reproductor nativo tiene un aspecto distinto en cada navegador —y en
 * Chrome, un gris que no responde al tema— así que dentro de un formulario
 * aparece como algo pegado de fuera. Este usa el mismo elemento `<audio>` por
 * debajo, sin sus controles, y dibuja los suyos.
 *
 * ## La barra de nivel es decorativa
 *
 * No representa la onda real de la grabación: obtenerla exige decodificar el
 * archivo entero con la Web Audio API, y eso son varios megabytes en memoria
 * por cada campo de audio del formulario. Las barras dan la sensación de sonido
 * y marcan el avance, que es para lo que se miran.
 */
@Component({
  selector: 'vt-audio-player',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './audio-player.component.html',
  styleUrl: './audio-player.component.scss',
})
export class AudioPlayerComponent {
  readonly src = input.required<string>();

  /** Texto bajo la barra: el nombre, el tamaño. */
  readonly caption = input('');

  private readonly audioRef = viewChild<ElementRef<HTMLAudioElement>>('audio');

  readonly playing = signal(false);
  readonly current = signal(0);
  readonly duration = signal(0);

  /** Alturas de las barras del nivel. Fijas, para que no bailen al repintar. */
  readonly bars = BARS;

  readonly progress = computed(() => {
    const total = this.duration();
    return total > 0 ? Math.min(1, this.current() / total) : 0;
  });

  readonly elapsed = computed(() => format(this.current()));
  readonly total = computed(() => format(this.duration()));

  constructor() {
    // Al cambiar de grabación se para y se vuelve al principio: seguir sonando
    // la anterior sobre una nueva sería desconcertante.
    effect(() => {
      this.src();
      const audio = this.audioRef()?.nativeElement;
      if (!audio) return;

      audio.pause();
      this.playing.set(false);
      this.current.set(0);
    });
  }

  toggle(): void {
    const audio = this.audioRef()?.nativeElement;
    if (!audio) return;

    if (audio.paused) {
      void audio.play();
      this.playing.set(true);
    } else {
      audio.pause();
      this.playing.set(false);
    }
  }

  onTimeUpdate(): void {
    this.current.set(this.audioRef()?.nativeElement.currentTime ?? 0);
  }

  /**
   * Anota la duración cuando el navegador la conoce.
   *
   * Una grabación de `MediaRecorder` suele llegar con `duration = Infinity`
   * hasta que se reproduce entera: el contenedor WebM no lleva la duración en
   * la cabecera cuando se escribe en directo. Se descarta ese valor para no
   * mostrar `Infinity:NaN` en la etiqueta.
   */
  onMetadata(): void {
    const value = this.audioRef()?.nativeElement.duration ?? 0;
    this.duration.set(Number.isFinite(value) ? value : 0);
  }

  onEnded(): void {
    this.playing.set(false);
    this.current.set(0);
  }

  /** Salta al punto pulsado de la barra. */
  seek(event: MouseEvent): void {
    const audio = this.audioRef()?.nativeElement;
    const total = this.duration();
    if (!audio || total <= 0) return;

    const bar = event.currentTarget as HTMLElement;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));

    audio.currentTime = ratio * total;
    this.current.set(audio.currentTime);
  }
}

/**
 * Alturas de las barras, en porcentaje.
 *
 * Escritas a mano y no generadas al azar: con `Math.random()` cambiarían en
 * cada repintado y el nivel parecería temblar.
 */
const BARS = [
  34, 58, 42, 76, 90, 64, 48, 82, 96, 70, 52, 38, 62, 88, 74, 46, 30, 56, 80, 92, 68, 44, 36, 60,
  84, 72, 50, 40, 66, 54,
];

/** Segundos → `m:ss`. */
function format(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';

  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
