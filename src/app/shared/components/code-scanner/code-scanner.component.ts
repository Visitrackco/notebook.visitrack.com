import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { describeCameraError, detenerCaptura, motivoSinCamara } from '../../utils/camara';
import { IconComponent } from '../icon/icon.component';
import { LectorDeCodigos, crearLector } from './lector-de-codigos';

/** La forma del recuadro: cuadrado para QR, ancho y bajo para barras. */
export type ModoDeEscaneo = 'qr' | 'barras';

/** Donde se recuerda el último modo mientras dure la pestaña. */
const MODO_KEY = 'visitrack.escaner.modo';

/** Una cámara para el selector. */
interface Camara {
  id: string;
  etiqueta: string;
}

/** Lo que salió mal, y si tiene sentido volver a intentarlo. */
interface FalloDelEscaner {
  mensaje: string;
  reintentable: boolean;
}

/**
 * El escáner de códigos QR y de barras.
 *
 * El hermano web de `escaner.dart` del móvil, y se comporta igual: la cámara a
 * pantalla completa (ventana grande en el escritorio), un recuadro que dice
 * dónde poner el código, el recuadro en verde y una vibración al leer, y se
 * cierra solo entregando el texto del **primer** código leído.
 *
 * ## Solo se lee lo que cae en el recuadro
 *
 * Cada fotograma se recorta al recuadro antes de pasárselo al reconocedor. No
 * es solo por rendimiento: con varios códigos a la vista —una estantería de
 * cajas, una placa con QR y código de barras— se lee el que el usuario está
 * señalando y no el que el reconocedor encuentre primero. Con un QR el recuadro
 * es cuadrado; con barras, ancho y bajo, para poder acercarse hasta que el
 * código lo llene de lado a lado, que es cuando las barras finas se distinguen.
 *
 * ## La cámara se apaga siempre
 *
 * Al leer, al cerrar, con Esc o si el componente desaparece por otra razón:
 * una cámara que se queda encendida sin nada en pantalla es lo que hace que la
 * gente deje de dar el permiso.
 */
@Component({
  selector: 'vt-code-scanner',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './code-scanner.component.html',
  styleUrl: './code-scanner.component.scss',
})
export class CodeScannerComponent implements OnInit, OnDestroy {
  /** Con qué modo abrir. Sin él, el último que se usó en esta pestaña. */
  readonly modo = input<ModoDeEscaneo | null>(null);

  /** Qué se está escaneando, para el título: «Escanear código QR», etc. */
  readonly titulo = input('Escanear código');

  /** Se ofrece escribir el código a mano cuando la cámara no sirve. */
  readonly permitirManual = input(true);

  /** El texto del código leído. El escáner ya está apagado cuando llega. */
  readonly leido = output<string>();
  readonly cancel = output<void>();

  /** El usuario prefiere escribirlo: quien abre el escáner pone el campo. */
  readonly manual = output<void>();

  private readonly videoRef = viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly ventanaRef = viewChild<ElementRef<HTMLElement>>('ventana');
  private readonly cerrarRef = viewChild<ElementRef<HTMLButtonElement>>('cerrar');

  /**
   * El modo en curso.
   *
   * Parte del que pide quien abre —el campo sabe si es QR o barras— y si no,
   * del recordado. Cambiarlo a mano sí se recuerda: quien escanea códigos de
   * barras lo hace con todos los de su ronda.
   */
  readonly modoActual = linkedSignal<ModoDeEscaneo>(() => this.modo() ?? modoRecordado());

  readonly iniciando = signal(true);
  readonly listo = signal(false);
  readonly fallo = signal<FalloDelEscaner | null>(null);

  /** Se leyó un código: el recuadro en verde mientras se cierra. */
  readonly leyo = signal(false);

  readonly camaras = signal<Camara[]>([]);
  readonly camaraElegida = signal('');
  readonly hayLinterna = signal(false);
  readonly linterna = signal(false);

  /** Qué motor se está usando, para depurar desde la consola si hace falta. */
  readonly motor = signal<'nativo' | 'zxing' | ''>('');

  readonly indicacion = computed(() => {
    if (this.leyo()) return 'Código leído';
    return this.modoActual() === 'barras'
      ? 'Acerca la cámara hasta que el código de barras llene el recuadro de lado a lado'
      : 'Centra el código QR dentro del recuadro';
  });

  private stream: MediaStream | null = null;
  private lector: LectorDeCodigos | null = null;
  private lienzo: HTMLCanvasElement | null = null;
  private reloj: ReturnType<typeof setTimeout> | undefined;
  private ocupado = false;

  /** Ver `CameraCaptureComponent.closed`: lo mismo, por la misma razón. */
  private cerrado = false;

  /**
   * Esc cierra el escáner, y **solo** el escáner.
   *
   * Se escucha en fase de captura sobre `window` y se detiene la propagación:
   * el armazón atiende los atajos en `document`, y un Esc que llegara hasta él
   * podría además cerrar la actividad que quedó detrás.
   */
  private readonly alPulsar = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  };

  ngOnInit(): void {
    window.addEventListener('keydown', this.alPulsar, true);
    void this.abrir();
  }

  ngOnDestroy(): void {
    window.removeEventListener('keydown', this.alPulsar, true);
    this.cerrado = true;
    this.detener();
  }

  /** Arranca (o rearranca) la cámara y el reconocimiento. */
  async abrir(deviceId = ''): Promise<void> {
    this.detener();
    this.fallo.set(null);
    this.iniciando.set(true);
    this.listo.set(false);

    const sinCamara = motivoSinCamara();
    if (sinCamara) {
      this.fallar(sinCamara, false);
      return;
    }

    /*
     * El reconocedor primero, y en paralelo con el permiso.
     *
     * Si ZXing no se puede descargar no tiene sentido encender la cámara: se
     * pediría un permiso para no hacer nada con él.
     */
    const lector = this.lector ? Promise.resolve(this.lector) : crearLector();
    const captura = navigator.mediaDevices.getUserMedia({
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
        : { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });

    // Se atiende más abajo; esto solo evita que un rechazo temprano —el permiso
    // negado mientras se carga ZXing— salga en la consola como no atendido.
    captura.catch(() => undefined);

    let stream: MediaStream;

    try {
      this.lector = await lector;
      this.motor.set(this.lector.motor);
    } catch (error) {
      console.error('[Escáner] no se pudo cargar el reconocedor', error);
      captura.then(detenerCaptura, () => undefined);
      this.fallar(
        'No se pudo cargar el lector de códigos en este navegador. Si estás sin conexión, ' +
          'conéctate un momento y vuelve a intentarlo.',
        true,
      );
      return;
    }

    try {
      stream = await captura;
    } catch (error) {
      this.fallar(describeCameraError(error), true);
      return;
    }

    if (this.cerrado) {
      detenerCaptura(stream);
      return;
    }

    this.stream = stream;

    try {
      const video = this.videoRef()?.nativeElement;
      if (video) {
        video.srcObject = stream;
        await video.play();
      }
    } catch (error) {
      // `play()` se rechaza si se cerró a mitad; si no, es un fallo de verdad.
      if (this.cerrado) return;
      console.error('[Escáner] no se pudo reproducir la cámara', error);
    }

    const pista = stream.getVideoTracks()[0];
    this.camaraElegida.set(pista?.getSettings().deviceId ?? deviceId);
    this.hayLinterna.set(admiteLinterna(pista));
    this.linterna.set(false);

    this.iniciando.set(false);
    this.listo.set(true);

    void this.buscarCamaras();
    this.programar();

    // El foco al botón de cerrar: quien abrió con el teclado sale con él, y un
    // lector de pantalla anuncia dónde está.
    this.cerrarRef()?.nativeElement.focus({ preventScroll: true });
  }

  /**
   * Las cámaras del equipo, para el selector.
   *
   * Después del permiso: antes, el navegador las lista sin nombre y a veces
   * incompletas.
   */
  private async buscarCamaras(): Promise<void> {
    try {
      const dispositivos = await navigator.mediaDevices.enumerateDevices();
      const camaras = dispositivos
        .filter((d) => d.kind === 'videoinput' && d.deviceId)
        .map((d, i) => ({ id: d.deviceId, etiqueta: d.label || `Cámara ${i + 1}` }));

      this.camaras.set(camaras);
    } catch {
      this.camaras.set([]);
    }
  }

  onCamara(event: Event): void {
    const id = (event.target as HTMLSelectElement).value;
    if (id && id !== this.camaraElegida()) void this.abrir(id);
  }

  cambiarModo(modo: ModoDeEscaneo): void {
    if (modo === this.modoActual()) return;
    this.modoActual.set(modo);
    recordarModo(modo);
  }

  async alternarLinterna(): Promise<void> {
    const pista = this.stream?.getVideoTracks()[0];
    if (!pista) return;

    const encendida = !this.linterna();

    try {
      await pista.applyConstraints({ advanced: [{ torch: encendida } as MediaTrackConstraintSet] });
      this.linterna.set(encendida);
    } catch {
      // Hay cámaras que dicen tener linterna y luego la rechazan: se esconde el
      // botón en vez de dejar uno que no hace nada.
      this.hayLinterna.set(false);
    }
  }

  reintentar(): void {
    void this.abrir(this.camaraElegida());
  }

  escribirAMano(): void {
    this.cerrado = true;
    this.detener();
    this.manual.emit();
  }

  close(): void {
    this.cerrado = true;
    this.detener();
    this.cancel.emit();
  }

  // ── Reconocimiento ─────────────────────────────────────────────────────────

  /**
   * El siguiente intento de lectura.
   *
   * Con `setTimeout` y no en cada fotograma: un código no se mueve tan rápido,
   * y analizar sesenta imágenes por segundo calienta el teléfono para nada.
   * ZXing va más espaciado porque cada intento le cuesta más.
   */
  private programar(): void {
    clearTimeout(this.reloj);
    if (this.cerrado || this.leyo()) return;

    const pausa = this.lector?.motor === 'nativo' ? 120 : 200;
    this.reloj = setTimeout(() => void this.intentar(), pausa);
  }

  private async intentar(): Promise<void> {
    if (this.cerrado || this.leyo() || !this.lector || this.ocupado) return;

    const recorte = this.recortar();
    if (!recorte) {
      this.programar();
      return;
    }

    this.ocupado = true;

    try {
      const lectura = await this.lector.leer(recorte);
      if (lectura?.texto && !this.cerrado && !this.leyo()) {
        this.alLeer(lectura.texto);
        return;
      }
    } catch (error) {
      // Un fotograma que no se pudo analizar no detiene el escáner: el
      // siguiente puede salir bien.
      console.warn('[Escáner] fotograma no analizado', error);
    } finally {
      this.ocupado = false;
    }

    this.programar();
  }

  /**
   * El fotograma actual, recortado al recuadro.
   *
   * El `<video>` llena el escenario con `object-fit: cover`, así que la imagen
   * está escalada y centrada: hay que deshacer esa transformación para saber
   * qué píxeles de la cámara caen bajo el recuadro. Se toma un margen
   * alrededor, porque un código que roza el borde también se espera leído.
   */
  private recortar(): HTMLCanvasElement | null {
    const video = this.videoRef()?.nativeElement;
    const ventana = this.ventanaRef()?.nativeElement;
    if (!video || !ventana || video.readyState < 2 || !video.videoWidth) return null;

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const caja = video.getBoundingClientRect();
    const marco = ventana.getBoundingClientRect();
    if (!caja.width || !caja.height) return null;

    const escala = Math.max(caja.width / vw, caja.height / vh);
    const desfaseX = (caja.width - vw * escala) / 2;
    const desfaseY = (caja.height - vh * escala) / 2;

    const margenX = marco.width * 0.15;
    const margenY = marco.height * 0.15;

    const x0 = Math.max(0, (marco.left - margenX - caja.left - desfaseX) / escala);
    const y0 = Math.max(0, (marco.top - margenY - caja.top - desfaseY) / escala);
    const x1 = Math.min(vw, (marco.right + margenX - caja.left - desfaseX) / escala);
    const y1 = Math.min(vh, (marco.bottom + margenY - caja.top - desfaseY) / escala);

    const ancho = x1 - x0;
    const alto = y1 - y0;
    if (ancho < 16 || alto < 16) return null;

    // Se reduce lo que pase de 1024 px: más resolución no lee mejor y a ZXing
    // le cuesta proporcionalmente más.
    const reduccion = Math.min(1, 1024 / Math.max(ancho, alto));

    this.lienzo ??= document.createElement('canvas');
    const lienzo = this.lienzo;
    lienzo.width = Math.round(ancho * reduccion);
    lienzo.height = Math.round(alto * reduccion);

    const ctx = lienzo.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    ctx.drawImage(video, x0, y0, ancho, alto, 0, 0, lienzo.width, lienzo.height);
    return lienzo;
  }

  /** Se leyó: verde, vibración, y se entrega tras un instante. */
  private alLeer(texto: string): void {
    this.leyo.set(true);
    clearTimeout(this.reloj);

    try {
      navigator.vibrate?.(80);
    } catch {
      // Sin vibración (escritorio, iOS): el verde basta.
    }

    // Un instante en verde para que se vea qué pasó, como en el móvil.
    setTimeout(() => {
      if (this.cerrado) return;
      this.cerrado = true;
      this.detener();
      this.leido.emit(texto);
    }, 350);
  }

  private fallar(mensaje: string, reintentable: boolean): void {
    if (this.cerrado) return;
    this.iniciando.set(false);
    this.listo.set(false);
    this.fallo.set({ mensaje, reintentable });
  }

  /**
   * Apaga la cámara y el reconocimiento.
   *
   * También se suelta el `srcObject`: mientras el `<video>` conserve la
   * referencia, algunos navegadores mantienen viva la captura aunque las
   * pistas estén paradas.
   */
  private detener(): void {
    clearTimeout(this.reloj);
    detenerCaptura(this.stream);
    this.stream = null;

    const video = this.videoRef()?.nativeElement;
    if (video) video.srcObject = null;

    this.listo.set(false);
    this.linterna.set(false);
  }
}

/** ¿La pista deja encender la linterna? Solo Chrome en Android, en la práctica. */
function admiteLinterna(pista: MediaStreamTrack | undefined): boolean {
  try {
    const capacidades = pista?.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
    return Boolean(capacidades?.torch);
  } catch {
    return false;
  }
}

function modoRecordado(): ModoDeEscaneo {
  try {
    return sessionStorage.getItem(MODO_KEY) === 'barras' ? 'barras' : 'qr';
  } catch {
    return 'qr';
  }
}

function recordarModo(modo: ModoDeEscaneo): void {
  try {
    sessionStorage.setItem(MODO_KEY, modo);
  } catch {
    // Sin almacenamiento (navegación privada estricta): se recuerda solo
    // mientras siga abierto este escáner.
  }
}
