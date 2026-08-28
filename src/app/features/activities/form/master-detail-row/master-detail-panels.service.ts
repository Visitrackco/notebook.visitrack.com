import { Location } from '@angular/common';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Router, Scroll } from '@angular/router';
import { filter, firstValueFrom, race, timer } from 'rxjs';

import { MasterDetailRow } from '../../../../core/forms/master-detail';
import { MasterDetailStackService } from './master-detail-stack.service';

/**
 * Lo que un campo de tabla de detalle expone para que otra pantalla lo dibuje.
 *
 * No son datos sueltos: son las operaciones del campo. La pantalla del listado
 * no sabe de listas, permisos ni herencia — llama a `add`, `open` y `remove`, y
 * el campo hace lo suyo con todo el contexto que ya tiene.
 */
export interface DetailPanel {
  /** Identifica el panel en la dirección. */
  key: string;

  /** Campo del formulario al que pertenece. */
  fieldId: string;

  /** Nombre del campo: «Equipos revisados». */
  title: string;

  /**
   * Filas a las que les faltan obligatorios.
   *
   * Con esto el formulario valida la tabla igual que valida un campo suelto: no
   * basta con que tenga registros, tienen que estar respondidos.
   */
  incompleteRows: () => MasterDetailRow[];

  rows: () => MasterDetailRow[];

  /** Encabezados de la tabla, uno por descriptivo. */
  columns: () => string[];

  /** Valores de una fila, en el orden de [columns]. */
  cellsOf: (row: MasterDetailRow) => string[];

  progressOf: (row: MasterDetailRow) => string;
  isIncomplete: (row: MasterDetailRow) => boolean;

  canAdd: () => boolean;
  canOpen: () => boolean;
  canDelete: () => boolean;

  add: () => void;
  open: (row: MasterDetailRow) => void;
  remove: (row: MasterDetailRow) => void;

  /**
   * La pantalla del listado se cerró.
   *
   * Lo usa el campo para devolver la vista a su sitio: al volver, el formulario
   * aparece por donde estaba —arriba del todo— y encontrar de nuevo la pregunta
   * que se estaba respondiendo obliga a recorrerlo entero.
   */
  focus: () => void;
}

/**
 * Los campos de tabla de detalle que hay abiertos, por si alguien quiere
 * enseñarlos a pantalla completa.
 *
 * ## Por qué el campo no se lleva la pantalla consigo
 *
 * El listado completo es otra ruta, y una ruta hermana destruiría el formulario
 * —y con él el campo, sus filas y sus permisos—. En vez de reconstruir todo eso
 * desde la base en la otra pantalla, el campo **se registra** aquí mientras
 * vive, y la pantalla del listado se limita a dibujar lo que el campo expone.
 *
 * Es el mismo trato que con el formulario de una fila: una pantalla propia para
 * el usuario, un solo sitio donde vive el estado.
 */
@Injectable({ providedIn: 'root' })
export class MasterDetailPanelsService {
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly stack = inject(MasterDetailStackService);

  private readonly panels = signal(new Map<string, DetailPanel>());

  /** Panel que se está enseñando, si la dirección apunta a alguno. */
  readonly openKey = signal('');

  readonly current = computed(() => this.panels().get(this.openKey()) ?? null);

  /**
   * Los campos de tabla de detalle del formulario, sin los anidados.
   *
   * Los de dentro de una fila llevan el rastro de su fila en la clave y se
   * validan al guardar esa fila, no aquí: exigirlos desde el formulario
   * llevaría al usuario a una fila que a su vez tiene otra dentro.
   */
  readonly topLevel = computed(() =>
    [...this.panels().values()].filter((panel) => !panel.key.includes(',')),
  );

  /**
   * Las tablas de detalle que viven **dentro** de una fila abierta.
   *
   * Solo las suyas directas, no las de sus nietas: cada fila valida lo que
   * tiene delante, y la de dentro se validará al guardarse ella. Sin esto, una
   * tabla anidada no la comprobaba nadie —el formulario la deja fuera a
   * propósito, y la fila solo miraba sus propios campos— y se guardaba a medias
   * sin un solo aviso.
   */
  childrenOf(trail: string): DetailPanel[] {
    if (!trail) return [];

    const prefix = `${trail},`;

    return [...this.panels().values()].filter(
      (panel) => panel.key.startsWith(prefix) && !panel.key.slice(prefix.length).includes(','),
    );
  }

  register(panel: DetailPanel): void {
    this.panels.update((all) => new Map(all).set(panel.key, panel));
  }

  unregister(key: string): void {
    this.panels.update((all) => {
      const next = new Map(all);
      next.delete(key);
      return next;
    });
  }

  has(key: string): boolean {
    return this.panels().has(key);
  }

  /** Lleva al listado completo de un campo. */
  show(key: string): void {
    void this.router.navigate([...this.stack.baseCommands(), 'registros', key]);
  }

  /**
   * Vuelve al formulario.
   *
   * Se retrocede en el historial en vez de navegar hacia adelante: abrir el
   * listado añadió una entrada, y cerrarlo tiene que deshacerla.
   *
   * Espera a que la navegación termine porque hay quien encadena algo justo
   * después —agregar un registro abre el selector, que se dibuja en el
   * formulario— y hacerlo antes de tiempo lo dibujaría en una pantalla que
   * todavía está oculta.
   */
  async close(): Promise<void> {
    this.location.back();

    await this.trasElDesplazamiento();
  }

  /**
   * Espera a que el router termine de navegar **y de mover la página**.
   *
   * Volver de un panel es un «atrás» del navegador, y la aplicación tiene
   * encendida la restauración de posición: después de `NavigationEnd` el router
   * lleva la página a donde él guardó para esa entrada del historial. Quien
   * quiera colocar la vista tiene que hacerlo **después** de eso, o el router se
   * lo deshace — que es lo que dejaba el formulario arriba del todo al volver de
   * un registro.
   *
   * `Scroll` es el evento que llega justo después de que el router haya hecho lo
   * suyo. Con tope de espera: más vale colocar tarde que dejar a alguien
   * esperando para siempre.
   */
  trasElDesplazamiento(): Promise<unknown> {
    return firstValueFrom(
      race(
        this.router.events.pipe(filter((event) => event instanceof Scroll)),
        timer(1200),
      ),
    );
  }

  /** Vuelve a la actividad reemplazando la entrada: no hay panel que enseñar. */
  backToActivity(): void {
    void this.router.navigate(this.stack.baseCommands(), { replaceUrl: true });
  }
}
