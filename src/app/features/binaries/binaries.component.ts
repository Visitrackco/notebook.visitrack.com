import {
  Component,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';

import {
  ALL_STATES,
  BinaryAuditService,
  BinaryEntry,
  describeBinaryState,
  describeBinaryType,
} from '../../core/sync/binary-audit.service';
import { BinaryType } from '../../core/models/sync.model';
import { BinaryStorageService } from '../../core/services/binary-storage.service';
import { BinaryUploadService } from '../../core/sync/binary-upload.service';
import { BinaryVerifyService } from '../../core/sync/binary-verify.service';
import { DataRevisionService } from '../../core/sync/data-revision.service';
import { PendingUploadService } from '../../core/sync/pending-upload.service';
import { ConnectivityService } from '../../core/services/connectivity.service';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { AudioPlayerComponent } from '../activities/form/fields/audio-player/audio-player.component';
import { MediaViewerComponent } from '../activities/form/fields/media-viewer/media-viewer.component';

/**
 * Cuántos archivos por página.
 *
 * Doce, no cincuenta: cada fila trae una vista previa, y una vista previa es
 * una URL de objeto que retiene el archivo completo en memoria mientras exista.
 * Con páginas grandes, abrir esta pantalla en un teléfono con doscientas fotos
 * guardadas lo dejaba sin memoria.
 */
const PAGE_SIZE = 12;

/**
 * Auditoría de archivos.
 *
 * ## Para qué sirve esta pantalla
 *
 * Una actividad con fotografías no se envía hasta que todas estén confirmadas
 * en el servidor de archivos. Cuando algo se atasca, la pregunta del usuario es
 * siempre la misma: *¿qué archivo es y por qué no sube?* Sin un sitio donde
 * mirarlo, la única señal es una actividad detenida sin explicación.
 *
 * Aquí está cada archivo con su estado real, su vista previa y su actividad,
 * y las dos acciones que lo desatascan: subir lo que falta y preguntar al
 * servidor si ya lo publicó.
 */
@Component({
  selector: 'vt-binaries',
  standalone: true,
  imports: [AudioPlayerComponent, IconComponent, MediaViewerComponent],
  templateUrl: './binaries.component.html',
  styleUrl: './binaries.component.scss',
})
export class BinariesComponent implements OnDestroy {
  private readonly audit = inject(BinaryAuditService);
  private readonly storage = inject(BinaryStorageService);
  private readonly revisions = inject(DataRevisionService);

  readonly uploads = inject(BinaryUploadService);
  readonly verify = inject(BinaryVerifyService);
  readonly pendingUploads = inject(PendingUploadService);
  readonly connectivity = inject(ConnectivityService);

  readonly all = signal<BinaryEntry[]>([]);
  readonly loading = signal(true);
  readonly feedback = signal('');

  readonly state = signal<number>(ALL_STATES);
  readonly search = signal('');
  readonly page = signal(0);

  /** URLs de vista previa por GUID, resueltas bajo demanda. */
  readonly previews = signal<Record<string, string>>({});

  /** Archivo abierto en el visor. */
  readonly viewing = signal<BinaryEntry | null>(null);

  readonly stats = computed(() => this.audit.stats(this.all()));

  readonly result = computed(() =>
    this.audit.paginate(this.all(), {
      state: this.state(),
      search: this.search(),
      page: this.page(),
      size: PAGE_SIZE,
    }),
  );

  readonly entries = computed(() => this.result().entries);

  /** Rango que se está viendo, para el pie del listado. */
  readonly range = computed(() => {
    const { page, matching } = this.result();
    if (matching === 0) return '';

    const from = page * PAGE_SIZE + 1;
    const to = Math.min(matching, from + PAGE_SIZE - 1);
    return `${from}–${to} de ${matching}`;
  });

  readonly busy = computed(
    () => this.uploads.isRunning() || this.verify.verifying() || this.pendingUploads.running(),
  );

  /**
   * Archivos cuya vista previa ya se pidió.
   *
   * Un conjunto normal y no una señal, a propósito: si el efecto de abajo
   * leyera una señal que él mismo escribe, se volvería a disparar con cada
   * vista previa resuelta. Ese bucle es lo que dejaba la lista **sin ninguna
   * miniatura**: Angular cortaba el efecto por reentrante antes de que llegara
   * a pintarse nada.
   */
  private readonly requested = new Set<string>();

  constructor() {
    /**
     * La lista se recarga sola cuando cambia algo.
     *
     * Sube el contador cada vez que un archivo se captura, se sube o el
     * servidor lo confirma —lo hagan esta pantalla, el formulario o el proceso
     * automático—. Sin esto, la pantalla mostraba el estado del momento en que
     * se abrió y había que recargar a mano para ver que la subida ya terminó.
     */
    effect(() => {
      this.revisions.binaries();
      untracked(() => void this.reload());
    });

    // Las vistas previas se resuelven solo para lo que está en pantalla. Con
    // doscientos archivos, crear una URL de objeto por cada uno reservaría en
    // memoria todos los blobs a la vez.
    effect(() => {
      const visible = this.entries();

      // `untracked` protege de lo mismo por partida doble: nada de lo que
      // ocurra dentro —lecturas de señales incluidas— vuelve a enganchar este
      // efecto. Su única dependencia es la lista visible.
      untracked(() => void this.resolvePreviews(visible));
    });
  }

  ngOnDestroy(): void {
    // Las URLs se sueltan al salir: retienen el contenido completo de cada
    // archivo hasta que se revocan.
    for (const guid of Object.keys(this.previews())) this.storage.releaseUrl(guid);
  }

  async reload(): Promise<void> {
    this.loading.set(true);

    try {
      this.all.set(await this.audit.load());
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Prepara las vistas previas de lo que se muestra en la propia lista.
   *
   * Los videos quedan fuera a propósito. Pedir su URL trae el archivo entero a
   * memoria, y una página con doce videos de campo son cientos de megabytes
   * para enseñar algo que nadie está mirando. El suyo se resuelve al pulsarlo,
   * en [open].
   */
  private async resolvePreviews(entries: readonly BinaryEntry[]): Promise<void> {
    const pending = entries.filter(
      (entry) => showsInline(entry) && !this.requested.has(entry.resource.GUID),
    );

    if (pending.length === 0) return;

    // Se marcan antes de pedirlas: dos pasadas seguidas —al paginar y volver—
    // encargarían el mismo archivo dos veces mientras la primera sigue en
    // curso.
    for (const entry of pending) this.requested.add(entry.resource.GUID);

    const resolved: Record<string, string> = {};

    for (const entry of pending) {
      const url = await this.storage.objectUrl(entry.resource.GUID);

      if (url) resolved[entry.resource.GUID] = url;
      // Sin contenido no hay nada que reintentar: el archivo se perdió del
      // dispositivo, y la ficha lo dirá con su estado.
    }

    if (Object.keys(resolved).length > 0) {
      this.previews.update((current) => ({ ...current, ...resolved }));
    }
  }

  // ── Filtros ────────────────────────────────────────────────────────────────

  setFilter(value: number): void {
    this.state.set(value);
    this.page.set(0);
  }

  onSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
    this.page.set(0);
  }

  goToPage(index: number): void {
    this.page.set(index);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ── Acciones ───────────────────────────────────────────────────────────────

  /** Sube lo que todavía está solo en este dispositivo. */
  async uploadPending(): Promise<void> {
    this.feedback.set('');
    await this.uploads.uploadPending();
    await this.reload();
    this.feedback.set(this.uploads.progress().message);
  }

  /** Pregunta al servidor cuáles ya están publicados. */
  async confirmOnline(): Promise<void> {
    this.feedback.set('');
    const outcome = await this.verify.verifyAll(false);
    await this.reload();
    this.feedback.set(outcome.message);
  }

  /** Sube, confirma y envía las actividades que queden listas. */
  async processAll(): Promise<void> {
    this.feedback.set('');
    const summary = await this.pendingUploads.run();
    await this.reload();
    this.feedback.set(summary.message);
  }

  /** Descarga el archivo a la carpeta del usuario. */
  async download(entry: BinaryEntry): Promise<void> {
    const url = await this.storage.objectUrl(entry.resource.GUID);
    if (!url) {
      this.feedback.set('El archivo ya no está en este dispositivo.');
      return;
    }

    const link = document.createElement('a');
    link.href = url;
    link.download = `${entry.resource.GUID}.${entry.resource.Ext || 'bin'}`;
    link.click();
  }

  /** Abre el archivo a tamaño grande, cargándolo si aún no estaba. */
  async open(entry: BinaryEntry): Promise<void> {
    if (!canPreview(entry)) return;

    if (!this.previewUrl(entry)) {
      const url = await this.storage.objectUrl(entry.resource.GUID);

      if (!url) {
        this.feedback.set('El archivo ya no está en este dispositivo.');
        return;
      }

      this.requested.add(entry.resource.GUID);
      this.previews.update((current) => ({ ...current, [entry.resource.GUID]: url }));
    }

    this.viewing.set(entry);
  }

  closeViewer(): void {
    this.viewing.set(null);
  }

  // ── Presentación ───────────────────────────────────────────────────────────

  previewUrl(entry: BinaryEntry): string {
    return this.previews()[entry.resource.GUID] ?? '';
  }

  stateOf(entry: BinaryEntry) {
    return describeBinaryState(entry.resource.BinaryState);
  }

  typeOf(entry: BinaryEntry) {
    return describeBinaryType(entry.resource.TypeBinarie);
  }

  size(entry: BinaryEntry): string {
    return this.storage.formatSize(entry.resource.Size);
  }

  /** Momento de la captura, en formato corto. */
  captured(entry: BinaryEntry): string {
    const value = Number(entry.resource.tim);
    if (!Number.isFinite(value) || value <= 0) return '';

    return new Date(value).toLocaleString('es-CO', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /** Fotografía o firma: las dos se dibujan como imagen. */
  isImage(entry: BinaryEntry): boolean {
    return isType(entry, BinaryType.Image) || isType(entry, BinaryType.Signature);
  }

  /** La firma va sobre blanco y sin recortar: es un trazo, no una foto. */
  isSignature(entry: BinaryEntry): boolean {
    return isType(entry, BinaryType.Signature);
  }

  isAudio(entry: BinaryEntry): boolean {
    return isType(entry, BinaryType.Audio);
  }

  isVideo(entry: BinaryEntry): boolean {
    return isType(entry, BinaryType.Video);
  }
}

function isType(entry: BinaryEntry, type: BinaryType): boolean {
  return entry.resource.TypeBinarie === type;
}

/** ¿Se dibuja su contenido en la propia lista? */
function showsInline(entry: BinaryEntry): boolean {
  const type = entry.resource.TypeBinarie;

  return type === BinaryType.Image || type === BinaryType.Signature || type === BinaryType.Audio;
}

/** ¿Se puede abrir a tamaño grande, o solo se descarga? */
function canPreview(entry: BinaryEntry): boolean {
  const type = entry.resource.TypeBinarie;

  return (
    type === BinaryType.Image ||
    type === BinaryType.Signature ||
    type === BinaryType.Video ||
    type === BinaryType.Audio
  );
}
