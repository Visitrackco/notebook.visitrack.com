import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

import { environment } from '../../../../environments/environment';
import { User, fullName, initials } from '../../../core/models/user.model';
import { AuthService } from '../../../core/services/auth.service';
import { ConnectivityService } from '../../../core/services/connectivity.service';
import { DatabaseService } from '../../../core/database/database.service';

/**
 * Pantalla de acceso.
 *
 * Además de autenticar, resuelve dos situaciones propias de una aplicación que
 * funciona sin conexión:
 *
 *  - **Cuentas recordadas.** Quien ya entró antes en este navegador aparece
 *    listado y solo tiene que escribir su contraseña. En campo, con guantes o
 *    bajo el sol, escribir un correo completo es un obstáculo real.
 *  - **Aviso de modo sin conexión.** Si el servidor no responde se dice
 *    explícitamente, en vez de dejar al usuario adivinando por qué tarda.
 */
@Component({
  selector: 'vt-login',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
})
export class LoginComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly db = inject(DatabaseService);
  readonly connectivity = inject(ConnectivityService);

  readonly login = signal('');
  readonly password = signal('');
  readonly showPassword = signal(false);
  readonly rememberedAccounts = signal<User[]>([]);
  readonly errorMessage = signal('');
  readonly infoMessage = signal('');

  readonly isSubmitting = this.auth.isAuthenticating;
  readonly appVersion = environment.appVersion;

  /** Se habilita el botón solo con ambos campos escritos. */
  readonly canSubmit = computed(
    () => this.login().trim().length > 0 && this.password().length > 0 && !this.isSubmitting(),
  );

  constructor() {
    void this.initialize();
  }

  /**
   * Prepara la pantalla: abre la base, pide almacenamiento persistente y carga
   * las cuentas recordadas.
   *
   * El permiso de persistencia se pide aquí y no más adelante porque los
   * navegadores lo conceden con más facilidad tras una interacción real del
   * usuario, y sin él pueden purgar los datos locales cuando falte espacio —
   * lo que en esta aplicación significa perder actividades sin sincronizar.
   */
  private async initialize(): Promise<void> {
    try {
      await this.db.open();
      await this.db.requestPersistentStorage();

      const accounts = await this.auth.listAccounts();
      this.rememberedAccounts.set(accounts);

      // Con una sola cuenta se precarga: es el caso más común, un equipo por persona.
      if (accounts.length === 1) this.login.set(accounts[0].Login);
    } catch (error) {
      this.errorMessage.set(
        'No se pudo preparar el almacenamiento local. Revisa que el navegador permita guardar datos de este sitio.',
      );
      console.error('[Login] Error inicializando', error);
    }
  }

  /** Selecciona una cuenta recordada y pone el foco en la contraseña. */
  selectAccount(account: User): void {
    this.login.set(account.Login);
    this.password.set('');
    this.errorMessage.set('');

    queueMicrotask(() => {
      document.getElementById('password')?.focus();
    });
  }

  togglePassword(): void {
    this.showPassword.update((value) => !value);
  }

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.canSubmit()) return;

    this.errorMessage.set('');
    this.infoMessage.set('');

    const result = await this.auth.login(this.login(), this.password());

    if (!result.success) {
      this.errorMessage.set(result.message ?? 'No se pudo iniciar sesión.');
      return;
    }

    if (result.offline) {
      this.infoMessage.set('Entraste sin conexión. Se sincronizará cuando vuelva el internet.');
    }

    const redirect = this.route.snapshot.queryParamMap.get('redirect');
    await this.router.navigateByUrl(redirect ?? '/inicio');
  }

  displayName(user: User): string {
    return fullName(user) || user.Login;
  }

  avatarInitials(user: User): string {
    return initials(user);
  }
}
