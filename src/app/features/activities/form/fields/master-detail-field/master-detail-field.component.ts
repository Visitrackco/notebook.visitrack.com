import {
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';

import { allowsBulkPhotos } from '../../../../../core/config/company-rules';
import { FormEngine } from '../../../../../core/forms/form-engine';
import {
  FieldValue,
  FormField,
  ResolvedDescriptor,
  splitFileValue,
} from '../../../../../core/forms/form-schema';
import { ListDetail } from '../../../../../core/models/entities.model';
import { BinaryType } from '../../../../../core/models/sync.model';
import { AuthService } from '../../../../../core/services/auth.service';
import { BinaryStorageService } from '../../../../../core/services/binary-storage.service';
import { InheritedSource } from '../../../../../core/forms/inherited-defaults';
import { ListChoice, ListSource } from '../../../../../core/forms/list-source.service';
import {
  DetailConfig,
  MasterDetailSourceService,
} from '../../../../../core/forms/master-detail-source.service';
import {
  MasterDetailRow,
  createBlankRow,
  createRow,
  readRows,
  rowLimit,
  rowSummary,
} from '../../../../../core/forms/master-detail';
import { ConfirmDialogComponent } from '../../../../../shared/components/confirm-dialog/confirm-dialog.component';
import { HintComponent } from '../../../../../shared/components/hint/hint.component';
import { IconComponent } from '../../../../../shared/components/icon/icon.component';
import { MasterDetailPanelsService } from '../../master-detail-row/master-detail-panels.service';
import { MasterDetailStackService } from '../../master-detail-row/master-detail-stack.service';
import { ListPickerComponent } from '../list-picker/list-picker.component';
import { scrollToCenter } from '../../../../../shared/utils/scroll';

/**
 * Qué está abierto encima del campo.
 *
 * El formulario de una fila **no** está aquí: es una ruta hija. Lo que queda
 * son las dos cosas que sí son del campo — elegir el ítem y confirmar un
 * borrado.
 */
type Overlay = 'none' | 'picker' | 'remove';

/** Lo que se enseña de una fila en el listado. */
interface RowState {
  summary: string;
  progress: string;
  incomplete: boolean;
  /** Respuestas dadas y esperadas, para el porcentaje del campo. */
  filled: number;
  total: number;
}

/**
 * Campo de tabla de detalle.
 *
 * ## Qué es
 *
 * Una lista de filas donde cada una se responde con **su propio formulario**.
 * El caso típico: «los equipos revisados en esta visita», y por cada equipo un
 * cuestionario de estado.
 *
 * ## Lo que decide la lista, no el campo
 *
 * El campo solo dice a qué lista apunta. Es la configuración de esa lista la
 * que determina **qué es cada fila** —una ubicación, un activo, un ítem de
 * inventario, un registro de la lista, o nada— y también **cuál es el
 * formulario** de la fila, que vive en su `jsonFields`. Ese árbol lo resuelve
 * [MasterDetailSourceService]; aquí solo se opera con el resultado.
 *
 * ## La herencia
 *
 * Una fila arrastra el registro del que nació, y el sub-formulario lo usa para
 * dos cosas: rellenar los campos marcados como heredados —la dirección de la
 * sede, el código del equipo— y acotar las listas que tenga dentro. Sin eso, un
 * MasterDetail de equipos por sede pediría elegir la sede otra vez en cada fila.
 *
 * ## El formulario de la fila no se dibuja aquí
 *
 * Una fila es un formulario completo: páginas, obligatorios, fotos, y a veces
 * otra tabla de detalle. Eso vive en una **ruta hija** de la actividad, no en
 * una ventana flotante: así el botón atrás cierra la fila en vez de salir de la
 * actividad, y una tabla dentro de otra es un nivel más de la misma pila.
 *
 * Este campo monta el motor de la fila, la abre y **espera**. Se queda montado
 * detrás —oculto pero vivo— porque es quien tiene que escribir lo respondido de
 * vuelta cuando la fila se cierra.
 */
@Component({
  selector: 'vt-master-detail-field',
  standalone: true,
  imports: [ConfirmDialogComponent, HintComponent, IconComponent, ListPickerComponent],
  templateUrl: './master-detail-field.component.html',
  styleUrl: './master-detail-field.component.scss',
})
export class MasterDetailFieldComponent {
  private readonly source = inject(MasterDetailSourceService);
  private readonly stack = inject(MasterDetailStackService);
  private readonly panels = inject(MasterDetailPanelsService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly auth = inject(AuthService);
  private readonly binaries = inject(BinaryStorageService);

  readonly field = input.required<FormField>();
  readonly value = input<FieldValue>(null);
  readonly readOnly = input(false);
  readonly invalid = input(false);
  readonly answerGuid = input('');

  /**
   * GUID elegido en el campo del que depende, si lo hay.
   *
   * Una tabla de detalle puede encadenarse igual que un desplegable: primero se
   * elige la línea y después solo se ofrecen sus equipos. Sin responder el
   * campo anterior no hay nada que agregar.
   */
  readonly parentValue = input('');

  /**
   * Ítem de la fila que contiene esta tabla, cuando está dentro de otra.
   *
   * Es la herencia entre tablas anidadas: los registros de esta son los ítems
   * que cuelgan de aquel. Sin esto, una tabla dentro de otra ofrecería el
   * catálogo entero en vez de lo que pertenece al ítem que se está detallando
   * — que es justo lo que la app evita pasando el `parentInfo` hacia abajo.
   */
  readonly inheritedParent = input('');

  readonly valueChange = output<MasterDetailRow[]>();

  readonly overlay = signal<Overlay>('none');
  readonly feedback = signal('');

  /** Configuración de la lista: de dónde salen las filas y con qué se llenan. */
  readonly config = signal<DetailConfig | null>(null);
  readonly ready = signal(false);

  /** Ubicación y activo de la actividad, que algunas listas heredan. */
  private readonly answerContext = signal<{ loc: string; ass: string }>({ loc: '', ass: '' });

  /** Lo que enseña el selector, y si está buscando. */
  readonly items = signal<ListSource | null>(null);
  readonly loadingItems = signal(false);

  /**
   * Paso del selector en las listas de dos niveles.
   *
   * `1` elige la ubicación; `2`, uno de sus registros. En los demás orígenes no
   * se usa.
   */
  private readonly step = signal<1 | 2>(1);

  /** Ubicación elegida en el paso 1, para heredarla en la fila. */
  private readonly pickedLocation = signal<ListChoice | null>(null);

  private readonly pendingRemoval = signal<MasterDetailRow | null>(null);

  readonly rows = computed(() => readRows(this.value()));
  readonly limit = computed(() => rowLimit(this.field().limitRows));

  readonly atLimit = computed(() => {
    const limit = this.limit();
    return limit > 0 && this.rows().length >= limit;
  });

  // ── Permisos ───────────────────────────────────────────────────────────────
  //
  // Los valores por omisión son los de la app y no coinciden entre sí: agregar
  // está cerrado salvo que el formulario lo abra, mientras que editar y
  // eliminar están abiertos salvo que los cierre. No es un descuido —añadir
  // registros a un catálogo es la operación que se controla— y cambiarlo aquí
  // haría que el mismo formulario se comportara distinto en la web y en el
  // teléfono.

  readonly canAdd = computed(
    () =>
      (this.field().mobAdd ?? false) &&
      !this.readOnly() &&
      !this.atLimit() &&
      this.ready() &&
      !this.needsParent(),
  );

  /**
   * Depende de un campo que todavía está sin responder.
   *
   * Se anuncia desde fuera y no al abrir el selector: quien está llenando tiene
   * que saber que el paso va antes, no descubrirlo tras pulsar «agregar».
   */
  readonly needsParent = computed(
    () => Boolean(this.field().parentId) && !this.parentValue(),
  );

  readonly canEdit = computed(() => this.field().mobUpd ?? true);
  readonly canDelete = computed(() => (this.field().mobDel ?? true) && !this.readOnly());

  /** Por qué el botón de agregar está apagado. Vacío si no lo está. */
  readonly addBlocked = computed(() => {
    if (this.readOnly()) return '';
    if (!this.ready()) return '';
    if (!(this.field().mobAdd ?? false)) return 'No tienes permiso para agregar registros aquí.';
    if (this.atLimit()) return `Alcanzaste el máximo de ${this.limit()} registros.`;
    if (this.needsParent()) {
      return 'Depende del campo anterior. Respóndelo para poder agregar registros.';
    }

    return '';
  });

  /** Texto del contador de filas. */
  readonly counter = computed(() => {
    const count = this.rows().length;
    const limit = this.limit();
    const noun = count === 1 ? 'registro' : 'registros';

    return limit > 0 ? `${count} de ${limit} ${noun}` : `${count} ${noun}`;
  });

  /** El sub-formulario no tiene campos: la fila es solo el ítem elegido. */
  readonly emptySchema = computed(() => {
    const schema = this.config()?.schema ?? [];
    return schema.length === 0 || schema.every((page) => page.fie.length === 0);
  });

  /** No hay lista, o es de un tipo que no se puede resolver. */
  readonly unavailable = computed(() => this.config()?.origin === 'unavailable');

  readonly listName = computed(() => this.config()?.label ?? this.field().lab);

  /** Nombres ya usados, para señalarlos en el selector. */
  readonly usedNames = computed(() => this.rows().map((row) => row.Name ?? ''));

  // ── La tabla ───────────────────────────────────────────────────────────────

  /**
   * Cuántas filas se enseñan dentro del formulario.
   *
   * Un campo con veinte registros convierte una pregunta en media pantalla de
   * desplazamiento y esconde las que vienen detrás. Se enseñan las primeras y el
   * resto se consulta en su propia pantalla.
   */
  private static readonly PREVIEW = 5;

  /** Se pidió ver todas aquí mismo. Solo lo usan las tablas anidadas. */
  private readonly expanded = signal(false);

  readonly visibleRows = computed(() =>
    this.expanded() ? this.rows() : this.rows().slice(0, MasterDetailFieldComponent.PREVIEW),
  );

  /** Cuántas quedan fuera de la vista previa. */
  readonly hiddenCount = computed(() =>
    this.expanded() ? 0 : Math.max(0, this.rows().length - MasterDetailFieldComponent.PREVIEW),
  );

  /**
   * Esta tabla vive dentro de una fila de otra.
   *
   * Cambia a dónde lleva «Ver todos»: una pantalla aparte destruiría la fila
   * que la contiene —y con ella el campo que espera lo que se responda en
   * ella—, así que aquí se despliega en sitio.
   */
  readonly isNested = computed(() => Boolean(this.inheritedParent()));

  readonly canCollapse = computed(
    () => this.expanded() && this.rows().length > MasterDetailFieldComponent.PREVIEW,
  );

  collapse(): void {
    this.expanded.set(false);
  }

  /**
   * Los encabezados de la tabla: un descriptivo por columna.
   *
   * Salen de lo que cada fila guardó en `JSONTitle`, en el orden en que
   * aparecen. Se unen los de todas las filas porque una fila con un campo
   * oculto no trae ese descriptivo, y esa columna tiene que existir igual para
   * las demás.
   */
  readonly columns = computed(() => {
    const seen: string[] = [];

    for (const row of this.rows()) {
      for (const title of row.JSONTitle ?? []) {
        if (title.lab === '[DEF]' || !title.lab) continue;
        if (!seen.includes(title.lab)) seen.push(title.lab);
      }
    }

    return seen;
  });

  /** Los valores de una fila, en el orden de [columns]. */
  cellsOf(row: MasterDetailRow): string[] {
    const values = new Map((row.JSONTitle ?? []).map((title) => [title.lab, title.val]));

    return this.columns().map((column) => String(values.get(column) ?? ''));
  }

  /**
   * Clave de este campo en la dirección del listado.
   *
   * Lleva el rastro del nivel en que se montó: la misma tabla dentro de dos
   * filas distintas es el mismo campo, y sin el rastro compartirían dirección.
   *
   * Se calcula al montar y no cambia: el rastro del padre es el que había
   * cuando esta pantalla se abrió.
   */
  private readonly panelKey = signal('');

  /**
   * Enseña todos los registros.
   *
   * En el formulario, en su propia pantalla. Dentro de otra fila, desplegados
   * aquí: navegar a una pantalla aparte cerraría la fila que contiene esta
   * tabla, que es lo contrario de lo que se pidió.
   */
  showAll(): void {
    if (this.isNested()) {
      this.expanded.set(true);
      return;
    }

    this.panels.show(this.panelKey());
  }

  constructor() {
    effect(() => {
      const field = this.field();
      const answerGuid = this.answerGuid();

      untracked(() => void this.prepare(field, answerGuid));
    });

    this.trackRowStates();
    this.publishPanel();
  }

  /**
   * Publica lo que este campo sabe hacer, para que el listado lo dibuje.
   *
   * La pantalla del listado es otra ruta y no puede llevarse el campo consigo;
   * en vez de reconstruir allí el árbol de listas, los permisos y la herencia,
   * el campo expone sus operaciones mientras vive.
   */
  private publishPanel(): void {
    effect((onCleanup) => {
      const field = this.field();

      const parent = untracked(() => this.stack.current()?.trail ?? '');
      const key = parent ? `${parent},${field.id}` : field.id;

      untracked(() => this.panelKey.set(key));

      this.panels.register({
        key,
        fieldId: field.id,
        title: field.lab,
        rows: () => this.rows(),
        incompleteRows: () => this.rows().filter((row) => this.isIncomplete(row)),
        columns: () => this.columns(),
        cellsOf: (row) => this.cellsOf(row),
        progressOf: (row) => this.progressOf(row),
        isIncomplete: (row) => this.isIncomplete(row),
        canAdd: () => this.canAdd(),
        canOpen: () => this.canEdit() && !this.emptySchema() && !this.unavailable(),
        canDelete: () => this.canDelete(),
        // El selector lo dibuja este campo, y desde el listado el formulario
        // está oculto detrás: primero se vuelve y después se abre, o el
        // usuario se quedaría mirando una pantalla que no reacciona.
        add: () => void this.panels.close().then(() => this.add()),
        open: (row) => void this.edit(row),
        remove: (row) => this.removeRow(row),
        focus: () => this.scrollIntoView(),
      });

      onCleanup(() => this.panels.unregister(key));
    });
  }

  private async prepare(field: FormField, answerGuid: string): Promise<void> {
    this.ready.set(false);

    try {
      const [config, context] = await Promise.all([
        this.source.configure(field),
        this.source.answerContext(answerGuid),
      ]);

      this.config.set(config);
      this.answerContext.set(context);
    } catch (error) {
      console.error('[MasterDetail] no se pudo leer la configuración del campo', error);
      this.config.set(null);
    } finally {
      this.ready.set(true);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Fotos en bloque
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * ¿Este campo admite soltar varias fotos de golpe?
   *
   * Es una regla de dos compañías cuyo trabajo consiste en documentar con
   * fotografías: una tabla con veinte registros donde cada uno es una sola
   * foto. Crearlos uno a uno —agregar, entrar, tomar la foto, guardar, salir—
   * convierte veinte fotos en veinte recorridos completos. Ver
   * [allowsBulkPhotos].
   */
  readonly acceptsBulkPhotos = computed(() => {
    const user = this.auth.currentUser();
    if (!user || this.readOnly() || !this.canAdd()) return false;

    return allowsBulkPhotos(user.CompanyID, this.field().lab) && Boolean(this.photoField());
  });

  /** El campo de fotografía del sub-formulario, que es donde va cada imagen. */
  private readonly photoField = computed(() => {
    for (const page of this.config()?.schema ?? []) {
      const found = page.fie.find((field) => field.fty === 'picture');
      if (found) return found;
    }

    return null;
  });

  /** Cuántas imágenes quedan por guardar. */
  readonly importing = signal(0);

  /** Se está arrastrando algo encima. */
  readonly dragging = signal(false);

  onDragOver(event: DragEvent): void {
    if (!this.acceptsBulkPhotos()) return;

    event.preventDefault();
    this.dragging.set(true);
  }

  onDragLeave(): void {
    this.dragging.set(false);
  }

  async onDrop(event: DragEvent): Promise<void> {
    this.dragging.set(false);
    if (!this.acceptsBulkPhotos()) return;

    event.preventDefault();

    const files = [...(event.dataTransfer?.files ?? [])].filter((file) =>
      file.type.startsWith('image/'),
    );

    await this.importPhotos(files);
  }

  /** Elegir las fotos del equipo, para quien prefiera el explorador. */
  async onPhotosPicked(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = [...(input.files ?? [])];

    // Se limpia el valor o volver a elegir las mismas fotos no dispara nada.
    input.value = '';

    await this.importPhotos(files);
  }

  /**
   * Crea un registro por cada fotografía.
   *
   * Cada fila nace en blanco —su lista no representa ningún ítem— y llega con
   * la imagen ya respondida en el campo de foto del sub-formulario. Es lo que
   * hace la app: guardar el binario y escribir su referencia dentro de la fila,
   * sin abrir el formulario de ninguna.
   */
  private async importPhotos(files: File[]): Promise<void> {
    const config = this.config();
    const photo = this.photoField();

    if (!config || !photo || files.length === 0) return;

    const limit = this.limit();
    const room = limit > 0 ? Math.max(0, limit - this.rows().length) : files.length;

    if (room === 0) {
      this.feedback.set(`Este campo admite como máximo ${limit} registros.`);
      return;
    }

    const accepted = files.slice(0, room);

    this.feedback.set(
      accepted.length < files.length
        ? `Solo caben ${room} ${room === 1 ? 'registro más' : 'registros más'}: se agregaron ` +
            `las primeras ${room} de ${files.length} fotos.`
        : '',
    );

    this.importing.set(accepted.length);

    const field = this.field();
    const created: MasterDetailRow[] = [];

    try {
      for (const [index, file] of accepted.entries()) {
        try {
          const blob = await shrinkImage(file);

          const value = await this.binaries.save({
            blob,
            answerGuid: this.answerGuid(),
            fieldId: photo.id,
            type: BinaryType.Image,
            ext: 'jpg',
          });

          const row = createBlankRow({
            fieldId: field.id,
            masterListGuid: String(field.lst ?? ''),
            name: `${config.label} ${this.rows().length + created.length + 1}`,
            readOnly: Boolean(field.rea),
            updated: field.mobUpd ?? true,
          });

          /**
           * La fila se arma con el motor, no a mano.
           *
           * Así recibe lo mismo que si se hubiera abierto su formulario: la
           * fecha y la hora del momento, los valores de fábrica y los que
           * hereda del registro. Escribir solo la foto dejaba esos campos
           * vacíos en veinte registros que nadie va a abrir uno por uno.
           *
           * La foto entra como respuesta ya dada del campo de fotografía, y el
           * motor la vuelca repartida entre `val` y `val1` igual que lo haría
           * el propio campo — que es lo que sabe leer el backend.
           */
          const { val, val1 } = splitFileValue(photo.fty, value);

          const engine = new FormEngine({
            questions: config.schema,
            answers: [{ id: photo.id, val, val1, fty: photo.fty, hid: false }],
          });

          created.push({
            ...row,
            JSONValues: [
              ...row.JSONValues,
              ...engine.toAnswerFields().filter((entry) => entry.id !== 'name'),
            ],
          });
        } catch (error) {
          console.error(`[MasterDetail] no se pudo importar la foto ${index + 1}`, error);
        } finally {
          this.importing.update((left) => Math.max(0, left - 1));
        }
      }
    } finally {
      this.importing.set(0);
    }

    if (created.length > 0) this.valueChange.emit([...this.rows(), ...created]);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Agregar una fila
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Empieza una fila nueva.
   *
   * Según el origen hay tres caminos: sin nada que elegir la fila nace vacía y
   * se abre su formulario; en una lista de dos niveles se pide primero la
   * ubicación —salvo que la actividad ya tenga una—; en los demás, el selector.
   */
  async add(): Promise<void> {
    const blocked = this.addBlocked();

    if (blocked) {
      this.feedback.set(blocked);
      return;
    }

    if (!this.canAdd()) return;

    this.feedback.set('');

    const config = this.config();
    if (!config) return;

    if (config.origin === 'blank') {
      this.addBlank(config);
      return;
    }

    // Dos niveles: si la actividad ya trae ubicación, el primer paso sobra.
    if (config.origin === 'location-l2') {
      this.pickedLocation.set(null);
      this.step.set(this.answerContext().loc ? 2 : 1);
    } else {
      this.step.set(1);
    }

    this.overlay.set('picker');
    this.items.set(null);
    await this.loadItems('');
  }

  /** Una fila sin ítem detrás: solo el formulario, repetido. */
  private addBlank(config: DetailConfig): void {
    const field = this.field();

    const row = createBlankRow({
      fieldId: field.id,
      masterListGuid: String(field.lst ?? ''),
      name: `${config.label} ${this.rows().length + 1}`,
      readOnly: Boolean(field.rea),
      updated: field.mobUpd ?? true,
    });

    this.valueChange.emit([...this.rows(), row]);
    void this.openRow(row, true);
  }

  // ── Selector ───────────────────────────────────────────────────────────────

  readonly pickerTitle = computed(() => `Agregar a ${this.field().lab}`);

  readonly pickerSubtitle = computed(() => {
    if (this.config()?.origin !== 'location-l2') return '';

    return this.step() === 1
      ? 'Paso 1 de 2 · Elige la ubicación'
      : `Paso 2 de 2 · ${this.pickedLocation()?.txt ?? 'Registros de la ubicación'}`;
  });

  /**
   * La lista a la que se pueden añadir ítems desde aquí.
   *
   * Solo cuando lo que se está eligiendo son **ítems de una lista**: en el paso
   * de la ubicación, o cuando las filas salen de ubicaciones, activos, usuarios
   * o del inventario, el alta no es de un ítem de lista y se da en otra parte.
   */
  readonly pickerDefinition = computed(() => {
    const config = this.config();
    if (!config) return null;

    const isList =
      config.origin === 'list' || (config.origin === 'location-l2' && this.step() === 2);

    return isList ? (config.target ?? config.definition) : null;
  });

  /**
   * Con qué contexto nace el ítem creado desde aquí.
   *
   * Es el mismo criterio con el que se acotan los ítems que se muestran: si la
   * tabla solo enseña los de una ubicación, uno creado sin esa ubicación no
   * aparecería en la lista de la que acaba de salir.
   */
  readonly createContext = computed(() => {
    const answer = this.answerContext();

    if (this.parentValue()) return { parent: this.parentValue(), loc: '', ass: '' };

    const inherited = this.inheritedFilter();
    if (inherited.loc) return { parent: '', loc: inherited.loc, ass: '' };
    if (answer.ass) return { parent: '', loc: '', ass: answer.ass };
    if (answer.loc) return { parent: '', loc: answer.loc, ass: '' };

    return { parent: this.inheritedParent(), loc: '', ass: '' };
  });

  /**
   * Un ítem recién dado de alta entra como fila sin más trámite.
   *
   * Se recargan las opciones para tomarlo con sus descriptivos ya resueltos; si
   * el filtro de la lista lo dejara fuera, se usa el registro tal cual antes que
   * perder lo que el usuario acaba de escribir.
   */
  async onItemCreated(item: ListDetail): Promise<void> {
    await this.loadItems('');

    const created = this.items()?.choices.find((choice) => choice.id === item.GUID);

    await this.onItemChosen(
      created ?? {
        id: item.GUID,
        txt: item.Name,
        des: [],
        preview: [],
        src: { item, lst: String(item.ListIDBD ?? ''), ent: 0 },
      },
    );
  }

  onSearch(term: string): void {
    void this.loadItems(term);
  }

  private async loadItems(search: string): Promise<void> {
    const config = this.config();
    if (!config) return;

    this.loadingItems.set(true);

    try {
      this.items.set(
        await this.source.choices(
          this.field(),
          config,
          {
            answerGuid: this.answerGuid() || undefined,
            search,
            parentField: this.parentValue() || undefined,
            parent: this.inheritedParent() || undefined,
            ...this.inheritedFilter(),
          },
          this.step(),
        ),
      );
    } catch (error) {
      console.error('[MasterDetail] no se pudieron cargar los registros', error);
      this.items.set({
        origin: 'none',
        choices: [],
        truncated: false,
        message: 'No se pudo cargar la lista.',
      });
    } finally {
      this.loadingItems.set(false);
    }
  }

  /**
   * Por qué se acotan los ítems del paso actual.
   *
   * En una lista de dos niveles, por la ubicación: la elegida en el paso 1 o,
   * si el paso se saltó, la de la actividad. En las demás, por lo que la
   * actividad aporte.
   */
  private inheritedFilter(): { loc?: string; ass?: string } {
    const config = this.config();
    const answer = this.answerContext();

    if (config?.origin === 'location-l2') {
      const picked = locationIdOf(this.pickedLocation()?.src?.item);
      return { loc: picked || answer.loc };
    }

    return {};
  }

  /**
   * Un ítem elegido.
   *
   * En el paso 1 de una lista de dos niveles no crea nada: guarda la ubicación
   * y pasa al segundo. En cualquier otro caso, la fila nace aquí.
   */
  async onItemChosen(choice: ListChoice): Promise<void> {
    const config = this.config();
    if (!config) return;

    if (config.origin === 'location-l2' && this.step() === 1) {
      this.pickedLocation.set(choice);
      this.step.set(2);
      this.items.set(null);
      await this.loadItems('');
      return;
    }

    this.closeOverlay();

    // El tope se vuelve a comprobar aquí y no solo en el botón: entre abrir el
    // selector y elegir puede haberse llenado desde otra parte.
    if (this.atLimit()) {
      this.feedback.set(`Este campo admite como máximo ${this.limit()} registros.`);
      return;
    }

    const field = this.field();
    const src = choice.src ?? {};

    const row = createRow({
      fieldId: field.id,
      masterListGuid: String(field.lst ?? ''),
      itemGuid: choice.id,
      itemName: choice.txt,
      readOnly: Boolean(field.rea),
      updated: field.mobUpd ?? true,

      // La entidad y el catálogo salen del ítem, no del campo: son lo que el
      // servidor usa para saber a qué apunta la fila.
      ent: Number(src.ent ?? field.ent ?? 0),
      item: src.item,
      baseListGuid: src.lst ?? '',
      isLocation: src.loc === true,
      isAsset: src.ass === true,
      locationItem: this.pickedLocation()?.src?.item,
    });

    this.valueChange.emit([...this.rows(), row]);

    /**
     * Un ítem bloqueado no se responde.
     *
     * `Ref1 == 'LockedMD'` marca los registros que se agregan a la tabla pero
     * cuyo formulario no se llena —un consumible que solo se cuenta—. La app lo
     * respeta y aquí igual, o el usuario se encontraría un formulario que no
     * debía ver.
     */
    if (isLocked(src.item) || this.emptySchema()) return;

    // Se abre en cuanto se crea: elegir el ítem es el primer paso, y lo que
    // sigue es responder su formulario.
    void this.openRow(row, true);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Responder una fila
  // ───────────────────────────────────────────────────────────────────────────

  /** Abre una fila guardada. */
  async edit(row: MasterDetailRow): Promise<void> {
    if (this.emptySchema() || this.unavailable()) return;

    if (!this.canEdit()) {
      this.feedback.set(`No tienes permiso para editar los registros de ${this.field().lab}.`);
      return;
    }

    this.feedback.set('');
    await this.openRow(row, false);
  }

  /**
   * Lleva a la pantalla de la fila y espera a que se cierre.
   *
   * El formulario de la fila es una **ruta hija** de la actividad, no una
   * ventana: dentro puede haber páginas, fotos y hasta otra tabla de detalle, y
   * como ventana el botón atrás del navegador saldría de la actividad entera en
   * vez de cerrar lo que se tiene delante.
   *
   * El campo se queda montado detrás —oculto, pero vivo— y es quien escribe el
   * resultado de vuelta cuando la fila se cierra.
   */
  private async openRow(row: MasterDetailRow, fresh: boolean): Promise<void> {
    const config = this.config();
    if (!config) return;

    /**
     * El registro del que nació la fila se recupera **antes** de abrirla.
     *
     * Es lo que alimenta los valores heredados del sub-formulario —la dirección
     * de la sede, el código del equipo—, y el motor los aplica al construirse:
     * llegar tarde significaría montar el formulario con esos campos vacíos.
     */
    const info = await this.source.infoFor(row, config);
    const engine = this.engineFor(row, config, info);

    const outcome = await this.stack.open({
      fieldId: this.field().id,
      rowGuid: row.GUID,
      title: this.field().lab,
      name: row.Name,

      // Lo hereda la tabla que haya dentro de esta fila: sus registros son los
      // ítems que cuelgan del que originó la fila.
      listDetGuid: row.ListDetGUID,
      engine,
      answerGuid: this.answerGuid(),
      fresh,
    });

    /**
     * `auto` es la salida por el navegador —el botón atrás, un enlace—. Se
     * trata como salir: si la fila está completa se guarda, y si no, se
     * conserva o se descarta según sea nueva. Perder lo respondido por
     * retroceder sería el peor de los desenlaces.
     */
    /**
     * `auto` es la salida por el navegador —el botón atrás, un enlace—. Se
     * trata como salir: si la fila está completa se guarda, y si no, se
     * conserva o se descarta según sea nueva. Perder lo respondido por
     * retroceder sería el peor de los desenlaces.
     */
    const discards = outcome === 'discard' || (outcome === 'auto' && fresh && !engine.isComplete());

    if (discards) {
      if (fresh) this.valueChange.emit(this.rows().filter((entry) => entry.GUID !== row.GUID));
    } else {
      this.commit(row, engine);
    }

    // La vista vuelve al campo salga como salga: guardando, descartando o
    // retrocediendo con el navegador. Es el mismo sitio en los tres casos.
    this.scrollIntoView();
  }

  /**
   * Devuelve la vista a este campo.
   *
   * Al volver de una fila o del listado, el formulario reaparece por donde
   * estaba —arriba del todo— y encontrar otra vez la pregunta que se estaba
   * respondiendo obliga a recorrerlo entero. En un formulario de cuarenta
   * campos eso es lo que hace que la gente pierda el hilo.
   *
   * Se espera a que el formulario vuelva a ser visible: mientras hay una
   * pantalla encima está oculto, y a un elemento oculto no se le puede llevar
   * la vista. Con un tope de intentos, porque el cierre puede llevar a otra
   * pantalla y no al formulario —cerrar una fila abierta desde el listado
   * devuelve al listado— y entonces no hay nada que enfocar.
   */
  private scrollIntoView(attempt = 0): void {
    const element = this.host.nativeElement;

    // Mientras hay una pantalla encima, el formulario está oculto y a un
    // elemento oculto no se le puede llevar la vista. Se espera —hasta unos
    // tres segundos— a que vuelva a estar en pantalla. Con tope, porque cerrar
    // una fila abierta desde el listado devuelve al listado y no al formulario,
    // y entonces no hay nada que enfocar.
    if (element.offsetParent === null) {
      if (attempt < 180) requestAnimationFrame(() => this.scrollIntoView(attempt + 1));
      return;
    }

    /**
     * Se espera a que la altura deje de moverse antes de dar por buena la
     * posición.
     *
     * Dos cosas cambian el alto **después** de pedir el desplazamiento: el
     * formulario acaba de reaparecer y sus filas todavía se están colocando, y
     * —al descartar— la fila que se quitó desaparece de la tabla en el
     * repintado siguiente. Con un solo fotograma de espera, el desplazamiento
     * se calculaba contra un formulario más alto del que iba a quedar y
     * terminaba por encima del campo, o directamente arriba del todo.
     *
     * Por eso se desplaza, se vuelve a medir un fotograma después, y si el
     * campo se movió de sitio se corrige. Es imperceptible y evita el caso que
     * más molesta: descartar un registro y aparecer en otra parte del
     * formulario.
     */
    requestAnimationFrame(() => {
      const before = element.getBoundingClientRect().top;

      scrollToCenter(element);

      // Un fotograma después: si el repintado cambió la altura —al descartar,
      // la fila desaparece— el destino calculado ya no vale y se corrige. Sin
      // animación esta vez: la primera ya mostró el movimiento, y repetirlo
      // se vería como un temblor.
      requestAnimationFrame(() => {
        const after = element.getBoundingClientRect().top;

        // Cuatro píxeles de tolerancia: el desplazamiento ya está en marcha y
        // siempre mueve algo. Lo que se busca es el salto de un repintado.
        if (Math.abs(after - before) > 4) scrollToCenter(element, 0);
      });
    });
  }

  private engineFor(
    row: MasterDetailRow,
    config: DetailConfig,
    info: InheritedSource,
  ): FormEngine {
    return new FormEngine({
      questions: config.schema,
      answers: row.JSONValues ?? [],
      inherits: {
        itemsInfo: info.itemsInfo ?? row.itemsInfo,
        LocationInfo: info.LocationInfo ?? row.LocationInfo,
        AssetInfo: info.AssetInfo ?? row.AssetInfo,
      },
    });
  }

  /** Escribe lo respondido en la fila. */
  private commit(row: MasterDetailRow, engine: FormEngine): void {
    const answers = engine.toAnswerFields();
    const header = (row.JSONValues ?? []).filter((entry) => entry.id === 'name');

    const updated: MasterDetailRow = {
      ...row,
      // Se conserva la entrada `name` que se escribe al crear la fila: el motor
      // no la conoce —no es un campo del sub-formulario— y sin este cuidado se
      // perdería al volcar las respuestas.
      JSONValues: [...header, ...answers.filter((entry) => entry.id !== 'name')],
      JSONTitle: [
        { lab: '[DEF]', val: row.Name },
        ...engine
          .toTitles('')
          .filter((title) => title.lab !== '[DEF]')
          .map((title) => ({ lab: title.lab, val: title.val })),
      ],
    };

    this.valueChange.emit(this.rows().map((entry) => (entry.GUID === updated.GUID ? updated : entry)));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Eliminar
  // ───────────────────────────────────────────────────────────────────────────

  askRemove(row: MasterDetailRow): void {
    if (!this.canDelete()) {
      this.feedback.set(`No tienes permiso para eliminar registros de ${this.field().lab}.`);
      return;
    }

    this.feedback.set('');
    this.pendingRemoval.set(row);
    this.overlay.set('remove');
  }

  readonly removalName = computed(() => this.pendingRemoval()?.Name ?? '');

  confirmRemove(): void {
    const row = this.pendingRemoval();
    this.overlay.set('none');
    this.pendingRemoval.set(null);

    if (row) this.removeRow(row);
  }

  /** Quita una fila. Quien llama ya confirmó. */
  private removeRow(row: MasterDetailRow): void {
    this.valueChange.emit(this.rows().filter((entry) => entry.GUID !== row.GUID));
  }

  closeOverlay(): void {
    this.overlay.set('none');
    this.pendingRemoval.set(null);
    this.items.set(null);
    this.pickedLocation.set(null);
    this.step.set(1);
  }

  /** Cierra solo el selector, conservando lo demás. */
  cancelPicker(): void {
    this.overlay.set('none');
    this.items.set(null);
    this.pickedLocation.set(null);
    this.step.set(1);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Presentación
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * El estado de cada fila.
   *
   * ## Por qué es un efecto y no un cálculo derivado
   *
   * Saber cuánto lleva respondida una fila exige montarle su motor y evaluar la
   * visibilidad condicionada de sus campos, y **montar un motor escribe
   * señales** —sus valores iniciales y sus secciones activas—. Angular prohíbe
   * eso dentro de un `computed`, con razón: un cálculo derivado que además
   * modifica estado no tiene un orden de evaluación definido.
   *
   * Así que se calcula al margen, cuando cambian las filas o el esquema, y se
   * deja el resultado en una señal corriente que la plantilla lee.
   */
  private readonly rowStates = signal(new Map<string, RowState>());

  /**
   * Cuánto lleva respondido el campo entero.
   *
   * Suma las respuestas de todas sus filas, no el número de filas completas:
   * con diez registros a medias, «0 % completo» sería falso y desalentador,
   * mientras que «60 %» dice lo que de verdad queda.
   *
   * `null` cuando no hay nada que medir —sin filas, o con un sub-formulario sin
   * preguntas—, y entonces no se enseña.
   */
  readonly progress = computed<{ percent: number; filled: number; total: number } | null>(() => {
    let filled = 0;
    let total = 0;

    for (const row of this.rows()) {
      const state = this.rowStates().get(row.GUID);
      if (!state) continue;

      filled += state.filled;
      total += state.total;
    }

    if (total === 0) return null;

    return { percent: Math.round((filled / total) * 100), filled, total };
  });

  private trackRowStates(): void {
    effect(() => {
      const schema = this.config()?.schema ?? [];
      const rows = this.rows();

      const states = new Map<string, RowState>();

      for (const row of rows) {
        const engine = new FormEngine({
          questions: schema,
          answers: row.JSONValues ?? [],
          inherits: {
            itemsInfo: row.itemsInfo,
            LocationInfo: row.LocationInfo,
            AssetInfo: row.AssetInfo,
          },
        });

        const { filled, total } = engine.progress();

        states.set(row.GUID, {
          summary: rowSummary(row),
          progress: total === 0 ? '' : `${filled} de ${total} respondidas`,
          incomplete: total > 0 && !engine.isComplete(),
          filled,
          total,
        });
      }

      this.rowStates.set(states);
    });
  }


  /**
   * Longitud del aro, en unidades del `viewBox`.
   *
   * Es la circunferencia (2πr con r = 18): así el trazo tiene exactamente una
   * raya del largo del aro, y desplazarla con `stroke-dashoffset` descubre la
   * porción que corresponde al porcentaje. El mismo recurso que el anillo de
   * progreso del formulario.
   */
  readonly ringLength = computed(() => 2 * Math.PI * 18);

  /** Cuánto se retrae el trazo: en 0 % el aro queda vacío; en 100 %, completo. */
  readonly ringOffset = computed(
    () => this.ringLength() * (1 - (this.progress()?.percent ?? 0) / 100),
  );

  summaryOf(row: MasterDetailRow): string {
    return this.rowStates().get(row.GUID)?.summary ?? '';
  }

  progressOf(row: MasterDetailRow): string {
    return this.rowStates().get(row.GUID)?.progress ?? '';
  }

  isIncomplete(row: MasterDetailRow): boolean {
    return this.rowStates().get(row.GUID)?.incomplete ?? false;
  }
}

/**
 * El `LocationID` de una ubicación.
 *
 * Es lo que enlaza los ítems de una lista con su sede, y no coincide con el
 * GUID: los registros de `ListsDet` guardan el identificador numérico.
 */
function locationIdOf(item: unknown): string {
  if (!item || typeof item !== 'object') return '';

  return String((item as { LocationID?: unknown }).LocationID ?? '');
}

/** Un ítem marcado para no abrir su formulario. */
function isLocked(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;

  return String((item as { Ref1?: unknown }).Ref1 ?? '') === 'LockedMD';
}

/**
 * Reduce una fotografía antes de guardarla.
 *
 * Las cámaras de hoy entregan imágenes de varios megabytes, y en una tabla de
 * veinte fotos eso son cuarenta megas que guardar en el navegador y subir
 * después desde donde haya señal. Mil seiscientos píxeles por el lado mayor
 * bastan para documentar, y es la misma medida que usa el editor de fotos del
 * formulario.
 *
 * Si el navegador no puede decodificarla, se guarda tal cual: mejor una foto
 * grande que ninguna.
 */
async function shrinkImage(file: File): Promise<Blob> {
  const MAX_SIDE = 1600;
  const QUALITY = 0.85;

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));

    if (scale === 1 && file.type === 'image/jpeg') {
      bitmap.close();
      return file;
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);

    const ctx = canvas.getContext('2d');
    if (!ctx) return file;

    // Al reducir sin suavizado alto, las líneas finas y el texto de una placa
    // salen dentados.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', QUALITY),
    );

    return blob ?? file;
  } catch {
    return file;
  }
}
