import { DatePipe } from '@angular/common';
import { Component, computed, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { EntityUploadService } from '../../core/sync/entity-upload.service';
import { LocationEditorService } from '../../core/services/location-editor.service';
import { ToastService } from '../../core/services/toast.service';

import { esModoPublico } from '../../core/config/modo-publico';
import { Asset, LocationForm, Survey, SurveyAnswer } from '../../core/models/entities.model';
import { ANSWER_STATE } from '../../core/models/activity.model';
import { ActivityService, readRequirements, resolveNextStep } from '../../core/services/activity.service';
import {
  ConfiguracionDelEnlace,
  EnlaceCerrado,
  EnlacePublicoService,
} from '../../core/services/enlace-publico.service';
import {
  EntityPickerComponent,
  PickerItem,
} from '../activities/entity-picker/entity-picker.component';
import { IconComponent } from '../../shared/components/icon/icon.component';

/** Cuántas entidades trae cada página del selector en línea. */
const POR_PAGINA = 25;

/** Espera entre teclas antes de consultar. Ver [buscar]. */
const ESPERA_MS = 300;

/** En qué punto va la apertura del enlace. */
type Paso = 'abriendo' | 'retomar' | 'ubicacion' | 'activo' | 'cerrado' | 'error';

/**
 * La puerta de un enlace público.
 *
 * ## Qué hace
 *
 * Resolver el enlace en línea, sembrar la base pública con lo que haga falta,
 * preguntar la ubicación y el activo **solo si el enlace no los dejó puestos**,
 * crear la actividad y mandar a la pantalla de siempre —la misma que usa quien
 * tiene sesión, con su motor de flujos, sus obligatorios y sus tablas de
 * detalle—.
 *
 * ## Por qué es una pantalla y no un guardia
 *
 * Porque tiene cosas que contar. Un enlace puede haber vencido, haberse
 * agotado, haberse apagado, apuntar a un formulario que ya no está, o
 * simplemente encontrarse sin conexión — y cada uno de esos casos se arregla de
 * una forma distinta. Un guardia solo sabe dejar pasar o no.
 *
 * ## Lo que no se pierde
 *
 * Si en este navegador quedó una actividad de este mismo enlace **sin subir**,
 * se ofrece retomarla antes de empezar otra. Es la única forma de recuperarla:
 * aquí no hay sesión con la que identificar a esa persona más tarde.
 */
@Component({
  selector: 'vt-enlace-publico',
  standalone: true,
  imports: [DatePipe, EntityPickerComponent, IconComponent],
  templateUrl: './enlace-publico.component.html',
  styleUrl: './enlace-publico.component.scss',
})
export class EnlacePublicoComponent {
  private readonly router = inject(Router);
  private readonly enlaces = inject(EnlacePublicoService);
  private readonly activities = inject(ActivityService);
  private readonly subidas = inject(EntityUploadService);
  private readonly editor = inject(LocationEditorService);
  private readonly toasts = inject(ToastService);

  /** El GUID, del segmento de la ruta. Solo para reintentar sobre la misma. */
  readonly guid = input('');

  /**
   * Al volver del editor de entidades: qué se creó y para qué actividad.
   *
   * El editor es la pantalla de siempre —la misma que usa quien tiene sesión—
   * y vuelve aquí con `?creado=<guid>`. La actividad viaja en la misma
   * dirección porque esta pantalla se vuelve a montar desde cero al volver, y
   * sin ella se ofrecería «retomar» o se crearía otra.
   */
  readonly creado = input('');
  readonly actividad = input('');

  readonly paso = signal<Paso>('abriendo');
  readonly mensaje = signal('');
  readonly detalle = signal('');

  readonly config = signal<ConfiguracionDelEnlace | null>(null);
  readonly survey = signal<Survey | null>(null);

  /** La actividad en curso: la que se acaba de crear o la que se retomó. */
  private readonly answer = signal<SurveyAnswer | null>(null);

  /** Actividades de visitas anteriores que no llegaron a subir. */
  readonly pendientes = signal<SurveyAnswer[]>([]);

  // ── El selector en línea ──────────────────────────────────────────────────

  readonly cargando = signal(false);
  readonly buscando = signal(false);
  readonly busqueda = signal('');
  readonly total = signal(0);

  private readonly paginaActual = signal(1);
  private readonly ubicaciones = signal<Record<string, unknown>[]>([]);
  private readonly activos = signal<Record<string, unknown>[]>([]);

  private temporizador?: ReturnType<typeof setTimeout>;

  readonly titulo = computed(() =>
    this.paso() === 'activo' ? 'Elige el equipo' : 'Elige la ubicación',
  );

  readonly subtitulo = computed(() => {
    const nombre = this.survey()?.Title ?? '';
    return nombre ? `Para «${nombre}»` : '';
  });

  readonly items = computed<PickerItem[]>(() => {
    const filas = this.paso() === 'activo' ? this.activos() : this.ubicaciones();

    return filas.map((fila) => this.comoOpcion(fila));
  });

  readonly hayMas = computed(() => {
    const cargadas = this.paso() === 'activo' ? this.activos().length : this.ubicaciones().length;
    return cargadas < this.total();
  });

  constructor() {
    void this.abrir();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Abrir
  // ───────────────────────────────────────────────────────────────────────────

  async abrir(): Promise<void> {
    this.paso.set('abriendo');
    this.mensaje.set('');

    /*
     * El modo se enciende en `main.ts`, antes de arrancar. Si aquí no está
     * encendido es que el navegador no dejó escribir en `sessionStorage`
     * —modo privado estricto, o una política de la empresa— y sin eso no hay
     * dónde guardar nada: mejor decirlo que fallar más adelante con un error
     * que no se parece a la causa.
     */
    if (!esModoPublico()) {
      this.paso.set('error');
      this.mensaje.set('Tu navegador no permite guardar datos de esta página');
      this.detalle.set(
        'Suele pasar en ventanas de incógnito o con el almacenamiento bloqueado. ' +
          'Abre el enlace en una ventana normal e inténtalo otra vez.',
      );
      return;
    }

    try {
      const config = await this.enlaces.abrir();
      this.config.set(config);

      const survey = await this.activities.findSurvey(String(config.surveyId));

      if (!survey) {
        this.paso.set('cerrado');
        this.mensaje.set('Este enlace ya no tiene formulario');
        this.detalle.set('Pídele uno nuevo a quien te lo envió.');
        return;
      }

      this.survey.set(survey);

      // Se viene del editor con una ubicación o un activo recién creados.
      if (this.creado() && this.actividad()) {
        const retomada = await this.activities.findByGuid(this.actividad());

        if (retomada) {
          this.answer.set(retomada);
          await this.alCrearEntidad(this.creado());
          return;
        }
      }

      // Lo que quedó a medias de una visita anterior manda: empezar una
      // actividad nueva encima dejaría la anterior enterrada.
      const sinSubir = await this.buscarPendientes(survey);

      if (sinSubir.length > 0) {
        this.pendientes.set(sinSubir);
        this.paso.set('retomar');
        return;
      }

      await this.empezar();
    } catch (error) {
      this.contarLoQuePaso(error);
    }
  }

  /** Traduce el fallo a algo que quien lo lee pueda hacer. */
  private contarLoQuePaso(error: unknown): void {
    if (error instanceof EnlaceCerrado) {
      this.paso.set('cerrado');

      switch (error.motivo) {
        case 'caducado':
          this.mensaje.set('Este enlace ya venció');
          this.detalle.set('Pídele uno nuevo a quien te lo envió.');
          break;

        case 'agotado':
          this.mensaje.set('Este enlace ya se usó todas las veces permitidas');
          this.detalle.set('Pídele uno nuevo a quien te lo envió.');
          break;

        default:
          this.mensaje.set('Este enlace no está disponible');
          this.detalle.set(
            'Puede que lo hayan desactivado. Comprueba con quien te lo envió que sigue vigente.',
          );
      }

      return;
    }

    this.paso.set('error');
    this.mensaje.set('No se pudo abrir el formulario');
    this.detalle.set(
      error instanceof Error
        ? error.message
        : 'Comprueba tu conexión e inténtalo de nuevo.',
    );
  }

  /**
   * Actividades de este formulario que siguen sin llegar a Visitrack.
   *
   * Incluye los borradores: en un enlace público un borrador es trabajo real a
   * medias, y quien lo dejó no tiene ninguna otra pantalla desde donde
   * recuperarlo.
   */
  private async buscarPendientes(survey: Survey): Promise<SurveyAnswer[]> {
    const todas = await this.activities.listBySurvey(survey.SurveyID);

    /*
     * «Sin terminar» es **no haber pulsado Guardar**, no «no haber subido».
     *
     * Son dos cosas muy distintas y antes se contaban como una. Una respuesta
     * que se guardó y está subiendo ya está terminada: quien la llenó hizo su
     * parte y lo que queda es cosa de la cola. Ofrecerle «continuar» al abrir
     * de nuevo el enlace la invitaría a rehacer un trabajo que ya entregó.
     *
     * Y rompía «Llenar otra»: al volver a la puerta del enlace justo después de
     * guardar, la que acababa de salir aparecía como pendiente y se topaba con
     * la pantalla de retomar en vez de empezar una nueva.
     *
     * Solo cuenta `UNSAVED`. `PENDING` y `WAITING_BINARIES` son estados de la
     * subida, y esa se reintenta sola.
     */
    const sinTerminar = todas.filter((a) => Number(a.isSaved) === ANSWER_STATE.UNSAVED);
    const yaEntregadas = todas.filter((a) => Number(a.isSaved) === ANSWER_STATE.SYNCED);

    await this.recogerLoViejo(yaEntregadas);

    return sinTerminar;
  }

  /**
   * Borra de este navegador lo que ya llegó a Visitrack hace más de una semana.
   *
   * Con sus archivos, que es lo que de verdad ocupa: unas cuantas fotos por
   * respuesta, en un equipo compartido, acaban llenando la cuota del navegador
   * — y cuando eso pasa, lo que el navegador purga es la base entera, incluida
   * la respuesta de alguien que todavía no ha subido.
   *
   * **Solo lo confirmado.** Lo que no ha subido no se toca nunca, por viejo que
   * sea: es la única copia que existe.
   *
   * Una semana y no un día porque el único uso que le queda a una respuesta ya
   * enviada es que quien la llenó vuelva a abrir el enlace para comprobar que
   * salió, y eso pasa en los días siguientes.
   */
  private async recogerLoViejo(subidas: SurveyAnswer[]): Promise<void> {
    const limite = Date.now() - 7 * 24 * 60 * 60 * 1000;

    for (const actividad of subidas) {
      const cuando = Date.parse(actividad.UpdatedOn ?? actividad.CreatedOn ?? '');

      if (!Number.isFinite(cuando) || cuando > limite) continue;

      try {
        await this.activities.remove(actividad);
      } catch {
        // La limpieza no puede impedir que el formulario se abra: si una no se
        // deja borrar, se queda y se reintenta la próxima vez.
      }
    }
  }

  /** Retoma una actividad de una visita anterior. */
  async retomar(actividad: SurveyAnswer): Promise<void> {
    this.answer.set(actividad);

    /*
     * Lo que le falte se vuelve a pedir.
     *
     * Una actividad retomada puede ser una que se creó y se cerró sin elegir
     * la sede o el equipo —al recargar a medio camino—. Abrirle el formulario
     * directamente dejaba responder con la ubicación en nulo.
     */
    const survey = this.survey();
    const config = this.config();
    if (survey && config) {
      const requisitos = readRequirements(survey);
      const paso = resolveNextStep(requisitos, actividad);

      if (paso === 'location' && !config.conUbicacion) {
        this.paso.set('ubicacion');
        await this.recargar();
        return;
      }

      if (paso === 'asset' && !config.conActivo) {
        await this.irAlPasoDelActivo();
        return;
      }
    }

    await this.alFormulario();
  }

  /** Descarta lo anterior y empieza de cero. */
  async empezarDeNuevo(): Promise<void> {
    this.pendientes.set([]);
    await this.empezar();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Crear la actividad
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Crea la actividad y decide si hay algo que preguntar antes.
   *
   * La actividad se crea **antes** de preguntar la ubicación, igual que en la
   * aplicación normal: si alguien abandona a mitad del selector, lo que llevaba
   * está guardado y la próxima vez que abra el enlace se le ofrece retomarlo.
   */
  private async empezar(): Promise<void> {
    const survey = this.survey();
    const config = this.config();

    if (!survey || !config) return;

    try {
      this.answer.set(await this.activities.create(survey));

      const requisitos = readRequirements(survey);

      // Lo que el enlace dejó puesto ya vino sembrado y asociado; solo se
      // pregunta lo que falta.
      if (requisitos.requiresLocation && !config.conUbicacion) {
        this.paso.set('ubicacion');
        await this.recargar();
        return;
      }

      if (requisitos.requiresAsset && !config.conActivo) {
        await this.irAlPasoDelActivo();
        return;
      }

      await this.alFormulario();
    } catch (error) {
      this.paso.set('error');
      this.mensaje.set('No se pudo preparar el formulario');
      this.detalle.set(error instanceof Error ? error.message : 'Inténtalo de nuevo.');
    }
  }

  /**
   * Asocia lo que el enlace fijó y va al formulario.
   *
   * La ubicación y el activo quemados se asocian aquí y no en el servidor
   * porque la actividad se crea en este navegador: el servidor los vuelve a
   * plantar al recibirla, así que aunque alguien manipulara la fila local, lo
   * que llega a Visitrack sigue siendo lo que el enlace decidió.
   */
  private async alFormulario(): Promise<void> {
    const config = this.config();
    const answer = this.answer();

    if (!config || !answer) return;

    if (config.conUbicacion && !answer.LocationID) {
      const ubicacion = await this.laQueSembroElEnlace<LocationForm>('ubicacion');
      if (ubicacion) {
        const guardada = await this.activities.attachLocation(answer, ubicacion);
        if (guardada) this.answer.set(guardada);
      }
    }

    if (config.conActivo && !this.answer()?.AssetID) {
      const activo = await this.laQueSembroElEnlace<Asset>('activo');
      if (activo) {
        const actual = (await this.activities.findByGuid(answer.GUID)) ?? answer;
        await this.activities.attachAsset(actual, activo);
      }
    }

    await this.router.navigate(
      ['/formularios', String(config.surveyId), 'actividad', answer.GUID],
      { replaceUrl: true },
    );
  }

  /**
   * La entidad que sembró el enlace.
   *
   * Es la única que hay en su store cuando el enlace la fijó, así que no hace
   * falta más criterio que «la primera». Cuando el enlace no la fijó, el store
   * tiene lo que se haya elegido, y este camino no se recorre.
   */
  private async laQueSembroElEnlace<T>(cual: 'ubicacion' | 'activo'): Promise<T | null> {
    const survey = this.survey();
    if (!survey) return null;

    const requisitos = readRequirements(survey);

    const filas =
      cual === 'ubicacion'
        ? await this.activities.listLocations(requisitos.locationTypeGuid, { limit: 1 })
        : await this.activities.listAssets(
            requisitos.assetTypeGuid,
            String(this.answer()?.LocationID ?? ''),
            { limit: 1, locationGuid: String(this.answer()?.LocationGUID ?? '') },
          );

    return (filas[0] as unknown as T) ?? null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // El selector en línea
  // ───────────────────────────────────────────────────────────────────────────

  private async irAlPasoDelActivo(): Promise<void> {
    this.paso.set('activo');
    this.busqueda.set('');
    this.paginaActual.set(1);
    this.activos.set([]);

    await this.recargar();
  }

  /**
   * Espera entre teclas antes de consultar.
   *
   * Sin esto, escribir «bodega» son seis peticiones al servidor de las que solo
   * importa la última — y en una conexión lenta las respuestas llegan
   * desordenadas y la lista parpadea con resultados de lo que ya no se busca.
   */
  buscar(texto: string): void {
    this.busqueda.set(texto);

    clearTimeout(this.temporizador);

    this.temporizador = setTimeout(() => {
      this.paginaActual.set(1);

      if (this.paso() === 'activo') this.activos.set([]);
      else this.ubicaciones.set([]);

      void this.recargar(true);
    }, ESPERA_MS);
  }

  /** Trae la página siguiente y la añade a lo que ya hay. */
  async masResultados(): Promise<void> {
    this.paginaActual.update((n) => n + 1);
    await this.recargar();
  }

  private async recargar(esBusqueda = false): Promise<void> {
    if (esBusqueda) this.buscando.set(true);
    else this.cargando.set(true);

    try {
      if (this.paso() === 'activo') {
        const pagina = await this.enlaces.activos(
          String(this.answer()?.LocationID ?? ''),
          this.busqueda(),
          this.paginaActual(),
        );

        this.activos.update((previas) => [...previas, ...(pagina.items as any[])]);
        this.total.set(pagina.total);
      } else {
        const pagina = await this.enlaces.ubicaciones(this.busqueda(), this.paginaActual());

        this.ubicaciones.update((previas) => [...previas, ...(pagina.items as any[])]);
        this.total.set(pagina.total);
      }
    } catch {
      // Se deja la lista como está y se dice arriba: vaciarla haría creer que
      // la búsqueda no encontró nada, que es una cosa muy distinta.
      this.mensaje.set('No se pudieron traer los datos. Comprueba tu conexión.');
    } finally {
      this.cargando.set(false);
      this.buscando.set(false);
    }
  }

  /** Eligió una. Se guarda en la base y se sigue al paso siguiente. */
  /** Si en este paso se puede dar de alta lo que no se encuentra. */
  readonly puedeCrear = computed(() => {
    const config = this.config();
    if (!config) return false;

    return this.paso() === 'activo' ? config.puedeCrearActivos : config.puedeCrearUbicaciones;
  });

  /**
   * Al editor de siempre, y de vuelta aquí con lo creado.
   *
   * Del tipo que exige el formulario, como en el selector con sesión: de otro
   * tipo no serviría para esta actividad. La actividad viaja en la dirección
   * de vuelta para retomarla tal cual al regresar.
   */
  async crearNueva(): Promise<void> {
    const survey = this.survey();
    const answer = this.answer();
    if (!survey || !answer) return;

    const requisitos = readRequirements(survey);
    const volver = `/e/${this.guid()}?actividad=${encodeURIComponent(answer.GUID)}`;

    if (this.paso() === 'activo') {
      const ubicacion = answer.LocationGUID;
      if (!ubicacion) return;

      await this.router.navigate(['/ubicaciones', ubicacion, 'activo', 'nuevo'], {
        queryParams: { volver, tipo: requisitos.assetTypeGuid ?? '' },
      });
      return;
    }

    await this.router.navigate(['/ubicaciones', 'nueva'], {
      queryParams: { volver, tipo: requisitos.locationTypeGuid ?? '' },
    });
  }

  /**
   * Lo recién creado se asocia **ya** y sube a Visitrack por detrás.
   *
   * Antes se subía primero y se asociaba después, esperando la respuesta del
   * servidor con la rueda puesta. El alta de una sede en Visitrack no es
   * instantánea —el procedimiento reparte la novedad a todos los aparatos de
   * la zona— y quien acaba de pulsar «Crear» se quedaba mirando la rueda sin
   * saber qué pasaba, a veces bastantes segundos, creyendo que se había
   * colgado.
   *
   * No hace falta esperar. La actividad lleva el GUID de lo creado y, cuando
   * el servidor devuelve el identificador, la cola lo pone en su sitio
   * (`relabelAnswers`): es lo mismo que pasa con sesión al crear una sede sin
   * cobertura. Y la actividad **no sale** hasta que sus entidades estén
   * arriba —`waitingEntities`—, así que nunca llega apuntando a nada.
   *
   * Si el servidor la rechaza se avisa con el motivo y la cola lo reintenta;
   * lo diligenciado no se pierde.
   */
  private async alCrearEntidad(guidCreado: string): Promise<void> {
    const config = this.config();
    const answer = this.answer();
    const survey = this.survey();
    if (!config || !answer || !survey) return;

    const requisitos = readRequirements(survey);
    const activo = await this.editor.findAsset(guidCreado);
    const ubicacion = activo ? null : await this.editor.findLocation(guidCreado);

    if (!activo && !ubicacion) {
      this.toasts.show({
        title: 'Lo que se creó ya no está en este navegador',
        detail: 'Vuelve a crearlo o elige uno de la lista.',
        tone: 'error',
      });
      this.paso.set(requisitos.requiresLocation && !answer.LocationID ? 'ubicacion' : 'activo');
      await this.recargar();
      return;
    }

    const actual = (await this.activities.findByGuid(answer.GUID)) ?? answer;

    if (activo) {
      await this.activities.attachAsset(actual, activo);
      this.toasts.show({
        title: 'Activo creado',
        detail: 'Se está subiendo a Visitrack mientras sigues.',
        tone: 'success',
      });
      this.subirDetras('activo', guidCreado);
      await this.alFormulario();
      return;
    }

    const conUbicacion = await this.activities.attachLocation(actual, ubicacion!);
    if (conUbicacion) this.answer.set(conUbicacion);

    this.toasts.show({
      title: 'Ubicación creada',
      detail: 'Se está subiendo a Visitrack mientras sigues.',
      tone: 'success',
    });
    this.subirDetras('ubicacion', guidCreado);

    if (requisitos.requiresAsset && !config.conActivo) {
      await this.irAlPasoDelActivo();
      return;
    }

    await this.alFormulario();
  }

  /**
   * Sube lo creado sin bloquear la pantalla, y cuenta cómo fue.
   *
   * Va por la cola entera y no por la entidad suelta: un activo recién creado
   * cuelga de una sede que puede estar subiendo en este mismo momento, y la
   * cola ya sabe esperar a la sede, tomar su identificador y subir el activo
   * detrás. Si hay una corrida en marcha se espera a que acabe: lanzar otra
   * encima solo devolvería «ya hay una subida en curso».
   *
   * La pantalla desde la que se llamó puede haberse ido; los avisos son
   * globales y la cola vive en el armazón.
   */
  private subirDetras(entidad: 'ubicacion' | 'activo', guid: string): void {
    void (async () => {
      try {
        while (this.subidas.running()) await espera(400);

        await this.subidas.run();

        const subida =
          entidad === 'activo'
            ? (await this.editor.findAsset(guid))?.SyncedToServer === '1'
            : (await this.editor.findLocation(guid))?.SyncedToServer === '1';

        if (subida) return;

        const resumen = this.subidas.lastSummary();
        this.toasts.show({
          title: entidad === 'activo' ? 'El activo aún no subió' : 'La ubicación aún no subió',
          detail: `${resumen?.message ?? 'Se reintenta solo.'} La actividad esperará a que esté arriba.`,
          tone: 'warning',
        });
      } catch (error) {
        console.warn('[Enlace] no se pudo subir lo creado; la cola lo reintenta', error);
      }
    })();
  }

  async elegir(opcion: PickerItem): Promise<void> {
    const config = this.config();
    const answer = this.answer();
    const survey = this.survey();

    if (!config || !answer || !survey) return;

    const enActivo = this.paso() === 'activo';
    const filas = enActivo ? this.activos() : this.ubicaciones();
    const fila = filas.find((f) => String(f['GUID']) === opcion.id);

    if (!fila) return;

    this.cargando.set(true);

    try {
      // Lo que se asocia es el registro **ya mapeado**, no la fila del
      // servidor: son dos formas del mismo dato y la que la base entiende es la
      // primera.
      const guardado = await this.enlaces.guardarEntidad(enActivo ? 12 : 1, fila);
      if (!guardado) return;

      // Y la actividad se relee, porque el paso anterior pudo cambiarla.
      const actual = (await this.activities.findByGuid(answer.GUID)) ?? answer;

      if (enActivo) {
        await this.activities.attachAsset(actual, guardado as unknown as Asset);
        await this.alFormulario();
        return;
      }

      const conUbicacion = await this.activities.attachLocation(
        actual,
        guardado as unknown as LocationForm,
      );

      if (conUbicacion) this.answer.set(conUbicacion);

      if (readRequirements(survey).requiresAsset && !config.conActivo) {
        await this.irAlPasoDelActivo();
        return;
      }

      await this.alFormulario();
    } finally {
      this.cargando.set(false);
    }
  }

  /**
   * Una fila del servidor, como opción del selector.
   *
   * Los descriptores se arman con lo que distingue de verdad una sede de otra
   * —la etiqueta física, la dirección, la serie—: en un catálogo con doce
   * «Bodega principal», el nombre por sí solo no permite elegir.
   */
  private comoOpcion(fila: Record<string, unknown>): PickerItem {
    const texto = (clave: string) => String(fila[clave] ?? '').trim();

    const pistas =
      this.paso() === 'activo'
        ? [texto('SerialNumber'), texto('Make'), texto('Model')]
        : [texto('FullAddress'), texto('City')];

    return {
      id: texto('GUID'),
      name: texto('Name') || 'Sin nombre',
      hint: pistas.filter(Boolean).join(' · '),
      descriptors: texto('TagUID') ? [{ lab: 'Etiqueta', val: texto('TagUID') }] : [],
    };
  }

  /** Reintenta desde cero. */
  reintentar(): void {
    void this.abrir();
  }
}

/** Una pausa corta, para esperar a que acabe una corrida en marcha. */
function espera(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
