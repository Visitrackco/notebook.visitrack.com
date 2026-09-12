import {
  Component,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import { ToastService } from '../../../core/services/toast.service';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { ChatApi, SalaResumen } from '../chat.api';

/**
 * Lo que se está mandando a una sala.
 *
 * De la actividad viaja **el GUID** y no la dirección de su PDF: la dirección
 * la arma quien la abre con el dominio de exportación que tenga puesto ese día.
 * Guardándola en el mensaje, el dominio queda congelado dentro de cada uno — y
 * ya cambió dos veces esta semana, así que lo compartido hace un mes dejaría de
 * abrirse.
 *
 * Del archivo viaja **una copia**, no un enlace a donde vive ahora: los
 * binarios de una actividad se limpian cuando esa actividad se cierra, y un
 * mensaje que apunta a un archivo borrado es peor que no haberlo mandado.
 */
export type ParaCompartir =
  | { clase: 'actividad'; guid: string; titulo: string }
  | { clase: 'archivo'; blob: Blob; nombre: string; titulo: string };

/**
 * Elegir una sala y mandarle algo, desde cualquier pantalla.
 *
 * ## Por qué no vive dentro del chat
 *
 * Porque quien comparte **no está en el chat**: está en el listado de
 * actividades o mirando un archivo, y lo que quiere es mandarlo sin perder lo
 * que estaba haciendo. Metido en la pantalla del chat habría que ir allí,
 * buscar la sala y volver — y para entonces ya no se comparte nada.
 *
 * Quien lo usa solo pone `[que]` con lo que quiere mandar y escucha `cerrado`.
 * Elegir sala, subir, escribir el mensaje y avisar del resultado se hace aquí:
 * repartirlo entre las pantallas que comparten era tener la misma secuencia
 * escrita tres veces y desalineada a la primera corrección.
 */
@Component({
  selector: 'vt-compartir-en-sala',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './compartir-en-sala.component.html',
  styleUrl: './compartir-en-sala.component.scss',
})
export class CompartirEnSalaComponent {
  private readonly api = inject(ChatApi);
  private readonly toasts = inject(ToastService);

  /** Qué se comparte. `null` cierra el diálogo. */
  readonly que = input<ParaCompartir | null>(null);

  readonly cerrado = output<void>();

  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  readonly salas = signal<SalaResumen[]>([]);
  readonly cargando = signal(false);
  readonly error = signal('');

  /** Nombre de la sala a la que se está mandando. Vacío = nada en curso. */
  readonly enviandoA = signal('');

  constructor() {
    effect(() => {
      const abierto = this.que() !== null;
      const elemento = this.dialog()?.nativeElement;
      if (!elemento) return;

      if (abierto && !elemento.open) {
        elemento.showModal();
        // Se piden **al abrir** y no se guardan: a alguien lo agregan a una sala
        // mientras la pestaña lleva horas abierta, y una lista de entonces le
        // esconde justo la sala a la que quiere escribir.
        untracked(() => void this.traerSalas());
      } else if (!abierto && elemento.open) {
        elemento.close();
      }
    });
  }

  async traerSalas(): Promise<void> {
    this.cargando.set(true);
    this.error.set('');

    try {
      this.salas.set(await this.api.salas());
    } catch {
      this.error.set('No se pudieron cargar tus salas.');
    } finally {
      this.cargando.set(false);
    }
  }

  inicialDe(nombre: string): string {
    return (nombre.trim().charAt(0) || '?').toUpperCase();
  }

  async elegir(sala: SalaResumen): Promise<void> {
    const que = this.que();
    if (!que || this.enviandoA()) return;

    // El nombre queda a la vista mientras dura: subir una foto por una red de
    // campo tarda, y sin nada en pantalla se vuelve a pulsar — dos mensajes
    // iguales en la sala de todos.
    this.enviandoA.set(sala.nombre);

    try {
      if (que.clase === 'actividad') {
        await this.api.escribir(sala.id, {
          tipo: 'actividad',
          texto: que.guid,
          clientId: crypto.randomUUID(),
        });
      } else {
        const ficha = await this.api.subirAdjunto(sala.id, que.blob, que.nombre);

        await this.api.escribir(sala.id, {
          tipo: 'archivo',
          clientId: crypto.randomUUID(),
          adjuntos: [ficha],
        });
      }

      this.toasts.show({
        title: `Compartido en ${sala.nombre}`,
        detail: que.titulo,
        tone: 'success',
      });

      this.cerrado.emit();
    } catch {
      this.toasts.show({
        title: 'No se pudo compartir.',
        detail: 'Inténtalo otra vez.',
        tone: 'error',
      });
    } finally {
      this.enviandoA.set('');
    }
  }

  /**
   * Cierra al pulsar fuera de la tarjeta.
   *
   * El `<dialog>` ocupa toda la pantalla y su `::backdrop` no recibe eventos,
   * así que el clic de fuera llega al propio dialog. Comparando el objetivo con
   * el elemento se distingue «fuera» de «dentro».
   */
  alPulsarElVelo(evento: MouseEvent): void {
    if (evento.target === this.dialog()?.nativeElement) this.cerrar();
  }

  cerrar(): void {
    // Con un envío en curso no se cierra: la subida seguiría, el mensaje se
    // escribiría igual y nadie vería que salió bien.
    if (this.enviandoA()) return;

    this.cerrado.emit();
  }
}
