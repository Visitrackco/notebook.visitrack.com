import { Component, ElementRef, computed, effect, input, output, viewChild } from '@angular/core';

import { FormField } from '../../../../core/forms/form-schema';
import { IconComponent } from '../../../../shared/components/icon/icon.component';

/** Un obligatorio sin responder, con la página donde vive. */
export interface MissingEntry {
  field: FormField;
  page: number;

  /**
   * Aclaración de qué falta, cuando no es «sin responder».
   *
   * Una tabla de detalle puede tener registros y aun así estar incompleta —le
   * faltan respuestas **dentro**—, y decir solo su nombre dejaría al usuario
   * mirando un campo que a la vista está lleno.
   */
  note?: string;

  /**
   * A dónde lleva al pulsarla.
   *
   * Por omisión, al campo en su página. Una tabla de detalle lleva **dentro**,
   * al registro que está a medias: el campo en sí no tiene nada que corregir.
   */
  go?: () => void;
}

/** Los faltantes de una misma página, juntos. */
export interface MissingGroup {
  page: number;
  label: string;
  entries: MissingEntry[];
}

/**
 * Aviso de campos obligatorios sin responder.
 *
 * ## Por qué ofrece guardar de todos modos
 *
 * Un obligatorio marca lo que la operación necesita, pero quien está en campo a
 * veces no lo tiene: falta el dato de un tercero, el equipo no tiene placa
 * legible, el cliente no está. Bloquear el guardado sin más deja a esa persona
 * con dos opciones malas — inventarse un valor o perder todo lo diligenciado—, y
 * la primera es la que acaba eligiendo.
 *
 * Guardar deja la actividad registrada y visible como incompleta, que es
 * información honesta. Inventar un dato para poder guardar no lo es.
 *
 * La otra salida, **Revisar**, lleva al primer campo que falta y los deja
 * marcados en rojo: es lo que se quiere en el caso normal, que es haberse
 * saltado uno sin darse cuenta.
 */
@Component({
  selector: 'vt-required-dialog',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './required-dialog.component.html',
  styleUrl: './required-dialog.component.scss',
})
export class RequiredDialogComponent {
  readonly missing = input.required<MissingEntry[]>();

  /** Nombre de cada página, por índice. Para titular los grupos. */
  readonly pageLabels = input<string[]>([]);

  readonly open = input(false);

  /**
   * Se ofrece guardar dejándolo incompleto.
   *
   * Vale para una **actividad**: es el trabajo de quien está en campo, y una
   * actividad incompleta sigue siendo información honesta. No vale para una
   * ubicación, un activo ni un ítem de lista: esos son catálogo, los consulta
   * todo el mundo, y uno a medias envenena las respuestas de los demás sin que
   * nadie sepa de dónde salió. Ahí la única salida es completarlos.
   */
  readonly canSaveAnyway = input(true);

  /**
   * Los faltantes se agrupan por página.
   *
   * Con una sola página el encabezado «Página 1» es ruido: no hay nada de lo
   * que distinguirla.
   */
  readonly grouped = computed(() => this.groups().length > 1);

  /**
   * Los faltantes agrupados por página, en el orden del formulario.
   *
   * Sin agrupar, una lista de doce campos de cuatro páginas distintas obliga a
   * leer el número de página de cada línea para hacerse una idea de por dónde
   * empezar. Agrupados se ve de un vistazo que faltan «tres en Inspección
   * eléctrica» y se va allí una sola vez.
   */
  readonly groups = computed<MissingGroup[]>(() => {
    const labels = this.pageLabels();
    const byPage = new Map<number, MissingEntry[]>();

    for (const entry of this.missing()) {
      const bucket = byPage.get(entry.page);
      if (bucket) bucket.push(entry);
      else byPage.set(entry.page, [entry]);
    }

    return [...byPage.entries()]
      .sort(([left], [right]) => left - right)
      .map(([page, entries]) => ({
        page,
        label: labels[page] || `Página ${page + 1}`,
        entries,
      }));
  });

  /** Se marcan en rojo y se salta al primero. */
  readonly review = output<void>();

  /** Se guarda dejando la actividad incompleta. */
  readonly saveAnyway = output<void>();

  /** Ir directamente a un campo concreto. */
  readonly goToField = output<MissingEntry>();

  readonly close = output<void>();

  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    effect(() => {
      const element = this.dialog()?.nativeElement;
      if (!element) return;

      if (this.open() && !element.open) element.showModal();
      else if (!this.open() && element.open) element.close();
    });
  }

  onBackdropClick(event: MouseEvent): void {
    if (event.target === this.dialog()?.nativeElement) this.close.emit();
  }
}
