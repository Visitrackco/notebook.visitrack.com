import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';

import { FormEngine } from '../../core/forms/form-engine';
import { FieldValue, FormField, ResolvedDescriptor, asGeo } from '../../core/forms/form-schema';
import { EntityType } from '../../core/models/entities.model';
import { LocationEditorService, titlesFrom } from '../../core/services/location-editor.service';
import { AlertSoundService } from '../../core/services/alert-sound.service';
import { PermissionsService } from '../../core/services/permissions.service';
import {
  MissingEntry,
  RequiredDialogComponent,
} from '../activities/form/required-dialog/required-dialog.component';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { ToTopComponent } from '../../shared/components/to-top/to-top.component';
import { FieldHostComponent } from '../activities/form/fields/field-host.component';

/** Qué se está editando. */
type Subject = 'location' | 'asset';

/**
 * Crear y editar ubicaciones y activos.
 *
 * ## Los campos los pone el tipo
 *
 * Una ubicación no tiene campos propios: los define su **tipo**, en el mismo
 * formato que un formulario (`jsonFields` con páginas y `fty`). Por eso aquí se
 * usa el motor de formularios y el mismo repartidor de campos que diligencia una
 * actividad — fotos, firmas, listas y tablas de detalle incluidas. Escribir un
 * editor propio habría significado una segunda implementación de los veintitantos
 * tipos de campo.
 *
 * ## El nombre va aparte
 *
 * No es un campo del tipo sino una columna de la tabla, y es lo único
 * obligatorio siempre. Va arriba y separado, como en la app.
 *
 * ## Un mismo componente para los dos
 *
 * Una ubicación y un activo se editan igual: cambia de dónde salen los tipos y
 * dónde se guarda. Separarlos en dos pantallas habría duplicado el montaje del
 * motor, el guardado y la validación para que solo difiriera el título.
 */
@Component({
  selector: 'vt-entity-editor',
  standalone: true,
  imports: [FieldHostComponent, IconComponent, RequiredDialogComponent, ToTopComponent],
  templateUrl: './entity-editor.component.html',
  styleUrl: './entity-editor.component.scss',
})
export class EntityEditorComponent {
  private readonly editor = inject(LocationEditorService);
  private readonly router = inject(Router);
  private readonly permissions = inject(PermissionsService);
  private readonly sound = inject(AlertSoundService);

  /** Ubicación sobre la que se trabaja. Vacío al crear una nueva. */
  readonly guid = input('');

  /** Activo que se edita, cuando lo hay. `nuevo` para crear uno. */
  readonly asset = input('');

  /**
   * A dónde volver al terminar.
   *
   * Lo pone quien mandó aquí — el selector de ubicación de una actividad, por
   * ejemplo. Sin esto, dar de alta una sede en mitad de crear una actividad
   * terminaba en el catálogo de ubicaciones, y había que rehacer el camino.
   */
  readonly volver = input('');

  /**
   * Tipo con el que nace la entidad, impuesto por quien mandó aquí.
   *
   * Un formulario exige ubicaciones de **un** tipo concreto. Si el alta dejara
   * elegir otro, la sede recién creada no aparecería en el selector del que se
   * acaba de salir — y el usuario no tendría forma de entender por qué.
   */
  readonly tipo = input('');

  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal('');

  readonly name = signal('');
  readonly types = signal<EntityType[]>([]);
  readonly type = signal<EntityType | null>(null);
  readonly engine = signal<FormEngine | null>(null);

  /** Identificador de lo que se está editando. Se genera al crear. */
  private readonly entityGuid = signal('');

  /** Se intentó guardar: a partir de ahí se señala lo que falta. */
  readonly submitted = signal(false);

  readonly subject = computed<Subject>(() => (this.asset() ? 'asset' : 'location'));

  readonly isNew = computed(() =>
    this.subject() === 'asset' ? this.asset() === 'nuevo' : !this.guid(),
  );

  readonly title = computed(() => {
    const what = this.subject() === 'asset' ? 'activo' : 'ubicación';
    return this.isNew() ? `Nuevo ${what}` : `Editar ${what}`;
  });

  /**
   * Solo se puede elegir el tipo al crear, y solo si nadie lo impuso.
   *
   * Cambiarlo después vaciaría todo lo respondido; e impuesto desde un selector,
   * cambiarlo dejaría la entidad fuera de la lista a la que se va a volver.
   */
  readonly canChooseType = computed(
    () => this.isNew() && !this.tipo() && this.types().length > 1,
  );

  readonly nameMissing = computed(() => this.submitted() && !this.name().trim());

  constructor() {
    effect(() => {
      const guid = this.guid();
      const asset = this.asset();

      untracked(() => void this.load(guid, asset));
    });
  }

  /** El rol permite trabajar sobre esta entidad. */
  readonly allowed = computed(() =>
    this.subject() === 'asset'
      ? this.permissions.canCreateAssets()
      : this.permissions.canCreateLocations(),
  );

  readonly noPermission = computed(() => this.permissions.entitiesReason());

  private async load(guid: string, asset: string): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    this.submitted.set(false);

    // Sin permiso no se carga nada: no tiene sentido montar un formulario que
    // no se va a poder guardar.
    if (!this.allowed()) {
      this.loading.set(false);
      return;
    }

    try {
      if (asset) await this.loadAsset(guid, asset);
      else await this.loadLocation(guid);
    } catch (error) {
      console.error('[Ubicaciones] no se pudo abrir el editor', error);
      this.error.set('No se pudo abrir el editor.');
    } finally {
      this.loading.set(false);
    }
  }

  private async loadLocation(guid: string): Promise<void> {
    const types = await this.editor.locationTypesOf();
    this.types.set(types);

    if (!guid) {
      this.entityGuid.set(crypto.randomUUID());
      this.name.set('');
      this.chooseType(this.startingType(types));
      return;
    }

    const record = await this.editor.findLocation(guid);

    if (!record) {
      this.error.set('Esta ubicación ya no está en el dispositivo.');
      return;
    }

    this.entityGuid.set(record.GUID);
    this.name.set(record.Name ?? '');

    /**
     * El tipo se busca en el catálogo, y si no está se arma con lo que trae el
     * propio registro.
     *
     * Pasa con las ubicaciones que bajaron del servidor cuando su tipo no se
     * descargó: sin este respaldo, editar una sede existente enseñaría un
     * formulario vacío y guardarla borraría sus datos.
     */
    const found = this.types().find(
      (type) => String(type.ID) === String(record.LocationTypeGUID),
    );

    this.type.set(found ?? syntheticType(record.typeTitle, record.jsonQuestion, record.jsonDescriptor, record.LocationTypeGD));
    this.mount(this.editor.answersOf(record.jsonValues));
  }

  private async loadAsset(locationGuid: string, assetGuid: string): Promise<void> {
    const location = await this.editor.findLocation(locationGuid);

    if (!location) {
      this.error.set('La ubicación de este activo ya no está en el dispositivo.');
      return;
    }

    const types = await this.editor.assetTypesFor(String(location.LocationTypeGUID));

    /**
     * El tipo impuesto entra aunque no esté declarado para esta sede.
     *
     * Un formulario puede exigir un tipo de activo que su catálogo declara para
     * otro tipo de ubicación. Dejarlo fuera enseñaría un «no hay tipos» justo
     * después de que la plataforma pidiera ese tipo — y no habría forma de
     * seguir.
     */
    const forced = this.tipo();

    if (forced && !types.some((type) => String(type.ID) === String(forced))) {
      const missing = await this.editor.assetTypeById(forced);
      if (missing) types.unshift(missing);
    }

    this.types.set(types);

    if (assetGuid === 'nuevo') {
      this.entityGuid.set(crypto.randomUUID());
      this.name.set('');
      this.chooseType(this.startingType(types));
      return;
    }

    const record = await this.editor.findAsset(assetGuid);

    if (!record) {
      this.error.set('Este activo ya no está en el dispositivo.');
      return;
    }

    this.entityGuid.set(record.GUID);
    this.name.set(record.Name ?? '');

    const found = types.find((type) => String(type.ID) === String(record.AssetTypeGUID));

    this.type.set(found ?? syntheticType(record.typeTitle, record.jsonQuestion, record.jsonDescriptor, record.AssetTypeGD));
    this.mount(this.editor.answersOf(record.jsonValues));
  }

  /**
   * Con qué tipo se arranca un alta.
   *
   * El impuesto manda. Si no lo hay y solo existe uno, no hay nada que elegir y
   * se entra directo a los campos.
   */
  private startingType(types: readonly EntityType[]): EntityType | null {
    const forced = this.tipo();

    if (forced) {
      return types.find((type) => String(type.ID) === String(forced)) ?? null;
    }

    return types.length === 1 ? types[0] : null;
  }

  /** Elige el tipo y monta sus campos. */
  chooseType(type: EntityType | null): void {
    this.type.set(type);
    this.mount([]);
  }

  onTypePicked(event: Event): void {
    const id = (event.target as HTMLSelectElement).value;
    this.chooseType(this.types().find((type) => String(type.ID) === id) ?? null);
  }

  private mount(answers: readonly { id: string }[]): void {
    const type = this.type();

    this.engine.set(
      type ? new FormEngine({ questions: type.jsonFields, answers }) : null,
    );
  }

  // ── Diligenciamiento ───────────────────────────────────────────────────────

  onName(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
  }

  onValue(field: FormField, value: FieldValue): void {
    this.engine()?.setValue(field, value);
  }

  onDescriptors(field: FormField, values: ResolvedDescriptor[]): void {
    this.engine()?.setDescriptors(field.id, values);
  }

  /** GUID con el que se guardan las fotos y firmas de esta entidad. */
  readonly binaryOwner = computed(() => this.entityGuid());

  readonly missing = computed(() => this.engine()?.missing() ?? []);

  /** El aviso de obligatorios está abierto. */
  readonly askingRequired = signal(false);

  /** Nombre de cada página, para titular los grupos del aviso. */
  readonly pageLabels = computed(() =>
    (this.engine()?.pages ?? []).map((page, index) => page.lab || `Página ${index + 1}`),
  );

  /**
   * Todo lo que impide guardar, en la lista del aviso.
   *
   * El nombre entra el primero aunque no sea un campo del tipo: es una columna
   * del registro, es obligatorio siempre, y dejarlo fuera del aviso haría que
   * quien lo olvidó viera «faltan 0 campos» y no entendiera por qué no se
   * guarda.
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

    return [...entries, ...this.missing()];
  });

  // ── Guardar ────────────────────────────────────────────────────────────────

  async save(): Promise<void> {
    const engine = this.engine();
    const type = this.type();

    /**
     * La comprobación se repite al guardar.
     *
     * Esconder el botón es interfaz; esto es la regla. Entre abrir el editor y
     * pulsar guardar pueden haber cambiado los permisos —una sincronización de
     * rol— y lo que decide es lo que valga en el momento de escribir.
     */
    if (!this.allowed()) {
      this.error.set(this.noPermission());
      return;
    }

    this.submitted.set(true);
    engine?.markSubmitted();

    if (!type) {
      this.error.set('Elige un tipo antes de guardar.');
      return;
    }

    /**
     * Lo que falta se enseña y se oye.
     *
     * Antes era una línea de texto arriba del formulario, que en un tipo con
     * veinte campos queda fuera de la pantalla justo cuando se pulsa guardar
     * abajo: el usuario veía que no pasaba nada y volvía a pulsar. El aviso
     * lista lo que falta, lleva a cada campo, y suena — porque en campo la
     * pantalla se mira a ratos.
     */
    if (this.blocking().length > 0) {
      this.askingRequired.set(true);
      void this.sound.warn();
      return;
    }

    this.saving.set(true);
    this.error.set('');

    try {
      const answers = engine?.toAnswerFields() ?? [];
      const fields = (engine?.pages ?? []).flatMap((page) => page.fie);

      const draft = {
        guid: this.entityGuid(),
        name: this.name().trim(),
        type,
        answers,
        titles: titlesFrom(fields, (id) => engine?.valueOf(id) ?? ''),
        ...this.coordinates(engine),
      };

      if (this.subject() === 'asset') {
        const location = await this.editor.findLocation(this.guid());

        await this.editor.saveAsset({
          ...draft,
          locationId: String(location?.LocationID ?? ''),

          // El GUID va siempre: si la sede se creó aquí todavía no tiene
          // identificador de servidor, y sin esto el activo se quedaría
          // huérfano hasta que alguien lo notara.
          locationGuid: this.guid(),
        });
      } else {
        await this.editor.saveLocation(draft);
      }

      await this.afterSave();
    } catch (error) {
      console.error('[Ubicaciones] no se pudo guardar', error);
      this.error.set('No se pudo guardar. Inténtalo de nuevo.');
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Las coordenadas de la entidad, si algún campo las capturó.
   *
   * Se copian a las columnas `Latitude`/`Longitude` además de quedar en la
   * respuesta: son las que usan el listado y el mapa, y buscarlas dentro del
   * JSON cada vez que se pinta una lista de doscientas sedes no es opción.
   */
  private coordinates(engine: FormEngine | null): { latitude?: string; longitude?: string } {
    if (!engine) return {};

    for (const page of engine.pages) {
      for (const field of page.fie) {
        if (field.fty !== 'gps') continue;

        const reading = asGeo(engine.valueOf(field.id));
        if (reading) return { latitude: String(reading.lat), longitude: String(reading.lng) };
      }
    }

    return {};
  }

  /** Cierra el aviso y lleva al primero que falta. */
  async reviewRequired(): Promise<void> {
    const first = this.blocking()[0];

    this.askingRequired.set(false);
    if (first) await this.goToMissing(first);
  }

  /**
   * Lleva a un campo concreto de los que faltan.
   *
   * Cambia de página si hace falta y espera al repintado: el campo puede vivir
   * en otra página y no existir todavía en el documento cuando se pide.
   */
  async goToMissing(entry: MissingEntry): Promise<void> {
    this.askingRequired.set(false);

    if (entry.go) {
      entry.go();
      return;
    }

    this.engine()?.goTo(entry.page);

    setTimeout(() => {
      const element = document.getElementById(`entity-field-${entry.field.id}`);
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      element?.querySelector<HTMLElement>('input, textarea, select')?.focus({
        preventScroll: true,
      });
    });
  }

  /**
   * Cancelar: se vuelve de donde se vino.
   *
   * Si alguien mandó aquí con un destino de vuelta, manda ese: puede ser el
   * selector de una actividad a medias, y llevar al catálogo dejaría el trabajo
   * empezado sin camino de regreso.
   *
   * De crear un activo se vuelve a su ubicación, no a la ficha del activo — que
   * no llegó a existir.
   */
  async leave(): Promise<void> {
    const guid = this.guid();

    if (this.volver()) {
      await this.router.navigateByUrl(this.volver());
      return;
    }

    if (this.subject() === 'asset') {
      const asset = this.asset();

      await this.router.navigate(
        this.isNew() ? ['/ubicaciones', guid] : ['/ubicaciones', guid, 'activo', asset],
      );
      return;
    }

    await this.router.navigate(guid ? ['/ubicaciones', guid] : ['/ubicaciones']);
  }

  /**
   * Después de guardar se abre la ficha de lo que se acaba de crear.
   *
   * Es lo que sigue: comprobar que quedó como se quería, y desde ahí añadirle
   * un activo o registrarle una actividad. Volver al listado obligaría a
   * buscarlo otra vez.
   */
  private async afterSave(): Promise<void> {
    const guid = this.guid();

    /**
     * Vuelta al selector que mandó aquí, diciéndole qué se creó.
     *
     * No basta con que aparezca en la lista: quien salió a dar de alta una sede
     * en mitad de abrir una actividad la quiere **ya asociada**. El selector la
     * toma de `creado` y la asocia sin que haya que buscarla otra vez.
     */
    if (this.volver()) {
      await this.router.navigateByUrl(withCreated(this.volver(), this.entityGuid()));
      return;
    }

    if (this.subject() === 'asset') {
      await this.router.navigate(['/ubicaciones', guid, 'activo', this.entityGuid()]);
      return;
    }

    await this.router.navigate(['/ubicaciones', this.entityGuid()]);
  }
}

/** Lleva al nombre, que vive fuera del motor y no tiene tarjeta propia. */
function focusName(): void {
  const input = document.getElementById('entity-name');

  input?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  (input as HTMLInputElement | null)?.focus({ preventScroll: true });
}

/**
 * La dirección de vuelta, con la entidad recién creada.
 *
 * Se añade como parámetro y no se guarda en memoria: recargar la página en ese
 * punto tiene que seguir funcionando, y un servicio con estado se habría
 * vaciado.
 */
function withCreated(url: string, guid: string): string {
  if (!guid) return url;

  const [path, query = ''] = url.split('?');
  const params = new URLSearchParams(query);
  params.set('creado', guid);

  return `${path}?${params.toString()}`;
}

/**
 * El tipo reconstruido a partir del propio registro.
 *
 * Las entidades que bajan del servidor traen consigo la estructura de sus
 * campos, así que se pueden editar aunque su tipo no esté descargado. Sin esto,
 * editar una sede existente enseñaría un formulario vacío — y guardarla borraría
 * lo que tenía.
 */
function syntheticType(
  name: string,
  jsonFields: string,
  jsonDescriptors: string,
  guid: string,
): EntityType {
  return {
    ID: 0,
    GUID: guid ?? '',
    UserID: 0,
    CompanyID: '',
    Name: name || 'Tipo del registro',
    jsonFields: jsonFields ?? '',
    FlatForm: '',
    jsonDescriptors: jsonDescriptors ?? '',
    Sect: '',
  };
}
