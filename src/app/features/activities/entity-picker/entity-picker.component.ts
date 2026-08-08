import { Component, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';

import { IconComponent } from '../../../shared/components/icon/icon.component';
import { Descriptor } from '../../../shared/utils/descriptors';

/** Una opción del selector, ya normalizada. */
export interface PickerItem {
  /** Identificador estable. Solo se usa para el seguimiento del `@for`. */
  id: string;
  name: string;
  /** Campos que ayudan a distinguirla de las demás. */
  descriptors: Descriptor[];
  /** Dato secundario (dirección, código, serie). */
  hint?: string;
}

/**
 * Selector de ubicación o de activo.
 *
 * Es el mismo componente para los dos porque el trabajo es idéntico —una lista
 * larga, un buscador y un toque para elegir— y lo único que cambia es de dónde
 * salen los datos. Tenerlo dos veces significaba arreglar dos veces cada
 * detalle de la búsqueda o del vacío.
 *
 * Es puramente presentacional: no sabe de repositorios ni de rutas. Quien lo
 * usa carga los datos, escucha [choose] y decide a dónde ir después.
 *
 * ## Sobre la paginación
 *
 * La lista llega por páginas porque un cliente puede tener decenas de miles de
 * ubicaciones y pintarlas todas congela la pestaña. La **búsqueda**, en cambio,
 * corre sobre el conjunto completo: buscar solo en lo ya cargado daría «sin
 * resultados» para una sede que sí existe, y eso es peor que tardar un momento.
 */
@Component({
  selector: 'vt-entity-picker',
  standalone: true,
  imports: [IconComponent, MatButtonModule, MatTooltipModule],
  templateUrl: './entity-picker.component.html',
  styleUrl: './entity-picker.component.scss',
})
export class EntityPickerComponent {
  /** Qué se está eligiendo. Sale del nombre del tipo: «Sedes», «Equipos»… */
  readonly title = input.required<string>();

  /** Contexto: de qué actividad y qué formulario viene la elección. */
  readonly subtitle = input('');

  /** Icono de la cabecera y de cada fila. */
  readonly icon = input('map-pin');

  readonly items = input.required<PickerItem[]>();
  readonly loading = input(false);

  /** true mientras la búsqueda recorre el conjunto completo. */
  readonly searching = input(false);

  /** Quedan más páginas por traer. */
  readonly hasMore = input(false);

  readonly searchTerm = input('');

  /** Cuántas opciones hay en total. 0 si no se sabe. */
  readonly totalCount = input(0);

  /** Frase para cuando no hay nada que elegir. */
  readonly emptyMessage = input('No hay opciones disponibles.');

  /**
   * Texto del botón de crear. Vacío lo oculta.
   *
   * Se ofrece aquí porque es donde aparece la necesidad: quien viene a elegir
   * una sede y no la encuentra tiene que poder darla de alta sin abandonar lo
   * que estaba haciendo — y volver a este mismo punto con ella ya elegida.
   */
  readonly createLabel = input('');

  /** Por qué no se puede crear, cuando el rol lo prohíbe. */
  readonly createBlocked = input('');

  readonly search = output<string>();
  readonly loadMore = output<void>();
  readonly choose = output<PickerItem>();
  readonly create = output<void>();
  readonly back = output<void>();

  onSearch(event: Event): void {
    this.search.emit((event.target as HTMLInputElement).value);
  }

  clearSearch(): void {
    this.search.emit('');
  }
}
