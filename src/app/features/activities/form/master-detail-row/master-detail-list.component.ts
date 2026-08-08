import { Component, OnDestroy, computed, effect, inject, input, signal } from '@angular/core';

import { MasterDetailRow } from '../../../../core/forms/master-detail';
import { ConfirmDialogComponent } from '../../../../shared/components/confirm-dialog/confirm-dialog.component';
import { IconComponent } from '../../../../shared/components/icon/icon.component';
import { ToTopComponent } from '../../../../shared/components/to-top/to-top.component';
import { MasterDetailPanelsService } from './master-detail-panels.service';

/**
 * El listado completo de una tabla de detalle.
 *
 * ## Por qué existe
 *
 * En el formulario solo caben unos pocos registros: veinte equipos revisados
 * convierten una pregunta en media pantalla de desplazamiento, y las que vienen
 * detrás dejan de verse. Allí se enseñan los primeros y desde aquí se ve todo,
 * con buscador y en tabla.
 *
 * ## No tiene datos propios
 *
 * Todo lo que dibuja —las filas, las columnas, los permisos— lo expone el campo
 * del formulario, que sigue montado detrás. Reconstruirlo aquí desde la base
 * habría significado repetir el árbol de listas y la herencia en una segunda
 * implementación que se desincroniza a la primera corrección.
 */
@Component({
  selector: 'vt-master-detail-list',
  standalone: true,
  imports: [ConfirmDialogComponent, IconComponent, ToTopComponent],
  templateUrl: './master-detail-list.component.html',
  styleUrl: './master-detail-list.component.scss',
})
export class MasterDetailListComponent implements OnDestroy {
  private readonly panels = inject(MasterDetailPanelsService);

  /** Campo que se está enseñando, desde la dirección. */
  readonly panel = input('');

  readonly search = signal('');
  private readonly pendingRemoval = signal<MasterDetailRow | null>(null);
  readonly asking = computed(() => this.pendingRemoval() !== null);

  readonly current = computed(() => this.panels.current());
  readonly columns = computed(() => this.current()?.columns() ?? []);

  /** Todas las filas del campo. */
  private readonly all = computed(() => this.current()?.rows() ?? []);

  /**
   * Las que coinciden con la búsqueda.
   *
   * Busca en el nombre **y en los datos**: dos registros que se llaman igual se
   * distinguen justo por su placa o su sede, que es lo que se teclea para dar
   * con uno concreto.
   */
  readonly rows = computed(() => {
    const needle = this.search().trim().toLowerCase();
    const panel = this.current();
    if (!needle || !panel) return this.all();

    return this.all().filter((row) => {
      const haystack = [row.Name ?? '', ...panel.cellsOf(row)].join(' ').toLowerCase();
      return haystack.includes(needle);
    });
  });

  readonly counter = computed(() => {
    const total = this.all().length;
    const shown = this.rows().length;
    const noun = total === 1 ? 'registro' : 'registros';

    return shown === total ? `${total} ${noun}` : `${shown} de ${total} ${noun}`;
  });

  readonly removalName = computed(() => this.pendingRemoval()?.Name ?? '');

  constructor() {
    /**
     * Sin campo que enseñar no hay pantalla.
     *
     * Pasa al recargar la página sobre esta dirección: el campo vive en el
     * formulario y no sobrevive a una recarga. Se vuelve a la actividad, que es
     * de donde se llega aquí.
     */
    effect(() => {
      const key = this.panel();
      this.panels.openKey.set(key);

      if (!this.panels.has(key)) this.panels.backToActivity();
    });
  }

  ngOnDestroy(): void {
    // Se vuelve al formulario: que la vista aterrice en el campo del que se
    // salió y no arriba del todo.
    this.current()?.focus();
    this.panels.openKey.set('');
  }

  close(): void {
    void this.panels.close();
  }

  cellsOf(row: MasterDetailRow): string[] {
    return this.current()?.cellsOf(row) ?? [];
  }

  progressOf(row: MasterDetailRow): string {
    return this.current()?.progressOf(row) ?? '';
  }

  isIncomplete(row: MasterDetailRow): boolean {
    return this.current()?.isIncomplete(row) ?? false;
  }

  onSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  add(): void {
    this.current()?.add();
  }

  open(row: MasterDetailRow): void {
    this.current()?.open(row);
  }

  askRemove(row: MasterDetailRow): void {
    this.pendingRemoval.set(row);
  }

  confirmRemove(): void {
    const row = this.pendingRemoval();
    this.pendingRemoval.set(null);

    if (row) this.current()?.remove(row);
  }

  cancelRemove(): void {
    this.pendingRemoval.set(null);
  }
}
