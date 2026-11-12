import { NearEndDirective } from '../../shared/directives/near-end.directive';
import { ZonaHorariaService } from '../../core/services/zona-horaria.service';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';

import { CorreoPendiente, CorreoRepository, CorreoService } from '../../core/services/correo.service';
import { ToastService } from '../../core/services/toast.service';
import { traducir } from '../../core/i18n/idioma.service';
import { TPipe } from '../../core/i18n/t.pipe';

/** Las que se pintan de una vez, y las que se guardan en memoria como mucho. */
const POR_TANDA = 50;
const TOPE_EN_MEMORIA = 500;

/**
 * Los correos que pidieron las reglas de flujo, y en qué punto va cada uno.
 *
 * ## Qué contesta esta pantalla
 *
 * «¿Salió el correo?». Hasta ahora no había forma de saberlo desde aquí: el
 * correo se apuntaba en un almacén que nadie enseñaba, y quien pulsaba un botón
 * se quedaba sin manera de comprobar nada.
 *
 * ## «En la cola» no es «le llegó»
 *
 * Desde el navegador solo se sabe que **el servidor lo aceptó**. Quien lo manda
 * es un job, después, y todavía puede tropezar con el buzón. Por eso aquí no
 * dice «enviado» en ninguna parte: prometer un envío que no consta deja a
 * alguien esperando una respuesta que quizá nunca se pidió. Lo que pasó después
 * se ve en Module, en la bandeja de correos.
 */
@Component({
  selector: 'vt-flow-emails',
  standalone: true,
  imports: [NearEndDirective, TPipe],
  templateUrl: './flow-emails.component.html',
  styleUrl: './flow-emails.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FlowEmailsComponent implements OnInit {
  readonly zona = inject(ZonaHorariaService);
  private readonly repo = inject(CorreoRepository);
  private readonly correos = inject(CorreoService);
  private readonly toasts = inject(ToastService);

  readonly filas = signal<CorreoPendiente[]>([]);

  /**
   * Cuántas filas se pintan. De a poco y al acercarse al final: pintarlas todas
   * de una vez, con el historial de meses, es lo que dejaba colgada la pestaña.
   */
  private readonly limite = signal(POR_TANDA);

  readonly visibles = computed(() => this.filas().slice(0, this.limite()));

  readonly hayMas = computed(() => this.limite() < this.filas().length);

  verMas(): void {
    this.limite.update((n) => n + POR_TANDA);
  }
  readonly cargando = signal(true);
  readonly reintentando = signal(false);

  /**
   * Los que todavía no están en la cola del servidor.
   *
   * `Encolado = 0` es exactamente eso. Los que el servidor rechazó para siempre
   * —sin buzón, sin destinatario— se marcan resueltos con su motivo, así que no
   * cuentan aquí: no hay nada que reintentar con ellos.
   */
  readonly pendientes = computed(() => this.filas().filter((c) => !c.Encolado).length);

  /**
   * Cuantos hay en cada punto, para el resumen de arriba.
   *
   * Se cuentan los tres y no solo los pendientes: con veinte filas, saber
   * cuantos fallaron a ojo obliga a recorrerlas una por una, que es justo lo
   * que esta pantalla existe para evitar.
   */
  readonly enEspera = computed(
    () => this.filas().filter((c) => this.estadoDe(c) === 'espera').length,
  );

  readonly enCola = computed(
    () => this.filas().filter((c) => this.estadoDe(c) === 'cola').length,
  );

  readonly conFallo = computed(
    () => this.filas().filter((c) => this.estadoDe(c) === 'mal').length,
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
   * No manda el correo: pide que entre en la cola del servidor, que es lo unico
   * que el navegador puede hacer. **Quien valida es el servidor**, y ahi es
   * donde se comprueba que la actividad este en Visitrack con sus fotos ya en
   * linea. Si dice que no, se ensena su motivo tal cual: es la respuesta a «por
   * que no ha salido».
   */
  async dispararUno(fila: CorreoPendiente): Promise<void> {
    const guid = String(fila.AnswerGUID ?? '');
    const id = fila.ID ?? null;

    if (!guid || id === null) return;

    this.empujando.set(id);

    try {
      const salida = await this.correos.encolarPendientes(guid);

      this.toasts.show({
        title: salida.aceptados
          ? salida.aceptados === 1
            ? traducir('flujos.entroCola')
            : traducir('flujos.entraronCola', { n: salida.aceptados })
          : traducir('flujos.noPuedeEntrar'),
        detail: salida.aceptados
          ? traducir('flujos.loMandaServidor')
          : String(salida.mensaje ?? '').trim() ||
            traducir('flujos.tieneQueEstar'),
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
        [...todos]
          .sort((a, b) => (a.Encolado ?? 0) - (b.Encolado ?? 0) || (b.ID ?? 0) - (a.ID ?? 0))
          .slice(0, TOPE_EN_MEMORIA),
      );
    } catch (error) {
      console.warn('[correo] no se pudo leer la bandeja local', error);
      this.filas.set([]);
    } finally {
      this.cargando.set(false);
    }
  }

  /**
   * Vuelve a intentar los que están esperando.
   *
   * No manda nada: pide que entren en la cola del servidor, que es lo único que
   * el navegador puede hacer. Los que ya están dentro no se tocan.
   */
  async reintentar(): Promise<void> {
    this.reintentando.set(true);

    try {
      const guids = [...new Set(this.filas().filter((c) => !c.Encolado).map((c) => c.AnswerGUID))];

      let aceptados = 0;

      for (const guid of guids) {
        const salida = await this.correos.encolarPendientes(guid);
        aceptados += salida.aceptados;
      }

      this.toasts.show({
        title: aceptados
          ? aceptados === 1
            ? traducir('flujos.correo1Cola')
            : traducir('flujos.correosNCola', { n: aceptados })
          : traducir('flujos.ningunoPudo'),
        detail: aceptados
          ? undefined
          : traducir('flujos.necesitanConexion'),
        tone: aceptados ? 'success' : 'info',
      });
    } finally {
      this.reintentando.set(false);
      await this.cargar();
    }
  }

  /**
   * En qué punto va uno.
   *
   * Tres estados y no dos: encolado **con motivo escrito** no es un acierto, es
   * un correo que el servidor rechazó y que ya no se va a reintentar. Pintarlo
   * igual que uno aceptado escondería justo el caso que hay que ver.
   */
  estadoDe(correo: CorreoPendiente): 'espera' | 'cola' | 'mal' {
    if (!correo.Encolado) return 'espera';

    return String(correo.Error ?? '').trim() ? 'mal' : 'cola';
  }

  comoSeLee(correo: CorreoPendiente): string {
    const estado = this.estadoDe(correo);

    if (estado === 'mal') return traducir('flujos.noSePudo');

    return traducir(estado === 'cola' ? 'flujos.enCola' : 'flujos.esperando');
  }
}
