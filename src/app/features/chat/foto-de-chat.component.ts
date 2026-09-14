import { Component, inject, input, output, signal } from '@angular/core';

import { AdjuntoDeMensaje, ChatApi, propiedadesDe } from './chat.api';

/**
 * Las direcciones ya pedidas, con hasta cuándo valen.
 *
 * Es del módulo y no del componente porque la lista de mensajes rehace las
 * burbujas al cambiar de sala y al cargar más arriba; sin esto, cada vuelta
 * pedía otra vez todas las fotos que ya se habían visto.
 */
const direcciones = new Map<number, { url: string; hasta: number }>();

/** Menos que los cinco minutos de la firma, para no estrenar una que caduca. */
const VALEN_MS = 4 * 60 * 1000;

/**
 * Una foto compartida en el chat, pintada en la burbuja.
 *
 * ## Por qué se pinta y no se enlaza
 *
 * Porque una foto que hay que abrir para saber qué es no es una foto, es un
 * archivo. En una sala de trabajo la foto **es** el mensaje —el equipo dañado,
 * la etiqueta, el acta firmada— y se decide con verla, sin salir de la
 * conversación.
 *
 * ## La dirección caduca
 *
 * El archivo vive privado en el bucket y se abre con una dirección firmada que
 * vale cinco minutos. Se pide al pintar y se guarda por adjunto. Si al abrir en
 * grande ya caducó, se pide otra; y si la imagen falla, se puede reintentar.
 */
@Component({
  selector: 'vt-foto-de-chat',
  standalone: true,
  template: `
    <figure class="foto" [class.foto--mia]="mia()">
      <button
        type="button"
        class="foto__marco"
        [disabled]="cargando()"
        (click)="fallo() ? pedir() : abrir()"
        [attr.aria-label]="fallo() ? 'Reintentar cargar la foto' : 'Ver en grande'"
      >
        @if (cargando()) {
          <span class="foto__espera">Cargando…</span>
        } @else if (fallo()) {
          <span class="foto__espera">No se pudo cargar. Pulsa para reintentar.</span>
        } @else {
          <img [src]="url()" [alt]="adjunto().nombre" loading="lazy" (error)="seRompio()" />
        }
      </button>

      <figcaption class="foto__pie">
        <span class="foto__datos" [title]="adjunto().nombre">{{ descripcion() }}</span>
        <button type="button" class="foto__bajar" (click)="descargar.emit(adjunto())">
          Descargar
        </button>
      </figcaption>
    </figure>
  `,
  styles: `
    .foto {
      max-width: 280px;
      margin: 0.3rem 0 0;
    }

    .foto__marco {
      display: block;
      width: 100%;
      padding: 0;
      overflow: hidden;
      cursor: zoom-in;
      background: rgb(0 0 0 / 8%);
      border: 0;
      border-radius: var(--vt-radius-md, 10px);
    }

    .foto__marco:disabled {
      cursor: progress;
    }

    .foto__marco img {
      display: block;
      width: 100%;
      max-height: 320px;
      object-fit: cover;
    }

    .foto__espera {
      display: grid;
      place-items: center;
      min-height: 120px;
      padding: 1rem;
      font-size: 0.8rem;
      opacity: 0.75;
    }

    .foto__pie {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      justify-content: space-between;
      margin-top: 0.25rem;
      font-size: 0.72rem;
      opacity: 0.85;
    }

    .foto__datos {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .foto__bajar {
      flex: none;
      padding: 0.1rem 0.45rem;
      font: inherit;
      font-size: 0.72rem;
      color: inherit;
      cursor: pointer;
      background: transparent;
      border: 1px solid currentcolor;
      border-radius: var(--vt-radius-sm);
      opacity: 0.8;
    }
  `,
})
export class FotoDeChatComponent {
  private readonly api = inject(ChatApi);

  readonly adjunto = input.required<AdjuntoDeMensaje>();

  /** Si la burbuja es propia: el pie hereda el color de encima. */
  readonly mia = input(false);

  /** Verla en grande. Sale con una dirección recién pedida. */
  readonly ver = output<{ adjunto: AdjuntoDeMensaje; url: string }>();

  readonly descargar = output<AdjuntoDeMensaje>();

  readonly url = signal('');
  readonly cargando = signal(true);
  readonly fallo = signal(false);

  constructor() {
    void this.pedir();
  }

  /** «foto.jpg · JPG · 1,2 MB». */
  descripcion(): string {
    const a = this.adjunto();
    return [a.nombre, propiedadesDe(a)].filter(Boolean).join(' · ');
  }

  async pedir(): Promise<void> {
    this.cargando.set(true);
    this.fallo.set(false);

    try {
      const url = await this.direccion();
      this.url.set(url);
      this.fallo.set(!url);
    } catch {
      this.fallo.set(true);
    } finally {
      this.cargando.set(false);
    }
  }

  async abrir(): Promise<void> {
    try {
      this.ver.emit({ adjunto: this.adjunto(), url: await this.direccion(true) });
    } catch {
      this.fallo.set(true);
    }
  }

  /**
   * La imagen no cargó: la firma caducó con la foto en pantalla, o se fue la
   * red. Se pasa a fallo, que al pulsar pide otra dirección. Sin esto la foto
   * quedaba rota hasta cambiar de sala.
   */
  seRompio(): void {
    direcciones.delete(this.adjunto().id);
    this.fallo.set(true);
  }

  private async direccion(fresca = false): Promise<string> {
    const id = this.adjunto().id;
    const guardada = direcciones.get(id);

    if (!fresca && guardada && guardada.hasta > Date.now()) return guardada.url;

    const { url } = await this.api.direccionDe(id);
    direcciones.set(id, { url, hasta: Date.now() + VALEN_MS });

    return url;
  }
}
