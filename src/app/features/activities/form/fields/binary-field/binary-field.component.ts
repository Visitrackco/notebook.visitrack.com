import {
  Component,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

import { BinaryResource, BinaryState, BinaryType } from '../../../../../core/models/sync.model';
import {
  BinaryStorageService,
  BinaryValue,
} from '../../../../../core/services/binary-storage.service';
import { ConfirmDialogComponent } from '../../../../../shared/components/confirm-dialog/confirm-dialog.component';
import { IconComponent } from '../../../../../shared/components/icon/icon.component';
import { AudioPlayerComponent } from '../audio-player/audio-player.component';
import { CameraCaptureComponent } from '../camera-capture/camera-capture.component';
import { MediaRecorderComponent } from '../media-recorder/media-recorder.component';
import { MediaViewerComponent } from '../media-viewer/media-viewer.component';
import { PhotoEditorComponent } from '../photo-editor/photo-editor.component';
import { SignaturePadComponent } from '../signature-pad/signature-pad.component';

/** Qué está abierto encima del campo. */
type Overlay =
  | 'none'
  | 'source'
  | 'camera'
  | 'editor'
  | 'signature'
  | 'recorder'
  | 'viewer'
  | 'remove';

/** Cómo se presenta cada tipo. */
interface TypeConfig {
  binary: BinaryType;
  ext: string;
  icon: string;
  /** Texto del botón cuando no hay archivo. */
  action: string;
  hint: string;
  /** Formatos que acepta el selector de archivos. Vacío = cualquiera. */
  accept: string;
  /**
   * Familia MIME que se admite al soltar un archivo encima.
   *
   * Vacío = no se puede soltar nada. Es el caso de la firma: no hay archivo que
   * arrastrar, se traza en el momento.
   */
  drop: string;
}

/**
 * Tope de un video, en bytes.
 *
 * Cien megabytes. No es una cifra arbitraria: el archivo se guarda en
 * IndexedDB y después tiene que subirse desde donde esté el usuario, que a
 * menudo es una conexión móvil en un sitio con mala cobertura. Un video de
 * medio giga no llega nunca y deja la actividad detenida esperándolo, sin que
 * nada explique por qué.
 */
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

const TYPES: Record<string, TypeConfig> = {
  picture: {
    binary: BinaryType.Image,
    ext: 'jpg',
    icon: 'camera',
    action: 'Agregar fotografía',
    hint: 'Con la cámara, desde los archivos o arrastrando una imagen aquí',
    accept: 'image/*',
    drop: 'image/',
  },
  signature: {
    binary: BinaryType.Signature,
    ext: 'png',
    icon: 'user',
    action: 'Firmar',
    hint: 'Firma con el dedo o el ratón',
    accept: '',
    drop: '',
  },
  audio: {
    binary: BinaryType.Audio,
    ext: 'webm',
    icon: 'mic',
    action: 'Grabar audio',
    hint: 'Con el micrófono o arrastrando una grabación aquí',
    accept: 'audio/*',
    drop: 'audio/',
  },
  video: {
    binary: BinaryType.Video,
    ext: 'webm',
    icon: 'video',
    action: 'Grabar video',
    hint: 'Con la cámara o arrastrando un video aquí (hasta 100 MB)',
    accept: 'video/*',
    drop: 'video/',
  },
  file: {
    binary: BinaryType.File,
    ext: '',
    icon: 'file',
    action: 'Adjuntar archivo',
    hint: 'Elige un documento o arrástralo aquí',
    accept: '',
    drop: '*',
  },
};

/**
 * Campo de archivo: fotografía, cámara, firma, audio, video o documento.
 *
 * Los seis comparten casi todo —capturar, mostrar lo capturado, reemplazarlo,
 * borrarlo, y llevar la cuenta de si ya subió—, así que viven en un componente
 * y lo que cambia es de dónde sale el contenido. Cada forma de capturar sí
 * tiene el suyo, porque una cámara en vivo y un lienzo de firma no se parecen
 * en nada.
 *
 * ## El valor y el archivo van por separado
 *
 * En `Fields` se guarda `{bin, sig, lat, lng, acc, pro, tim, tph}`, donde `bin`
 * es el GUID del archivo. El contenido vive en `BinariesData` y su ficha en
 * `BinariesResources`. Es la misma separación que hace la app, y es lo que
 * permite que la actividad viaje al servidor sin arrastrar los megabytes.
 */
@Component({
  selector: 'vt-binary-field',
  standalone: true,
  imports: [
    AudioPlayerComponent,
    CameraCaptureComponent,
    ConfirmDialogComponent,
    IconComponent,
    MediaRecorderComponent,
    MediaViewerComponent,
    PhotoEditorComponent,
    SignaturePadComponent,
  ],
  templateUrl: './binary-field.component.html',
  styleUrl: './binary-field.component.scss',
  host: {
    // El campo entero recibe el archivo, no solo el botón: al arrastrar, el
    // objetivo que se busca con la vista es el recuadro completo.
    '(dragover)': 'onDragOver($event)',
    '(dragleave)': 'onDragLeave($event)',
    '(drop)': 'onDrop($event)',
    '[class.bin--dropping]': 'dragging()',
  },
})
export class BinaryFieldComponent implements OnDestroy {
  private readonly storage = inject(BinaryStorageService);

  readonly fty = input.required<string>();
  readonly label = input('Archivo');
  readonly help = input('');
  readonly required = input(false);
  readonly readOnly = input(false);
  readonly invalid = input(false);

  /**
   * ¿Se puede elegir la fotografía de los archivos del equipo?
   *
   * Lo decide el formulario con `blockGallery`: hay inspecciones donde la
   * evidencia tiene que tomarse en el sitio, y permitir una imagen guardada de
   * antes vaciaría de sentido el requisito.
   */
  readonly allowGallery = input(true);

  /** GUID de la actividad: los archivos cuelgan de ella. */
  readonly answerGuid = input.required<string>();
  readonly fieldId = input.required<string>();

  /** Valor guardado, o `null` si el campo está vacío. */
  readonly value = input<BinaryValue | null>(null);

  readonly valueChange = output<BinaryValue | null>();

  readonly overlay = signal<Overlay>('none');
  readonly busy = signal(false);
  readonly error = signal('');

  /** Ficha del archivo guardado. Se lee al montar y tras cada cambio. */
  readonly resource = signal<BinaryResource | null>(null);

  /** URL para la vista previa. */
  readonly previewUrl = signal('');

  /** La fotografía es más alta que ancha. Lo decide [onThumbLoad]. */
  readonly portrait = signal(false);

  /** Hay un archivo suspendido sobre el campo. */
  readonly dragging = signal(false);

  /** Imagen en espera de pasar por el editor. */
  readonly pendingImage = signal<Blob | null>(null);

  readonly config = computed<TypeConfig>(() => TYPES[this.fty()] ?? TYPES['file']);
  readonly hasValue = computed(() => Boolean(this.value()?.bin));

  /**
   * El contenido llega directo del selector de archivos.
   *
   * Solo el documento: no tiene otra procedencia posible. La fotografía también
   * puede venir de ahí, pero antes se pregunta —lo hace [start]—.
   */
  readonly usesPicker = computed(() => this.fty() === 'file');

  /** Es una fotografía: pasa por el editor al capturarla. */
  readonly isImage = computed(() => this.config().binary === BinaryType.Image);
  readonly isSignature = computed(() => this.config().binary === BinaryType.Signature);
  readonly isAudio = computed(() => this.config().binary === BinaryType.Audio);
  readonly isVideo = computed(() => this.config().binary === BinaryType.Video);

  /**
   * Se dibuja como imagen.
   *
   * La firma también: se guarda en PNG, y sin esto caía en la rama del
   * documento genérico — quedaba un icono de archivo donde debería verse el
   * trazo, que es justo lo que hay que comprobar antes de irse del sitio.
   */
  readonly showsImage = computed(() => this.isImage() || this.isSignature());

  /** Nombre o texto asociado: el del archivo, o quién firmó. */
  readonly caption = computed(() => this.value()?.sig ?? '');

  readonly size = computed(() => {
    const resource = this.resource();
    return resource ? this.storage.formatSize(resource.Size) : '';
  });

  /** Lo que se lee bajo el título en el visor: quién firmó y cuánto pesa. */
  readonly viewerCaption = computed(() =>
    [this.caption(), this.size()].filter(Boolean).join(' · '),
  );

  /**
   * En qué punto del camino al servidor está el archivo.
   *
   * Se muestra porque una actividad con archivos sin confirmar no se envía, y
   * sin este dato el usuario no tiene forma de saber por qué su actividad sigue
   * esperando.
   */
  readonly uploadState = computed(() => {
    const state = this.resource()?.BinaryState ?? BinaryState.Pending;

    switch (state) {
      case BinaryState.Online:
        return { label: 'En línea', tone: 'success' as const };
      case BinaryState.InRepository:
        return { label: 'En servidor', tone: 'info' as const };
      case BinaryState.Discarded:
      case BinaryState.Unrecoverable:
        return { label: 'No disponible', tone: 'danger' as const };
      default:
        return { label: 'Pendiente de subir', tone: 'warning' as const };
    }
  });

  constructor() {
    effect(() => {
      const guid = this.value()?.bin ?? '';
      void this.loadPreview(guid);
    });
  }

  /**
   * Suelta la memoria de la vista previa.
   *
   * Una URL de objeto retiene el `Blob` entero hasta que se revoca. Sin esto,
   * pasar página en un formulario con doce fotos y volver a la anterior deja
   * doce imágenes en memoria por cada vuelta.
   */
  ngOnDestroy(): void {
    const guid = this.value()?.bin;
    if (guid) this.storage.releaseUrl(guid);
  }

  private async loadPreview(guid: string): Promise<void> {
    if (!guid) {
      this.resource.set(null);
      this.previewUrl.set('');
      return;
    }

    this.resource.set(await this.storage.find(guid));

    // Solo lo que se puede reproducir o mirar necesita URL; para un documento
    // basta con su nombre y su tamaño, y reservar memoria para él sería gasto
    // sin uso.
    if (this.showsImage() || this.isAudio() || this.isVideo()) {
      this.previewUrl.set(await this.storage.objectUrl(guid));
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Captura
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Abre lo que corresponda según el tipo.
   *
   * En la fotografía se pregunta primero de dónde sale —cámara o archivos—,
   * igual que la hoja de opciones de la app. Cuando el campo trae `blockGallery`
   * no hay nada que preguntar: solo vale la cámara, y mostrar un menú con una
   * opción deshabilitada añade un paso para no ofrecer nada.
   */
  start(): void {
    if (this.readOnly() || this.busy()) return;
    this.error.set('');

    switch (this.fty()) {
      case 'picture':
        this.overlay.set(this.allowGallery() ? 'source' : 'camera');
        break;
      case 'signature':
        this.overlay.set('signature');
        break;
      case 'audio':
      case 'video':
        this.overlay.set('recorder');
        break;
      default:
        // El documento va directo al selector nativo, que se dispara desde la
        // plantilla con un `<input type="file">` oculto.
        break;
    }
  }

  /** Elegida la cámara en el selector de origen. */
  useCamera(): void {
    this.overlay.set('camera');
  }

  /**
   * Llega un archivo del selector.
   *
   * El `value` del input se limpia siempre: sin eso, volver a elegir **el mismo
   * archivo** no dispara `change` —el valor no cambió— y parecería que el
   * selector se quedó colgado.
   */
  async onFilePicked(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';

    this.overlay.set('none');
    if (!file) return;

    await this.acceptFile(file);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Arrastrar y soltar
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * ¿Este campo acepta que le suelten un archivo encima?
   *
   * La firma no: no hay archivo que arrastrar, se traza en el momento. Y una
   * fotografía con la galería bloqueada tampoco — soltar una imagen guardada es
   * exactamente lo que `blockGallery` prohíbe, y dejarlo entrar por la puerta
   * de atrás vaciaría de sentido el ajuste.
   */
  readonly acceptsDrop = computed(() => {
    if (this.readOnly()) return false;
    if (this.isImage()) return this.allowGallery();

    return this.config().drop !== '';
  });

  onDragOver(event: DragEvent): void {
    if (!this.acceptsDrop()) return;

    // Sin `preventDefault` el navegador abre el archivo en la pestaña y se
    // pierde el formulario a medio diligenciar.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';

    this.dragging.set(true);
  }

  onDragLeave(event: DragEvent): void {
    // Arrastrar por encima de un hijo dispara `dragleave` en el padre. Se
    // comprueba que el puntero salió de verdad del campo, o el resalte
    // parpadearía al pasar sobre el botón o el texto.
    const next = event.relatedTarget as Node | null;
    if (next && (event.currentTarget as HTMLElement).contains(next)) return;

    this.dragging.set(false);
  }

  async onDrop(event: DragEvent): Promise<void> {
    if (!this.acceptsDrop()) return;

    event.preventDefault();
    this.dragging.set(false);

    const file = event.dataTransfer?.files?.[0];
    if (file) await this.acceptFile(file);
  }

  /**
   * Recibe un archivo, venga del selector o de un arrastre.
   *
   * Aquí se comprueba que sea lo que el campo pide: un video soltado en el
   * campo de audio se guardaría sin protestar, y el problema aparecería al
   * abrirlo semanas después, cuando ya nadie recuerda qué se grabó.
   */
  private async acceptFile(file: File): Promise<void> {
    const expected = this.config().drop;

    if (expected !== '*' && expected !== '' && !file.type.startsWith(expected)) {
      this.error.set(`Este campo solo admite ${describeFamily(expected)}.`);
      return;
    }

    if (this.isVideo() && file.size > MAX_VIDEO_BYTES) {
      this.error.set(
        `El video pesa ${this.storage.formatSize(file.size)} y el máximo son 100 MB. ` +
          'Graba uno más corto o comprímelo antes de adjuntarlo.',
      );
      return;
    }

    this.error.set('');

    // Una imagen pasa por el editor, venga de donde venga: recortar y marcar es
    // lo que la convierte en evidencia.
    if (this.isImage()) {
      this.pendingImage.set(file);
      this.overlay.set('editor');
      return;
    }

    await this.store(file, file.name, this.extensionOf(file.name));
  }

  /** La cámara entregó una foto: pasa al editor. */
  onCaptured(blob: Blob): void {
    this.pendingImage.set(blob);
    this.overlay.set('editor');
  }

  /** El editor terminó. */
  async onEdited(blob: Blob): Promise<void> {
    this.overlay.set('none');
    this.pendingImage.set(null);
    await this.store(blob, '', 'jpg');
  }

  /** La firma terminó. */
  async onSigned(result: { blob: Blob; name: string }): Promise<void> {
    this.overlay.set('none');
    await this.store(result.blob, result.name, 'png');
  }

  /**
   * La grabación terminó.
   *
   * El tope de tamaño también se aplica aquí: una grabación larga desde la
   * propia cámara pasa de 100 MB igual que un archivo arrastrado, y dejarla
   * entrar por esta vía haría el límite inútil.
   */
  async onRecorded(blob: Blob): Promise<void> {
    this.overlay.set('none');

    if (this.isVideo() && blob.size > MAX_VIDEO_BYTES) {
      this.error.set(
        `La grabación pesa ${this.storage.formatSize(blob.size)} y el máximo son 100 MB. ` +
          'Graba un video más corto.',
      );
      return;
    }

    await this.store(blob, '', this.config().ext);
  }

  /**
   * Guarda el archivo y publica el valor.
   *
   * Si el campo ya tenía uno, se reemplaza: `save` borra el anterior antes de
   * escribir, para no dejar contenido huérfano ocupando espacio que nadie va a
   * reclamar.
   */
  private async store(blob: Blob, sig: string, ext: string): Promise<void> {
    this.busy.set(true);
    this.error.set('');

    try {
      const value = await this.storage.save({
        blob,
        answerGuid: this.answerGuid(),
        fieldId: this.fieldId(),
        type: this.config().binary,
        ext: ext || 'bin',
        sig,
        replaces: this.value()?.bin,
      });

      this.valueChange.emit(value);
    } catch (error) {
      console.error('[Binary] no se pudo guardar el archivo', error);
      this.error.set('No se pudo guardar el archivo. Inténtalo de nuevo.');
    } finally {
      this.busy.set(false);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Borrado
  // ───────────────────────────────────────────────────────────────────────────

  /** Abre la evidencia a tamaño grande. */
  openViewer(): void {
    if (this.previewUrl()) this.overlay.set('viewer');
  }

  /**
   * Anota si la fotografía es más alta que ancha.
   *
   * Una foto vertical a 600 píxeles de ancho ocupa más de 800 de alto y empuja
   * el resto del formulario fuera de la pantalla: los campos siguientes dejan
   * de verse y parece que la página se acabó ahí. Cuando lo es, la miniatura se
   * recorta y el detalle se ve en el visor.
   */
  onThumbLoad(event: Event): void {
    const image = event.target as HTMLImageElement;
    this.portrait.set(image.naturalHeight > image.naturalWidth);
  }

  askRemove(): void {
    if (this.readOnly()) return;
    this.overlay.set('remove');
  }

  async confirmRemove(): Promise<void> {
    this.overlay.set('none');

    const guid = this.value()?.bin;
    if (guid) await this.storage.remove(guid);

    this.valueChange.emit(null);
  }

  closeOverlay(): void {
    this.overlay.set('none');
    this.pendingImage.set(null);
  }

  /** Descarga el archivo, para los tipos que no se pueden previsualizar. */
  async download(): Promise<void> {
    const guid = this.value()?.bin;
    if (!guid) return;

    const url = await this.storage.objectUrl(guid);
    if (!url) return;

    const link = document.createElement('a');
    link.href = url;
    link.download = this.caption() || `archivo.${this.resource()?.Ext ?? 'bin'}`;
    link.click();
  }

  private extensionOf(name: string): string {
    const parts = name.split('.');
    return parts.length > 1 ? parts.pop()!.toLowerCase() : 'bin';
  }
}

/** Nombre en español de una familia MIME, para el mensaje de error. */
function describeFamily(prefix: string): string {
  switch (prefix) {
    case 'image/':
      return 'imágenes';
    case 'audio/':
      return 'archivos de audio';
    case 'video/':
      return 'archivos de video';
    default:
      return 'archivos de ese tipo';
  }
}
