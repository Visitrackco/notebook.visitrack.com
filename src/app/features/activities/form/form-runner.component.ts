import {
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { MatTooltipModule } from '@angular/material/tooltip';

import { ActivityInheritsService } from '../../../core/forms/activity-inherits.service';
import { FormEngine } from '../../../core/forms/form-engine';
import {
  AnswerField,
  FieldValue,
  FormField,
  ResolvedDescriptor,
  parseAnswerFields,
  parseQuestions,
} from '../../../core/forms/form-schema';
import { Survey, SurveyAnswer } from '../../../core/models/entities.model';
import { DispatchStatusRepository } from '../../../core/repositories/entity.repositories';
import { SurveyAnswerRepository } from '../../../core/repositories/survey-answer.repository';
import { ActivityService } from '../../../core/services/activity.service';
import { AlertSoundService } from '../../../core/services/alert-sound.service';
import { AuthService } from '../../../core/services/auth.service';
import { CorreoService } from '../../../core/services/correo.service';
import { PushFlujoService } from '../../../core/services/push-flujo.service';
import { DespachoService } from '../../../core/services/despacho.service';
import { LluviaEmojisService } from '../../../core/services/lluvia-emojis.service';
import { ToastService, toneDelTono } from '../../../core/services/toast.service';
import { Destinatario, DestinatarioDialogComponent } from './destinatario-dialog/destinatario-dialog.component';
import { ShortcutsService } from '../../../core/services/shortcuts.service';
import { AutosaveService } from '../../../core/services/autosave.service';
import {
  Animacion,
  CorreoPedido,
  Flujo,
  HerenciaDeActividad,
  PushPedido,
} from '../../../core/forms/flujo-modelo';

/**
 * Cuánto se espera al pulsar un botón de correo antes de soltarlo.
 *
 * Veinte segundos. El correo no se pierde al agotarse —queda apuntado y sale en
 * la próxima subida—; lo que se acaba es la espera, para que una red que se cae
 * a mitad no deje a nadie mirando un botón que no responde.
 */
const ESPERA_DEL_BOTON = 20_000;
import { FlujoService } from '../../../core/forms/flujo.service';
import { MasterDetailSourceService } from '../../../core/forms/master-detail-source.service';
import {
  comoLoGuarda,
  datoDeLaRuta,
  normalizar,
  textoDeLaRespuesta,
} from '../../../core/forms/flujo-motor';
import { createBlankRow, createRow, readRows } from '../../../core/forms/master-detail';
import { PendingUploadService } from '../../../core/sync/pending-upload.service';
import { BinaryVerifyService } from '../../../core/sync/binary-verify.service';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { ToTopComponent } from '../../../shared/components/to-top/to-top.component';
import { FieldHostComponent } from './fields/field-host.component';
import { FlujoBotonesComponent } from './flujo-botones/flujo-botones.component';
import { FlujoLlamadasComponent } from './flujo-llamadas/flujo-llamadas.component';
import {
  ArchivoDeIntegracion,
  IntegracionesApi,
  comoSeVeLaRespuesta,
} from '../../../core/forms/integraciones.api';
import { LlamadaPintada } from '../../../core/forms/flujo-modelo';
import { FlujoGraficaComponent } from './flujo-grafica/flujo-grafica.component';
import { PageNavComponent } from './page-nav/page-nav.component';
import { MasterDetailPanelsService } from './master-detail-row/master-detail-panels.service';
import { MissingEntry, RequiredDialogComponent } from './required-dialog/required-dialog.component';
import { CompanyLogicService } from '../../../core/rules/company-logic.service';

/**
 * Cómo se reconoce un descriptivo puesto por el flujo.
 *
 * Va en el identificador y no en una lista aparte porque el `JSONTitle` viaja a
 * la nube y vuelve: cualquier registro que se llevara por fuera se perdería en
 * el viaje, y al volver no habría forma de distinguirlos de los demás.
 */
const PREFIJO_DESCRIPTIVO_DE_FLUJO = 'flujo:';

/**
 * Diligenciamiento de una actividad.
 *
 * Junta las tres piezas: el [FormEngine] que lleva el estado, los componentes
 * que dibujan cada campo y la persistencia.
 *
 * ## Guardar no es lo mismo que persistir
 *
 * Cada cambio se escribe solo, con retardo, igual que en la app: un formulario
 * a medias sobrevive a que se cierre la pestaña. El botón **Guardar** hace otra
 * cosa —marca la actividad como terminada y lista para subir— y es el único
 * momento en que se exigen los obligatorios.
 *
 * Separarlos importa: si el autoguardado exigiera campos completos no podría
 * escribir nada hasta el final, que es justo cuando ya no hace falta.
 */
@Component({
  selector: 'vt-form-runner',
  standalone: true,
  imports: [
    FieldHostComponent,
    FlujoBotonesComponent,
    FlujoLlamadasComponent,
    FlujoGraficaComponent,
    IconComponent,
    MatTooltipModule,
    PageNavComponent,
    RequiredDialogComponent,
    DestinatarioDialogComponent,
    ToTopComponent,
  ],
  templateUrl: './form-runner.component.html',
  styleUrl: './form-runner.component.scss',
})
export class FormRunnerComponent {
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly activities = inject(ActivityService);
  private readonly autosave = inject(AutosaveService);
  private readonly flujos = inject(FlujoService);
  private readonly detalles = inject(MasterDetailSourceService);
  private readonly pendingUploads = inject(PendingUploadService);
  private readonly panels = inject(MasterDetailPanelsService);
  private readonly sound = inject(AlertSoundService);
  private readonly shortcuts = inject(ShortcutsService);
  private readonly companyLogic = inject(CompanyLogicService);
  private readonly inherits = inject(ActivityInheritsService);
  private readonly estados = inject(DispatchStatusRepository);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly lluvias = inject(LluviaEmojisService);
  private readonly despachos = inject(DespachoService);
  private readonly correos = inject(CorreoService);
  private readonly pushes = inject(PushFlujoService);

  /** Los avisos del flujo que ya se enseñaron, para no repetirlos. */
  private readonly avisosDichos = new Set<string>();

  /** Las lluvias de caritas que ya se lanzaron, para no repetirlas. */
  private readonly animacionesLanzadas = new Set<string>();

  /*
   * ── Las gráficas que un botón ha destapado ────────────────────────────────
   *
   * Vive aquí y no en el motor a propósito. El motor decide **si** una gráfica
   * nace escondida, que es cosa del flujo y se recalcula con cada tecla; que
   * alguien haya pulsado el botón es de quien está mirando la pantalla, y no
   * puede depender de lo que se conteste después. Mezclarlos haría que el
   * resumen se volviera a tapar solo al responder la pregunta siguiente.
   *
   * Se guardan por su nombre, que es como el botón las llama.
   */
  private readonly destapadas = signal<ReadonlySet<string>>(new Set());

  destapar(nombres: string[]): void {
    this.destapadas.set(new Set([...this.destapadas(), ...nombres]));
  }

  /**
   * Los correos que pidió un botón al pulsarlo.
   *
   * Se **apuntan**, no se mandan: salen cuando la actividad esté en Visitrack
   * con sus archivos, igual que los que pide una regla al guardar. Por eso
   * pulsar el botón no exige tener señal.
   *
   * Es el gemelo de lo que ya hacía la app. Sin esto, un botón que en el
   * teléfono manda un correo aquí no hacía nada, y la misma regla se comportaba
   * distinto según por dónde se diligenciara.
   */
  /**
   * Lo que impide que el correo de un botón salga, dicho al pulsarlo.
   *
   * Lo decide el motor —ver `problemasDelCorreo`— y aquí solo se pinta: así el
   * teléfono y el navegador dicen exactamente lo mismo.
   */
  correoNoSePuede(problemas: string[]): void {
    this.toasts.show({
      title: 'No se puede enviar todavía',
      detail: problemas.join(' · '),
      tone: 'warning',
    });
  }

  /**
   * Los avisos que pidió un botón al pulsarlo.
   *
   * Gemelo de `correosDeUnBoton`. Se apuntan y se intenta encolarlos en el
   * momento: si la actividad ya está arriba salen enseguida, y si no, el
   * servidor responde 409 y vuelven con la próxima subida.
   */
  /**
   * Las caritas que pidió un botón al pulsarlo.
   *
   * Se lanzan sin pasar por `animacionesLanzadas`: aquel registro existe para
   * que una regla que sigue cumpliéndose no relance su lluvia en cada
   * evaluación. Un botón es lo contrario — se pulsa a propósito, y quien lo
   * pulsa dos veces quiere verlo dos veces.
   */
  celebrarDeUnBoton(caritas: Animacion[]): void {
    for (const una of caritas) this.lluvias.lanzar(una);
  }

  /**
   * La nota que un botón calculó, escrita en su campo.
   *
   * La cuenta la hizo el motor al armar el botón, y se rehace con cada cambio,
   * así que aquí no hay nada que calcular: solo dejarla donde va.
   */
  puntuarDesdeUnBoton(nota: { campo: string; valor: number }): void {
    const engine = this.engine();
    if (!engine) return;

    if (!engine.escribirValorDeUnBoton(nota.campo, nota.valor)) {
      this.toasts.show({
        title: 'No se pudo escribir la calificación',
        detail: `El campo «${nota.campo}» no existe o no admite ese valor.`,
        tone: 'warning',
      });
    }
  }

  async pushesDeUnBoton(pushes: PushPedido[]): Promise<void> {
    const guid = String(this.answer()?.GUID ?? '');

    // Sin GUID no hay de dónde colgarlo, y se dice: callarlo dejaría un botón
    // que no hace nada sin ninguna explicación.
    if (!guid) {
      this.toasts.show({
        title: 'Guarda la actividad primero',
        detail: 'La notificación tiene que colgar de ella.',
        tone: 'warning',
      });

      return;
    }

    let puestos = 0;

    for (const push of pushes) {
      // Solo los que de verdad se apuntaron: uno que ya estaba no se pidió
      // ahora, y contarlo haría que la pantalla dijera que se disparó otra vez.
      const puesto = await this.pushes.apuntar({
        AnswerGUID: guid,
        Llave: String(push.llave ?? ''),
        Para: String(push.para ?? ''),
        Titulo: String(push.titulo ?? ''),
        Texto: String(push.texto ?? ''),
        Foto: String(push.foto ?? ''),
        Enlace: String(push.enlace ?? ''),
        Programado: String(push.programado ?? ''),
        Regla: String(push.regla ?? ''),
        Disparo: 'boton',
      });

      if (puesto) puestos++;
    }

    if (!puestos) {
      // Ya estaban pedidos. Se dice, porque pulsar y que no pase nada visible
      // se lee como que el botón no funciona.
      this.toasts.show({
        title: 'Ya estaba pedida',
        detail: 'Esta notificación se pidió antes y sale una sola vez.',
        tone: 'info',
      });

      return;
    }

    const salida = await this.pushes.encolarPendientes(guid);

    // El motivo manda sobre el «en camino»: si el servidor lo rechazó para
    // siempre, decir que va en camino sería mentir justo cuando hay que avisar.
    if (salida.motivo) {
      this.toasts.show({
        title: 'La notificación no se pudo pedir',
        detail: salida.motivo,
        tone: 'warning',
      });

      return;
    }

    this.toasts.show({
      title: puestos === 1 ? 'Notificación en camino' : `${puestos} notificaciones en camino`,
      detail: 'Sale en cuanto la actividad esté en Visitrack.',
      tone: 'success',
    });
  }

  async correosDeUnBoton(correos: CorreoPedido[]): Promise<void> {
    const guid = String(this.answer()?.GUID ?? '');

    /*
     * Sin GUID no hay de dónde colgarlo, y se dice.
     *
     * Pasa en una actividad que todavía no se ha guardado ni una vez. Callarlo
     * dejaría un botón que no hace nada sin ninguna explicación, que es lo que
     * en campo se lee como una aplicación rota.
     */
    if (!guid) {
      this.toasts.show({
        title: 'Guarda la actividad primero',
        detail: 'El correo tiene que colgar de ella.',
        tone: 'warning',
      });

      return;
    }

    let puestos = 0;

    for (const correo of correos) {
      // Solo los que de verdad se apuntaron: uno que ya estaba no se pidió
      // ahora, y contarlo haría que la pantalla dijera que se disparó otra vez.
      const puesto = await this.correos.apuntar({
        AnswerGUID: guid,
        Llave: String(correo.llave ?? ''),
        Para: String(correo.para ?? ''),
        Copia: String(correo.copia ?? ''),
        CopiaOculta: String(correo.copiaOculta ?? ''),
        Adjuntos: correo.adjuntos ? JSON.stringify(correo.adjuntos) : '',
        MensajeEnviando: String(correo.mensajeEnviando ?? ''),
        MensajeEnviado: String(correo.mensajeEnviado ?? ''),
        Asunto: String(correo.asunto ?? ''),
        Cuerpo: String(correo.cuerpo ?? ''),
        Proveedor: String(correo.proveedor ?? ''),
        Area: String(correo.area ?? ''),
        Programado: String(correo.programado ?? ''),
        Regla: String(correo.regla ?? ''),
      });

      if (puesto) puestos++;
    }

    /*
     * Ya estaba pedido: la regla manda una sola vez.
     *
     * Se dice en vez de callarlo. Antes se anunciaba «enviando…» y se lanzaba la
     * subida igual, así que parecía que el correo se disparaba otra vez cuando
     * en realidad no se creaba ninguno: la pantalla mentía sobre lo que el motor
     * ya estaba haciendo bien.
     *
     * Para que pueda volver a salir hay que encenderle «Se puede volver a
     * enviar» a la regla, y eso se decide al configurarla, no aquí.
     */
    if (puestos === 0) {
      this.toasts.show({
        title: 'Este correo ya se pidió',
        detail: 'La regla manda enviarlo una sola vez.',
        tone: 'info',
      });

      return;
    }

    /*
     * Y se dice que va, con el texto de la regla.
     *
     * Pulsar el botón dispara una subida que puede tardar unos segundos, y sin
     * nada en pantalla eso se lee como que no pasó nada — que es como se acaba
     * pulsando tres veces. El texto sale del flujo porque quien lo configuró
     * sabe qué se está mandando: «Enviando el acta al cliente…» dice de qué va,
     * y un genérico no.
     */
    const enviando = correos.map((c) => String(c.mensajeEnviando ?? '')).find((t) => !!t);
    const texto =
      enviando || (correos.length === 1 ? 'Enviando el correo…' : 'Enviando los correos…');

    /*
     * Síncrono o suelto, según lo diga la regla.
     *
     * Síncrono deja el botón ocupado hasta que el correo queda pedido, para
     * cuando lo que sigue depende de que salga. Suelto avisa y deja seguir
     * trabajando, para el correo que es un efecto secundario.
     *
     * Ausente significa síncrono — ver `CorreoDeFlujo.avisoSincrono`.
     */
    const sincrono = !correos.some((c) => c.avisoSincrono === false);

    if (!sincrono) {
      this.toasts.show({ title: texto, tone: 'info' });
      // Sin `await`: el aviso de que salieron lo dará `dispatch`, y mientras
      // tanto se puede seguir tocando el formulario.
      void this.dispatch(guid);

      return;
    }

    // Síncrono: se tapa la pantalla. El toast no vale aquí, que lo que se pide
    // es no poder seguir hasta que esté.
    this.correoEnCurso.set(texto);

    /*
     * Y se intenta **ya**, sin esperar al siguiente guardado.
     *
     * Es la diferencia entre un botón y una regla de guardar: quien lo pulsa
     * está pidiendo que pase algo ahora. `dispatch` hace la cadena entera —sube
     * la actividad si le falta, y encola después—, que es el único orden
     * posible: el servidor rechaza un correo cuya actividad todavía no está
     * arriba, porque de ella saca los adjuntos y a ella remite.
     *
     * Lo que no arrastra son los cambios sin guardar: sube lo guardado. Quien
     * pulse el botón a media edición verá el correo salir con lo que había.
     */
    /*
     * Con tope de espera, y esto no es opcional.
     *
     * Esperar sin límite deja a alguien mirando un botón ocupado si la red se
     * cae a mitad de la subida. Pasados los veinte segundos se deja de esperar
     * y se dice que sigue por su cuenta: el correo **no se pierde** —queda
     * apuntado y sale en la próxima subida—, lo único que se acaba es la
     * espera.
     */
    let aceptados: number;

    try {
      aceptados = await Promise.race([
        this.dispatch(guid),
        new Promise<number>((ok) => setTimeout(() => ok(-1), ESPERA_DEL_BOTON)),
      ]);
    } finally {
      // Se quita pase lo que pase: un aviso de carga que se queda puesto deja
      // el formulario inservible, y eso es peor que no haber avisado.
      this.correoEnCurso.set('');
    }

    if (aceptados === -1) {
      this.toasts.show({
        title: 'Sigue subiendo en segundo plano',
        detail: 'El correo sale en cuanto termine.',
        tone: 'info',
      });

      return;
    }

    // `dispatch` ya avisa cuando alguno entró. Aquí solo queda decir el otro
    // caso, que si no se lee como un botón que no hizo nada.
    if (aceptados === 0) {
      this.toasts.show({
        title: correos.length === 1 ? 'Correo apuntado' : `${correos.length} correos apuntados`,
        detail: 'Sale en cuanto la actividad termine de subir.',
        tone: 'info',
      });
    }
  }

  estaDestapada(grafica: { id?: string }): boolean {
    const nombre = (grafica?.id ?? '').trim();

    return !!nombre && this.destapadas().has(nombre);
  }

  /** Títulos de las actividades que el flujo abrió al guardar. Ver [describeSave]. */
  private readonly abiertasPorElFlujo = signal<string[]>([]);

  readonly survey = input.required<Survey>();
  readonly answer = input.required<SurveyAnswer>();

  /**
   * El sello del flujo para un campo, para la clave del `@for`.
   *
   * Va aquí y no se lee del motor en la plantilla porque una expresión de
   * `track` solo puede tocar el campo, el índice y **el propio componente**:
   * Angular la evalúa fuera del contexto de la plantilla.
   */
  selloDe(id: string): number {
    return this.engine()?.selloDe(id) ?? 0;
  }

  /** Se emite tras guardar, para que la pantalla refresque su cabecera. */
  readonly saved = output<void>();

  /**
   * El flujo movió la actividad de estado.
   *
   * Lo escribe el runner en la base, pero la cabecera y la barra de estado
   * viven arriba y su copia de la actividad no se entera sola: sin avisar, el
   * selector seguía enseñando el estado anterior hasta recargar la pantalla.
   */
  readonly statusChanged = output<string>();

  /**
   * Petición de salir desde la barra inferior.
   *
   * El runner no sale por su cuenta: las comprobaciones de salida —descartar el
   * borrador, avisar antes— son de la actividad, no del formulario, y viven en
   * la pantalla que lo contiene. Aquí solo se vacía lo pendiente de escribir y
   * se pasa el aviso.
   */
  readonly leave = output<void>();

  readonly engine = signal<FormEngine | null>(null);

  /**
   * El flujo del formulario abierto.
   *
   * Se guarda aparte del motor porque lo necesita también la tabla de detalle:
   * cada fila se diligencia con su propio motor y corre las reglas que la tabla
   * declara para lo de dentro.
   */
  readonly flujoDelFormulario = signal<Flujo | null>(null);
  readonly saving = signal(false);

  /**
   * Lo que se lee mientras un botón espera a que su correo quede pedido.
   *
   * Vacío significa que no hay nada esperando. Es lo que enciende el aviso que
   * tapa la pantalla en el modo síncrono — ver `CorreoDeFlujo.avisoSincrono`:
   * un toast no sirve ahí, porque lo que se quiere es justamente que no se
   * pueda seguir tocando el formulario hasta que el correo esté pedido.
   */
  readonly correoEnCurso = signal('');
  readonly feedback = signal('');

  /** Obligatorios sin responder, señalados tras pulsar «Revisar». */
  readonly blocking = signal<MissingEntry[]>([]);

  /*
   * Lo que el flujo decidió sobre la actividad entera.
   *
   * Se leen del motor en vez de guardarse aparte: el motor ya los recalcula en
   * cada evaluación, y una copia local seria una segunda verdad que un dia deja
   * de coincidir. `?? valor por defecto` porque hasta que no hay motor no hay
   * nada decidido, y lo que no se ha decidido no bloquea.
   */
  readonly guardarOculto = computed(() => this.engine()?.guardarOculto() ?? false);

  readonly edicionBloqueada = computed(
    () => this.engine()?.edicionBloqueada() ?? ([] as readonly string[]),
  );

  /** Si no se puede editar, el formulario entero va en solo lectura. */
  readonly soloLectura = computed(() => this.edicionBloqueada().length > 0);

  /** El aviso de obligatorios está abierto. */
  readonly askingRequired = signal(false);

  /** Contenedor de campos: destino del desplazamiento al cambiar de página. */
  private readonly fieldsRef = viewChild<ElementRef<HTMLElement>>('fields');

  /** GUID de la actividad que está montada en el motor. */
  private mountedGuid = '';

  constructor() {
    effect(() => {
      const survey = this.survey();
      const answer = this.answer();

      // Solo se reconstruye al cambiar de actividad. La entrada `answer` es un
      // objeto nuevo cada vez que la pantalla de arriba relee la actividad —al
      // guardar, por ejemplo—, y reconstruir en cada una de esas veces
      // devolvería al usuario a la primera página y perdería lo que llevara
      // sin escribir.
      if (answer.GUID === this.mountedGuid) return;
      this.mountedGuid = answer.GUID;

      // Otra actividad, otra memoria: el estado que traía la anterior no dice
      // nada de esta.
      this.estadoAntesDelFlujo = null;
      this.estadoPuestoPorElFlujo = null;

      // `untracked`: dentro se leen señales —la sesión, al buscar la ubicación—
      // y sin esto el efecto quedaría suscrito a ellas y se volvería a montar
      // el formulario por cualquier cambio ajeno.
      untracked(() => void this.mount(survey, answer));
    });

    /*
     * El estado que pide el flujo, en cuanto lo pide.
     *
     * Un efecto y no una llamada dentro del motor: escribir en la base no es
     * cosa suya —tiene que dar el mismo resultado aquí, en el móvil y en el
     * simulador del Module—, así que anota lo que quiere y esto lo ejecuta.
     *
     * Se lee la señal fuera del `untracked` para quedar suscrito solo a ella;
     * lo de dentro toca la base y no debe volver a disparar el efecto.
     */
    effect(() => {
      const pedido = this.engine()?.estadoDelFlujo() ?? null;

      untracked(() => {
        /*
         * El fallo se cuenta, no se traga.
         *
         * Es una promesa que nadie espera: sin este `catch`, cualquier error de
         * la base —un índice que no está, una escritura rechazada— se perdía
         * como un rechazo sin dueño y el estado simplemente no cambiaba, sin
         * decir por qué.
         */
        this.aplicarEstadoDelFlujo(pedido).catch((error) =>
          console.error('[flujo] no se pudo aplicar el estado', pedido, error),
        );
      });
    });

    /*
     * Los avisos que pida el flujo, en cuanto los pida.
     *
     * **Solo los nuevos.** El flujo se evalúa con cada respuesta, así que
     * enseñarlos todos cada vez llenaría la pantalla del mismo mensaje una y
     * otra vez. Uno que deja de pedirse se olvida, y si su regla vuelve a
     * cumplirse se enseña otra vez: eso sí es información nueva.
     */
    effect(() => {
      const ahora = this.engine()?.avisosDelFlujo() ?? [];

      untracked(() => {
        for (const aviso of ahora) {
          if (this.avisosDichos.has(aviso.texto)) continue;

          this.avisosDichos.add(aviso.texto);

          /*
           * El color y el sonido los eligió la regla, no esta pantalla.
           *
           * Antes salían todos iguales —del mismo gris y en silencio— y había
           * que leerlos para saber si acababa de pasar algo grave o te estaban
           * recordando llevar el casco. Quien sabe eso es quien escribió la
           * regla, y ahora puede decirlo.
           */
          this.toasts.show({
            title: aviso.texto,
            tone: toneDelTono(aviso.tono),
            sonido: aviso.sonido,
          });
        }

        // Se olvida por texto, que es con lo que se recordó.
        const vigentes = new Set(ahora.map((aviso) => aviso.texto));

        for (const dicho of [...this.avisosDichos]) {
          if (!vigentes.has(dicho)) this.avisosDichos.delete(dicho);
        }
      });
    });

    /*
     * Las caritas que pida el flujo, **solo cuando aparecen**.
     *
     * Es la misma norma que los avisos y aquí importa más todavía: el resultado
     * del motor es un estado, no un suceso. El flujo se reevalúa con cada tecla
     * y la misma animación sigue en la lista mientras su condición se cumpla;
     * lanzándola cada vez, escribir una palabra llenaría la pantalla de emojis
     * hasta que el navegador se arrastrara.
     *
     * La identidad es el JSON de la animación —no la regla— porque una misma
     * regla puede pedir emojis distintos según el tramo que se cumpla, y eso sí
     * es otra animación. Cuando desaparece de la lista se olvida: si su regla
     * vuelve a cumplirse, vuelve a salir, que es justo lo que se espera.
     */
    effect(() => {
      const ahora = this.engine()?.animacionesDelFlujo() ?? [];

      untracked(() => {
        const vigentes = new Set(ahora.map((una) => JSON.stringify(una)));

        for (const una of ahora) {
          const identidad = JSON.stringify(una);
          if (this.animacionesLanzadas.has(identidad)) continue;

          this.animacionesLanzadas.add(identidad);
          this.lluvias.lanzar(una);
        }

        for (const lanzada of [...this.animacionesLanzadas]) {
          if (!vigentes.has(lanzada)) this.animacionesLanzadas.delete(lanzada);
        }
      });
    });

    /*
     * El estado de la actividad, siempre al día en el motor.
     *
     * Una condición puede preguntar por él —«si quedó en Aprobado, despacha»— y
     * el motor no conoce la actividad, solo los campos. Se le pasa desde aquí,
     * que es quien la tiene.
     */
    effect(() => {
      const estado = String(this.answer()?.Status ?? '');

      untracked(() => this.engine()?.estadoActividad.set(estado));
    });

    this.registerShortcuts();
  }

  /**
   * Monta el formulario de una actividad.
   *
   * Es asíncrono por la herencia: los campos que traen su valor de la sede o
   * del equipo necesitan esos registros **antes** de que el motor aplique los
   * valores por defecto. Aplicarlos después obligaría a repintar y, peor, a
   * distinguir lo heredado de lo que el usuario ya hubiera escrito.
   *
   * Si la actividad no tiene ubicación ni activo, o no están descargados, el
   * motor se arma igual con la fuente vacía: los heredados quedan en blanco y
   * el formulario funciona.
   */
  private async mount(survey: Survey, answer: SurveyAnswer): Promise<void> {
    const inherits = await this.inherits.forAnswer(answer, survey.JSONQuestion);

    /*
     * El flujo se trae **antes** de armar el motor.
     *
     * Sus reglas deciden qué se ve y qué se exige desde el primer pintado: si
     * llegaran después, el formulario aparecería un instante con los campos que
     * el flujo oculta, y esa aparición es justo lo que quien configuró el flujo
     * quería evitar.
     */
    const flujo = await this.flujos.paraFormulario(survey.ID);

    // Entre la espera y aquí el usuario pudo abrir otra actividad. Montar la
    // vieja encima sería peor que no montar nada.
    if (answer.GUID !== this.mountedGuid) return;

    const engine = new FormEngine({
      questions: survey.JSONQuestion,
      answers: answer.Fields,
      inherits,
      flujo,
    });

    this.engine.set(engine);
    this.flujoDelFormulario.set(flujo ?? null);
    this.blocking.set([]);
    this.feedback.set('');

    // Lo que respondió un servicio es de la actividad que lo pidió: arrastrarlo
    // a la siguiente enseñaría el archivo de otra visita.
    this.archivosDeIntegracion.set({});

    // Y qué lleva dentro cada tabla, para que una regla pueda hablar de sus
    // campos. Va detrás y sin bloquear: el formulario se dibuja igual, y lo
    // único que espera son las reglas que miran el detalle.
    void this.registrarDetalles(engine).then(() => this.llenarTablasQuePideElFlujo(engine));

    // Y las llamadas a servicios que el flujo dejo pedidas al abrir.
    void this.marcarLoQuePideElFlujo(engine);

    // Los valores de fábrica se escriben nada más aplicarse, como en la app:
    // si el usuario abre el formulario, no toca nada y guarda, tienen que
    // quedar registrados.
    if (engine.appliedDefaults && answer.ID != null) {
      this.persist(engine, answer.ID);
    }
  }

  /**
   * Hay teclado, así que los atajos existen y merece la pena anunciarlos.
   *
   * En una tableta o un teléfono el botón sería un control que no lleva a nada
   * que se pueda usar.
   */
  readonly shortcutsAvailable = this.shortcuts.enabled;

  /**
   * Enseña los atajos disponibles aquí.
   *
   * ## Por qué un botón y no solo la tecla
   *
   * El panel ya se abre con `?`, pero `?` **no llega** mientras se escribe: una
   * interrogación dentro de un campo de texto es una interrogación, no un
   * atajo. Y en un formulario el foco está casi siempre dentro de un campo, así
   * que la ayuda de los atajos era justo lo único inalcanzable desde la
   * pantalla donde más atajos hay.
   *
   * Un botón no depende de dónde esté el foco. Y de paso resuelve el problema
   * anterior: enterarse de que los atajos existen, que con una tecla escondida
   * solo pasa por accidente.
   */
  openShortcuts(): void {
    this.shortcuts.toggleHelp();
  }

  /**
   * Los atajos del formulario.
   *
   * Aquí es donde se pasa el tiempo, y cada paso —guardar, cambiar de página,
   * saltar al siguiente campo— son un desplazamiento y un clic. Se registran
   * mientras el formulario vive y se retiran al salir, así el panel de ayuda
   * solo ofrece lo que de verdad funciona en la pantalla que se está viendo.
   */
  private registerShortcuts(): void {
    const destroy = inject(DestroyRef);

    const undo = this.shortcuts.registerAll([
      {
        id: 'form-save',
        keys: 'ctrl+s',
        label: 'Guardar la actividad',
        group: 'Formulario',
        run: () => void this.save(),
      },
      {
        id: 'form-next',
        keys: 'alt+arrowright',
        label: 'Página siguiente',
        group: 'Formulario',
        run: () => void this.goNext(),
      },
      {
        id: 'form-prev',
        keys: 'alt+arrowleft',
        label: 'Página anterior',
        group: 'Formulario',
        run: () => void this.goPrevious(),
      },
      {
        id: 'form-field-next',
        keys: 'alt+arrowdown',
        label: 'Ir al siguiente campo',
        group: 'Formulario',
        run: () => this.moveFocus(1),
      },
      {
        id: 'form-field-prev',
        keys: 'alt+arrowup',
        label: 'Ir al campo anterior',
        group: 'Formulario',
        run: () => this.moveFocus(-1),
      },
      {
        id: 'form-missing',
        keys: 'alt+f',
        label: 'Ir al primer campo obligatorio que falta',
        group: 'Formulario',
        run: () => {
          const first = this.missing()[0];
          if (first) void this.goToMissing(first);
        },
      },
    ]);

    destroy.onDestroy(undo);
  }

  /**
   * Mueve el foco al campo de al lado.
   *
   * Sobre lo que hay **en pantalla** y no sobre el esquema: los campos ocultos
   * por una condición no están en el documento, y saltar a uno de ellos dejaría
   * el foco en ninguna parte. Se toma el control que de verdad recibe escritura
   * dentro de cada tarjeta.
   */
  private moveFocus(step: number): void {
    const container = this.fieldsRef()?.nativeElement;
    if (!container) return;

    const controls = [
      ...container.querySelectorAll<HTMLElement>(
        'input:not([type=hidden]), textarea, select, [contenteditable=true], button.lst__trigger',
      ),
    ].filter((element) => !element.hasAttribute('disabled'));

    if (controls.length === 0) return;

    const active = document.activeElement as HTMLElement | null;
    const index = active ? controls.indexOf(active) : -1;

    const next = index < 0 ? 0 : (index + step + controls.length) % controls.length;

    controls[next].focus();
    controls[next].scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /** Etiqueta de la página actual: la del esquema, o su número. */
  readonly pageLabel = computed(() => {
    const engine = this.engine();
    if (!engine) return '';

    const page = engine.currentPage();
    return page?.lab || `Página ${engine.page() + 1}`;
  });

  /**
   * Longitud del aro de progreso, en unidades del `viewBox`.
   *
   * Es la circunferencia del círculo (2πr con r = 50). Se calcula una vez y se
   * usa como `stroke-dasharray`: así el trazo tiene exactamente una raya del
   * largo del aro, y desplazarla con `stroke-dashoffset` descubre la porción
   * que corresponde al porcentaje.
   */
  readonly ringLength = computed(() => 2 * Math.PI * 50);

  /** Cuánto se retrae el trazo. En 0 % el aro queda vacío; en 100 %, completo. */
  readonly ringOffset = computed(() => {
    const percent = this.engine()?.progress().percent ?? 0;
    return this.ringLength() * (1 - percent / 100);
  });

  /** Nombres de las páginas, para titular los grupos de obligatorios. */
  readonly pageLabels = computed(() => {
    const engine = this.engine();
    if (!engine) return [];

    return engine.pages.map((page, index) => page.lab || `Página ${index + 1}`);
  });

  /**
   * Páginas para el indicador de progreso, **solo las que se ven**.
   *
   * Una regla puede esconder una página entera, y entonces desaparece también
   * del paginador: si siguiera ahí se podría pulsar para ir a una página que el
   * flujo quitó del formulario.
   *
   * Se guarda la posición real de cada una para poder volver a ella: el
   * paginador trabaja con posiciones de su propia lista y el motor con las del
   * formulario, y son distintas en cuanto falta una.
   */
  readonly pageMarks = computed(() => {
    const engine = this.engine();
    if (!engine) return [];

    const missing = engine.missing();

    return engine.paginasVisibles().map((real) => ({
      index: real,
      label: engine.pages[real]?.lab || `Página ${real + 1}`,
      current: real === engine.page(),
      incomplete: missing.some((entry) => entry.page === real),
    }));
  });

  /** En qué punto del paginador se está, contando solo las páginas visibles. */
  readonly posicionEnElPaginador = computed(() =>
    Math.max(0, this.pageMarks().findIndex((p) => p.current)),
  );

  /** Del punto pulsado a la página real. Ver [pageMarks]. */
  irAlPunto(posicion: number): void {
    const marca = this.pageMarks()[posicion];
    if (marca) this.goToPage(marca.index);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Diligenciamiento
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Registra un cambio y programa su escritura.
   *
   * El valor se refleja en pantalla al instante y la escritura va con retardo:
   * esperar a que la base confirme para mover el control lo haría sentirse
   * lento sin ninguna ganancia.
   */
  onValueChange(field: FormField, value: FieldValue): void {
    const engine = this.engine();
    const answer = this.answer();
    if (!engine || answer.ID == null) return;

    engine.setValue(field, value);
    this.persist(engine, answer.ID);

    // Y si lo que se acaba de responder hizo que una regla quiera llenar una
    // tabla, se llena: esperar al guardado dejaría mirando una tabla vacía.
    void this.llenarTablasQuePideElFlujo(engine);

    // Lo mismo con las llamadas a un servicio: «al escribir la cédula, tráete
    // el titular» tiene que salir al escribir la cédula.
    void this.marcarLoQuePideElFlujo(engine);
  }

  /**
   * Llegan los datos del ítem elegido en un campo de lista.
   *
   * Van por un canal aparte del valor porque no son la respuesta: acompañan a
   * `val` dentro del mismo campo, en `des`. Se anotan antes de que llegue el
   * cambio de valor —el componente emite en ese orden—, así que la escritura
   * que dispara el valor ya los incluye.
   */
  /**
   * Le dice al motor cómo es el sub-formulario de cada tabla del formulario.
   *
   * ## Por qué aquí
   *
   * El formulario de una fila no vive en el campo: sale de la configuración de
   * su lista, y esa se consulta a la base. El motor se arma antes de que eso
   * llegue, así que las tablas entran sin saber qué llevan dentro y una regla
   * que dice `DETALLE:EQUIPOS:ESTADO` no encuentra con qué `id` guardó la fila
   * su respuesta — leía siempre en blanco.
   *
   * Falla en silencio a propósito: una lista que no se puede leer deja las
   * reglas de esa tabla sin efecto, y eso es infinitamente mejor que un
   * formulario que no abre.
   */
  private async registrarDetalles(engine: FormEngine): Promise<void> {
    for (const page of engine.pages) {
      for (const field of page.fie) {
        if (field.fty !== 'masterdetail') continue;

        try {
          const config = await this.detalles.configure(field);
          if (!config.schema.length) continue;

          const apiId = (field.apiId ?? '').toString().trim() || field.id;
          engine.registrarDetalle(apiId, config.schema);
        } catch (error) {
          console.warn('[flujo] no se pudo leer el detalle de una tabla', error);
        }
      }
    }
  }

  /**
   * Crea las filas que una regla pidió meter en una tabla.
   *
   * ## Por qué aquí y no en el motor
   *
   * El motor solo anota «mete estos ítems en esta tabla»: crear una fila pide
   * ir a la lista, encontrar el registro, traerse sus datos y armarla con la
   * forma exacta que espera el backend. Eso no lo sabe el motor —ni debe, o
   * dejaría de dar el mismo resultado en el simulador—, así que lo hace quien
   * tiene la lista delante.
   *
   * ## Lo que no hace
   *
   * **No repite lo que ya está.** Una regla se evalúa muchas veces mientras se
   * responde, y sin esto cada evaluación metería otra vez las mismas filas.
   * Solo con `reemplazar` se tira lo que hubiera, que es la decisión explícita.
   */
  // ── Llamadas a un servicio externo ───────────────────────────────

  private readonly integraciones = inject(IntegracionesApi);

  // Para dejar en el bucket las fotos que una llamada va a nombrar, antes de
  // nombrarlas. Ver [ponerLasFotosEnLinea].
  private readonly binaryVerify = inject(BinaryVerifyService);

  /**
   * Marca las llamadas que el flujo dejó pedidas y que salen solas.
   *
   * ## Por qué esto no se convierte en un bucle
   *
   * Tres cerrojos, y hacen falta los tres:
   *
   * 1. **La llave es lo que la llamada pide** —la integración más sus entradas
   *    ya resueltas—, así que reevaluar en cada tecla vuelve a pedir *la misma*
   *    llamada, no una nueva.
   * 2. **`engine.marcar` apunta la llave antes de salir**, así que de aquí no
   *    sale una segunda petición para una llave que ya se marchó.
   * 3. **Hay un tope por regla**, para el caso que los otros dos no cubren: una
   *    regla cuya respuesta alimenta su propia entrada cambia la llave en cada
   *    vuelta. Al llegar al tope se corta y se dice.
   *
   * La respuesta vuelve al motor como un valor más y desde ahí escribe los
   * campos; escribir un campo **no** vuelve a llamar, porque la llave no cambió.
   */
  private async marcarLoQuePideElFlujo(engine: FormEngine): Promise<void> {
    for (const llamada of engine.llamadasQueSalenSolas()) {
      await this.marcarUna(engine, llamada);
    }
  }

  /**
   * Lo que pasa al pulsar el botón de una llamada, o al reintentarla.
   *
   * Es lo mismo que hace una que sale sola, con una diferencia: aquí se pide
   * explícitamente, así que se olvida lo que hubiera respondido antes.
   */
  async llamarAlServicio(llamada: LlamadaPintada): Promise<void> {
    const engine = this.engine();
    if (!engine) return;

    /*
     * Con lo que hay en los campos **ahora**, no con lo de la última evaluación.
     *
     * Se cambia la fotografía y se vuelve a pulsar: al servicio le llegaba la
     * foto vieja. La llamada que el botón tiene en la mano la armó la última
     * evaluación de su regla, y una regla de «al abrir» no se vuelve a evaluar
     * porque alguien cambie un campo — así que el botón se quedaba con una foto
     * congelada en el momento de abrir, sin nada que lo delatara.
     *
     * Se reevalúa nombrando la integración: eso despierta a la regla que la
     * llama sea cual sea su `cuando`, y vuelve a armar la llamada leyendo los
     * campos. Ver [laDeAhora].
     */
    engine.avisarDeLaIntegracion(llamada.integracion);

    const vigente = engine.laDeAhora(llamada);

    // Se pide otra vez a propósito, así que se olvida lo que respondiera antes
    // —y se olvida el de **esta**, que puede no ser el mismo de antes.
    engine.reintentar(vigente.llave);

    await this.marcarUna(engine, vigente);
  }

  /**
   * Sube y confirma las fotos que una llamada va a nombrar.
   *
   * Devuelve `true` cuando todas están en línea — y también cuando no había
   * ninguna que esperar, que es lo corriente.
   *
   * Nunca lanza hacia arriba: que la verificación falle no puede tumbar el
   * formulario, se trata como «todavía no está» y quien pulsó lo vuelve a
   * intentar.
   */
  private async ponerLasFotosEnLinea(llamada: LlamadaPintada): Promise<boolean> {
    const guid = String(this.answer()?.GUID ?? '');
    if (!guid) return true;

    try {
      return await this.binaryVerify.ensureBinariesOnline(guid, llamada.binarios ?? []);
    } catch (error) {
      console.warn('[flujo] no se pudo confirmar la foto de la llamada', error);

      return false;
    }
  }

  private async marcarUna(engine: FormEngine, llamada: LlamadaPintada): Promise<void> {
    /*
     * Que se pase del tope no se traga.
     *
     * Es un flujo mal configurado, y quien está diligenciando no tiene forma de
     * saberlo: sin este aviso, el formulario dejaría de traer el dato y
     * parecería que la aplicación no funciona.
     */
    if (!engine.sePuedeLlamar(llamada)) {
      this.toasts.show({
        title: `«${llamada.titulo}» se llamó demasiadas veces seguidas y se detuvo.`,
        tone: 'warning',
      });

      return;
    }

    // Marcar apunta la llave y deja la llamada en vuelo. Si devuelve `false` es
    // que ya salió: no hay nada que hacer.
    if (!engine.marcar(llamada)) return;

    /*
     * En vuelo: hay que reevaluar **ahora**, antes de esperar la respuesta.
     *
     * `marcar` deja la respuesta en `vuelo`, pero las llamadas que la pantalla
     * pinta salen de `integracionesPorMomento`, que solo se rellena al evaluar.
     * Sin esta linea, durante todo el viaje la llamada se sigue viendo como
     * `pendiente`: `hayLlamadaSincronaEnVuelo` nunca es cierto y el velo de
     * espera no llega a salir nunca — que es exactamente lo que se veia.
     *
     * Es lo mismo que hace la app en `_marcarUna`, y por lo mismo.
     */
    engine.avisarDeLaIntegracion(llamada.integracion);

    /*
     * Y sus fotos, en el bucket, **antes** de llamar.
     *
     * Una entrada que sale de un campo de fotografía manda la dirección de la
     * foto, y esa dirección solo lleva a alguna parte cuando el archivo ya está
     * en línea: recién tomada, la foto vive solo aquí. Llamar antes es mandarle
     * a alguien de fuera una dirección que no resuelve — y lo que contestó el
     * analizador de imágenes fue «Unable to process input image», hablando de
     * la fotografía cuando lo que pasaba era que nunca le llegó ninguna.
     *
     * Se hace con la llamada ya en vuelo, así que el botón está apagado y el
     * velo puesto: la espera se ve, que es lo que la hace tolerable.
     *
     * Y si no se consigue —sin señal, o el archivo no llega a subir— se para
     * aquí con un fallo escrito en castellano, en vez de gastar la consulta
     * para que conteste que la imagen no vale.
     */
    if (llamada.binarios?.length && !(await this.ponerLasFotosEnLinea(llamada))) {
      engine.fallo(llamada.llave, {
        codigo: 'foto-no-esta-en-linea',
        mensaje:
          'La fotografía todavía no está en el servidor, así que el servicio no puede verla. '
          + 'Comprueba la conexión y vuelve a intentarlo.',
        reintentable: true,
      });

      this.toasts.show({
        title: 'La fotografía todavía no se ha subido. Vuelve a intentarlo con señal.',
        tone: 'warning',
      });

      engine.avisarDeLaIntegracion(llamada.integracion);

      return;
    }

    const r = await this.integraciones.ejecutar(
      llamada.integracion,
      llamada.entradas ?? {},
      llamada.segundos,
    );

    if (r.ok) {
      // Un archivo se guarda aparte y al motor solo le llega su ficha: ver
      // [archivosDeIntegracion].
      if (r.archivo) this.guardarArchivo(llamada.llave, r.archivo);

      engine.respondio(llamada.llave, r.datos);

      /*
       * Y **que** respondio, no solo que respondio.
       *
       * Cuando una salida no escribe su campo, desde fuera se ve igual que si el
       * servicio no hubiera contestado: el campo sigue vacio y no hay ningun
       * error, porque el motor no toca un campo cuando su ruta no resuelve
       * —escribir un vacio borraria lo que ya hubiera contestado alguien—.
       *
       * La causa casi siempre es que la `ruta` configurada no casa con la forma
       * que de verdad devuelve el servicio, tipicamente porque viene envuelta en
       * otra clave. Con las claves delante se ve en dos segundos; sin ellas no
       * se puede adivinar.
       */
      console.log(
        `[flujo] «${llamada.integracion}» respondió ${comoSeVeLaRespuesta(r.datos)}`,
      );

      this.contarQueEscribeLaRespuesta(llamada, r.datos);
    } else {
      engine.fallo(llamada.llave, r);

      /*
       * Y se dice en pantalla, no solo junto al botón.
       *
       * Una llamada que sale sola no tiene botón donde mirar: sin esto, quien
       * está diligenciando ve que el campo no se llena y no tiene forma de saber
       * por qué.
       */
      this.toasts.show({ title: r.mensaje ?? 'El servicio no pudo responder.', tone: 'error' });
    }

    /*
     * Y se vuelve a evaluar diciendo que llegó noticia de esa integración.
     *
     * El campo que «cambió» es `INTEGRACION:<integración>`, que es como las
     * reglas que llaman a ese servicio se nombran a sí mismas —ver
     * `camposDeLaRegla` en el motor—. Así solo se reevalúan las reglas que de
     * verdad esperaban esta noticia, en vez de todas.
     */
    engine.avisarDeLaIntegracion(llamada.integracion);

    /*
     * Y si esa noticia dejó pedida otra llamada, sale.
     *
     * Es el caso de dos servicios encadenados: el primero trae la matrícula y
     * con ella el segundo trae el titular. Sin esto, la segunda se quedaría en
     * `pendiente` hasta que la persona escribiera cualquier otra cosa, que es
     * exactamente el fallo que se ve como «el formulario a veces lo trae y a
     * veces no».
     *
     * No se desboca: son los mismos tres cerrojos de
     * [marcarLoQuePideElFlujo] —la llave es lo que se pide, se apunta antes de
     * salir, y hay un tope por regla—. Es lo que hace la app, donde esto va
     * dentro de la propia evaluación.
     */
    void this.marcarLoQuePideElFlujo(engine);

    /*
     * Y lo que la respuesta escribió **se guarda en la actividad**.
     *
     * Sin esto, el valor entraba en el motor y se pintaba en el control, pero no
     * llegaba al `val` del campo en el JSON de la actividad: en pantalla estaba
     * y al sincronizar no iba nadie. Es el peor de los desenlaces, porque desde
     * el formulario se ve exactamente igual que si se hubiera guardado.
     *
     * Todos los demás caminos por los que el flujo escribe ya lo hacían
     * —responder un campo, llenar una tabla, retirar sus filas—; este se quedó
     * sin él porque es el único que no nace de un gesto del usuario. La app no
     * lo necesita: alli el guardado va dentro de la propia evaluación.
     */
    const answer = this.answer();
    if (answer.ID != null) this.persist(engine, answer.ID);
  }

  /**
   * Qué va a escribir esta respuesta, salida por salida.
   *
   * ## Por qué hace falta decirlo
   *
   * Cuando una salida no escribe su campo **no hay ningún error**: el motor deja
   * el campo intacto a propósito, porque escribir un vacío borraría lo que ya
   * hubiera contestado alguien. Visto desde fuera es idéntico a que el servicio
   * no hubiera respondido, y hay tres causas distintas que se ven igual: la ruta
   * no casa con lo que llegó, el `campo` no existe en el formulario, o el valor
   * es de un tipo que no se puede escribir.
   *
   * Esto las separa. Solo escribe en la consola —no decide nada—, y es lo que
   * convierte «no funciona» en «la ruta dice `datos.height` y lo que llegó tiene
   * las claves id, name, height».
   */
  private contarQueEscribeLaRespuesta(llamada: LlamadaPintada, datos: unknown): void {
    const regla = this.flujoDelFormulario()?.reglas?.find((r) => r.id === llamada.regla);

    if (!regla) {
      console.warn(`[flujo] no encuentro la regla «${llamada.regla}» para explicar sus salidas`);
      return;
    }

    /*
     * Se recorre la regla entera en vez de mirar solo `entonces`.
     *
     * Una llamada puede estar en la rama principal o dentro de cualquier `sino`,
     * y buscar por la forma —un objeto con `salidas`— no depende de cómo estén
     * anidadas las ramas hoy.
     */
    const configs: Array<{ id?: string; salidas?: Array<Record<string, unknown>> }> = [];

    const recorrer = (nodo: unknown): void => {
      if (Array.isArray(nodo)) {
        nodo.forEach(recorrer);
        return;
      }

      if (!nodo || typeof nodo !== 'object') return;

      const obj = nodo as Record<string, unknown>;

      if (Array.isArray(obj['salidas']) && String(obj['id'] ?? '') === llamada.integracion) {
        configs.push(obj as { id?: string; salidas?: Array<Record<string, unknown>> });
      }

      Object.values(obj).forEach(recorrer);
    };

    recorrer(regla);

    const salidas = configs.flatMap((c) => c.salidas ?? []);

    if (!salidas.length) {
      console.warn(
        `[flujo] «${llamada.integracion}» no tiene ninguna salida configurada: ` +
        'respondió bien, pero no hay nada que decir dónde escribirlo.',
      );
      return;
    }

    const campos = new Set(
      this.engine()?.pages.flatMap((pg) => pg.fie).map((f) => (f.apiId ?? '').toString().trim()),
    );

    for (const salida of salidas) {
      const ruta = String(salida['ruta'] ?? '');
      const campo = String(salida['campo'] ?? '').trim();

      const texto = textoDeLaRespuesta(datoDeLaRuta(datos, ruta));

      if (texto === null) {
        const claves =
          datos && typeof datos === 'object' && !Array.isArray(datos)
            ? Object.keys(datos as object).join(', ')
            : '(no es un objeto)';

        console.warn(
          `[flujo] la ruta «${ruta}» no resuelve, así que «${campo}» se queda como estaba. ` +
          `Lo que llegó tiene: ${claves}`,
        );

        continue;
      }

      if (campo && !campos.has(campo)) {
        console.warn(
          `[flujo] la ruta «${ruta}» dio «${texto}», pero el campo «${campo}» ` +
          'no está en este formulario. Revisa el identificador de la salida.',
        );

        continue;
      }

      console.log(`[flujo] «${ruta}» → «${texto}» → campo «${campo}»`);
    }
  }

  /**
   * Las llaves de las llamadas que ya tienen un botón de flujo propio.
   *
   * Desde que una acción de botón puede llamar a un servicio, la misma llamada
   * sale por dos sitios: dentro del botón que la configuró —en
   * `BotonPintado.llamadas`— y suelta en la lista de integraciones, porque el
   * motor la emite **también** ahí a propósito, para que un cliente que no
   * conozca la acción nueva siga pudiendo ejecutarla.
   *
   * Aquí sí la conocemos, así que la lista de llamadas la sigue enseñando —con
   * su estado, su error y su archivo— pero sin botón: el botón ya está arriba.
   */
  readonly llavesConBotonDeFlujo = computed<readonly string[]>(() => {
    const engine = this.engine();
    if (!engine) return [];

    return engine
      .botonesDelFlujo()
      .flatMap((boton) => boton.llamadas ?? [])
      .map((una) => una.llave);
  });

  /**
   * Lo que pasa al pulsar un botón que llama a servicios.
   *
   * **En orden y de una en una.** Un botón puede lanzar dos consultas y la
   * segunda puede depender de lo que escriba la primera —el motor rearma las
   * llamadas con cada respuesta—, así que en paralelo la segunda saldría con las
   * entradas de antes. Secuencial cuesta esperar; en paralelo cuesta un dato mal.
   *
   * Va por [llamarAlServicio], que es lo mismo que hace el botón propio de una
   * llamada: olvida lo que hubiera respondido antes y vuelve a pedirla. Es lo que
   * se espera de un botón que se pulsa a mano.
   */
  async llamadasDeUnBoton(llamadas: LlamadaPintada[]): Promise<void> {
    for (const una of llamadas) {
      await this.llamarAlServicio(una);
    }
  }

  /** Mientras el guardado espera a las llamadas que nacieron al evaluar. */
  readonly esperandoAlGuardar = signal(false);

  /**
   * Cuántas vueltas puede dar la espera del guardado.
   *
   * Una respuesta puede hacer nacer otra llamada —«con la cédula, trae el
   * titular; con el titular, trae su saldo»— así que no basta con una pasada.
   * El tope es la red de seguridad: el motor ya corta por regla, y esto corta
   * por guardado, para que un flujo mal escrito no deje a nadie mirando una
   * rueda para siempre.
   */
  private static readonly VUELTAS_DE_ESPERA = 5;

  /**
   * Las llamadas que nacen al evaluar «al guardar», ejecutadas y esperadas.
   *
   * ## Por qué hacía falta
   *
   * Una regla de «al guardar» con `llamar-servicio` **no existe** hasta que se
   * evalúa ese momento: la llamada nace ahí, dentro de `commit`. Quien la
   * dispara normalmente es un efecto reactivo, que corre después — o sea,
   * cuando el guardado ya se fue. Por eso la actividad se cerraba «de una» sin
   * esperar al servicio.
   *
   * ## Por qué se espera también a las asíncronas
   *
   * Porque el motor bloquea el guardado con **cualquier** llamada en vuelo, sea
   * síncrona o asíncrona: subir una actividad a la que le falta la mitad de lo
   * que iba a traer el servicio no se nota hasta que alguien echa de menos el
   * dato. Lanzar una asíncrona y no esperarla no adelantaría el guardado — lo
   * dejaría bloqueado con «Esperando la respuesta de…», que es peor que
   * esperar. `modo` decide si el formulario se congela **mientras se edita**,
   * no si retiene el guardado.
   *
   * ## Y de una en una
   *
   * En el orden en que el motor las pide, que es el orden de las reglas. La
   * segunda puede depender de lo que escriba la primera; en paralelo saldría
   * con las entradas de antes y nadie vería un error.
   */
  private async esperarLasLlamadasDelGuardado(engine: FormEngine): Promise<void> {
    for (let vuelta = 0; vuelta < FormRunnerComponent.VUELTAS_DE_ESPERA; vuelta++) {
      const pedidas = engine.llamadasQueSalenSolas();
      if (!pedidas.length) return;

      this.esperandoAlGuardar.set(true);

      try {
        for (const una of pedidas) {
          await this.marcarUna(engine, una);
        }
      } finally {
        this.esperandoAlGuardar.set(false);
      }

      // Con las respuestas ya escritas: puede aparecer otra llamada, y puede
      // aparecer un bloqueo. Lo segundo lo mira quien llamó a esto.
      engine.revisarFlujoAlGuardar();
    }
  }

  /**
   * El nombre de lo que se está esperando, para el velo.
   *
   * Con dos consultas en marcha hay que poder saber cuál va lenta, y
   * «cargando» a secas no lo dice. Si no se sabe cuál es, se calla el nombre
   * en vez de inventarse uno.
   */
  rotuloDeLaEspera(engine: FormEngine): string {
    /*
     * Cualquiera en vuelo, no solo la síncrona.
     *
     * El velo sale por dos motivos: una síncrona mientras se edita, y el
     * guardado esperando a las que nacieron al evaluar «al guardar» —que pueden
     * ser asíncronas—. Mirando solo las síncronas, ese segundo caso enseñaba un
     * velo que decía «Consultando…» sin decir a quién.
     */
    const enVuelo = engine
      .integracionesDelFlujo()
      .find((una) => una.estado === 'vuelo');

    return enVuelo?.titulo ? `Consultando «${enVuelo.titulo}»…` : 'Consultando…';
  }

  /**
   * Los archivos que han devuelto las llamadas de esta actividad, por llave.
   *
   * ## Qué se puede hacer con ellos hoy, y qué no
   *
   * **Enseñarlos: sí.** Llega el nombre, el tipo y el tamaño, y de una imagen
   * además una vista previa. Con eso quien diligencia ve que el servicio
   * respondió y con qué.
   *
   * **Guardarlos en un campo de la actividad: todavía no.** No es un descuido,
   * es una decisión: un binario no es un archivo suelto sino tres cosas a la vez
   * —un registro en la tabla de binarios, el archivo cuyo nombre **es** su GUID,
   * y ese mismo GUID escrito en el campo—, y ese GUID es además la llave con la
   * que acaba en el bucket. Encima hay una puerta que retiene la actividad hasta
   * que todos sus archivos suben. Montar ese trío sin poder probarlo de punta a
   * punta tiene un desenlace concreto y malo: una actividad que en pantalla se ve
   * con su PDF y que en el servidor llega sin él, y nadie se entera hasta que
   * alguien lo echa de menos. Antes que eso, que se vea y no se guarde.
   *
   * ## Por qué no se guarda el contenido de todo
   *
   * Porque lo único que se hace con él es la vista previa, y esa solo tiene
   * sentido en una imagen. Un certificado de ocho megas en base64 son once en
   * memoria por cada llamada.
   */
  readonly archivosDeIntegracion = signal<Record<string, ArchivoDeIntegracion>>({});

  /** Hasta dónde se conserva el contenido de una imagen para la vista previa. */
  private static readonly TOPE_DE_VISTA_PREVIA = 2 * 1024 * 1024;

  private guardarArchivo(llave: string, archivo: ArchivoDeIntegracion): void {
    const ligero =
      archivo.tipoMime.startsWith('image/') &&
      archivo.tamano <= FormRunnerComponent.TOPE_DE_VISTA_PREVIA
        ? archivo
        : { ...archivo, contenidoBase64: '' };

    this.archivosDeIntegracion.update((antes) => ({ ...antes, [llave]: ligero }));

    console.log(
      `[flujo] llegó el archivo «${archivo.nombre}» (${archivo.tipoMime}, ${archivo.tamano} B)`,
    );
  }

  private async llenarTablasQuePideElFlujo(engine: FormEngine): Promise<void> {
    const pedidas = engine.tablasQueLlenaElFlujo();

    /*
     * Que se vea en qué paso se queda.
     *
     * «La regla no llena la tabla» tiene cinco causas que desde fuera se ven
     * igual: que la regla no se cumpla, que no llegue el encargo, que el nombre
     * de la tabla no case con ningún campo, que la lista no se pueda resolver, o
     * que los ítems no se encuentren. Sin esto hay que ir descartándolas a
     * ciegas.
     */
    console.log('[flujo] llenar tablas:', {
      pedidas: pedidas.map((p) => `${p.tabla} · ${p.modo} · ${p.items.length} ítem(s)`),
      tablasDelFormulario: engine.pages
        .flatMap((pg) => pg.fie)
        .filter((f) => f.fty === 'masterdetail')
        .map((f) => (f.apiId ?? '').toString().trim() || f.id),
    });

    /*
     * Sin nada que llenar **sí** hay algo que hacer.
     *
     * Este `return` salía antes de la retirada, y justo en el único caso que
     * importa: cuando la condición dejó de cumplirse, la regla ya no pide nada
     * y sus filas se quedaban puestas para siempre. Ahora se retiran primero y
     * se sale después.
     */
    if (!pedidas.length) {
      this.retirarFilasDeReglasQueYaNoPiden(engine, pedidas);
      return;
    }

    for (const pedida of pedidas) {
      const field = engine.campoDeTabla(pedida.tabla);

      if (!field) {
        console.warn(
          `[flujo] la regla llena «${pedida.tabla}», que no es ninguna tabla de este formulario`,
        );

        continue;
      }

      try {
        const config = await this.detalles.configure(field);

        console.log(`[flujo] tabla «${pedida.tabla}»`, {
          origen: config.origin,
          lista: config.target?.Name ?? config.definition?.Name ?? '(ninguna)',
          mensaje: config.message ?? '',
        });

        const actuales = readRows(engine.valueOf(field.id));

        const quedan = pedida.modo === 'reemplazar' ? [] : [...actuales];

        /*
         * Lo que ya está no se vuelve a meter.
         *
         * Se reconoce por dos vías porque por dos vías se puede nombrar: por el
         * ítem del que nació la fila, y por su nombre. Con solo la primera, una
         * regla escrita con nombres duplicaba filas en cada evaluación — y una
         * regla se evalúa muchas veces mientras se diligencia.
         */
        const yaEstan = new Set(
          quedan.flatMap((r) => {
            const guid = String(r.ListDetGUID ?? '');
            const nombre = normalizar(String(r.Name ?? ''), 'solo-valor');

            return [...(guid ? [guid] : []), ...(nombre ? [`n:${nombre}`] : [])];
          }),
        );

        let nuevas = 0;

        for (const item of pedida.items) {
          /*
           * La regla puede nombrar un ítem de dos maneras, y las dos valen.
           *
           * Con identificador es lo normal: se eligió de la lista al escribir la
           * regla. Pero también se puede escribir **solo el nombre** —el motor lo
           * admite y lo manda tal cual—, y antes esas filas se descartaban en
           * silencio: la tabla se quedaba vacía y no había forma de saber por
           * qué. Ahora se busca el registro por su nombre, que es exactamente lo
           * que haría una persona al elegirlo a mano.
           */
          const clave = item.id || (item.txt ? `n:${normalizar(item.txt, 'solo-valor')}` : '');
          if (!clave || yaEstan.has(clave)) continue;

          const registro = (item.id
            ? await this.detalles.itemPorGuid(config, item.id)
            : await this.detalles.itemPorNombre(config, item.txt)) as
            | Record<string, unknown>
            | null;

          const guid = item.id || String(registro?.['GUID'] ?? '');
          const nombre = String(registro?.['Name'] ?? '') || item.txt;

          /*
           * Sin registro detrás, la fila se crea igual.
           *
           * Pasa cuando la regla nombra algo que no está descargado, o cuando la
           * tabla es de filas en blanco y lo único que aporta la regla es cómo se
           * llama cada una. En los dos casos la fila sirve: se puede abrir y
           * diligenciar, solo que no hereda nada. No crearla dejaría la tabla
           * vacía sin decir por qué, que es lo que pasaba.
           */
          quedan.push(
            guid
              ? createRow({
                  fieldId: field.id,
                  masterListGuid: String(field.lst ?? ''),
                  itemGuid: guid,
                  itemName: nombre,
                  readOnly: false,
                  updated: field.mobUpd ?? true,
                  ent: 0,
                  item: registro ?? undefined,
                  baseListGuid: String(config.target?.GUID ?? config.definition?.GUID ?? ''),
                  isLocation: config.origin === 'locations',
                  isAsset: config.origin === 'assets',
                })
              : createBlankRow({
                  fieldId: field.id,
                  masterListGuid: String(field.lst ?? ''),
                  name: nombre,
                  readOnly: false,
                  updated: field.mobUpd ?? true,
                }),
          );

          /*
           * De quién es la fila.
           *
           * Sin esta marca una fila puesta por una regla es indistinguible de
           * una que añadió una persona, y entonces no hay forma de retirarla
           * cuando la condición deja de cumplirse sin arriesgarse a borrar
           * trabajo ajeno. Va en la fila y viaja con ella.
           */
          (quedan[quedan.length - 1] as unknown as Record<string, unknown>)['_flujo'] = pedida.regla;

          console.log(
            `[flujo]   + fila «${nombre}»`,
            registro ? '(con su registro)' : '(sin registro: no se encontró)',
          );

          yaEstan.add(clave);
          if (guid) yaEstan.add(`n:${normalizar(nombre, 'solo-valor')}`);
          nuevas++;
        }

        console.log(`[flujo] tabla «${pedida.tabla}»: ${nuevas} fila(s) nueva(s)`);

        if (!nuevas && pedida.modo !== 'reemplazar') continue;

        engine.setValue(field, quedan as unknown as FieldValue);

        const answer = this.answer();
        if (answer.ID != null) this.persist(engine, answer.ID);
      } catch (error) {
        console.warn('[flujo] no se pudo llenar la tabla', pedida.tabla, error);
      }
    }

    this.retirarFilasDeReglasQueYaNoPiden(engine, pedidas);
  }

  /**
   * Quita las filas que puso una regla que **ya no se cumple**.
   *
   * ## Por qué hace falta
   *
   * Todo lo demás en un flujo se deshace: un campo que se oculta vuelve, un
   * estado que se pone se revierte. Llenar una tabla era la excepción, y quien
   * cambiaba una respuesta se quedaba con filas huérfanas sin saber de dónde
   * salían ni si podía borrarlas.
   *
   * ## Y por qué solo algunas
   *
   * Una fila **no es un campo oculto**: puede tener fotos, una firma o texto que
   * escribió alguien en campo. Así que solo se retiran las que cumplen las dos:
   *
   *   1. Llevan la marca de la regla (`_flujo`), o sea las puso ella.
   *   2. **Nadie las ha tocado**: todo lo que hay dentro sigue vacío.
   *
   * En cuanto alguien responde algo dentro, la fila deja de ser automática y se
   * queda para siempre. Es la misma prudencia que ya guía a `pisadas`: una regla
   * que borra lo que otro acaba de contestar casi nunca es lo que se quería.
   */
  private retirarFilasDeReglasQueYaNoPiden(
    engine: FormEngine,
    pedidas: readonly { tabla: string; regla: string }[],
  ): void {
    // Qué reglas piden algo ahora mismo, por tabla.
    const vigentes = new Map<string, Set<string>>();

    for (const p of pedidas) {
      const suyas = vigentes.get(p.tabla) ?? new Set<string>();
      suyas.add(p.regla);
      vigentes.set(p.tabla, suyas);
    }

    const tablas = engine.pages.flatMap((pg) => pg.fie).filter((f) => f.fty === 'masterdetail');

    for (const field of tablas) {
      const apiId = (field.apiId ?? '').toString().trim() || field.id;
      const filas = readRows(engine.valueOf(field.id));

      if (!filas.length) continue;

      const suyas = vigentes.get(apiId) ?? new Set<string>();

      /*
       * Por que una fila se queda o se va.
       *
       * «No se borran» tiene tres causas que desde fuera se ven igual: que la
       * fila no lleve la marca —se creo antes de que existiera, o la puso una
       * persona—, que su regla siga pidiendola, o que alguien haya respondido
       * algo dentro. Sin esto hay que ir descartandolas a ciegas.
       */
      console.log(
        `[flujo] retirada en «${apiId}» · piden ahora: [${[...suyas].join(', ')}] · ` +
          filas
            .map((f) => {
              const r = f as unknown as Record<string, unknown>;
              const marca = String(r['_flujo'] ?? '');

              return (
                `«${String(r['Name'] ?? '')}» marca=${marca || 'NINGUNA'}` +
                `/${this.filaTieneRespuestas(f) ? 'respondida' : 'vacia'}`
              );
            })
            .join(' | '),
      );

      const quedan = filas.filter((fila) => {
        const marca = String((fila as unknown as Record<string, unknown>)['_flujo'] ?? '');

        // Sin marca es de una persona: no se toca nunca.
        if (!marca) return true;

        // Su regla sigue pidiéndola.
        if (suyas.has(marca)) return true;

        // La puso una regla que ya no se cumple: se va solo si sigue vacía.
        return this.filaTieneRespuestas(fila);
      });

      if (quedan.length === filas.length) continue;

      console.log(
        `[flujo] tabla «${apiId}»: se retiran ${filas.length - quedan.length} fila(s) ` +
          'de reglas que ya no se cumplen',
      );

      engine.setValue(field, quedan as unknown as FieldValue);

      const answer = this.answer();
      if (answer.ID != null) this.persist(engine, answer.ID);
    }
  }

  /**
   * ¿Alguien respondió algo dentro de esta fila?
   *
   * El nombre no cuenta: lo pone la propia regla al crearla. Lo que cuenta es
   * cualquier otra respuesta, porque eso ya es trabajo de una persona.
   */
  private filaTieneRespuestas(fila: unknown): boolean {
    const valores = (fila as Record<string, unknown>)?.['JSONValues'];
    if (!Array.isArray(valores)) return false;

    return valores.some((dato) => {
      if (!dato || typeof dato !== 'object') return false;

      const id = String((dato as Record<string, unknown>)['id'] ?? '');
      if (id === 'name') return false;

      const val = (dato as Record<string, unknown>)['val'];

      if (val === null || val === undefined || val === '') return false;
      if (Array.isArray(val)) return val.length > 0;
      if (typeof val === 'object') return Object.keys(val as object).length > 0;

      return true;
    });
  }

  onDescriptorsChange(field: FormField, values: ResolvedDescriptor[]): void {
    this.engine()?.setDescriptors(field.id, values);
  }

  /**
   * ¿Este campo es un encabezado de sección?
   *
   * Los títulos y párrafos no son preguntas: separan bloques dentro del
   * formulario. Su tarjeta va con otro fondo para que se lean como el rótulo
   * de lo que viene debajo y no como una pregunta más que se olvidó responder.
   */
  isHeading(field: FormField): boolean {
    return field.fty === 'title' || field.fty === 'paragraph';
  }

  /** Programa la escritura de todo el formulario. */
  private persist(engine: FormEngine, id: number): void {
    const key = `form:${this.answer().GUID}`;

    this.autosave.schedule(key, async () => {
      await this.answers.update(id, {
        Fields: JSON.stringify(engine.toAnswerFields()),
        Titles: JSON.stringify(await this.titlesFor(engine, id)),
        UpdatedOn: new Date().toISOString(),
      });
    });
  }

  // ── Paginación ─────────────────────────────────────────────────────────────

  /**
   * Avanza de página.
   *
   * No bloquea por campos incompletos: en campo se salta una pregunta para
   * volver a ella —falta el dato, hay que preguntarle a alguien— y obligar a
   * completarla para pasar convierte eso en un callejón sin salida. Lo que sí
   * se hace es señalarlos, y exigirlos al guardar.
   */
  async goNext(): Promise<void> {
    this.engine()?.next();
    this.scrollToTop();
    await this.flush();
  }

  async goPrevious(): Promise<void> {
    this.engine()?.previous();
    this.scrollToTop();
    await this.flush();
  }

  async goToPage(index: number): Promise<void> {
    this.engine()?.goTo(index);
    this.scrollToTop();
    await this.flush();
  }

  /**
   * Sube al primer campo de la página nueva.
   *
   * Sin esto, cambiar de página conserva el desplazamiento: quien venía de
   * responder el último campo de una página larga aterriza a mitad de la
   * siguiente, sin ver su encabezado y con la impresión de que no pasó nada.
   *
   * El destino es el contenedor de campos y no el principio del documento: la
   * cabecera de la actividad ya se ve fija arriba, y volver a ella cada vez
   * obligaría a bajar de nuevo.
   */
  private scrollToTop(): void {
    // Tras el repintado: la página nueva todavía no está en el DOM cuando esto
    // se llama.
    setTimeout(() => {
      this.fieldsRef()?.nativeElement.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
  }

  /** Vacía lo pendiente y pide salir. */
  async requestLeave(): Promise<void> {
    await this.flush();
    this.leave.emit();
  }

  /**
   * Los descriptivos: los del formulario, **sin borrar los de fuera**.
   *
   * `toTitles()` los reconstruye desde cero con los campos marcados `pri`. Eso
   * está bien para lo que responde el usuario, pero arrasa con lo que escriben
   * las reglas de la compañía —«CORREO ENVIADO», los indicadores de conformidad
   * de Brillantex— que no salen de ningún campo `pri` y por lo tanto no se
   * regeneran. El síntoma era que aparecían al calcularse y desaparecían al
   * siguiente autoguardado.
   *
   * Se conserva lo que cumpla las dos condiciones: que no lo acabe de generar
   * el formulario, y que **no corresponda a un campo `pri`**. Lo segundo es lo
   * que evita el efecto contrario — que un descriptivo se quede pegado después
   * de borrar la respuesta que lo produjo.
   */
  /**
   * Los descriptivos que pide el flujo, listos para el `JSONTitle`.
   *
   * La etiqueta la elige quien escribe la regla; si la deja vacía se usa la del
   * propio campo, que es lo que esperaría cualquiera al no poner nada.
   *
   * Se les pone un identificador con prefijo para poder reconocerlos después: es
   * lo que permite recalcularlos enteros sin tocar los descriptivos que escriben
   * otras cosas —las reglas de compañía, los `pri` del formulario—.
   */
  private descriptivosDelFlujo(engine: FormEngine): { lab: string; val: string; id: string }[] {
    const pedidos = engine.descriptivosDeFlujo();
    if (!pedidos.length) return [];

    const porApiId = new Map(
      engine.pages
        .flatMap((page) => page.fie)
        .map((field) => [(field.apiId ?? '').toString().trim() || field.id, field]),
    );

    return pedidos.map((d) => {
      const campo = porApiId.get(d.campo);

      return {
        id: PREFIJO_DESCRIPTIVO_DE_FLUJO + d.campo,
        lab: d.lab || campo?.lab || d.campo,
        val: d.val,
      };
    });
  }

  private async titlesFor(
    engine: FormEngine,
    id: number,
  ): Promise<{ lab: string; val: string; id?: string }[]> {
    const generated = [...engine.toTitles(this.survey().Title), ...this.descriptivosDelFlujo(engine)];

    try {
      const stored = await this.answers.getByKey(id);
      const previous = JSON.parse(String(stored?.Titles ?? '[]')) as {
        lab?: string;
        val?: string;
        id?: string;
      }[];

      if (!Array.isArray(previous)) return generated;

      const priIds = new Set(
        engine.pages.flatMap((page) => page.fie).filter((field) => field.pri).map((field) => field.id),
      );

      const kept = previous.filter(
        (entry) =>
          entry.lab !== '[DEF]' &&
          entry.id != null &&
          // Los del flujo no se conservan: se recalculan enteros en cada
          // evaluación, y conservarlos dejaría pegado para siempre uno cuya
          // condición ya no se cumple — justo lo contrario de lo que se quiere.
          !String(entry.id).startsWith(PREFIJO_DESCRIPTIVO_DE_FLUJO) &&
          !priIds.has(entry.id) &&
          !generated.some((item) => item.id === entry.id),
      );

      return [...generated, ...(kept as { lab: string; val: string; id?: string }[])];
    } catch (error) {
      // Descriptivos ilegibles: se escriben los del formulario y ya. Perder un
      // añadido es menos malo que no poder guardar.
      console.warn('[Formulario] no se pudieron conservar los descriptivos previos', error);
      return generated;
    }
  }

  /** Escribe lo pendiente antes de cambiar de página. */
  private async flush(): Promise<void> {
    await this.autosave.flush(`form:${this.answer().GUID}`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Guardar
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Marca la actividad como terminada.
   *
   * Antes vacía el autoguardado: guardar con un cambio todavía en el aire
   * marcaría como completa una actividad a la que le falta el último dato.
   */
  async save(): Promise<void> {
    const engine = this.engine();
    if (!engine || this.saving()) return;

    this.feedback.set('');

    /*
     * Lo que el flujo impide, se impide de verdad.
     *
     * Es la única acción del flujo que **para** al usuario en vez de ayudarle,
     * así que el motivo lo escribe quien configuró la regla y se enseña tal
     * cual: un «no se puede guardar» sin explicación deja a alguien en campo
     * sin saber qué corregir.
     */
    const bloqueos = engine.revisarFlujoAlGuardar();

    if (bloqueos.length) {
      this.feedback.set(bloqueos.join(' · '));
      void this.sound.warn();
      return;
    }

    // Con obligatorios sin responder no se decide por el usuario: se le
    // muestran y él elige entre volver a ellos o guardar la actividad
    // incompleta. Ver `RequiredDialogComponent` para el porqué de la segunda
    // opción.
    if (this.missing().length > 0) {
      this.askingRequired.set(true);

      // En campo la pantalla se mira a ratos: se pulsa guardar, se levanta la
      // vista y se da por hecho que quedó registrada. Un aviso solo visual se
      // pierde justo en ese momento.
      void this.sound.warn();
      return;
    }

    await this.commit();
  }

  /**
   * Lo que falta por responder, campos y tablas de detalle.
   *
   * Una tabla no se valida sola: el motor ve un arreglo con registros dentro y
   * lo da por respondido, pero un registro a medias es exactamente igual de
   * incompleto que una pregunta en blanco — y llega al servidor así. Los
   * registros que les faltan respuestas se añaden aquí, con su propio destino:
   * pulsarlos lleva **dentro** del registro, que es donde está lo que corregir.
   */
  readonly missing = computed<MissingEntry[]>(() => {
    const engine = this.engine();
    if (!engine) return [];

    const fromFields = engine.missing();
    const fromDetails: MissingEntry[] = [];

    for (const panel of this.panels.topLevel()) {
      const rows = panel.incompleteRows();
      if (rows.length === 0) continue;

      const entry = this.locate(engine, panel.fieldId);
      if (!entry) continue;

      fromDetails.push({
        ...entry,
        note:
          rows.length === 1
            ? '1 registro sin completar'
            : `${rows.length} registros sin completar`,
        go: () => panel.open(rows[0]),
      });
    }

    return [...fromFields, ...fromDetails];
  });

  /** Dónde está un campo dentro del formulario. */
  private locate(engine: FormEngine, fieldId: string): MissingEntry | null {
    for (const [page, content] of engine.pages.entries()) {
      const field = content.fie.find((entry) => entry.id === fieldId);
      if (field) return { field, page };
    }

    return null;
  }

  /**
   * «Revisar campos»: los enciende en rojo y lleva al primero.
   *
   * `markSubmitted` es lo que hace que la marca de obligatorio se encienda en
   * todos, no solo en los que el usuario ya había tocado.
   */
  async onReviewRequired(): Promise<void> {
    const engine = this.engine();
    if (!engine) return;

    const missing = this.missing();
    engine.markSubmitted();
    this.blocking.set(missing);
    this.askingRequired.set(false);

    if (missing.length > 0) await this.goToMissing(missing[0]);
  }

  /** «Guardar de todos modos»: la actividad queda registrada e incompleta. */
  async onSaveAnyway(): Promise<void> {
    this.askingRequired.set(false);
    await this.commit(true);
  }

  /** Escribe y marca la actividad como terminada. */
  /**
   * El estado que la actividad tenía **antes** de que el flujo lo tocara.
   *
   * `null` significa que el flujo nunca se lo cambió. La cadena vacía es otra
   * cosa: significa que no tenía ninguno, y es a eso a lo que hay que volver si
   * la regla deja de cumplirse.
   */
  private estadoAntesDelFlujo: string | null = null;

  /** El estado que el flujo dejó puesto, para no reescribir el mismo. */
  private estadoPuestoPorElFlujo: string | null = null;

  /**
   * Pone —o quita— el estado que el flujo pida.
   *
   * Se aplica en cuanto cambia, no solo al guardar: un cambio de estado por
   * una regla de «al cambiar» tiene que verse al momento, igual que se ve un
   * campo que aparece.
   *
   * Y se deshace igual que se hace. Si la regla que puso el estado deja de
   * cumplirse —se borró la respuesta que la disparaba— la actividad vuelve al
   * estado que traía, que puede ser ninguno. Dejarla con el estado puesto sería
   * como dejar visible un campo que el flujo ya no quiere mostrar.
   */
  private async aplicarEstadoDelFlujo(pedido: string | null): Promise<void> {
    const answer = this.answer();

    if (answer.ID == null) {
      console.debug('[flujo] estado: la actividad todavía no tiene ID');
      return;
    }

    const actual = String(answer.Status ?? '');

    if (!pedido) {
      // Ninguna regla pide estado. Si el flujo nunca lo tocó no hay nada que
      // hacer; si lo tocó, se devuelve a como estaba.
      if (this.estadoAntesDelFlujo === null) return;

      const vuelta = this.estadoAntesDelFlujo;
      this.estadoAntesDelFlujo = null;
      this.estadoPuestoPorElFlujo = null;

      if (actual === vuelta) return;

      await this.answers.update(answer.ID, {
        Status: vuelta,
        UpdatedOn: new Date().toISOString(),
      });

      this.statusChanged.emit(vuelta);
      this.activities.notifyChanged();
      return;
    }

    // Cómo estaba antes, la primera vez que el flujo se mete: es a lo que hay
    // que volver si la regla deja de cumplirse.
    if (this.estadoAntesDelFlujo === null) this.estadoAntesDelFlujo = actual;

    /*
     * Ya lo tiene: no se reescribe, pero tampoco se da por hecho.
     *
     * Se compara contra **la actividad** y no contra lo último que puso el
     * flujo. Así, si alguien mueve el estado a mano mientras la regla sigue
     * cumpliéndose, la siguiente evaluación lo corrige: mientras su condición
     * se cumpla, el flujo manda.
     */
    if (actual === pedido) {
      console.debug('[flujo] estado: la actividad ya está en', pedido);
      this.estadoPuestoPorElFlujo = pedido;
      return;
    }

    /*
     * Un estado que no llegó en la sincronización se ignora.
     *
     * Dejar la actividad en un estado que el navegador no conoce la vuelve
     * indescifrable en el listado —sin nombre y sin color—, y eso es peor que
     * no haberlo cambiado.
     */
    const estado = await this.estados.findByDispatchId(Number(pedido));

    if (!estado) {
      console.warn('[FormRunner] el flujo pidió un estado que no está descargado', pedido);
      return;
    }

    this.estadoPuestoPorElFlujo = pedido;

    await this.answers.update(answer.ID, {
      Status: pedido,
      UpdatedOn: new Date().toISOString(),
    });

    console.debug('[flujo] estado: actividad movida de', actual || 'ninguno', 'a', pedido, `(${estado.Name})`);

    this.statusChanged.emit(pedido);
    this.activities.notifyChanged();
  }

  /**
   * Abre las actividades que el flujo pidió crear.
   *
   * ## Qué se hereda y qué no
   *
   * La sede y el equipo se copian **solo si el formulario destino los pide del
   * mismo tipo**. Copiarlos siempre dejaría una actividad apuntando a una sede
   * que su formulario no admite, y eso llega a Visitrack como un registro
   * válido que nadie puede cuadrar después. Cuando no encajan se deja en blanco
   * y quien la abra los elige, que es lo que haría de todos modos.
   *
   * Se comparan los dos formularios entre sí y no el formulario con la
   * actividad: en la actividad el tipo de sede se guarda como GUID y en el
   * formulario como número, así que compararlos no daría igual nunca.
   *
   * Nace como borrador y colgando de la que la creó, para que se sepa de dónde
   * salió: una actividad que aparece sola en el listado sin que nadie la haya
   * pedido desconcierta.
   */
  private async abrirLasQuePidioElFlujo(answer: SurveyAnswer): Promise<void> {
    const engine = this.engine();
    if (!engine) return;

    const destinos = engine.actividadesQuePideElFlujo();
    if (!destinos.length) return;

    const user = this.auth.currentUser();
    if (!user) return;

    const deOrigen = await this.activities.findSurvey(answer.SurveyID);
    const abiertas: string[] = [];

    for (const pedida of destinos) {
      const destino = pedida.formulario;
      const survey = await this.activities.findSurvey(destino);

      // Un formulario que no está descargado no se puede abrir. Se dice y no
      // se crea: una actividad de un formulario que no existe no se puede ni
      // diligenciar ni borrar con sentido.
      if (!survey) {
        console.warn('[FormRunner] el flujo pidió un formulario que no está descargado', destino);
        continue;
      }

      const mismaSede =
        !!deOrigen &&
        String(survey.LocationTypeID ?? '') === String(deOrigen.LocationTypeID ?? '') &&
        !!answer.LocationID;

      const mismoEquipo =
        !!deOrigen &&
        Number(survey.hasAsset) === 1 &&
        String(survey.AssetTypeID ?? '') === String(deOrigen.AssetTypeID ?? '') &&
        !!answer.AssetID;

      try {
        const nueva = await this.answers.createDraft({
          survey,
          userId: user.UserID,
          companyId: user.CompanyID,
          parentGuid: answer.GUID,
        });

        if ((mismaSede || mismoEquipo) && nueva.ID != null) {
          await this.answers.update(nueva.ID, {
            ...(mismaSede
              ? {
                  LocationTypeID: answer.LocationTypeID,
                  LocationID: answer.LocationID,
                  LocationGUID: answer.LocationGUID,
                  LocationName: answer.LocationName,
                  WorkZoneID: answer.WorkZoneID,
                }
              : {}),
            ...(mismoEquipo
              ? {
                  AssetID: answer.AssetID,
                  AssetGUID: answer.AssetGUID,
                  AssetName: answer.AssetName,
                }
              : {}),
          });
        }

        // Y lo que la regla quiso que llegara escrito. Después de crearla y no
        // dentro: una hija que nace bien y no consigue heredar algo sigue
        // siendo una actividad útil, y atar las dos cosas dejaría sin actividad
        // a quien configuró mal una herencia.
        await this.sembrarHerencia(nueva, survey, answer, deOrigen, pedida);

        abiertas.push(survey.Title);
      } catch (error) {
        console.error('[FormRunner] no se pudo abrir la actividad del flujo', error);
      }
    }

    if (abiertas.length) {
      this.abiertasPorElFlujo.set(abiertas);
      this.activities.notifyChanged();
    }
  }

  /**
   * Deja escrito en la actividad hija lo que el flujo quiso heredar.
   *
   * Los identificadores del encargo son `apiId` de **los dos** formularios: el
   * del hijo en `campo`/`tabla` y el del padre en `de`. Se traducen aquí contra
   * los dos esquemas, porque una respuesta se guarda por el identificador
   * interno y ese es propio de cada formulario.
   *
   * ## Lo que todavía no hace aquí
   *
   * Llenar una tabla del hijo **con registros de una lista** y heredar
   * archivos. Lo primero necesita resolver la lista de una tabla que no está
   * abierta —de eso vive `MasterDetailSourceService`, y trabaja sobre el
   * formulario en pantalla—; lo segundo, copiar ficheros, que en el navegador
   * no es lo mismo que en el teléfono. Se dice en la consola en vez de
   * callarse: una foto que parece heredada y no llega es peor que no heredarla.
   */
  private async sembrarHerencia(
    hija: SurveyAnswer,
    survey: Survey,
    padre: SurveyAnswer,
    surveyPadre: Survey | null | undefined,
    herencia: HerenciaDeActividad,
  ): Promise<void> {
    if (hija.ID == null) return;

    const campos = herencia.campos ?? [];
    const tablas = herencia.tablas ?? [];

    if (herencia.binarios?.length) {
      console.warn(
        '[flujo] heredar archivos todavía solo funciona en la app',
        herencia.binarios.map((b) => b.campo),
      );
    }

    if (!campos.length && !tablas.length) return;

    try {
      const delHijo = this.camposPorApiId(survey);
      const delPadre = this.camposPorApiId(surveyPadre);

      // Lo respondido en el padre, por el identificador con el que lo guardó.
      const respuestas = new Map(
        parseAnswerFields(padre.Fields).map((entrada) => [entrada.id, entrada]),
      );

      const entradas: AnswerField[] = [];

      for (const pedido of campos) {
        const campo = delHijo.get(String(pedido.campo ?? '').trim());

        if (!campo) {
          console.warn('[flujo] el formulario hijo no tiene el campo', pedido.campo);
          continue;
        }

        /*
         * El motor deja el valor **como texto** porque no conoce el esquema del
         * hijo. Aquí sí se conoce, así que se convierte en lo que ese campo
         * guarda de verdad: un radio `{id, txt}`, una casilla una lista de eso.
         */
        const valor = comoLoGuarda(pedido.valor, {
          // Hay esquemas viejos sin `apiId`; ahí el identificador interno hace
          // de nombre, igual que en el desplegable del lienzo.
          apiId: campo.apiId ?? campo.id,
          fty: campo.fty,
          opt: campo.opt ?? [],
        });

        if (valor === null) {
          console.warn('[flujo] el campo no admite ese valor', pedido.campo, pedido.valor);
          continue;
        }

        entradas.push({
          id: campo.id,
          val: valor as FieldValue,
          fty: campo.fty,
          hid: !!campo.hid,
        });
      }

      for (const pedida of tablas) {
        const tablaHija = delHijo.get(String(pedida.tabla ?? '').trim());

        if (!tablaHija || tablaHija.fty !== 'masterdetail') {
          console.warn('[flujo] el formulario hijo no tiene la tabla', pedida.tabla);
          continue;
        }

        if (pedida.items?.length) {
          console.warn(
            '[flujo] llenar con registros de una lista una tabla de la actividad hija ' +
              'todavía solo funciona en la app',
            pedida.tabla,
          );
        }

        const de = String(pedida.de ?? '').trim();
        if (!de) continue;

        const tablaPadre = delPadre.get(de);

        if (!tablaPadre) {
          console.warn('[flujo] el formulario padre no tiene la tabla', de);
          continue;
        }

        /*
         * Solo entre tablas que salen de la misma lista.
         *
         * Los campos de una fila se guardan por el identificador del
         * sub-formulario de esa lista; copiándolas a una tabla de otra, lo
         * respondido dentro apuntaría a identificadores que allí no significan
         * nada y la fila se vería vacía. Mejor no copiar y decirlo.
         */
        if (String(tablaPadre.lst ?? '') !== String(tablaHija.lst ?? '')) {
          console.warn(
            '[flujo] las dos tablas no salen de la misma lista: no se copian sus filas',
            de,
            pedida.tabla,
          );

          continue;
        }

        const filas = readRows(respuestas.get(tablaPadre.id)?.val).map((fila) => ({
          ...structuredClone(fila),

          // Es una fila de otra actividad: identificador propio y de la tabla
          // que la recibe.
          GUID: crypto.randomUUID(),
          id: tablaHija.id,
          LinkedAnswerGUID: '',
        }));

        if (!filas.length) continue;

        entradas.push({
          id: tablaHija.id,
          val: filas as unknown as FieldValue,
          fty: 'masterdetail',
          hid: !!tablaHija.hid,
        });
      }

      if (!entradas.length) return;

      await this.answers.update(hija.ID, { Fields: JSON.stringify(entradas) });
    } catch (error) {
      console.warn('[flujo] no se pudo sembrar la actividad hija', error);
    }
  }

  /**
   * Los campos de un formulario por el nombre con el que los pide una regla.
   *
   * Por `apiId`, y por el identificador interno cuando el campo no trae
   * `apiId`: hay esquemas viejos donde no existe, y una regla escrita sobre
   * ellos nombra el identificador.
   */
  private camposPorApiId(survey: Survey | null | undefined): Map<string, FormField> {
    const salida = new Map<string, FormField>();
    if (!survey) return salida;

    for (const page of parseQuestions(survey.JSONQuestion)) {
      for (const field of page.fie) {
        const clave = String(field.apiId ?? '').trim() || field.id;

        if (!clave || salida.has(clave)) continue;

        salida.set(clave, field);
      }
    }

    return salida;
  }

  /**
   * Apunta las consignas que pidió el flujo. **No las manda.**
   *
   * Salen cuando la actividad esté arriba con sus archivos confirmados; de eso
   * se ocupa `DespachoService`, al que se avisa desde el envío. Aquí solo se
   * dejan en la cola local para que sobrevivan a lo que pase en medio: perder
   * la conexión, cerrar la pestaña, apagar el equipo.
   */
  private async apuntarLasConsignas(answer: SurveyAnswer, incompleta: boolean): Promise<void> {
    const engine = this.engine();
    if (!engine) return;

    const pedidos = engine.despachosQuePideElFlujo();

    // Con rastro: esto ha costado varias vueltas y desde fuera «no despacha» se
    // ve igual tanto si la regla no se disparó como si se descartó aquí.
    console.debug('[flujo] consignas al guardar', {
      incompleta,
      pedidas: pedidos.length,
      detalle: pedidos,
    });

    for (const despacho of pedidos) {
      /*
       * «Solo si la actividad quedó completa».
       *
       * Guardar deja pasar aunque falten obligatorios —se avisa y quien
       * diligencia decide—, y una consigna que nace de un informe a medias
       * suele ser un error. Con la marca puesta, en ese caso no sale nada.
       */
      if (despacho['soloCompleta'] === true && incompleta) continue;

      /*
       * El que traiga la regla, el que se acaba de elegir en el diálogo, o uno
       * mismo.
       *
       * «Al mismo que la llenó» el motor no lo resuelve —tiene que dar el mismo
       * resultado en el simulador, donde no hay nadie diligenciando— así que lo
       * marca y lo resuelve quien despacha. Aquí sí se sabe quién es.
       */
      const destinatario = (
        String(despacho['destinatario'] ?? '').trim() ||
        this.elegidos.get(this.claveDeDespacho(despacho)) ||
        (despacho['mismoUsuario'] === true
          ? String(this.auth.currentUser()?.UserID ?? '')
          : '') ||
        ''
      ).trim();

      /*
       * Sin destinatario no se apunta.
       *
       * No debería llegar aquí: quien guarda ya lo resolvió en el diálogo. Si
       * llega, se avisa en vez de callarse — una consigna que desaparece sin
       * decir nada es lo peor que puede pasar con esto.
       */
      if (!destinatario) {
        console.warn('[despacho] descartado: sin a quién enviarlo', despacho);
        continue;
      }

      await this.despachos.apuntar({
        AnswerGUID: answer.GUID,
        Que: String(despacho['que'] ?? 'otro'),
        SurveyID: String(despacho['formulario'] ?? ''),
        Destinatario: destinatario,
        EstadoGUID: String(despacho['estado'] ?? ''),
        Aviso: String(despacho['aviso'] ?? ''),
        Hija: despacho['hija'] === true,
        Regla: String(despacho['regla'] ?? ''),
        Programado: String(despacho['programado'] ?? ''),
      });
    }
  }

  /**
   * Apunta los correos que pidió el flujo. **No los manda.**
   *
   * Salen cuando la actividad esté arriba con sus archivos confirmados; de eso
   * se ocupa `CorreoService`, al que se avisa desde el envío. Aquí solo se dejan
   * en la cola local para que sobrevivan a lo que pase en medio: perder la
   * conexión, cerrar la pestaña, apagar el equipo.
   *
   * Vienen ya escritos del motor —las variables resueltas y escapadas— así que
   * aquí no hay nada que leer del formulario.
   */
  private async apuntarLosCorreos(answer: SurveyAnswer, incompleta: boolean): Promise<void> {
    const engine = this.engine();
    if (!engine) return;

    for (const correo of engine.correosQuePideElFlujo()) {
      /*
       * «Solo si la actividad quedó completa».
       *
       * Lo mismo que en una consigna: guardar deja pasar aunque falten
       * obligatorios, y un correo que cuenta un informe a medias suele ser un
       * error. Con la marca puesta, en ese caso no sale nada.
       */
      if (correo['soloCompleta'] === true && incompleta) continue;

      await this.correos.apuntar({
        AnswerGUID: answer.GUID,
        Llave: String(correo['llave'] ?? ''),
        Para: String(correo['para'] ?? ''),
        Copia: String(correo['copia'] ?? ''),
        CopiaOculta: String(correo['copiaOculta'] ?? ''),

        // Como texto JSON, que es como viaja al servidor. Lo que el motor dejó
        // es **cuál** archivo se quiere, no el archivo: aquí no hay nada que
        // abrir.
        Adjuntos: correo['adjuntos'] ? JSON.stringify(correo['adjuntos']) : '',

        // Los avisos que la regla escribió para la pantalla. Viajan con el
        // correo y no con el botón: valen igual cuando sale al guardar.
        MensajeEnviando: String(correo['mensajeEnviando'] ?? ''),
        MensajeEnviado: String(correo['mensajeEnviado'] ?? ''),
        Asunto: String(correo['asunto'] ?? ''),
        Cuerpo: String(correo['cuerpo'] ?? ''),
        Proveedor: String(correo['proveedor'] ?? ''),
        Area: String(correo['area'] ?? ''),
        Programado: String(correo['programado'] ?? ''),
        Regla: String(correo['regla'] ?? ''),
      });
    }
  }

  /**
   * Apunta las notificaciones que pidió el flujo. **No las manda.**
   *
   * Gemela de `apuntarLosCorreos`, hasta en el motivo: salen cuando la actividad
   * esté arriba, y aquí solo se dejan en la cola local para que sobrevivan a lo
   * que pase en medio —perder la conexión, cerrar la pestaña, apagar el equipo—.
   *
   * Vienen ya escritas del motor: el texto con las variables puestas y la foto
   * convertida en dirección. Aquí no hay nada que leer del formulario.
   */
  private async apuntarLosPushes(answer: SurveyAnswer, incompleta: boolean): Promise<void> {
    const engine = this.engine();
    if (!engine) return;

    for (const push of engine.pushesQuePideElFlujo()) {
      // «Solo si la actividad quedó completa», igual que en un correo: guardar
      // deja pasar aunque falten obligatorios, y avisar de un informe a medias
      // suele ser un error.
      if (push['soloCompleta'] === true && incompleta) continue;

      await this.pushes.apuntar({
        AnswerGUID: answer.GUID,
        Llave: String(push['llave'] ?? ''),
        Para: String(push['para'] ?? ''),
        Titulo: String(push['titulo'] ?? ''),
        Texto: String(push['texto'] ?? ''),
        Foto: String(push['foto'] ?? ''),
        Enlace: String(push['enlace'] ?? ''),
        Programado: String(push['programado'] ?? ''),
        Regla: String(push['regla'] ?? ''),
        Disparo: String(push['disparo'] ?? 'guardar'),
      });
    }
  }

  /**
   * Los despachos a los que les falta a quién enviarlos.
   *
   * Salen del flujo marcados con `preguntar`: o la regla dice «pregunta al
   * guardar», o dice «sácalo de este campo» y el campo vino en blanco.
   */
  private despachosSinDestinatario(): Record<string, unknown>[] {
    return (this.engine()?.despachosQuePideElFlujo() ?? []).filter((d) => d['preguntar'] === true);
  }

  /**
   * Pregunta por las consignas **exigidas**, antes de guardar.
   *
   * Devuelve `false` si alguna se quedó sin resolver: entonces no se guarda
   * nada. Es lo que pidió quien configuró la regla — cerrar la actividad sin
   * esa consigna sería darla por terminada cuando no lo está.
   *
   * La actividad se queda como estaba: sin guardar, en gris, y no sube.
   */
  private async resolverLoExigido(): Promise<boolean> {
    for (const despacho of this.despachosSinDestinatario()) {
      if (despacho['exigido'] !== true) continue;

      this.pidiendoDestinatario.set(
        despacho['que'] === 'misma' ? 'esta misma actividad' : 'una actividad nueva',
      );

      const elegido = await new Promise<Destinatario | null>((resolve) => {
        this.resolverEleccion = resolve;
      });

      this.pidiendoDestinatario.set(null);
      this.resolverEleccion = null;

      if (!elegido) {
        this.feedback.set(
          'No se guardó: este formulario exige decir a quién se le despacha la consigna antes de cerrar.',
        );

        void this.sound.warn();
        return false;
      }

      this.elegidos.set(this.claveDeDespacho(despacho), String(elegido.ID));
    }

    return true;
  }

  /**
   * Pide el destinatario que falte, uno por uno, antes de dejar guardar.
   *
   * Devuelve `false` si se canceló: entonces **no se guarda**. Es la única
   * forma de que el despacho no se pierda sin que nadie se entere — una
   * consigna sin dueño no la ve nadie.
   */
  private async resolverDestinatarios(answer: SurveyAnswer): Promise<void> {
    let sinResolver = 0;

    for (const despacho of this.despachosSinDestinatario()) {
      // Lo exigido ya se resolvió antes de guardar, o no habríamos llegado aquí.
      if (despacho['exigido'] === true) continue;

      this.pidiendoDestinatario.set(
        despacho['que'] === 'misma' ? 'esta misma actividad' : 'una actividad nueva',
      );

      const elegido = await new Promise<Destinatario | null>((resolve) => {
        this.resolverEleccion = resolve;
      });

      this.pidiendoDestinatario.set(null);
      this.resolverEleccion = null;

      /*
       * Sin elegir, esta consigna **no sale**. Y la actividad se guarda igual.
       *
       * No se apunta sin dueño: la regla no está marcada como imprescindible,
       * así que retener la actividad por ella sería frenar el trabajo por algo
       * que quien configuró el flujo dijo que no era para tanto. Se avisa, que
       * es lo que evita que se pierda en silencio.
       */
      if (!elegido) {
        sinResolver++;
        continue;
      }

      // Se resuelve sobre el propio encargo: lo que se apunta después ya lleva
      // el usuario dentro y no vuelve a preguntar.
      this.elegidos.set(this.claveDeDespacho(despacho), String(elegido.ID));

      await this.despachos.apuntar({
        AnswerGUID: answer.GUID,
        Que: String(despacho['que'] ?? 'otro'),
        SurveyID: String(despacho['formulario'] ?? ''),
        Destinatario: String(elegido.ID),
        EstadoGUID: String(despacho['estado'] ?? ''),
        Aviso: String(despacho['aviso'] ?? ''),
        Hija: despacho['hija'] === true,
        Regla: String(despacho['regla'] ?? ''),
        Programado: String(despacho['programado'] ?? ''),
      });
    }

    if (sinResolver > 0) {
      this.feedback.set(
        sinResolver === 1
          ? 'La actividad se guardó, pero la consigna no se despachó: nadie la va a recibir.'
          : `La actividad se guardó, pero ${sinResolver} consignas no se despacharon: nadie las va a recibir.`,
      );

      void this.sound.warn();
    }
  }

  /**
   * Lo elegido en el diálogo, mientras dura este guardado.
   *
   * Hace falta guardarlo aparte: `despachosQuePideElFlujo` **copia** los
   * encargos en cada llamada, así que escribir el usuario sobre lo que devuelve
   * no llega a ninguna parte — al apuntar se pediría otra vez, vendría igual de
   * vacío, y la consigna se descartaría en silencio.
   */
  private readonly elegidos = new Map<string, string>();

  /** Con qué se reconoce un despacho entre dos guardados. */
  private claveDeDespacho(d: Record<string, unknown>): string {
    // Con la programación dentro: una misma regla puede pedir dos consignas del
    // mismo formulario para dos fechas distintas, y cada una puede ir a alguien
    // distinto. Sin ella, la segunda heredaba el destinatario de la primera.
    return [d['regla'] ?? '', d['que'] ?? '', d['formulario'] ?? '', d['programado'] ?? ''].join('|');
  }

  /** Qué se está despachando mientras el diálogo está abierto, o `null`. */
  readonly pidiendoDestinatario = signal<string | null>(null);

  /** Cómo se le contesta al diálogo. Ver [resolverDestinatarios]. */
  private resolverEleccion: ((quien: Destinatario | null) => void) | null = null;

  alElegirDestinatario(quien: Destinatario): void {
    this.resolverEleccion?.(quien);
  }

  alCancelarDestinatario(): void {
    this.resolverEleccion?.(null);
  }

  private async commit(incomplete = false): Promise<void> {
    const answer = this.answer();
    if (answer.ID == null) return;

    /*
     * El flujo, con el momento «al guardar», por aquí y no solo en [save].
     *
     * A esto se llega por dos botones: «guardar» y «guardar de todos modos»
     * —el de la lista de obligatorios sin responder—. Comprobándolo solo en el
     * primero, salir por el segundo dejaba la actividad sin el estado que
     * pedía el flujo y sin abrir la siguiente: el mismo formulario se
     * comportaba distinto según por qué botón se hubiera salido. Aquí pasan
     * los dos.
     *
     * Volver a evaluarlo no cuesta: con las mismas respuestas el motor da el
     * mismo resultado, así que la segunda pasada solo cambia algo si de verdad
     * cambió un dato.
     */
    const engineAlGuardar = this.engine();

    if (engineAlGuardar) {
      /*
       * Evaluar, esperar, y volver a evaluar.
       *
       * La primera pasada puede hacer **nacer** llamadas que no existían: una
       * regla de «al guardar» con `llamar-servicio` se resuelve justo aquí. La
       * segunda es la que decide, ya con lo que respondieron: su `alResponder`
       * puede escribir campos y también poner un bloqueo, y guardar sin volver
       * a mirar dejaría pasar una actividad que la regla quería frenar.
       */
      engineAlGuardar.revisarFlujoAlGuardar();

      await this.esperarLasLlamadasDelGuardado(engineAlGuardar);

      const bloqueos = engineAlGuardar.revisarFlujoAlGuardar();

      if (bloqueos.length) {
        this.feedback.set(bloqueos.join(' · '));
        void this.sound.warn();
        return;
      }
    }

    // Lo elegido en un guardado anterior no se arrastra: puede que la regla ya
    // no aplique.
    this.elegidos.clear();

    /*
     * Las consignas que la regla marcó como **exigidas**, antes de escribir.
     *
     * Son las que el formulario declara imprescindibles: sin resolverlas la
     * actividad no se guarda, y por tanto no sube nunca. Es la única forma de
     * que una consigna que es el motivo de la visita —«si está dañado, avisa a
     * mantenimiento»— no se quede sin salir.
     *
     * Las demás se preguntan **después** de guardar: ahí lo que se pierde es la
     * consigna, no el trabajo. Ver [resolverDestinatarios].
     */
    if (!(await this.resolverLoExigido())) return;

    this.blocking.set([]);
    this.saving.set(true);

    try {
      await this.flush();

      // Con archivos por subir, la actividad queda esperándolos en lugar de
      // ponerse en cola: subirla antes la dejaría en Visitrack apuntando a
      // fotos que no existen, y eso pasa por completa sin serlo.
      /**
       * Las reglas de la compañía, antes de marcarla como guardada.
       *
       * Deciden el estado a partir de lo respondido —si falta la firma queda
       * pendiente, si el trabajo se cerró queda terminado—. Va antes de
       * `markSaved` para que el estado ya esté escrito cuando la actividad
       * entre en la cola de subida: al revés, podría salir con el estado
       * anterior. Ver `core/rules/company-logic.service.ts`.
       */
      const engineForRules = this.engine();
      if (engineForRules) {
        await this.companyLogic.onSaved(
          answer,
          engineForRules.toAnswerFields(),
          engineForRules.pages,
        );
      }

      /*
       * Lo que el flujo pidió hacer con la actividad.
       *
       * Después de las reglas de la compañía y antes de `markSaved`, por el
       * mismo motivo que ellas: tiene que estar escrito cuando la actividad
       * entre en la cola de subida. Después de ellas porque el flujo lo
       * configuró el cliente para este formulario, y eso es más concreto que
       * una regla de compañía escrita en el código.
       */
      await this.abrirLasQuePidioElFlujo(answer);
      await this.apuntarLasConsignas(answer, incomplete);
      await this.apuntarLosCorreos(answer, incomplete);
      await this.apuntarLosPushes(answer, incomplete);
      await this.aplicarEstadoDelFlujo(this.engine()?.estadoDelFlujo() ?? null);

      /*
       * Y ahora sí, a quién se le despacha lo que quedó sin dueño.
       *
       * Con la actividad **ya escrita**. Antes se preguntaba primero y cancelar
       * significaba no guardar: quien diligencia acababa buscando una persona
       * entre cientos con el formulario todavía sin guardar, y un descuido le
       * costaba el trabajo entero.
       *
       * Lo que no se resuelva no se pierde: la consigna queda apuntada sin
       * dueño y **retiene el envío** de la actividad. Ver [dispatch].
       */
      await this.resolverDestinatarios(answer);

      const pendingFiles = await this.activities.countBlockingBinaries(answer.GUID);

      /*
       * «Completada» es sin obligatorios pendientes, y nada más.
       *
       * De esta marca cuelga la regla de borrado del formulario —el equipo
       * retira sus actividades terminadas pasado un plazo—, así que sellarla
       * al guardar de todos modos ponía a contar el plazo de algo que sigue a
       * medias, y la actividad acababa retirándose sin haberse terminado.
       *
       * Es el mismo criterio de la app: allí solo se sella cuando la actividad
       * pasa a un estado de completada.
       */
      const completedOn = incomplete ? '' : answer.CompletedOn || new Date().toISOString();

      await this.answers.markSaved(answer.ID, pendingFiles > 0, completedOn);

      this.activities.notifyChanged();
      this.feedback.set(this.describeSave(incomplete, pendingFiles));

      // El envío arranca aquí mismo, sin esperar al proceso del minuto: el
      // usuario acaba de pulsar Guardar y es cuando más probable es que tenga
      // cobertura y la pestaña abierta.
      //
      // Va sin `await` a propósito. Subir cinco fotos puede tardar medio
      // minuto, y bloquear el botón todo ese rato hace que la gente lo vuelva
      // a pulsar creyendo que no funcionó. El estado real se sigue en el
      // listado y en la pantalla de pendientes.
      //
      // Y **antes** de avisar de que se guardó, con el GUID ya en la mano:
      // ese aviso saca al usuario al listado y destruye este componente, así
      // que leer la entrada después sería leer algo que ya no está.
      void this.dispatch(answer.GUID);

      this.saved.emit();
    } catch (error) {
      console.error('[FormRunner] no se pudo guardar', error);
      this.feedback.set('No se pudo guardar la actividad.');
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Lanza la subida de esta actividad en segundo plano.
   *
   * Los fallos se registran pero no se le muestran al usuario: acaba de
   * guardar y su trabajo ya está a salvo en el dispositivo. Que el envío no
   * saliera ahora mismo no es un error suyo ni algo que pueda resolver desde
   * aquí — se reintentará solo, y el listado dice en qué estado quedó.
   */
  private async dispatch(guid: string): Promise<number> {
    try {
      await this.pendingUploads.run(guid);
    } catch (error) {
      console.error('[FormRunner] no se pudo enviar la actividad', error);
    }

    /*
     * Las consignas se intentan **pase lo que pase con la subida**.
     *
     * Estaban dentro del `try`, después de subir, y ahí había un caso que no
     * salía nunca: una actividad que ya estaba arriba —se guarda otra vez, o no
     * tenía nada pendiente— hace que `run` no haga nada o falle, y la consigna
     * se quedaba en la cola sin que nadie la intentara jamás.
     *
     * Intentarlo siempre es seguro: si la actividad todavía no está en
     * Visitrack, el servidor responde 409 y se reintenta. Es él quien sabe si
     * está, no nosotros.
     */
    await this.despachos.enviarPendientes(guid);

    // Y los correos, en el mismo momento y por lo mismo: un correo que remite a
    // una actividad que todavia no esta arriba no le sirve a quien lo recibe.
    const encolados = await this.correos.encolarPendientes(guid);

    /*
     * Y las notificaciones, aquí mismo.
     *
     * Con un motivo propio y más fuerte: el servidor resuelve «@asignado» y
     * «@creador» mirando la actividad, así que antes de que suba no sabría a
     * quién mandarlas. Responde 409 y se reintenta, que es lo que hace el
     * servicio; intentarlo aquí siempre es seguro.
     *
     * ## Y sí se dice, aunque el aviso sea para otro
     *
     * Al principio esto no anunciaba nada: un push que sale al guardar va casi
     * siempre a **otra** persona, y parecía ruido contárselo a quien guarda.
     *
     * Estaba mal. Sin ningún rastro en pantalla, un aviso que el servidor
     * rechaza —sin destinatarios válidos, sin título— se ve exactamente igual
     * que uno que salió, y quien configuró la regla no tiene forma de saber que
     * su flujo no avisa a nadie. Es el mismo motivo por el que el correo lo
     * dice. Lo que se anuncia es que **se pidió**, no que haya sonado.
     */
    const avisos = await this.pushes.encolarPendientes(guid);

    if (avisos.motivo) {
      this.toasts.show({
        title: 'La notificación no se pudo pedir',
        detail: avisos.motivo,
        tone: 'warning',
      });
    } else if (avisos.aceptados > 0) {
      this.toasts.show({
        title:
          avisos.aceptados === 1
            ? 'Notificación en camino'
            : `${avisos.aceptados} notificaciones en camino`,
        detail: 'Sale en cuanto el servidor la reparta.',
        tone: 'success',
      });
    }

    /*
     * Y se dice, porque un correo no se ve.
     *
     * Guardar una actividad que además avisa a alguien se veía igual que
     * guardarla a secas: quien configuró la regla no tenía forma de saber si
     * llegó a pedirse el correo, y acababa preguntando por chat.
     *
     * **«En camino» y no «enviado».** Aquí solo se sabe que el servidor lo
     * aceptó en su cola; quien lo manda es el job, después, y puede tropezar
     * con el buzón. Decir «enviado» prometería algo que desde aquí no se sabe
     * — es la misma razón por la que la columna se llama `Encolado`.
     */
    /*
     * El texto de la regla manda, si lo hay.
     *
     * «Acta de Bar Pepe en camino» dice de qué va esto; «Correo en camino», no.
     * Quien configura el flujo sabe qué se manda y aquí no se puede saber, así
     * que se deja escribir allí — con variables, como el asunto.
     */
    if (encolados.aceptados > 0) {
      this.toasts.show({
        title:
          encolados.mensaje ||
          (encolados.aceptados === 1
            ? 'Correo en camino'
            : `${encolados.aceptados} correos en camino`),
        tone: 'success',
      });
    }

    return encolados.aceptados;
  }

  /**
   * Qué se le dice al usuario después de guardar.
   *
   * Los archivos pendientes se nombran a propósito: si no, una actividad que se
   * queda esperando a que suban sus fotos parece atascada sin motivo, y el
   * usuario acaba volviéndola a guardar o borrándola.
   */
  private describeSave(incomplete: boolean, pendingFiles: number): string {
    const head = incomplete
      ? 'Actividad guardada con campos obligatorios sin responder.'
      : 'Actividad guardada.';

    const cola =
      pendingFiles === 0
        ? `${head} Se subirá en la próxima sincronización.`
        : `${head} Se enviará cuando ${
            pendingFiles === 1 ? 'su archivo esté' : `sus ${pendingFiles} archivos estén`
          } en el servidor.`;

    // Lo que el flujo abrió se cuenta aquí y no en un aviso aparte: al guardar
    // la pantalla se va al listado, y un segundo mensaje no llegaría a leerse.
    const abiertas = this.abiertasPorElFlujo();
    if (!abiertas.length) return cola;

    return abiertas.length === 1
      ? `${cola} El flujo abrió una actividad de «${abiertas[0]}».`
      : `${cola} El flujo abrió ${abiertas.length} actividades nuevas.`;
  }

  /** Salta al campo que falta y lo deja enfocado. */
  async goToMissing(entry: MissingEntry): Promise<void> {
    this.askingRequired.set(false);
    await this.goToPage(entry.page);

    /**
     * Una tabla de detalle lleva **dentro**, al registro que está a medias.
     *
     * Llevar al campo no serviría de nada: a la vista está lleno, y lo que hay
     * que corregir son las respuestas de uno de sus registros.
     */
    if (entry.go) {
      entry.go();
      return;
    }

    // El desplazamiento va tras el repintado: el campo puede estar en otra
    // página y todavía no existir en el DOM cuando se pide.
    setTimeout(() => {
      const element = document.getElementById(`field-${entry.field.id}`);
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      element?.querySelector<HTMLElement>('input, textarea, select')?.focus({
        preventScroll: true,
      });
    });
  }

  /**
   * Los límites que el flujo puso a un campo, si puso alguno.
   *
   * Se devuelve `null` cuando no hay ninguno para que el campo no tenga que
   * distinguir entre «sin límites» y «con límites vacíos».
   */
  limitesDe(estado: { desde?: string; hasta?: string; dias?: string } | undefined) {
    if (!estado?.desde && !estado?.hasta && !estado?.dias) return null;

    return { desde: estado.desde, hasta: estado.hasta, dias: estado.dias };
  }

  /**
   * Lo que el flujo le puso al teclado de un campo, si le puso algo.
   *
   * Gemela de [limitesDe] y por lo mismo: `null` cuando no hay nada evita que
   * el campo tenga que distinguir entre «sin reglas» y «con reglas vacías».
   *
   * Un cero es una decisión —«el mínimo es cero»— así que se pregunta por
   * `undefined` y no por si el número es falsy: con lo segundo, un mínimo de
   * cero desaparecería sin que nadie lo hubiera quitado.
   */
  entradaDe(
    estado:
      | {
          minimo?: number;
          maximo?: number;
          minCaracteres?: number;
          maxCaracteres?: number;
          patron?: string;
          patronMensaje?: string;
        }
      | undefined,
  ) {
    if (!estado) return null;

    const hayAlguna =
      estado.minimo !== undefined ||
      estado.maximo !== undefined ||
      estado.minCaracteres !== undefined ||
      estado.maxCaracteres !== undefined ||
      !!estado.patron;

    if (!hayAlguna) return null;

    return {
      minimo: estado.minimo,
      maximo: estado.maximo,
      minCaracteres: estado.minCaracteres,
      maxCaracteres: estado.maxCaracteres,
      patron: estado.patron,
      patronMensaje: estado.patronMensaje,
    };
  }

}
