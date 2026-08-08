import { Component, computed, input } from '@angular/core';

import { FormField } from '../../../../../core/forms/form-schema';
import { IconComponent } from '../../../../../shared/components/icon/icon.component';

/**
 * Campos que no se responden: se calculan.
 *
 * Son tres —el campo calculado, la suma de una tabla de detalle y la diferencia
 * entre dos fechas— y comparten pantalla porque comparten naturaleza: un número
 * grande que sale de otras respuestas y que el usuario no teclea.
 *
 * ## Sin botón de recalcular
 *
 * La app lleva un botón ↻ porque allí el valor se recalcula al dibujar el
 * widget y puede quedarse atrás. Aquí el motor los rehace en cuanto cambia
 * cualquier campo, así que el botón no tendría nada que hacer — y un botón que
 * nunca cambia nada enseña a desconfiar del número que hay al lado.
 *
 * ## Por qué se explica de dónde sale
 *
 * Un número sin origen invita a dudar de él. Debajo del resultado se dice en
 * una línea qué lo produce: los días entre dos fechas, la suma de una columna,
 * o una fórmula. Es lo que evita la llamada de «este total está mal».
 */
@Component({
  selector: 'vt-derived-field',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './derived-field.component.html',
  styleUrl: './derived-field.component.scss',
})
export class DerivedFieldComponent {
  readonly field = input.required<FormField>();
  readonly value = input<string>('');
  readonly invalid = input(false);

  /** Todavía no hay con qué calcularlo. */
  readonly empty = computed(() => this.value().trim() === '');

  /** El número, con separador de miles. */
  readonly display = computed(() => {
    const raw = this.value().trim();
    if (!raw) return '—';

    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return raw;

    return parsed.toLocaleString('es-CO', { maximumFractionDigits: 4 });
  });

  /** Unidad que acompaña al número, si la tiene. */
  readonly unit = computed(() => {
    if (this.field().fty !== 'datediff' || this.empty()) return '';

    return Math.abs(Number(this.value())) === 1 ? 'día' : 'días';
  });

  /** De dónde sale el número, en una línea. */
  readonly origin = computed(() => {
    switch (this.field().fty) {
      case 'datediff':
        return 'Días entre las dos fechas del formulario.';

      case 'sumdetail':
        return 'Suma de una columna de la tabla de registros.';

      default:
        return 'Resultado de una fórmula sobre otros campos.';
    }
  });

  /** Por qué está vacío. Solo se dice cuando lo está. */
  readonly reason = computed(() => {
    if (!this.empty()) return '';

    switch (this.field().fty) {
      case 'datediff':
        return 'Se calcula cuando las dos fechas estén respondidas.';

      case 'sumdetail':
        return 'Se calcula cuando la tabla tenga registros con ese dato.';

      default:
        return 'Se calcula cuando los campos de la fórmula tengan valor.';
    }
  });

  readonly icon = computed(() => (this.field().fty === 'datediff' ? 'clipboard' : 'database'));
}
