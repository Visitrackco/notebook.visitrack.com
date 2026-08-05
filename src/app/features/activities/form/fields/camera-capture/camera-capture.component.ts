import {
  Component,
  ElementRef,
  OnDestroy,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { IconComponent } from '../../../../../shared/components/icon/icon.component';

/**
 * Cámara en vivo.
 *
 * Se usa `getUserMedia` y no un `<input capture>` porque este último delega en
 * la aplicación de cámara del sistema: en escritorio no hace nada y en el móvil
 * saca al usuario de la aplicación, con el riesgo de que al volver el navegador
 * haya descartado la página. Aquí la captura ocurre dentro.
 *
 * La cámara trasera es la de partida (`facingMode: environment`): se está
 * documentando algo que se tiene delante, no haciendo un retrato.
 */
@Component({
  selector: 'vt-camera-capture',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './camera-capture.component.html',
  styleUrl: './camera-capture.component.scss',
})
export class CameraCaptureComponent implements OnDestroy {
  readonly captured = output<Blob>();
  readonly cancel = output<void>();

  private readonly videoRef = viewChild<ElementRef<HTMLVideoElement>>('video');

  readonly error = signal('');
  readonly ready = signal(false);
  readonly facing = signal<'environment' | 'user'>('environment');
  readonly hasMultipleCameras = signal(false);

  private stream: MediaStream | null = null;

  /**
   * La pantalla ya se cerró.
   *
   * `getUserMedia` puede tardar segundos —el navegador está preguntando por el
   * permiso—, y en ese rato el usuario puede haberse ido. Sin esta marca, la
   * promesa resolvía después y dejaba la cámara **encendida** apuntando a un
   * componente que ya no existe: el piloto seguía puesto y no había forma de
   * apagarlo salvo recargando la página.
   */
  private closed = false;

  constructor() {
    void this.open();
  }

  ngOnDestroy(): void {
    this.closed = true;
    this.stop();
  }

  private async open(): Promise<void> {
    this.stop();
    this.error.set('');
    this.ready.set(false);

    if (!navigator.mediaDevices?.getUserMedia) {
      this.error.set('Este navegador no permite usar la cámara.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: this.facing(), width: { ideal: 1920 } },
        audio: false,
      });

      // Se cerró mientras se pedía el permiso: se apaga lo que acaba de
      // concederse y no se toca nada más.
      if (this.closed) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      this.stream = stream;

      const video = this.videoRef()?.nativeElement;
      if (video) {
        video.srcObject = stream;
        await video.play();
      }

      this.ready.set(true);
      await this.detectCameras();
    } catch (error) {
      if (!this.closed) this.error.set(describeCameraError(error));
    }
  }

  /**
   * ¿Hay más de una cámara?
   *
   * Solo entonces tiene sentido el botón de cambiar. La consulta va **después**
   * de conceder el permiso: sin él, el navegador devuelve la lista sin
   * etiquetas y a veces incompleta.
   */
  private async detectCameras(): Promise<void> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter((device) => device.kind === 'videoinput');
      this.hasMultipleCameras.set(cameras.length > 1);
    } catch {
      this.hasMultipleCameras.set(false);
    }
  }

  async flip(): Promise<void> {
    this.facing.update((value) => (value === 'environment' ? 'user' : 'environment'));
    await this.open();
  }

  /** Congela el fotograma actual y lo entrega como imagen. */
  async shoot(): Promise<void> {
    const video = this.videoRef()?.nativeElement;
    if (!video || !this.ready()) return;

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // La cámara frontal se muestra en espejo para que resulte natural; la foto
    // se guarda sin espejar, que es como se ve la escena en realidad.
    ctx.drawImage(video, 0, 0);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.92),
    );

    if (blob) {
      this.stop();
      this.captured.emit(blob);
    }
  }

  close(): void {
    this.closed = true;
    this.stop();
    this.cancel.emit();
  }

  /**
   * Apaga la cámara.
   *
   * Cada pista hay que pararla explícitamente: sin esto el piloto sigue
   * encendido después de cerrar, y no hay forma de que el usuario sepa que ya
   * no se está grabando nada.
   *
   * También se suelta el `srcObject` del `<video>`: mientras el elemento
   * conserve la referencia, algunos navegadores mantienen viva la captura
   * aunque las pistas estén paradas.
   */
  private stop(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;

    const video = this.videoRef()?.nativeElement;
    if (video) video.srcObject = null;

    this.ready.set(false);
  }
}

/** Traduce el error de `getUserMedia` a algo accionable. */
function describeCameraError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';

  switch (name) {
    case 'NotAllowedError':
      return 'No se concedió el permiso de cámara. Habilítalo desde el icono de la barra de direcciones y vuelve a intentarlo.';
    case 'NotFoundError':
      return 'No se encontró ninguna cámara en este dispositivo.';
    case 'NotReadableError':
      return 'La cámara está siendo usada por otra aplicación. Ciérrala e inténtalo de nuevo.';
    default:
      return 'No se pudo abrir la cámara. Comprueba que la página esté en HTTPS.';
  }
}
