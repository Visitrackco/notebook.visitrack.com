import { Location } from '@angular/common';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';

import { SurveyAnswer } from '../../core/models/entities.model';
import { BinaryType } from '../../core/models/sync.model';
import { FormEngine } from '../../core/forms/form-engine';
import { FieldValue, FormField } from '../../core/forms/form-schema';
import { ActivityHistoryApi, HistoryActivity } from '../../core/services/activity-history.api';
import { ActivityDownloadService } from '../../core/services/activity-download.service';
import { BinaryExportService } from '../../core/services/binary-export.service';
import { NotifyService } from '../../core/services/notify.service';
import { ToastService } from '../../core/services/toast.service';
import { DispatchFilesService } from '../../core/sync/dispatch-files.service';
import { FieldHostComponent } from '../activities/form/fields/field-host.component';
import { ConfirmDialogComponent } from '../../shared/components/confirm-dialog/confirm-dialog.component';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { ToTopComponent } from '../../shared/components/to-top/to-top.component';

/** Un archivo de la actividad, listo para pintar. */
interface FieldFile {
  guid: string;
  url: string;
  type: BinaryType;
  isImage: boolean;
  isSignature: boolean;
  isVideo: boolean;
  isAudio: boolean;
}

/**
 * Tipos cuyo contenido no está en el valor sino en un archivo.
 *
 * Se dibujan aquí y no con el componente del formulario porque aquél lee el
 * contenido de la base local, y una actividad que solo se está consultando no
 * lo tiene: sus archivos están en el bucket. Ver [ActivityViewComponent].
 */
const BINARY_TYPES = new Set(['picture', 'signature', 'audio', 'video', 'file']);

/**
 * Una actividad del historial, tal como quedó.
 *
 * ## Se dibuja con el formulario de verdad
 *
 * Cada campo se pinta con `vt-field-host`, el mismo componente que usa el
 * formulario cuando se diligencia. No es un ahorro de código: es lo que hace
 * que una respuesta se lea **donde y como** se escribió. Una tabla de
 * etiqueta-y-valor obliga a traducir mentalmente entre dos representaciones de
 * lo mismo, y en una inspección de cuarenta preguntas eso es justo lo que hace
 * que se pase por alto lo que importa.
 *
 * El bloqueo viene marcado desde el servidor: cada campo llega con `rea = true`,
 * que es la marca de solo lectura que todos los tipos ya entienden. Así no
 * depende de que la interfaz se acuerde de desactivar cada control.
 *
 * ## Los campos vacíos se muestran igual
 *
 * Con su etiqueta y su control vacío, en su sitio. Que una pregunta quedara sin
 * responder es información —y en una inspección, a veces la más importante—;
 * omitirla haría creer que el formulario nunca la tuvo.
 *
 * ## Las páginas y los campos ocultos no se muestran
 *
 * Lo que se ve sale del mismo `FormEngine` que gobierna el formulario al
 * diligenciarlo: descarta las páginas marcadas como ocultas y los campos cuya
 * sección no está activa según lo que se respondió. Pintar el esquema completo
 * enseñaría ramas que en esa actividad nunca existieron —el «¿por qué?» de una
 * opción que nadie eligió— y haría leer como omitido lo que jamás se preguntó.
 *
 * La paginación es la misma por el mismo motivo: mismas páginas, mismo orden,
 * misma numeración que vio quien la diligenció.
 *
 * ## Salvo los archivos
 *
 * Los campos de archivo son la única excepción: el componente del formulario
 * busca el contenido en la base local, y aquí los archivos están en el bucket.
 * Se dibujan con las direcciones del servidor.
 */
@Component({
  selector: 'vt-activity-view',
  standalone: true,
  imports: [ConfirmDialogComponent, FieldHostComponent, IconComponent, ToTopComponent],
  templateUrl: './activity-view.component.html',
  styleUrl: './activity-view.component.scss',
})
export class ActivityViewComponent {
  private readonly api = inject(ActivityHistoryApi);
  private readonly downloads = inject(ActivityDownloadService);
  private readonly exporter = inject(BinaryExportService);
  private readonly files = inject(DispatchFilesService);
  private readonly toast = inject(ToastService);
  private readonly notify = inject(NotifyService);
  private readonly location = inject(Location);

  readonly guid = input.required<string>();

  readonly activity = signal<HistoryActivity | null>(null);
  readonly loading = signal(true);
  readonly error = signal('');

  readonly downloading = signal(false);
  readonly exporting = signal(false);

  /** La copia que ya existe en este dispositivo, si la hay. */
  readonly local = signal<SurveyAnswer | null>(null);

  readonly downloaded = computed(() => this.local() !== null);

  /** Esa copia tiene trabajo que todavía no llegó a Visitrack. */
  readonly localPending = computed(() => {
    const copy = this.local();

    return copy ? this.downloads.hasUnsentWork(copy) : false;
  });

  /** Confirmación abierta antes de sobrescribir lo que ya está aquí. */
  readonly asking = signal(false);

  /**
   * El motor del formulario, en modo lectura.
   *
   * Se instancia por actividad y es quien resuelve visibilidad, paginación y
   * campos calculados — exactamente igual que al diligenciar. Aquí solo se le
   * pregunta; no se le escribe nada.
   */
  readonly engine = signal<FormEngine | null>(null);

  /** Páginas visibles, ya sin las ocultas. */
  readonly pageLabels = computed(() =>
    (this.engine()?.pages ?? []).map((page, index) => page.lab || `Página ${index + 1}`),
  );

  /** Página que se está mirando. La lleva el propio motor. */
  readonly page = computed(() => this.engine()?.page() ?? 0);

  /** Campos visibles de esa página, en orden. */
  readonly fields = computed<FormField[]>(() => this.engine()?.visibleFields() ?? []);

  /** Archivos de la actividad, agrupados por el campo que los contiene. */
  readonly filesByField = computed<Map<string, FieldFile[]>>(() => {
    const activity = this.activity();
    const grouped = new Map<string, FieldFile[]>();

    if (!activity) return grouped;

    /**
     * Se reutiliza el lector de las consignas.
     *
     * Sabe encontrar los archivos aunque el `fty` venga con otra grafía o no
     * venga, y entra en las filas de las tablas de detalle. Repetir esa lectura
     * aquí sería copiar reglas que ya costó afinar una vez.
     */
    const pseudo = {
      GUID: activity.GUID,
      Fields: JSON.stringify(activity.JSONAnswers ?? []),
    } as unknown as SurveyAnswer;

    for (const file of this.files.filesOf(pseudo)) {
      const list = grouped.get(file.fieldId) ?? [];

      list.push({
        guid: file.guid,
        url: file.url,
        type: file.type,
        isImage: file.type === BinaryType.Image || file.type === BinaryType.Signature,
        isSignature: file.type === BinaryType.Signature,
        isVideo: file.type === BinaryType.Video,
        isAudio: file.type === BinaryType.Audio,
      });

      grouped.set(file.fieldId, list);
    }

    return grouped;
  });

  readonly title = computed(() => this.activity()?.SurveyName || 'Actividad');

  readonly subtitle = computed(() => {
    const activity = this.activity();

    if (!activity) return '';

    return [
      activity.AssetName,
      activity.LocationName,
      activity.AssignedToName,
      activity.Consecutive ? `#${activity.Consecutive}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  });

  constructor() {
    effect(() => {
      const guid = this.guid();

      untracked(() => void this.load(guid));
    });
  }

  private async load(guid: string): Promise<void> {
    this.loading.set(true);
    this.error.set('');

    const reply = await this.api.detail(guid);

    this.loading.set(false);

    if (!reply.ok || !reply.activity) {
      this.error.set(reply.error ?? 'No se pudo abrir la actividad.');
      return;
    }

    this.activity.set(reply.activity);

    this.engine.set(
      new FormEngine({
        questions: reply.activity.questions,
        answers: reply.activity.JSONAnswers,
        // Sin valores por defecto: aquí un hueco es una pregunta sin responder,
        // no un campo esperando ayuda. Ver FormEngineInput.readOnly.
        readOnly: true,
      }),
    );

    this.local.set(await this.downloads.localCopy(guid));
  }

  // ── Navegación ────────────────────────────────────────────────────────────

  /**
   * Vuelve por donde se entró.
   *
   * `location.back()` y no un enlace fijo: a una actividad se llega desde la
   * pantalla propia del historial o desde la pestaña de una ubicación o un
   * activo, y mandar siempre al mismo sitio sacaría al usuario de donde estaba.
   * La consulta se conserva; la guarda el listado antes de salir.
   */
  back(): void {
    this.location.back();
  }

  /** Página anterior y siguiente, como en el formulario. */
  previousPage(): void {
    this.goToPage(this.page() - 1);
  }

  nextPage(): void {
    this.goToPage(this.page() + 1);
  }

  goToPage(index: number): void {
    const engine = this.engine();

    if (!engine || index < 0 || index >= engine.pages.length) return;

    engine.goTo(index);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ── Acciones ──────────────────────────────────────────────────────────────

  /**
   * Pide descargar. Si ya está aquí, primero pregunta.
   *
   * Descargar encima reemplaza la copia local por la del servidor, y si esa
   * copia tenía cambios sin enviar, eso es trabajo que no está en ningún otro
   * sitio. No se hace en silencio.
   */
  ask(): void {
    if (this.downloaded()) {
      this.asking.set(true);
      return;
    }

    void this.download();
  }

  async download(): Promise<void> {
    const activity = this.activity();

    this.asking.set(false);

    if (!activity || this.downloading()) return;

    this.downloading.set(true);

    const result = await this.downloads.download(activity);

    this.downloading.set(false);

    if (!result.ok) {
      this.toast.error('No se pudo descargar', result.message);
      return;
    }

    this.local.set(await this.downloads.localCopy(activity.GUID));

    // Con sonido: la descarga trae archivos y puede tardar, y el usuario suele
    // haber apartado la vista para cuando termina.
    void this.notify.success('Actividad descargada', result.message);
  }

  /** Saca al computador los archivos de esta actividad, ya descargados. */
  async exportFiles(): Promise<void> {
    const activity = this.activity();

    if (!activity || this.exporting()) return;

    this.exporting.set(true);

    const files = await this.exporter.collect(activity.GUID);

    if (files.length === 0) {
      this.exporting.set(false);
      this.toast.info('Sin archivos', 'Descarga primero la actividad para tener sus archivos aquí.');
      return;
    }

    const result = this.exporter.canWriteFolder
      ? await this.exporter.toFolder(files)
      : await this.exporter.toZip(files);

    this.exporting.set(false);

    if (result.message) {
      if (result.ok) void this.notify.success('Archivos exportados', result.message);
      else this.toast.error('No se pudo exportar', result.message);
    }
  }

  // ── Presentación ──────────────────────────────────────────────────────────

  /** Este campo guarda su contenido en un archivo, no en el valor. */
  isBinary(field: FormField): boolean {
    return BINARY_TYPES.has(String(field.fty ?? '').toLowerCase());
  }

  filesOfField(field: FormField): FieldFile[] {
    return this.filesByField().get(field.id) ?? [];
  }

  /** El valor guardado de un campo. */
  valueOf(field: FormField): FieldValue {
    return this.engine()?.valueOf(field.id) ?? null;
  }

  /**
   * El valor del campo del que este depende.
   *
   * Lo necesitan los desplegables encadenados para resolver su etiqueta: sin
   * él, una lista hija se queda sin saber de qué padre cuelga y muestra el
   * identificador en vez del nombre.
   */
  parentValueOf(field: FormField): string {
    return this.engine()?.parentValueOf(field) ?? '';
  }

  dateOf(raw: string | null): string {
    if (!raw) return '—';

    const date = new Date(raw);

    return Number.isNaN(date.getTime())
      ? String(raw).slice(0, 16)
      : date.toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });
  }
}
