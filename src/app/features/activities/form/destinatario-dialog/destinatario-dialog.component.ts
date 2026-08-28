import { Component, effect, inject, input, output, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ApiService } from '../../../../core/services/api.service';
import { AuthService } from '../../../../core/services/auth.service';

/** Un usuario al que se le puede despachar. */
export interface Destinatario {
  ID: number;
  Nombre: string;
  Login: string;
}

/**
 * Pregunta a quién se le despacha una consigna.
 *
 * ## Por qué no se puede cerrar sin elegir
 *
 * Una consigna sin dueño no la ve nadie. Dejar guardar sin resolverlo sería
 * perder el despacho sin que nadie se entere, así que de aquí solo se sale
 * eligiendo, o cancelando el guardado entero.
 *
 * ## Por qué por tandas
 *
 * Hay compañías con miles de usuarios. Bajarlos todos para elegir a uno es
 * lento en el mejor caso, así que llegan de a veinticinco: se busca escribiendo
 * y al llegar al final se piden los siguientes.
 *
 * ## Y por qué necesita conexión
 *
 * La lista vive en el servidor, que es quien sabe a quién puede ver cada uno
 * —respeta su segmentación—. Sin conexión no se inventa una lista: se dice, y
 * se ofrece reintentar.
 */
@Component({
  selector: 'vt-destinatario-dialog',
  standalone: true,
  template: `
    @if (open()) {
      <div class="dst" role="dialog" aria-modal="true" aria-labelledby="dst-tit">
        <div class="dst__caja">
          <header class="dst__cab">
            <h2 id="dst-tit">¿A quién se le envía?</h2>
            <p>Se va a despachar {{ queFormulario() }}.</p>
          </header>

          <input
            class="dst__busca"
            type="search"
            autofocus
            placeholder="Buscar por nombre o usuario"
            [value]="busca()"
            (input)="alBuscar($any($event.target).value)"
          />

          <div class="dst__lista" (scroll)="alDesplazar($any($event.target))">
            @if (!usuarios().length && cargando()) {
              <p class="dst__nada">Buscando…</p>
            } @else if (!usuarios().length && fallo()) {
              <div class="dst__nada">
                <p>
                  No se pudo traer la lista.<br />
                  Hace falta conexión para elegir a quién enviarle.
                </p>
                <button type="button" class="dst__reintentar" (click)="traer(true)">
                  Cargar de nuevo
                </button>
              </div>
            } @else if (!usuarios().length) {
              <p class="dst__nada">
                {{ busca().trim() ? 'Nadie se llama así' : 'No hay usuarios disponibles' }}
              </p>
            } @else {
              @for (u of usuarios(); track u.ID) {
                <button type="button" class="dst__uno" (click)="elegir.emit(u)">
                  <span class="dst__ini">{{ (u.Nombre || u.Login || '?').charAt(0) }}</span>
                  <span class="dst__nom">
                    <strong>{{ u.Nombre || u.Login }}</strong>
                    <small>{{ u.Login }}</small>
                  </span>
                </button>
              }

              @if (cargando()) {
                <p class="dst__nada">Cargando más…</p>
              } @else if (fallo()) {
                <button type="button" class="dst__reintentar" (click)="traer()">Cargar más</button>
              }
            }
          </div>

          <footer class="dst__pie">
            <button type="button" class="dst__cancelar" (click)="cancelar.emit()">
              Cancelar y no guardar
            </button>
          </footer>
        </div>
      </div>
    }
  `,
  styleUrl: './destinatario-dialog.component.scss',
})
export class DestinatarioDialogComponent {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);

  readonly open = input(false);

  /** Qué se está despachando, para que quien elige sepa a qué dice que sí. */
  readonly queFormulario = input('una consigna');

  readonly elegir = output<Destinatario>();
  readonly cancelar = output<void>();

  readonly usuarios = signal<Destinatario[]>([]);
  readonly busca = signal('');
  readonly cargando = signal(false);
  readonly fallo = signal(false);

  private hayMas = true;
  private espera: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    /*
     * Al abrirse empieza de cero: la lista de la vez anterior era de otro
     * despacho, y la búsqueda que quedó escrita no la pidió nadie.
     *
     * `untracked` no es un adorno. `traer` lee señales —la lista que lleva, si
     * está cargando, quién es el usuario— y leerlas dentro del efecto lo
     * suscribe a ellas: al terminar la petición escribe la lista, eso despierta
     * al efecto, que vuelve a pedir, y así sin parar. Una ráfaga de consultas al
     * servidor por abrir un diálogo.
     *
     * Lo único que debe despertarlo es que se abra.
     */
    effect(() => {
      const abierto = this.open();

      untracked(() => {
        if (abierto) void this.traer(true);
      });
    });
  }

  alBuscar(texto: string): void {
    this.busca.set(texto);

    // Con espera: preguntar al servidor en cada letra son diez consultas para
    // escribir un apellido.
    if (this.espera) clearTimeout(this.espera);
    this.espera = setTimeout(() => void this.traer(true), 400);
  }

  /** Al llegar al final se piden los siguientes, con margen para que no se note. */
  alDesplazar(caja: HTMLElement): void {
    if (caja.scrollTop + caja.clientHeight >= caja.scrollHeight - 120) void this.traer();
  }

  /**
   * Trae la siguiente tanda. Con `reiniciar`, vuelve a empezar.
   *
   * Una sola petición a la vez, siempre: `cargando` se levanta antes de tocar
   * la red y no se baja hasta que responde, así que el desplazamiento puede
   * disparar esto cincuenta veces mientras se baja y solo sale una.
   */
  async traer(reiniciar = false): Promise<void> {
    if (this.cargando()) return;
    if (!reiniciar && !this.hayMas) return;

    if (reiniciar) {
      this.usuarios.set([]);
      this.hayMas = true;
    }

    this.cargando.set(true);
    this.fallo.set(false);

    try {
      const res = await firstValueFrom(
        this.api.get<{ response?: Destinatario[]; hayMas?: boolean }>('/usuariosParaDespachar', {
          userId: String(this.auth.currentUser()?.UserID ?? ''),
          q: this.busca().trim(),
          desde: this.usuarios().length,
          cuantos: 25,
        }),
      );

      this.usuarios.update((ya) => [...ya, ...(res?.response ?? [])]);
      this.hayMas = res?.hayMas === true;
    } catch (error) {
      // Sin lista no es que no haya nadie: es que no se pudo pedir, y eso se
      // dice de otra manera y con un botón para reintentar.
      console.warn('[despacho] no se pudo traer la lista de usuarios', error);
      this.fallo.set(true);
    } finally {
      this.cargando.set(false);
    }
  }
}
