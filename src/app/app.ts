import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { DatabaseService } from './core/database/database.service';
import { ThemeService } from './core/services/theme.service';
import { ToastsComponent } from './shared/components/toasts/toasts.component';

/**
 * Raíz de la aplicación.
 *
 * Solo hace dos cosas: alojar el router y avisar si el esquema local no puede
 * actualizarse porque hay otras pestañas abiertas con una versión anterior.
 * Sin ese aviso, la aplicación simplemente no cargaría y el usuario no tendría
 * forma de saber por qué.
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ToastsComponent],
  template: `
    @if (db.upgradeBlocked()) {
      <div class="app-blocked">
        <div class="app-blocked__card">
          <h2>Hay otra pestaña abierta</h2>
          <p>
            La aplicación necesita actualizar su almacenamiento local, pero otra pestaña de
            Visitrack lo está usando. Ciérrala y recarga esta página para continuar.
          </p>
          <button type="button" (click)="reload()">Recargar</button>
        </div>
      </div>
    }

    <router-outlet />

    <!--
      Los avisos viven aquí, en la raíz, y no dentro del shell.

      Estaban en el shell, que es el marco de las pantallas con sesión abierta.
      Un aviso emitido justo antes de salir de ahí —«tu sesión terminó», que es
      el que más importa— se creaba y desaparecía en el mismo instante, porque
      la navegación al inicio destruía el componente que lo pintaba. Aquí
      sobreviven a cualquier cambio de ruta, y además funcionan en la pantalla
      de inicio de sesión.
    -->
    <vt-toasts />
  `,
  styles: [
    `
      .app-blocked {
        position: fixed;
        inset: 0;
        z-index: 999;
        display: grid;
        place-items: center;
        padding: 20px;
        background: rgb(15 28 46 / 62%);
      }

      .app-blocked__card {
        max-width: 380px;
        padding: 28px;
        text-align: center;
        background: #fff;
        border-radius: 18px;
        box-shadow: 0 24px 60px rgb(15 28 46 / 25%);
      }

      .app-blocked__card h2 {
        margin-bottom: 10px;
        font-size: 19px;
      }

      .app-blocked__card p {
        margin-bottom: 20px;
        font-size: 14px;
        color: #5b6b80;
      }

      .app-blocked__card button {
        padding: 11px 22px;
        font-weight: 600;
        color: #fff;
        background: var(--vt-brand, #d32029);
        border: 0;
        border-radius: 12px;
      }
    `,
  ],
})
export class App {
  protected readonly db = inject(DatabaseService);

  /**
   * Se inyecta aquí para que el tema se aplique **siempre**, sin importar en
   * qué ruta arranque la aplicación.
   *
   * `providedIn: 'root'` no basta: Angular crea el servicio la primera vez que
   * alguien lo inyecta, y antes solo lo hacía la pantalla de perfil. Al recargar
   * en cualquier otra ruta nadie lo construía, así que `data-theme` nunca se
   * escribía en `<html>` y mandaba la preferencia del sistema operativo — la
   * aplicación aparecía en oscuro aunque el usuario tuviera elegido el claro.
   */
  private readonly theme = inject(ThemeService);

  protected reload(): void {
    location.reload();
  }
}
