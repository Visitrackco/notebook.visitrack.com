import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatCheckboxModule } from '@angular/material/checkbox';
import {
  MAT_DATE_FORMATS,
  MAT_DATE_LOCALE,
  MatDateFormats,
  provideNativeDateAdapter,
} from '@angular/material/core';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatRadioModule } from '@angular/material/radio';
import { MatSelectModule } from '@angular/material/select';
import { MatTimepickerModule } from '@angular/material/timepicker';

import {
  FieldValue,
  FileValue,
  FormField,
  asFile,
  asGeo,
  asOption,
  blocksGallery,
  isDisplayOnly,
  pendingTypeName,
} from '../../../../core/forms/form-schema';
import { GpsReading } from '../../../../core/services/geolocation.service';
import { IconComponent } from '../../../../shared/components/icon/icon.component';
import { BinaryFieldComponent } from './binary-field/binary-field.component';
import { GpsFieldComponent } from './gps-field/gps-field.component';

/**
 * Formatos de fecha y hora.
 *
 * ## Lo que se ve no es lo que se guarda
 *
 * En pantalla la hora va en **12 horas con a. m./p. m.**, que es como la lee y
 * la dice quien está en campo. Por debajo se guarda siempre en **24 horas**
 * (`HH:mm`), porque es lo que espera el servidor y lo que escribe la app móvil
 * — la conversión la hace [formatTime] con `getHours()`, sin pasar por estos
 * formatos.
 *
 * Que la representación y el almacenamiento difieran es deliberado: obligar al
 * usuario a pensar en formato militar para que el dato viaje bien es trasladarle
 * un problema que es nuestro.
 *
 * `timeOptionLabel` es lo que se ve en el desplegable del reloj; `timeInput`, lo
 * que queda escrito en el campo. Los dos tienen que coincidir o el valor elegido
 * se ve distinto al listado del que salió.
 *
 * Las fechas se muestran en el formato local (`05/08/2026`) y se guardan en
 * `yyyy-MM-dd`, por el mismo motivo.
 */
const VT_DATE_FORMATS: MatDateFormats = {
  parse: {
    dateInput: null,
    timeInput: null,
  },
  display: {
    dateInput: { year: 'numeric', month: '2-digit', day: '2-digit' },
    timeInput: { hour: 'numeric', minute: '2-digit', hour12: true },
    timeOptionLabel: { hour: 'numeric', minute: '2-digit', hour12: true },
    monthYearLabel: { year: 'numeric', month: 'short' },
    dateA11yLabel: { year: 'numeric', month: 'long', day: 'numeric' },
    monthYearA11yLabel: { year: 'numeric', month: 'long' },
  },
};

/**
 * Dibuja un campo del formulario según su tipo.
 *
 * ## Por qué un único componente y no uno por tipo
 *
 * Los veintitantos tipos comparten casi todo: etiqueta, obligatoriedad, ayuda,
 * solo-lectura, cómo notifican el cambio. Repartirlos en veinte componentes
 * significa repetir ese envoltorio veinte veces —y arreglar cada detalle de
 * accesibilidad veinte veces—. Lo que de verdad cambia es el control de dentro,
 * y para eso basta un `@switch`.
 *
 * Cuando un tipo traiga lógica propia de peso —la cámara, la firma, la tabla de
 * detalle— entonces sí merecerá su componente, y este seguirá siendo quien
 * decida a cuál delegar.
 *
 * ## El valor
 *
 * Entra y sale como [FieldValue], que es la forma exacta en que lo guarda el
 * servidor: cadena para los campos de texto y de fecha, `{id, txt}` para la
 * selección única y un arreglo de esos para la múltiple. La conversión se hace
 * aquí, al borde, para que el motor no tenga que saber de eventos del DOM.
 */
@Component({
  selector: 'vt-field-host',
  standalone: true,
  imports: [
    BinaryFieldComponent,
    GpsFieldComponent,
    IconComponent,
    NgTemplateOutlet,
    FormsModule,
    MatCheckboxModule,
    MatDatepickerModule,
    MatFormFieldModule,
    MatInputModule,
    MatRadioModule,
    MatSelectModule,
    MatTimepickerModule,
  ],
  providers: [
    provideNativeDateAdapter(),
    // El calendario y el reloj, en español: con el locale por defecto salen los
    // meses y el formato en inglés dentro de una aplicación que está entera en
    // español.
    { provide: MAT_DATE_LOCALE, useValue: 'es-CO' },
    { provide: MAT_DATE_FORMATS, useValue: VT_DATE_FORMATS },
  ],
  templateUrl: './field-host.component.html',
  styleUrl: './field-host.component.scss',
  host: {
    // La marca de «falta responder» se pinta sobre el contenedor entero y no
    // sobre el control: en un grupo de opciones el control son ocho elementos
    // sueltos, y teñirlos uno a uno no señala la pregunta sino las respuestas.
    '[class.fld--invalid]': 'invalid()',
  },
})
export class FieldHostComponent {
  readonly field = input.required<FormField>();
  readonly value = input<FieldValue>(null);

  /**
   * GUID de la actividad.
   *
   * Solo lo usan los campos de archivo: el contenido no vive dentro del valor
   * sino en un registro propio que cuelga de la actividad, y sin este dato no
   * habría de qué colgarlo.
   */
  readonly answerGuid = input('');

  /** true cuando falta y hay que señalarlo. */
  readonly invalid = input(false);

  readonly valueChange = output<FieldValue>();

  /** Nombre del tipo si todavía no se dibuja. Vacío si sí. */
  readonly pending = computed(() => pendingTypeName(this.field().fty));

  /** Solo muestra información: no lleva marca de obligatorio. */
  readonly isDisplay = computed(() => isDisplayOnly(this.field().fty));

  /** Valor como texto, para los controles que lo esperan así. */
  readonly text = computed(() => {
    const value = this.value();
    return typeof value === 'string' ? value : '';
  });

  /** Id de la opción elegida, en los campos de selección única. */
  readonly selectedId = computed(() => asOption(this.value())?.id ?? '');

  /** Ids marcados, en los de selección múltiple. */
  readonly checkedIds = computed(() => {
    const value = this.value();
    return Array.isArray(value) ? value.map((option) => option.id) : [];
  });

  /**
   * El valor como lectura de GPS.
   *
   * Se comprueba que tenga coordenadas y no solo que sea un objeto: un valor de
   * otro tipo guardado por error en este campo dejaría el control mostrando
   * `undefined, undefined` en vez de pedir una captura.
   */
  readonly geoValue = computed<GpsReading | null>(() => asGeo(this.value()));

  /** El valor como referencia a un archivo. */
  readonly fileValue = computed<FileValue | null>(() => asFile(this.value()));

  /**
   * ¿Se puede elegir la foto de los archivos del equipo?
   *
   * Lo prohíbe `blockGallery` cuando la evidencia tiene que tomarse en el sitio.
   */
  readonly allowsGallery = computed(() => !blocksGallery(this.field()));

  readonly options = computed(() => this.field().opt ?? []);
  readonly readOnly = computed(() => Boolean(this.field().rea));

  /**
   * Tipo del `<input>` para los campos de texto.
   *
   * Determina el teclado en un móvil y la validación del navegador. Un correo
   * escrito en un teclado sin `@` a la vista es una fuente de erratas.
   *
   * Las fechas y las horas **no** salen por aquí: usan los componentes de
   * Material, por el motivo que se explica en [dateValue].
   */
  readonly inputType = computed(() => {
    switch (this.field().fty) {
      case 'numeric':
        return 'number';
      case 'email':
        return 'email';
      case 'phone':
      case 'cellphone':
        return 'tel';
      default:
        return 'text';
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Fecha y hora
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * La parte de fecha del valor, como `Date` para el calendario de Material.
   *
   * ## Por qué no `<input type="date">`
   *
   * El input nativo emite `input` con **valor vacío** mientras la fecha está a
   * medio escribir: al teclear el día, el navegador todavía no tiene una fecha
   * válida y reporta `''`. Como el valor se refleja de vuelta al control, eso
   * borraba lo tecleado en cuanto se escribía el primer número — el campo era
   * literalmente imposible de diligenciar.
   *
   * El calendario de Material no tiene ese problema: entrega la fecha una sola
   * vez, ya completa.
   *
   * ## Por qué `[ngModel]` y no `[value]`
   *
   * `matInput` y `matDatepicker` declaran **ambos** una entrada llamada
   * `value` sobre el mismo elemento, así que enlazarla deja el resultado a
   * merced de cuál de las dos directivas escriba última — y el valor inicial no
   * llegaba a mostrarse. `ngModel` pasa por el accesor de formularios, que es
   * el camino que las dos directivas respetan.
   *
   * El valor se sigue guardando como texto (`yyyy-MM-dd`), que es el formato de
   * la app móvil y del servidor; la conversión vive aquí, en el borde.
   */
  readonly dateValue = computed<Date | null>(
    () => this.dateMemo.resolve(this.text()) ?? this.draftDate(),
  );

  /** La parte de hora del valor, como `Date`. */
  readonly timeValue = computed<Date | null>(
    () => this.timeMemo.resolve(this.text()) ?? this.draftTime(),
  );

  /**
   * Mitades sueltas de un campo de fecha y hora.
   *
   * En `datetime` el valor solo se guarda cuando **las dos** partes están
   * puestas: media fecha y hora no es un dato, y completar la que falta con un
   * `00:00` inventado hacía que un campo obligatorio se diera por respondido
   * con una hora que nadie eligió.
   *
   * Pero mientras se elige la primera hay que mostrarla, o el control se
   * vaciaría en cuanto se cierra el calendario. Estas señales guardan esa mitad
   * a la espera de la otra; en cuanto se completa, el valor pasa al motor y
   * dejan de usarse.
   */
  private readonly draftDate = signal<Date | null>(null);
  private readonly draftTime = signal<Date | null>(null);

  /** true cuando falta una de las dos mitades. */
  readonly incompleteDateTime = computed(
    () =>
      this.field().fty === 'datetime' &&
      !this.text() &&
      Boolean(this.draftDate() || this.draftTime()),
  );

  /** Cuál de las dos mitades falta, para decírselo al usuario. */
  readonly missingHalf = computed(() => (this.draftDate() ? 'la hora' : 'la fecha'));

  /**
   * Cachés de conversión.
   *
   * Sin ellas, cada lectura devolvía una instancia de `Date` distinta aunque el
   * texto fuera el mismo. Material compara por referencia, así que reescribía
   * el contenido del control en **cada** ciclo de detección de cambios — lo que
   * interfiere con quien esté tecleando la fecha a mano en vez de usar el
   * calendario.
   */
  private readonly dateMemo = new DateMemo(parseDatePart);
  private readonly timeMemo = new DateMemo(parseTimePart);

  /** Fecha elegida en el calendario. */
  onDate(value: Date | null): void {
    const valid = value && !Number.isNaN(value.getTime()) ? value : null;

    if (this.field().fty !== 'datetime') {
      this.draftDate.set(null);
      this.valueChange.emit(valid ? formatDate(valid) : '');
      return;
    }

    this.draftDate.set(valid);
    this.commitDateTime();
  }

  /** Hora elegida en el reloj. */
  onTime(value: Date | null): void {
    const valid = value && !Number.isNaN(value.getTime()) ? value : null;

    if (this.field().fty === 'time') {
      this.draftTime.set(null);
      this.valueChange.emit(valid ? formatTime(valid) : '');
      return;
    }

    this.draftTime.set(valid);
    this.commitDateTime();
  }

  /**
   * Publica el valor de un campo de fecha y hora.
   *
   * Solo cuando están las dos mitades. Si falta una, el campo queda vacío para
   * el motor —así un obligatorio sigue contando como pendiente— y la mitad
   * elegida se conserva en pantalla hasta que llegue la otra.
   */
  private commitDateTime(): void {
    const date = this.draftDate() ?? this.dateMemo.resolve(this.text());
    const time = this.draftTime() ?? this.timeMemo.resolve(this.text());

    if (!date || !time) {
      // Las mitades sueltas se recuerdan aquí, no en el valor: el motor no debe
      // recibir un dato a medias.
      this.draftDate.set(date);
      this.draftTime.set(time);
      this.valueChange.emit('');
      return;
    }

    this.draftDate.set(null);
    this.draftTime.set(null);
    this.valueChange.emit(`${formatDate(date)}T${formatTime(time)}`);
  }

  // ── Cambios ────────────────────────────────────────────────────────────────

  onText(event: Event): void {
    this.valueChange.emit((event.target as HTMLInputElement | HTMLTextAreaElement).value);
  }

  /** Selección única: se emite la opción completa, no solo su id. */
  onSingle(optionId: string): void {
    const option = this.options().find((candidate) => candidate.id === optionId);
    this.valueChange.emit(option ? { id: option.id, txt: option.txt } : null);
  }

  /**
   * Selección múltiple.
   *
   * Se reconstruye la lista a partir del orden de las **opciones**, no del
   * orden en que se marcaron: así dos actividades con las mismas respuestas
   * producen el mismo texto en el listado, en vez de uno distinto según por
   * dónde empezó cada quien.
   */
  onMultiple(optionId: string, checked: boolean): void {
    const current = new Set(this.checkedIds());

    if (checked) current.add(optionId);
    else current.delete(optionId);

    const chosen = this.options()
      .filter((option) => current.has(option.id))
      .map((option) => ({ id: option.id, txt: option.txt }));

    this.valueChange.emit(chosen);
  }

  isChecked(optionId: string): boolean {
    return this.checkedIds().includes(optionId);
  }
}

// ─── Conversión entre el texto guardado y `Date` ─────────────────────────────

/**
 * Convierte texto a `Date` devolviendo **la misma instancia** mientras el texto
 * no cambie.
 *
 * Es lo que evita que Material reescriba el control en cada ciclo de detección
 * de cambios: compara el valor por referencia, y una instancia nueva —aunque
 * represente la misma fecha— cuenta como un valor distinto.
 */
class DateMemo {
  private lastText: string | null = null;
  private lastValue: Date | null = null;

  constructor(private readonly parse: (text: string) => Date | null) {}

  resolve(text: string): Date | null {
    if (text === this.lastText) return this.lastValue;

    this.lastText = text;
    this.lastValue = this.parse(text);
    return this.lastValue;
  }
}

/** Dos dígitos, para componer las cadenas de fecha y hora. */
function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `Date` → `yyyy-MM-dd`, en hora local. */
function formatDate(value: Date): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

/** `Date` → `HH:mm`, en hora local. */
function formatTime(value: Date): string {
  return `${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

/**
 * Lee la parte de fecha de un valor guardado.
 *
 * Se construye el `Date` con sus componentes y no con `new Date(texto)`: la
 * cadena `2026-08-05` la interpreta el navegador como **UTC**, así que en una
 * zona al oeste de Greenwich el calendario marcaría el día anterior.
 */
function parseDatePart(text: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text.trim());
  if (!match) return null;

  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

/**
 * Lee la parte de hora de un valor guardado.
 *
 * Sirve tanto para un `HH:mm` suelto como para la hora dentro de un
 * `yyyy-MM-ddTHH:mm`. La fecha del `Date` resultante no la usa el reloj de
 * Material, pero se toma la del propio valor cuando la hay.
 */
function parseTimePart(text: string): Date | null {
  const trimmed = text.trim();
  const match = /(?:^|T)(\d{2}):(\d{2})/.exec(trimmed);
  if (!match) return null;

  const base = parseDatePart(trimmed) ?? new Date();
  base.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return base;
}
