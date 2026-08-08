import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';

import { FormField, ResolvedDescriptor } from '../../../../../core/forms/form-schema';
import { ListDefinition, ListDetail } from '../../../../../core/models/entities.model';
import {
  ListChoice,
  ListSource,
  ListSourceService,
} from '../../../../../core/forms/list-source.service';
import { IconComponent } from '../../../../../shared/components/icon/icon.component';
import { ListPickerComponent } from '../list-picker/list-picker.component';

/** Lo que este campo entrega al motor. */
export interface ListSelection {
  id: string;
  txt: string;
  des: ResolvedDescriptor[];
}

/**
 * Campo de lista desplegable.
 *
 * ## Por qué no es un `<select>`
 *
 * Un desplegable nativo sirve para cinco opciones. Aquí una lista puede tener
 * veinte mil ítems, y el ítem elegido trae datos propios que hay que enseñar
 * —el código, el responsable, la última revisión—. Nada de eso cabe en un
 * `<option>`.
 *
 * La app resuelve esto con una pantalla completa de búsqueda, y esto es lo
 * mismo: un botón que abre un buscador con los ítems y sus detalles.
 *
 * ## Los descriptivos se guardan con la respuesta
 *
 * No se recalculan al reabrir la actividad. El ítem puede cambiar en Visitrack
 * después, y lo que la actividad documenta es lo que decía **cuando se
 * respondió**. Reabrir una inspección de hace un mes y ver los datos de hoy
 * sería reescribir el pasado.
 */
@Component({
  selector: 'vt-list-field',
  standalone: true,
  imports: [IconComponent, ListPickerComponent],
  templateUrl: './list-field.component.html',
  styleUrl: './list-field.component.scss',
})
export class ListFieldComponent {
  private readonly source = inject(ListSourceService);

  readonly field = input.required<FormField>();
  readonly readOnly = input(false);
  readonly invalid = input(false);

  /** Lo elegido, o `null`. */
  readonly value = input<ListSelection | null>(null);

  /** GUID elegido en el campo del que depende, si lo hay. */
  readonly parentValue = input('');

  /**
   * Actividad abierta.
   *
   * De ella salen la ubicación y el activo con los que se filtran las listas
   * ligadas a una u otro.
   */
  readonly answerGuid = input('');

  readonly valueChange = output<ListSelection | null>();

  readonly open = signal(false);

  /** Lo que se está enseñando en el selector. */
  readonly items = signal<ListSource | null>(null);
  readonly loading = signal(false);

  /**
   * La lista de la que se está eligiendo, si es una lista.
   *
   * Solo con ella el selector puede ofrecer dar de alta un ítem: cuando el
   * campo apunta a ubicaciones, activos o usuarios, el ítem no es un registro
   * de lista y crearlo aquí no significaría nada.
   */
  readonly listDefinition = signal<ListDefinition | null>(null);

  /** Ubicación y activo de la actividad, para que el ítem nazca con ellos. */
  readonly context = signal<{ loc: string; ass: string }>({ loc: '', ass: '' });

  readonly selected = computed(() => this.value());

  /** Descriptivos que se enseñan bajo el campo. */
  readonly descriptors = computed(() => this.value()?.des ?? []);

  /**
   * El campo depende de otro que todavía está sin responder.
   *
   * Se calcula del esquema y no del resultado de la consulta: hay que poder
   * avisarlo **antes** de que el usuario abra el selector.
   */
  readonly needsParent = computed(
    () => Boolean(this.field().parentId) && !this.parentValue(),
  );

  constructor() {
    /**
     * Si cambia el campo del que depende, lo elegido deja de valer.
     *
     * Elegir «Antioquia → Medellín» y después cambiar a «Valle» dejaría
     * «Medellín» respondido bajo un departamento al que no pertenece. Se limpia
     * en cuanto el padre cambia.
     */
    effect(() => {
      const parent = this.parentValue();

      untracked(() => {
        if (this.value() && parent !== this.lastParent && this.lastParent !== null) {
          this.valueChange.emit(null);
        }

        this.lastParent = parent;
      });
    });
  }

  /** Último padre visto, para distinguir un cambio real del arranque. */
  private lastParent: string | null = null;

  // ── Selector ───────────────────────────────────────────────────────────────

  /**
   * El selector solo presenta: la carga la hace el campo.
   *
   * Cada campo resuelve sus opciones de forma distinta —este por `ent` y `lst`,
   * una tabla de detalle por la configuración de su lista— y meter esa decisión
   * dentro de la ventana obligaba a que la ventana las conociera todas.
   */
  async openPicker(): Promise<void> {
    if (this.readOnly()) return;

    this.open.set(true);
    this.items.set(null);

    // En paralelo con las opciones: quién puede crear no debe esperar a que
    // termine de cargarse una lista de veinte mil ítems para verlo.
    void this.loadDefinition();
    await this.load('');
  }

  /**
   * La lista del campo y el contexto de la actividad.
   *
   * Se resuelve al abrir y no en el arranque: la mayoría de los campos de un
   * formulario no se llegan a abrir, y hacerlo antes serían decenas de
   * consultas para nada.
   */
  private async loadDefinition(): Promise<void> {
    const field = this.field();

    // Solo las listas propiamente dichas: `ent` 0. Las demás entidades tienen
    // su propio alta, en su propia pantalla.
    if (Number(field.ent ?? 0) !== 0 || (field.opt?.length ?? 0) > 0) {
      this.listDefinition.set(null);
      return;
    }

    try {
      this.listDefinition.set(await this.source.definitionOf(String(field.lst ?? '').trim()));
      this.context.set(await this.source.answerContext(this.answerGuid()));
    } catch {
      this.listDefinition.set(null);
    }
  }

  /**
   * Se acaba de crear un ítem: se recarga y se elige solo.
   *
   * Quien lo dio de alta lo hizo porque lo necesitaba **ahora**; obligarle a
   * buscarlo otra vez en la lista sería un paso sin ningún sentido.
   */
  async onCreated(item: ListDetail): Promise<void> {
    await this.load('');

    const created = this.items()?.choices.find((choice) => choice.id === item.GUID);
    if (created) this.choose(created);
    else this.valueChange.emit({ id: item.GUID, txt: item.Name, des: [] });

    this.close();
  }

  close(): void {
    this.open.set(false);
  }

  onSearch(term: string): void {
    void this.load(term);
  }

  private async load(search: string): Promise<void> {
    this.loading.set(true);

    try {
      this.items.set(
        await this.source.resolve(this.field(), {
          answerGuid: this.answerGuid() || undefined,
          parentValue: this.parentValue() || undefined,
          search,
        }),
      );
    } catch (error) {
      console.error('[Lista] no se pudieron cargar los ítems', error);
      this.items.set({
        origin: 'none',
        choices: [],
        truncated: false,
        message: 'No se pudo cargar la lista.',
      });
    } finally {
      this.loading.set(false);
    }
  }

  choose(choice: ListChoice): void {
    this.valueChange.emit({ id: choice.id, txt: choice.txt, des: choice.des });
    this.close();
  }

  /** Deja el campo sin responder. */
  clear(): void {
    if (this.readOnly()) return;
    this.valueChange.emit(null);
  }
}
