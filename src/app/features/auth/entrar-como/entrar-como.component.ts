import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { Location } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { AuthService } from '../../../core/services/auth.service';
import { IconComponent } from '../../../shared/components/icon/icon.component';

/**
 * La puerta de «Entrar como» abierto desde Module: `#/entrar-como?pase=…`.
 *
 * Module > Configuración > Usuarios abre esta dirección en una pestaña nueva
 * con un pase firmado de un solo uso que vence al minuto. Aquí se canjea
 * (`AuthService.canjearEntrarComo`) y, si vale, se sigue a la descarga como
 * tras un inicio de sesión normal.
 *
 * Fuera del armazón y **sin guardia**: llega quien todavía no tiene sesión en
 * este navegador, o quien tiene otra: se reemplaza, como en cualquier inicio
 * de sesión. Lo que queda es una sesión normal del usuario, sin franja.
 *
 * El pase se quita de la dirección **antes** de canjearlo: no debe quedar en
 * el historial ni en la barra, aunque ya no sirva para nada después.
 */
@Component({
  selector: 'vt-entrar-como',
  standalone: true,
  imports: [IconComponent, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="ec">
      <div class="ec__caja">
        <span class="ec__marca"><vt-icon name="user" [size]="28" /></span>
        @if (error()) {
          <h1>No se pudo entrar a la cuenta</h1>
          <p class="ec__error" role="alert">{{ error() }}</p>
          <p class="ec__nota">Vuelve a Module y pulsa otra vez «Abrir en la Web».</p>
          <a class="ec__boton" routerLink="/login" [replaceUrl]="true">Ir al inicio de sesión</a>
        } @else {
          <h1>Entrando a la cuenta…</h1>
          <p class="ec__nota">Abierta desde Module por un administrador.</p>
        }
      </div>
    </main>
  `,
  styles: `
    .ec {
      display: grid;
      place-items: center;
      min-height: 100dvh;
      padding: var(--vt-space-6) var(--vt-space-4);
      background: var(--vt-surface);
    }
    .ec__caja {
      display: flex;
      flex-direction: column;
      gap: var(--vt-space-3);
      align-items: center;
      max-width: 26rem;
      text-align: center;
    }
    .ec__marca {
      display: grid;
      place-items: center;
      width: 62px;
      height: 62px;
      color: var(--vt-on-brand);
      background: var(--vt-brand-fill);
      border-radius: var(--vt-radius-xl);
    }
    h1 {
      margin: 0;
      font-size: var(--vt-text-lg);
      font-weight: 650;
      color: var(--vt-text);
    }
    .ec__nota {
      margin: 0;
      font-size: var(--vt-text-sm);
      color: var(--vt-text-muted);
    }
    .ec__error {
      margin: 0;
      padding: var(--vt-space-2) var(--vt-space-3);
      font-size: var(--vt-text-sm);
      color: var(--vt-danger);
      background: var(--vt-danger-bg);
      border-radius: var(--vt-radius);
    }
    .ec__boton {
      padding: var(--vt-space-2) var(--vt-space-4);
      color: var(--vt-on-brand);
      text-decoration: none;
      background: var(--vt-brand-fill);
      border-radius: var(--vt-radius);
    }
  `,
})
export class EntrarComoComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly location = inject(Location);

  readonly error = signal('');

  async ngOnInit(): Promise<void> {
    const pase = this.route.snapshot.queryParamMap.get('pase') ?? '';

    // Fuera de la barra y del historial antes de nada.
    this.location.replaceState('/entrar-como');

    const res = await this.auth.canjearEntrarComo(pase);

    if (!res.success) {
      this.error.set(res.message ?? 'El enlace no es válido o ya venció.');
      return;
    }

    // La cuenta es nueva en este navegador (o distinta de la que había): hay
    // que descargar sus datos, como tras un inicio de sesión. Fuera del
    // historial: volver atrás no debe repetir el canje.
    await this.router.navigate(['/cargando'], { replaceUrl: true });
  }
}
