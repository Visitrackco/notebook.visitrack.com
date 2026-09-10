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
  ResolvedDescriptor,
  asFile,
  asGeo,
  asOption,
  asOptions,
  blocksGallery,
  isDisplayOnly,
} from '../../../../core/forms/form-schema';
import { FormEngine } from '../../../../core/forms/form-engine';
import { Flujo } from '../../../../core/forms/flujo-modelo';
import { GpsReading } from '../../../../core/services/geolocation.service';
import { IconComponent } from '../../../../shared/components/icon/icon.component';
import { BinaryFieldComponent } from './binary-field/binary-field.component';
import { DerivedFieldComponent } from './derived-field/derived-field.component';
import { GpsFieldComponent } from './gps-field/gps-field.component';
import { LinkFieldComponent } from './link-field/link-field.component';
import { ListFieldComponent, ListSelection } from './list-field/list-field.component';
import { MasterDetailFieldComponent } from './master-detail-field/master-detail-field.component';
import { RichTextFieldComponent } from './rich-text-field/rich-text-field.component';
import { LinkedFormFieldComponent } from './linked-form-field/linked-form-field.component';

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
    LinkedFormFieldComponent,
    BinaryFieldComponent,
    DerivedFieldComponent,
    GpsFieldComponent,
    IconComponent,
    LinkFieldComponent,
    ListFieldComponent,
    MasterDetailFieldComponent,
    RichTextFieldComponent,
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

  /**
   * Si el flujo dijo algo sobre exigir este campo. `null` cuando no dijo nada.
   *
   * Llega resuelto desde el formulario, que es quien tiene el motor. Aquí no se
   * puede leer `f.req` a secas: ese es el del esquema, y una regla puede
   * haberlo cambiado en cualquiera de los dos sentidos.
   */
  readonly obligatorioDelFlujo = input<boolean | null>(null);

  /**
   * Si este campo se exige, contando lo que el flujo decidió.
   *
   * Es lo que decide el asterisco y el `required` del control. Sin esto, la
   * marca de obligatorio y lo que de verdad se exige al guardar decían cosas
   * distintas en cuanto una regla tocaba el campo.
   */
  readonly esObligatorio = computed(() => this.obligatorioDelFlujo() ?? !!this.field().req);

  /**
   * Los límites que el flujo puso a este campo: desde, hasta y qué días.
   *
   * Llegan del motor de flujos ya resueltos por el formulario. Aquí solo se
   * traducen a lo que entiende el calendario, porque impedir elegir mal es
   * mejor que avisar después de haberlo hecho.
   */
  readonly limites = input<{ desde?: string; hasta?: string; dias?: string } | null>(null);

  /**
   * Lo que el campo **dice**, si una regla lo cambió.
   *
   * Un título, un párrafo o una etiqueta son texto fijo del formulario, así que
   * no tienen valor que escribir. Esto es lo que permite reescribirlos desde una
   * regla sin confundirlos con una respuesta.
   */
  readonly textoDelFlujo = input<string | null>(null);

  /** La dirección de la imagen, si una regla la cambió. */
  readonly imagenDelFlujo = input<string | null>(null);

  /**
   * La nota de ayuda, si una regla la puso.
   *
   * `null` es «ninguna regla dijo nada» y entonces se enseña la del formulario;
   * la cadena vacía sí es una decisión —«quítale la ayuda»— y por eso se
   * distinguen con `??` y no con `||`.
   */
  readonly ayudaDelFlujo = input<string | null>(null);

  /** El alto de un campo de texto largo, en líneas, si una regla lo decidió. */
  readonly lineasDelFlujo = input<number | null>(null);

  /**
   * Lo que una regla le puso al teclado: entre qué números, entre cuántos
   * caracteres y con qué patrón.
   *
   * Van juntas y no una entrada por cosa, igual que los límites de una fecha:
   * son la misma clase de decisión —restricciones del editor— y repartirlas en
   * cinco entradas más no habría dicho nada nuevo.
   */
  readonly entrada = input<{
    minimo?: number;
    maximo?: number;
    minCaracteres?: number;
    maxCaracteres?: number;
    patron?: string;
    patronMensaje?: string;
  } | null>(null);

  /**
   * El flujo entero y el motor del formulario.
   *
   * Solo los usa la tabla de detalle: cada fila se diligencia con su propio
   * motor y necesita las reglas que la tabla declara para lo de dentro, y lo
   * que hay respondido fuera. Los demás campos ni los miran.
   */
  readonly flujo = input<Flujo | null>(null);

  readonly motor = input<FormEngine | null>(null);

  /** Cuántas filas admite una tabla, si una regla lo decidió. */
  readonly maxFilasDelFlujo = input<number | null>(null);

  /*
   * Qué se puede hacer con las filas, si una regla lo decidió.
   *
   * `null` es «no lo decidió nadie», que no es lo mismo que `false`: el campo se
   * comporta como diga el formulario, igual que cuando no hay flujo.
   */
  readonly agregarDelFlujo = input<boolean | null>(null);
  readonly editarDelFlujo = input<boolean | null>(null);
  readonly eliminarDelFlujo = input<boolean | null>(null);


  /** El enunciado que toca enseñar: el de la regla, si lo hay. */
  readonly enunciado = computed(() => {
    const f = this.field();
    return this.textoDelFlujo() || f.txt || f.lab;
  });

  /** La imagen que toca enseñar: la de la regla, si la hay. */
  readonly imagen = computed(() => this.imagenDelFlujo() || this.field().url);

  /** La ayuda que toca enseñar: la de la regla, si alguna la puso. */
  readonly ayuda = computed(() => this.ayudaDelFlujo() ?? this.field().hel ?? '');

  /**
   * El alto mínimo del editor de texto largo, en píxeles.
   *
   * Se traduce aquí y no en el motor porque son píxeles, y el motor no sabe de
   * píxeles: él dice cuántas líneas y cada plataforma sabe lo que mide una
   * suya. `null` deja el alto de siempre.
   */
  readonly altoDelEditor = computed(() => {
    const lineas = this.lineasDelFlujo();
    return lineas && lineas > 0 ? Math.round(lineas * 22) : null;
  });

  /**
   * Qué está mal en lo respondido, según lo que el flujo pidió del teclado.
   *
   * Vacío cuando está bien — y también cuando el campo está sin responder: de
   * eso ya se encarga el obligatorio, y decir «escribe al menos veinte
   * caracteres» en un campo intacto es regañar antes de empezar.
   *
   * Se comprueba aquí y no en el motor por lo mismo que los límites de una
   * fecha: el motor solo vuelve a mirar cuando algo se responde, y para
   * entonces el campo ya se escribió entero. Esto avisa mientras se teclea.
   */
  readonly avisoDeEntrada = computed(() => {
    const reglas = this.entrada();
    const texto = this.text().trim();

    if (!reglas || !texto) return '';

    if (reglas.maxCaracteres !== undefined && texto.length > reglas.maxCaracteres) {
      return `Caben ${reglas.maxCaracteres} caracteres y van ${texto.length}`;
    }

    if (reglas.minCaracteres !== undefined && texto.length < reglas.minCaracteres) {
      return `Escribe al menos ${reglas.minCaracteres} caracteres`;
    }

    const numero = Number(texto.replace(',', '.'));

    if (Number.isFinite(numero)) {
      if (reglas.minimo !== undefined && numero < reglas.minimo) {
        return `El mínimo es ${reglas.minimo}`;
      }

      if (reglas.maximo !== undefined && numero > reglas.maximo) {
        return `El máximo es ${reglas.maximo}`;
      }
    }

    /*
     * El patrón se construye aquí cada vez, y no una y se guarda: el motor ya
     * comprobó que compila, así que lo que queda es barato y no hay estado que
     * mantener sincronizado con una regla que puede cambiar de patrón en la
     * tecla siguiente.
     */
    if (reglas.patron) {
      try {
        if (!new RegExp(reglas.patron).test(texto)) {
          return reglas.patronMensaje || 'No tiene el formato que se espera';
        }
      } catch {
        // Un patrón que no compila no puede rechazar nada: el motor no lo
        // habría anotado, y si llegara igual es mejor dejar responder.
      }
    }

    return '';
  });

  /**
   * La fecha mínima que se puede elegir.
   *
   * `HOY` se resuelve **aquí**, contra el reloj del aparato: un flujo se guarda
   * una vez y se ejecuta durante meses, así que una fecha calculada al
   * guardarlo estaría vencida al día siguiente.
   */
  readonly fechaDesde = computed(() => this.aFecha(this.limites()?.desde));
  readonly fechaHasta = computed(() => this.aFecha(this.limites()?.hasta));

  private aFecha(valor: string | undefined): Date | null {
    const texto = (valor ?? '').trim();
    if (!texto) return null;

    if (texto.toUpperCase() === 'HOY') {
      const hoy = new Date();
      hoy.setHours(0, 0, 0, 0);
      return hoy;
    }

    const fecha = new Date(texto);
    return Number.isNaN(fecha.getTime()) ? null : fecha;
  }

  /**
   * Los límites de hora, como `Date` del día de hoy.
   *
   * `mat-timepicker` compara horas pero trabaja con `Date`, así que la hora de
   * la regla —«08:00»— se planta sobre la fecha de hoy. Solo se mira la hora,
   * de modo que el día da igual mientras sea el mismo en los dos extremos.
   */
  readonly horaDesde = computed(() => this.aHora(this.limites()?.desde));
  readonly horaHasta = computed(() => this.aHora(this.limites()?.hasta));

  private aHora(valor: string | undefined): Date | null {
    const texto = (valor ?? '').trim();
    if (!texto) return null;

    const [h, m] = texto.split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;

    const cuando = new Date();
    cuando.setHours(h, m, 0, 0);
    return cuando;
  }

  /**
   * Qué días se pueden elegir en el calendario.
   *
   * Los días vienen del 1 (lunes) al 7 (domingo), que es como los cuenta la
   * gente; `Date.getDay()` empieza en domingo con el 0, de ahí la conversión.
   * Sin días declarados no se filtra nada: devolver siempre `true` deja el
   * calendario como estaba.
   */
  readonly filtroDeDias = computed<(d: Date | null) => boolean>(() => {
    const crudo = (this.limites()?.dias ?? '').trim();
    if (!crudo) return () => true;

    const permitidos = new Set(crudo.split(',').map((d) => d.trim()).filter(Boolean));

    return (fecha: Date | null) => {
      if (!fecha) return true;

      const dia = fecha.getDay() === 0 ? '7' : String(fecha.getDay());
      return permitidos.has(dia);
    };
  });

  readonly valueChange = output<FieldValue>();

  /** Solo muestra información: no lleva marca de obligatorio. */
  readonly isDisplay = computed(() => isDisplayOnly(this.field().fty));

  /**
   * ¿Se dibuja la etiqueta encima?
   *
   * Todos los campos que reciben datos y tienen nombre. Los de presentación no:
   * un título ya **es** su texto, y repetirlo encima lo diría dos veces. El
   * hipervínculo tampoco, porque su propia tarjeta lleva el rótulo dentro del
   * botón, que es donde se pulsa.
   */
  readonly showsLabel = computed(() => {
    const field = this.field();
    return Boolean(field.lab?.trim()) && !isDisplayOnly(field.fty);
  });

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
    return asOptions(value).map((option) => option.id);
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

  /**
   * ¿Este campo de selección única es una calificación?
   *
   * Lo dice `apiId` con `_star`, no el tipo: para el esquema sigue siendo un
   * `radio` corriente con sus opciones, y lo que cambia es cómo se pide. Cinco
   * opciones en fila de estrellas se responden de un toque; como lista de
   * radios ocupan media pantalla y se leen una por una.
   */
  readonly isRating = computed(() => String(this.field().apiId ?? '').includes('_star'));

  /**
   * Cuántas estrellas van encendidas.
   *
   * Se encienden **todas hasta la elegida**, como una calificación de toda la
   * vida: tres estrellas es «tres», no «la tercera». `-1` cuando no hay
   * respuesta.
   */
  readonly ratingIndex = computed(() => {
    const chosen = this.selectedId();
    return this.options().findIndex((option) => option.id === chosen);
  });

  /** Texto de la opción elegida, que acompaña a las estrellas. */
  readonly ratingLabel = computed(() => this.options()[this.ratingIndex()]?.txt ?? '');
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

  /**
   * Valor del campo de lista.
   *
   * Los descriptivos guardados con la respuesta se recuperan aquí para que
   * reabrir la actividad siga mostrando el detalle del ítem.
   */
  readonly listValue = computed<ListSelection | null>(() => {
    const option = asOption(this.value());
    if (!option) return null;

    return { id: option.id, txt: option.txt, des: this.descriptors() };
  });

  /** Elegido en el campo del que depende esta lista. */
  readonly parentValue = input('');

  /**
   * Ítem de la fila que contiene este formulario.
   *
   * Solo llega cuando el formulario **es** una fila de tabla de detalle, y solo
   * lo usa la tabla que haya dentro: sus registros son los ítems que cuelgan de
   * aquel. Ver `DetailContext.parent`.
   */
  readonly inheritedParent = input('');

  /** Descriptivos guardados con la respuesta. */
  readonly descriptors = input<ResolvedDescriptor[]>([]);

  readonly descriptorsChange = output<ResolvedDescriptor[]>();

  /**
   * Llega una elección de la lista.
   *
   * El valor y sus descriptivos viajan por separado: el motor guarda el
   * primero en `val` y los segundos en `des`, que es como los espera el
   * backend y como los escribe la app.
   */
  onListChange(selection: ListSelection | null): void {
    this.descriptorsChange.emit(selection?.des ?? []);
    this.valueChange.emit(selection ? { id: selection.id, txt: selection.txt } : null);
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
