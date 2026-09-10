import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { LlamadaPintada } from '../../../../core/forms/flujo-modelo';
import { ArchivoDeIntegracion } from '../../../../core/forms/integraciones.api';

/**
 * Las llamadas a servicios externos que una regla del flujo pidió.
 *
 * ## Por qué esto no es un botón
 *
 * Un botón se pulsa y ya. Una llamada tiene además un «esperando», un «falló
 * porque la cédula no está en el padrón» y un «se puede reintentar», y eso hay
 * que enseñarlo: encontrarse algo que no responde sin saber por qué deja a
 * alguien sin saber si está roto o es a propósito.
 *
 * Por eso cada estado se dice **con palabras**, y las que se disparan solas
 * —las que no tienen botón que pulsar— también se dibujan: si no, quien
 * diligencia vería un campo que no se llena y ninguna explicación.
 *
 * ## Qué NO decide este componente
 *
 * Si hay que llamar, con qué, y si se puede guardar. Todo eso lo decidió el
 * motor: aquí solo llega lo que hay que pintar. Pulsar avisa hacia arriba, que
 * es quien tiene el cliente del intermediario.
 */
@Component({
  selector: 'vt-flujo-llamadas',
  standalone: true,
  templateUrl: './flujo-llamadas.component.html',
  styleUrl: './flujo-llamadas.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FlujoLlamadasComponent {
  readonly llamadas = input.required<LlamadaPintada[]>();

  /**
   * Los archivos que ya devolvieron esas llamadas, por llave.
   *
   * Vienen de fuera y no del motor porque un archivo **no es un dato del
   * formulario**: no se puede recorrer con una ruta ni se guarda en la
   * actividad. Lo que el motor sabe de él es su ficha; los bytes se quedan
   * arriba. Ver `archivosDeIntegracion` en el ejecutor.
   */
  readonly archivos = input<Record<string, ArchivoDeIntegracion>>({});

  /**
   * Las llaves de las llamadas que ya tienen un botón de flujo propio.
   *
   * ## Por qué se sigue dibujando la llamada, pero sin su botón
   *
   * Porque una llamada no es solo un botón: es también el «esperando», el «falló
   * porque la cédula no está en el padrón» y el archivo que devolvió. Eso hay que
   * enseñarlo se dispare desde donde se dispare — esconderla entera dejaría a
   * quien diligencia con un botón que no explica nada.
   *
   * Lo que sobra es **el segundo botón**. Desde que una acción de botón puede
   * llamar a un servicio, la misma llamada aparece por dos sitios: en el botón
   * que la configuró y aquí. Dos botones para lo mismo, uno al lado del otro, se
   * lee como dos acciones distintas.
   */
  readonly conBotonPropio = input<readonly string[]>([]);

  /** La llamada que hay que hacer, porque alguien pulsó su botón. */
  readonly llamar = output<LlamadaPintada>();

  /** El archivo que devolvió esta llamada, si devolvió uno. */
  archivo(una: LlamadaPintada): ArchivoDeIntegracion | null {
    return this.archivos()[una.llave] ?? null;
  }

  /** Una imagen que además conservó su contenido: lo único que hay que ver. */
  vistaPrevia(una: LlamadaPintada): string {
    const archivo = this.archivo(una);

    if (!archivo?.contenidoBase64 || !archivo.tipoMime.startsWith('image/')) return '';

    return `data:${archivo.tipoMime};base64,${archivo.contenidoBase64}`;
  }

  /**
   * El tipo y el tamaño en algo que se pueda leer de un vistazo.
   *
   * Del tipo MIME interesa la mitad de la derecha —`pdf`, `jpeg`—: la izquierda
   * es siempre la misma y no distingue nada.
   */
  comoSeLee(archivo: ArchivoDeIntegracion): string {
    const tipo = archivo.tipoMime.split('/').pop()!.toUpperCase();

    if (archivo.tamano <= 0) return tipo;

    const kb = archivo.tamano / 1024;

    return kb < 1024
      ? `${tipo} · ${Math.round(kb)} KB`
      : `${tipo} · ${(kb / 1024).toFixed(1)} MB`;
  }

  /** ¿Esta llamada la dispara un botón, o sale sola? */
  porBoton(una: LlamadaPintada): boolean {
    // La que ya tiene su propio botón de flujo no dibuja otro aquí.
    if (this.conBotonPropio().includes(una.llave)) return false;

    return (una.disparo ?? 'boton') === 'boton';
  }

  /**
   * ¿Se puede pulsar ahora mismo?
   *
   * Con la llamada en vuelo, no: pulsar otra vez no la adelanta y sí gasta otra
   * petición. Sin lo que necesita —estado `falta`— tampoco: lo que hay que hacer
   * es responder el campo que falta, y eso lo dice el mensaje.
   */
  sePuedePulsar(una: LlamadaPintada): boolean {
    if (una.estado === 'pendiente') return true;
    if (una.estado === 'error') return una.reintentable === true;

    return una.estado === 'ok' && this.porBoton(una);
  }

  /** Lo que se lee dentro del botón, según en qué vaya la llamada. */
  rotulo(una: LlamadaPintada): string {
    if (una.estado === 'error') return una.reintentable ? 'Reintentar' : una.titulo;
    if (una.estado === 'ok') return 'Volver a consultar';

    return una.titulo;
  }

  pulsar(una: LlamadaPintada): void {
    if (!this.sePuedePulsar(una)) return;

    this.llamar.emit(una);
  }
}
