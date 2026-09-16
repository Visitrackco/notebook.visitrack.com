import { Component, OnDestroy, inject, signal } from '@angular/core';

import { FirmaGuardada } from '../../../core/models/entities.model';
import { FirmaRepository } from '../../../core/repositories/entity.repositories';
import { UserRepository } from '../../../core/repositories/user.repository';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { SignaturePadComponent } from '../../activities/form/fields/signature-pad/signature-pad.component';

/**
 * «Mis firmas», como en la aplicación.
 *
 * Se dibuja una vez, con el nombre de quien firma, y en cada actividad se
 * elige en el lienzo en vez de volver a firmar. Viven en este navegador, por
 * persona. Borrar una no toca ninguna actividad: al usarla se copió el PNG al
 * campo.
 *
 * Es la misma lista que enseña el lienzo de firma arriba del todo; aquí se
 * administra —crear, ver, quitar— sin tener que abrir una actividad.
 */
@Component({
  selector: 'vt-mis-firmas',
  standalone: true,
  imports: [IconComponent, SignaturePadComponent],
  template: `
    <div class="firmas">
      @if (lista().length) {
        <ul class="firmas__lista">
          @for (f of lista(); track f.ID) {
            <li class="firmas__una">
              <img [src]="f.url" [alt]="'Firma de ' + f.Name" />
              <span class="firmas__nombre" [title]="f.Name">{{ f.Name }}</span>
              <button
                type="button"
                class="firmas__quitar"
                (click)="quitar(f)"
                [attr.aria-label]="'Quitar la firma de ' + f.Name"
                title="Quitar de mis firmas"
              >
                <vt-icon name="trash" [size]="14" />
              </button>
            </li>
          }
        </ul>
      } @else {
        <p class="firmas__nada">
          Todavía no tienes firmas guardadas. Crea una y en cada actividad la
          eliges en vez de volver a firmar.
        </p>
      }

      <button type="button" class="firmas__nueva" (click)="dibujando.set(true)">
        <vt-icon name="pen" [size]="16" />
        Nueva firma
      </button>
    </div>

    @if (dibujando()) {
      <vt-signature-pad modo="mias" (signed)="alFirmar($event)" (cancel)="dibujando.set(false)" />
    }
  `,
  styles: `
    .firmas {
      display: flex;
      flex-direction: column;
      gap: var(--vt-space-3);
    }

    .firmas__lista {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: var(--vt-space-3);
      padding: 0;
      margin: 0;
      list-style: none;
    }

    .firmas__una {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 6px;
      align-items: center;
      padding: 10px 10px 8px;
      background: #fff;
      border: 1px solid var(--vt-rule-strong);
      border-radius: var(--vt-radius-md, 10px);
    }

    .firmas__una img {
      width: 100%;
      height: 56px;
      object-fit: contain;
    }

    .firmas__nombre {
      max-width: 100%;
      overflow: hidden;
      font-size: var(--vt-text-xs);
      color: var(--vt-text-muted);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .firmas__quitar {
      position: absolute;
      top: 4px;
      right: 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      padding: 0;
      color: var(--vt-text-muted);
      cursor: pointer;
      background: var(--vt-surface);
      border: 1px solid var(--vt-rule);
      border-radius: 50%;

      &:hover {
        color: var(--vt-danger, #c0392b);
      }
    }

    .firmas__nada {
      margin: 0;
      font-size: var(--vt-text-sm);
      color: var(--vt-text-muted);
    }

    .firmas__nueva {
      display: inline-flex;
      gap: 6px;
      align-items: center;
      align-self: flex-start;
      padding: 8px 14px;
      font: inherit;
      font-size: var(--vt-text-sm);
      font-weight: 600;
      color: var(--vt-brand);
      cursor: pointer;
      background: transparent;
      border: 1px solid var(--vt-brand);
      border-radius: var(--vt-radius-full);

      &:hover {
        background: color-mix(in srgb, var(--vt-brand) 10%, transparent);
      }
    }
  `,
})
export class MisFirmasComponent implements OnDestroy {
  private readonly firmas = inject(FirmaRepository);
  private readonly users = inject(UserRepository);

  readonly lista = signal<(FirmaGuardada & { url: string })[]>([]);
  readonly dibujando = signal(false);

  private userId = 0;

  constructor() {
    void this.cargar();
  }

  ngOnDestroy(): void {
    this.soltarUrls();
  }

  async alFirmar(firma: { blob: Blob; name: string }): Promise<void> {
    this.dibujando.set(false);
    if (!this.userId) return;

    await this.firmas.guardar(this.userId, firma.name, firma.blob);
    await this.cargar();
  }

  async quitar(f: FirmaGuardada): Promise<void> {
    if (f.ID === undefined) return;
    await this.firmas.delete(f.ID);
    await this.cargar();
  }

  private async cargar(): Promise<void> {
    try {
      const sesion = await this.users.getActiveSession();
      this.userId = Number(sesion?.UserID) || 0;
      if (!this.userId) return;

      this.soltarUrls();
      const lista = await this.firmas.deUsuario(this.userId);
      this.lista.set(lista.map((f) => ({ ...f, url: URL.createObjectURL(f.Png) })));
    } catch {
      this.lista.set([]);
    }
  }

  private soltarUrls(): void {
    for (const f of this.lista()) URL.revokeObjectURL(f.url);
  }
}
