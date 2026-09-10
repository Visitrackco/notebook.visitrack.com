import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import {
  Animacion,
  BotonPintado,
  CorreoPedido,
  LlamadaPintada,
  PushPedido,
} from '../../../../core/forms/flujo-modelo';

/**
 * Los botones que una regla del flujo puso debajo de los campos.
 *
 * ## Qué NO decide este componente
 *
 * **Si el botón se ve y si se puede pulsar.** Eso lo decidió el motor con la
 * misma condición que decide cualquier otra cosa del flujo: aquí solo llegan los
 * que hay que dibujar. Si esto volviera a evaluar condiciones habría dos sitios
 * donde responder la misma pregunta, y el día que no coincidieran nadie sabría
 * cuál manda.
 *
 * ## Lo que sí decide
 *
 * **Qué pasa al pulsar.** Mostrar una gráfica escondida es un estado de la
 * pantalla —de quien está mirando— y no del formulario: el motor cuenta lo mismo
 * se haya pulsado o no, y lo respondido no cambia por destapar un resumen. Por
 * eso se avisa hacia arriba con [mostrar] y quien tiene el formulario recuerda
 * qué gráficas van destapadas.
 */
@Component({
  selector: 'vt-flujo-botones',
  standalone: true,
  templateUrl: './flujo-botones.component.html',
  styleUrl: './flujo-botones.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FlujoBotonesComponent {
  readonly botones = input.required<BotonPintado[]>();

  /** Los nombres de las gráficas que hay que destapar. */
  readonly mostrar = output<string[]>();

  /**
   * Los correos que el botón pide encolar, ya escritos por el motor.
   *
   * Salen hacia fuera en vez de encolarse aquí porque este componente no sabe
   * de qué actividad cuelgan —ni tiene por qué—: quien lo sabe es el formulario,
   * que es también quien guarda. Aquí solo se pulsa.
   */
  readonly encolar = output<CorreoPedido[]>();

  /**
   * Las notificaciones que el botón pide encolar, ya escritas por el motor.
   *
   * Salida propia y no mezclada con la de los correos: quien las recibe las
   * apunta en otra cola y las manda a otro endpoint. Mezclarlas obligaría a
   * distinguirlas por su forma en el otro extremo, que es como se cuela el
   * fallo de mandar un aviso al buzón de correo.
   */
  readonly encolarPush = output<PushPedido[]>();

  /**
   * Las caritas que el botón lanza al pulsarlo.
   *
   * Salida propia y no mezclada con las gráficas: aquélla destapa algo que ya
   * estaba en la pantalla, y ésta lanza una animación que se va sola. Quien las
   * recibe hace dos cosas distintas con ellas.
   */
  readonly celebrar = output<Animacion[]>();

  /**
   * La nota que el botón escribe al pulsarlo, y en qué campo.
   *
   * Ya calculada por el motor al armar el botón: aquí no se cuenta nada. Ver
   * `BotonPintado.puntua`.
   */
  readonly puntuar = output<{ campo: string; valor: number }>();

  /**
   * Las llamadas a un servicio que el botón dispara al pulsarlo.
   *
   * Salida propia, como las demás: quien tiene el cliente del intermediario es
   * el formulario, no este componente. Aquí solo se pulsa.
   *
   * Vienen en `BotonPintado.llamadas`, y **las mismas** están en la lista de
   * integraciones del motor: de ahí salen su estado, su respuesta y su
   * reintento. Por eso esto emite las llamadas y no las ejecuta — no hay una
   * segunda maquinaria.
   */
  readonly llamar = output<LlamadaPintada[]>();

  /** Cuando no se puede mandar, para decirlo en vez de no hacer nada. */
  readonly noSePuede = output<string[]>();

  /**
   * Por qué el correo de este botón no puede salir ahora mismo.
   *
   * Lo calcula el motor y se recalcula con cada respuesta, así que borrar el
   * campo del que salía el destinatario apaga el botón en ese momento — no al
   * pulsarlo.
   */
  problemasDe(boton: BotonPintado): string[] {
    return boton.problemas ?? [];
  }

  /**
   * Las llamadas de este botón que están en vuelo ahora mismo.
   *
   * El estado no lo lleva el botón: lo lleva la llamada, y el motor rearma el
   * botón con cada evaluación, así que lo que hay aquí es siempre lo de ahora.
   */
  enVuelo(boton: BotonPintado): LlamadaPintada[] {
    return (boton.llamadas ?? []).filter((una) => una.estado === 'vuelo');
  }

  /**
   * Qué está esperando el botón, con el nombre de la consulta.
   *
   * El nombre y no «cargando»: un botón puede lanzar dos consultas y, cuando una
   * va lenta, saber cuál es la diferencia entre esperar y dar por roto.
   */
  esperando(boton: BotonPintado): string {
    const enVuelo = this.enVuelo(boton);
    if (!enVuelo.length) return '';

    return enVuelo.length === 1
      ? `Consultando «${enVuelo[0].titulo}»…`
      : `Consultando ${enVuelo.length} servicios…`;
  }

  /**
   * Lo que el botón dice que hace y todavía no se hace, en palabras.
   *
   * Se escribe entero y no con una marca a secas porque quien está en campo no
   * tiene por qué saber qué significa un icono de reloj: lo que necesita es
   * poder decidir si además tiene que llamar a alguien.
   */
  pendienteDe(boton: BotonPintado): string {
    const que = (boton.pendientes ?? []).map((p) =>
      p === 'correo' ? 'el correo' : 'la notificación',
    );

    if (!que.length) return '';

    return `${que.join(' y ')} ${que.length === 1 ? 'todavía no se envía' : 'todavía no se envían'}`;
  }

  /** ¿Este botón hace algo de verdad ahora mismo? */
  hacePendienteSolo(boton: BotonPintado): boolean {
    return !(boton.graficas ?? []).length && !!(boton.pendientes ?? []).length;
  }

  /**
   * Lo que pasa al pulsarlo: destapar lo que destape **y** pedir sus correos.
   *
   * Los dos, no uno u otro: un botón puede enseñar el resumen y además
   * mandarlo. Es lo mismo que hace la app, y a propósito — un botón que en el
   * teléfono manda un correo y en el navegador no haría que la misma regla se
   * comportara distinto según por dónde se diligencie.
   *
   * El correo se **apunta**, no se manda: sale cuando la actividad esté en
   * Visitrack con sus archivos, y por eso pulsar esto no exige tener señal.
   */
  pulsar(boton: BotonPintado): void {
    if (boton.soloLectura) return;

    const graficas = boton.graficas ?? [];
    if (graficas.length) this.mostrar.emit(graficas);

    /*
     * Se vuelve a comprobar al pulsar, aunque el botón ya se vea apagado.
     *
     * Entre que se pintó y se pulsó pudo cambiar cualquier cosa, y un botón que
     * no hace nada y no dice por qué se lee como una aplicación rota. Con el
     * motivo delante, quien está en campo sabe qué arreglar.
     */
    const problemas = this.problemasDe(boton);
    const correos = boton.correos ?? [];

    /*
     * Con una sola dirección mal escrita **no se manda nada**.
     *
     * Es lo contrario de dejar salir el correo a los buenos y avisar del malo, y
     * se eligió a propósito: un aviso que sale a dos de tres destinatarios se
     * lee como enviado, y el que faltaba no se descubre hasta que hace falta.
     * Mejor que no salga y que se arregle.
     *
     * Para que esto no deje un botón muerto —una dirección mal escrita en la
     * regla no la puede arreglar quien está en campo— el lienzo marca ahora esas
     * direcciones al configurarlas, que es donde sí está quien puede corregirlas.
     */
    if (problemas.length) {
      this.noSePuede.emit(problemas);
      return;
    }

    if (correos.length) this.encolar.emit(correos);

    // Y los avisos, con el mismo trato: se apuntan, no se mandan.
    const pushes = boton.pushes ?? [];
    if (pushes.length) this.encolarPush.emit(pushes);

    /*
     * La nota primero, las caritas después.
     *
     * Importa el orden: celebrar antes de escribir deja medio segundo en el que
     * la pantalla festeja una calificación que todavía no se ve. Al revés, el
     * número aparece y la celebración lo acompaña.
     */
    if (boton.puntua) this.puntuar.emit(boton.puntua);

    const caritas = boton.animaciones ?? [];
    if (caritas.length) this.celebrar.emit(caritas);

    /*
     * Y las llamadas, al final.
     *
     * Al final a propósito: lo demás es inmediato —destapar, apuntar, escribir
     * la nota— y una consulta tarda. Lanzarla primero dejaría al botón hilando
     * mientras lo que sí se podía hacer ya está hecho y no se ve.
     */
    const llamadas = boton.llamadas ?? [];
    if (llamadas.length) this.llamar.emit(llamadas);
  }
}
