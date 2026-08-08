import { Component, computed, inject, input, output, signal } from '@angular/core';

import { ListChoice, ListSource } from '../../../../../core/forms/list-source.service';
import { ListDefinition, ListDetail } from '../../../../../core/models/entities.model';
import { PermissionsService } from '../../../../../core/services/permissions.service';
import { IconComponent } from '../../../../../shared/components/icon/icon.component';
import { ListItemFormComponent } from './list-item-form.component';

/**
 * Ventana para elegir un ítem de una lista.
 *
 * ## Solo presenta
 *
 * No sabe de dónde salen los ítems ni cómo se buscan: los recibe ya resueltos y
 * avisa cuando el usuario escribe. Es lo que le permite servir a dos campos que
 * los resuelven de forma muy distinta —el desplegable, por `ent` y `lst`; la
 * tabla de detalle, por la configuración de su lista— sin que ninguno de los
 * dos tenga que copiar la ventana entera para cambiar de dónde lee.
 */
@Component({
  selector: 'vt-list-picker',
  standalone: true,
  imports: [IconComponent, ListItemFormComponent],
  templateUrl: './list-picker.component.html',
  styleUrl: './list-picker.component.scss',
})
export class ListPickerComponent {
  /** Título de la ventana. */
  readonly title = input('Seleccionar');

  /** Aclaración bajo el título: el paso, o de qué se está eligiendo. */
  readonly subtitle = input('');

  /** Los ítems, ya resueltos. `null` mientras no hay nada aún. */
  readonly source = input<ListSource | null>(null);

  readonly loading = input(false);

  /** Ítem ya elegido, para señalarlo. */
  readonly selectedId = input('');

  /**
   * Nombres que ya están en uso.
   *
   * En una tabla de detalle se marcan los ítems que ya tienen fila. No se
   * bloquean —repetir puede ser legítimo, dos revisiones del mismo equipo— pero
   * verlo antes de pulsar evita el duplicado por descuido. La app hace lo mismo.
   */
  readonly usedNames = input<readonly string[]>([]);

  /**
   * Lista a la que se pueden añadir ítems.
   *
   * Sin ella no se ofrece crear: hay orígenes —ubicaciones, activos, usuarios—
   * donde el ítem no es un registro de lista y darlo de alta aquí no
   * significaría nada.
   */
  readonly listDefinition = input<ListDefinition | null>(null);

  /** Contexto con el que nace el ítem, si la lista lo relaciona. */
  readonly parentGuid = input('');
  readonly locationId = input('');
  readonly locationGuid = input('');
  readonly assetId = input('');

  readonly search = output<string>();
  readonly choose = output<ListChoice>();
  readonly cancel = output<void>();

  /** Se acaba de crear un ítem: quien escucha debe recargar y elegirlo. */
  readonly created = output<ListDetail>();

  /** Se está dando de alta un ítem en vez de elegir uno. */
  readonly creating = signal(false);

  /**
   * Se puede crear aquí.
   *
   * Lo decide **solo el permiso del rol** y que la lista exista. Antes esto
   * dependía además de cómo estuviera configurada la lista, y eso dejaba sin
   * poder dar de alta a quien lo necesitaba en la mitad de los casos — sin
   * ninguna razón de negocio detrás.
   */
  readonly canCreate = computed(
    () => Boolean(this.listDefinition()) && this.permissions.canCreateListItems(),
  );

  readonly createBlocked = computed(() =>
    this.listDefinition() && !this.permissions.canCreateListItems()
      ? this.permissions.listsReason()
      : '',
  );

  startCreate(): void {
    if (this.canCreate()) this.creating.set(true);
  }

  cancelCreate(): void {
    this.creating.set(false);
  }

  onCreated(item: ListDetail): void {
    this.creating.set(false);
    this.created.emit(item);
  }

  readonly term = signal('');

  readonly choices = computed(() => this.source()?.choices ?? []);
  readonly hasChoices = computed(() => this.choices().length > 0);
  readonly isOnline = computed(() => this.source()?.origin === 'online');
  readonly truncated = computed(() => this.source()?.truncated === true);
  readonly message = computed(() => this.source()?.message ?? '');

  private readonly permissions = inject(PermissionsService);

  private readonly used = computed(
    () => new Set(this.usedNames().map((name) => name.trim().toLowerCase())),
  );

  /** Filas fantasma del estado de carga. */
  readonly ghosts = [1, 2, 3, 4, 5];

  private timer?: ReturnType<typeof setTimeout>;

  /**
   * Avisa de la búsqueda con retardo.
   *
   * Cada pulsación recorre la lista entera. Sin esperar a que el usuario
   * termine de escribir, teclear «medellín» dispara ocho recorridos de veinte
   * mil registros y la pantalla se atasca justo mientras se escribe.
   */
  onSearch(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.term.set(value);

    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.search.emit(value), 300);
  }

  close(): void {
    clearTimeout(this.timer);
    this.cancel.emit();
  }

  select(choice: ListChoice): void {
    clearTimeout(this.timer);
    this.choose.emit(choice);
  }

  /** ¿Este ítem ya tiene una fila? */
  isUsed(choice: ListChoice): boolean {
    return this.used().has((choice.txt ?? '').trim().toLowerCase());
  }

  /** Inicial del ítem, para la marca de la fila. */
  initialOf(text: string): string {
    return (text ?? '').trim().charAt(0).toUpperCase() || '·';
  }
}
