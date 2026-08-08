import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';

import { FormEngine } from '../../../../../core/forms/form-engine';
import { FieldValue, FormField, ResolvedDescriptor } from '../../../../../core/forms/form-schema';
import { ListDefinition, ListDetail } from '../../../../../core/models/entities.model';
import { AlertSoundService } from '../../../../../core/services/alert-sound.service';
import { ListItemEditorService } from '../../../../../core/services/list-item-editor.service';
import { IconComponent } from '../../../../../shared/components/icon/icon.component';
import { FieldHostComponent } from '../field-host.component';
import {
  MissingEntry,
  RequiredDialogComponent,
} from '../../required-dialog/required-dialog.component';

/**
 * Dar de alta un ítem de lista sin salir de donde se estaba.
 *
 * ## Por qué aquí dentro
 *
 * La necesidad aparece en el selector: se busca un ítem, no está, y hay que
 * seguir trabajando. Mandar a otra pantalla obligaría a rehacer el camino —y en
 * una tabla de detalle, a perder la fila que se estaba creando—.
 *
 * ## Los campos los pone la lista
 *
 * `jsonFields` de la lista define qué se pregunta, con los mismos tipos que un
 * formulario. Por eso se usa el motor y el mismo repartidor de campos: escribir
 * un editor aparte sería una segunda implementación de los veintitantos tipos.
 *
 * Muchas listas no definen ninguno y el ítem es solo su nombre. Es un caso
 * legítimo y frecuente, no un error de configuración.
 */
@Component({
  selector: 'vt-list-item-form',
  standalone: true,
  imports: [FieldHostComponent, IconComponent, RequiredDialogComponent],
  templateUrl: './list-item-form.component.html',
  styleUrl: './list-item-form.component.scss',
})
export class ListItemFormComponent {
  private readonly editor = inject(ListItemEditorService);
  private readonly sound = inject(AlertSoundService);

  /** Lista a la que se añade. */
  readonly definition = input.required<ListDefinition>();

  /** Ítem del que cuelga, en las listas encadenadas. */
  readonly parentGuid = input('');

  /** Ubicación y activo de la actividad, si la lista se relaciona con ellos. */
  readonly locationId = input('');
  readonly locationGuid = input('');
  readonly assetId = input('');

  readonly created = output<ListDetail>();
  readonly cancel = output<void>();

  readonly name = signal('');
  readonly saving = signal(false);
  readonly error = signal('');
  readonly submitted = signal(false);

  readonly engine = signal<FormEngine | null>(null);

  readonly listName = computed(() => this.definition().Name || 'la lista');
  readonly nameMissing = computed(() => this.submitted() && !this.name().trim());

  /** El aviso de obligatorios está abierto. */
  readonly askingRequired = signal(false);

  /**
   * Todo lo que impide crear el ítem.
   *
   * El nombre va primero: no es un campo de la lista sino su identidad, y sin
   * él el ítem no se podría ni reconocer en el selector del que va a formar
   * parte.
   */
  readonly blocking = computed<MissingEntry[]>(() => {
    const entries: MissingEntry[] = [];

    if (!this.name().trim()) {
      entries.push({
        field: { id: '__name', fty: 'TextLine', lab: 'Nombre', req: true },
        page: 0,
        go: () => focusName(),
      });
    }

    return [...entries, ...(this.engine()?.missing() ?? [])];
  });

  readonly pageLabels = computed(() =>
    (this.engine()?.pages ?? []).map((page, index) => page.lab || `Página ${index + 1}`),
  );

  constructor() {
    effect(() => {
      const definition = this.definition();

      untracked(() => {
        this.name.set('');
        this.error.set('');
        this.submitted.set(false);

        const pages = this.editor.schemaOf(definition);
        this.engine.set(pages.length > 0 ? new FormEngine({ questions: pages, answers: [] }) : null);
      });
    });
  }

  onName(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
  }

  onValue(field: FormField, value: FieldValue): void {
    this.engine()?.setValue(field, value);
  }

  onDescriptors(field: FormField, values: ResolvedDescriptor[]): void {
    this.engine()?.setDescriptors(field.id, values);
  }

  /** Cierra el aviso y lleva al primero que falta. */
  reviewRequired(): void {
    const first = this.blocking()[0];

    this.askingRequired.set(false);
    if (first) this.goToMissing(first);
  }

  /** Lleva a un campo concreto de los que faltan. */
  goToMissing(entry: MissingEntry): void {
    this.askingRequired.set(false);

    if (entry.go) {
      entry.go();
      return;
    }

    this.engine()?.goTo(entry.page);

    // Tras el repintado: el campo puede estar en otra página y no existir
    // todavía en el documento cuando esto se llama.
    setTimeout(() => {
      const element = document.getElementById(`item-field-${entry.field.id}`);
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      element?.querySelector<HTMLElement>('input, textarea, select')?.focus({
        preventScroll: true,
      });
    });
  }

  async save(): Promise<void> {
    if (this.saving()) return;

    const engine = this.engine();

    this.submitted.set(true);
    engine?.markSubmitted();

    /**
     * Lo que falta se enseña y se oye.
     *
     * Un ítem de lista lo van a elegir después todos los demás: uno creado a
     * medias reaparece en cada actividad que use esa lista, y el que lo
     * escogió no tiene forma de saber que le faltan datos. Por eso aquí no se
     * ofrece guardar incompleto.
     */
    if (this.blocking().length > 0) {
      this.askingRequired.set(true);
      void this.sound.warn();
      return;
    }

    this.saving.set(true);
    this.error.set('');

    try {
      const item = await this.editor.create({
        definition: this.definition(),
        name: this.name().trim(),
        answers: engine?.toAnswerFields() ?? [],
        fields: (engine?.pages ?? []).flatMap((page) => page.fie),
        parentGuid: this.parentGuid() || undefined,
        locationId: this.locationId() || undefined,
        locationGuid: this.locationGuid() || undefined,
        assetId: this.assetId() || undefined,
      });

      this.created.emit(item);
    } catch (error) {
      console.error('[Listas] no se pudo crear el ítem', error);
      this.error.set('No se pudo crear el ítem. Inténtalo de nuevo.');
    } finally {
      this.saving.set(false);
    }
  }
}

/** Lleva al nombre, que vive fuera del motor y no tiene tarjeta propia. */
function focusName(): void {
  const input = document.getElementById('item-name');

  input?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  (input as HTMLInputElement | null)?.focus({ preventScroll: true });
}
