import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';

import {
  PushFlujoRepository,
  PushFlujoService,
  PushPendiente,
} from '../../core/services/push-flujo.service';
import { ToastService } from '../../core/services/toast.service';

/**
 * Las notificaciones que pidieron las reglas de flujo, y en qué punto va cada una.
 *
 * **Gemela de `FlowEmailsComponent`**, y a propósito: la pregunta es la misma
 * —«¿salió?»— y quien ya sabe leer la de correos no tiene que aprender otra
 * cosa.
 *
 * ## «En la cola» no es «le llegó»
 *
 * Desde el navegador solo se sabe que **el servidor lo aceptó**. Quien lo manda
 * es un job, después, y todavía puede tropezar: la persona puede no tener
 * ningún aparato con avisos encendidos. Por eso aquí no dice «enviado» en
 * ninguna parte.
 *
 * Lo que pasó después —si le llegó al aparato y si lo abrió— se ve en Module,
 * en la bandeja de notificaciones. Ahí están las cuatro fechas; aquí solo la
 * primera mitad del camino, que es la que este navegador conoce.
 *
 * ## Por qué el destinatario se enseña como viene
 *
 * Porque son **personas**, no direcciones: identificadores, o las palabras
 * `@asignado` y `@creador`. Resolverlas aquí es imposible —quién es el asignado
 * lo decide el servidor mirando la actividad— y traducirlas a un nombre
 * inventado sería peor que enseñar la palabra tal cual, que al menos es lo que
 * se configuró.
 */
@Component({
  selector: 'vt-flow-pushes',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './flow-pushes.component.html',
  styleUrl: './flow-pushes.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FlowPushesComponent implements OnInit {
  private readonly repo = inject(PushFlujoRepository);
  private readonly pushes = inject(PushFlujoService);
  private readonly toasts = inject(ToastService);

  readonly filas = signal<PushPendiente[]>([]);
  readonly cargando = signal(true);
  readonly reintentando = signal(false);

  /**
   * Las que todavía no están en la cola del servidor.
   *
   * `Encolado = 0` es exactamente eso. Las que el servidor rechazó para siempre
   * —sin destinatarios válidos, sin título— se marcan resueltas con su motivo,
   * así que no cuentan aquí: no hay nada que reintentar con ellas.
   */
  readonly pendientes = computed(() => this.filas().filter((p) => !p.Encolado).length);

  /**
   * Cuantos hay en cada punto, para el resumen de arriba.
   *
   * Se cuentan los tres y no solo los pendientes: con veinte filas, saber
   * cuantos fallaron a ojo obliga a recorrerlas una por una, que es justo lo
   * que esta pantalla existe para evitar.
   */
  readonly enEspera = computed(
    () => this.filas().filter((p) => this.estadoDe(p) === 'espera').length,
  );

  readonly enCola = computed(
    () => this.filas().filter((p) => this.estadoDe(p) === 'cola').length,
  );

  readonly conFallo = computed(
    () => this.filas().filter((p) => this.estadoDe(p) === 'mal').length,
  );

  /**
   * El `ID` del que se esta empujando ahora, para apagar solo su boton.
   *
   * Uno y no un booleano de pantalla: con un booleano, pulsar en una fila
   * apagaba el boton de las veinte, y desde fuera eso se lee como que se estan
   * mandando todas.
   */
  readonly empujando = signal<number | null>(null);

  /**
   * Empuja **uno**, el que se pidio.
   *
   * ## Por que uno y no solo el «reintentar todo» de arriba
   *
   * Porque quien entra aqui suele venir por uno concreto: el que pidio hace un
   * momento y no ve salir. Obligarle a reintentar los veinte para empujar ese
   * uno es pedirle que dispare a ciegas.
   *
   * No manda el aviso: pide que entre en la cola del servidor, que es lo unico
   * que el navegador puede hacer. **Quien valida es el servidor**, y ahi es
   * donde se comprueba que la actividad este en Visitrack con sus fotos ya en
   * linea. Si dice que no, se ensena su motivo tal cual: es la respuesta a «por
   * que no ha salido».
   */
  async dispararUno(fila: PushPendiente): Promise<void> {
    const guid = String(fila.AnswerGUID ?? '');
    const id = fila.ID ?? null;

    if (!guid || id === null) return;

    this.empujando.set(id);

    try {
      const salida = await this.pushes.encolarPendientes(guid);

      this.toasts.show({
        title: salida.aceptados
          ? salida.aceptados === 1
            ? 'Entro en la cola'
            : `${salida.aceptados} entraron en la cola`
          : 'Todavia no puede entrar',
        detail: salida.aceptados
          ? 'Lo manda el servidor enseguida.'
          : String(salida.motivo ?? '').trim() ||
            'La actividad tiene que estar en Visitrack y sus fotos subidas.',
        tone: salida.aceptados ? 'success' : 'info',
      });
    } finally {
      this.empujando.set(null);
      await this.cargar();
    }
  }

  async ngOnInit(): Promise<void> {
    await this.cargar();
  }

  async cargar(): Promise<void> {
    this.cargando.set(true);

    try {
      const todos = await this.repo.getAll();

      // Lo que espera primero, que es lo que se viene a mirar; y dentro de cada
      // grupo, lo último arriba.
      this.filas.set(
        [...todos].sort(
          (a, b) => (a.Encolado ?? 0) - (b.Encolado ?? 0) || (b.ID ?? 0) - (a.ID ?? 0),
        ),
      );
    } catch (error) {
      /*
       * Puede fallar porque el almacén no exista todavía.
       *
       * Pasa con una pestaña abierta desde antes de que se añadiera: la base
       * está en la versión anterior hasta que se recargue. Se trata como
       * «no hay nada», que es lo que se ve, en vez de romper la pantalla.
       */
      console.warn('[push] no se pudo leer la bandeja local', error);
      this.filas.set([]);
    } finally {
      this.cargando.set(false);
    }
  }

  /**
   * Vuelve a intentar las que están esperando.
   *
   * No manda nada: pide que entren en la cola del servidor, que es lo único que
   * el navegador puede hacer. Las que ya están dentro no se tocan.
   */
  async reintentar(): Promise<void> {
    this.reintentando.set(true);

    try {
      const guids = [...new Set(this.filas().filter((p) => !p.Encolado).map((p) => p.AnswerGUID))];

      let aceptados = 0;
      let motivo = '';

      for (const guid of guids) {
        const salida = await this.pushes.encolarPendientes(guid);

        aceptados += salida.aceptados;

        // El primer motivo que aparezca. Dos actividades suelen fallar por lo
        // mismo, y apilar el mismo texto tres veces no dice nada nuevo.
        if (!motivo && salida.motivo) motivo = salida.motivo;
      }

      this.toasts.show({
        title: aceptados
          ? aceptados === 1
            ? '1 notificación entró en la cola'
            : `${aceptados} notificaciones entraron en la cola`
          : 'Ninguna pudo entrar todavía',

        /*
         * El motivo manda sobre el texto genérico.
         *
         * «Necesitan conexión» es lo normal y no ayuda cuando lo que pasa es
         * que al servidor le falta la ruta o que el destinatario ya no está en
         * la compañía. Ese es justo el caso que hay que poder leer.
         */
        detail:
          motivo || (aceptados ? undefined : 'Necesitan conexión, o que su actividad termine de subir.'),
        tone: aceptados ? 'success' : motivo ? 'warning' : 'info',
      });
    } finally {
      this.reintentando.set(false);
      await this.cargar();
    }
  }

  /**
   * En qué punto va una.
   *
   * Tres estados y no dos: encolada **con motivo escrito** no es un acierto, es
   * una notificación que el servidor rechazó y que ya no se va a reintentar.
   * Pintarla igual que una aceptada escondería justo el caso que hay que ver.
   */
  estadoDe(push: PushPendiente): 'espera' | 'cola' | 'mal' {
    if (!push.Encolado) return 'espera';

    return String(push.Error ?? '').trim() ? 'mal' : 'cola';
  }

  comoSeLee(push: PushPendiente): string {
    const estado = this.estadoDe(push);

    if (estado === 'mal') return 'No se pudo';

    return estado === 'cola' ? 'En la cola' : 'Esperando';
  }

  /**
   * A quién va, en palabras.
   *
   * Las dos palabras se traducen —`@asignado` no le dice nada a quien no
   * configuró la regla— y los identificadores se dejan como están: no hay de
   * dónde sacar el nombre sin pedirlo al servidor, y esta pantalla tiene que
   * funcionar sin conexión.
   */
  paraQuien(push: PushPendiente): string {
    const partes = String(push.Para ?? '')
      .split(/[,;]+/)
      .map((uno) => uno.trim())
      .filter(Boolean)
      .map((uno) => {
        if (uno.toLowerCase() === '@asignado') return 'al asignado';
        if (uno.toLowerCase() === '@creador') return 'a quien la creó';

        return uno;
      });

    return partes.length ? partes.join(', ') : '(sin destinatario)';
  }
}
