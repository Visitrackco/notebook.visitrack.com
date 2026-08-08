import {
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import QRCode from 'qrcode';

import { DeviceLinkService } from '../../../core/services/device-link.service';
import { IconComponent } from '../../../shared/components/icon/icon.component';

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
  imports: [FormsModule, IconComponent],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
})
export class LoginComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  // ── Entrar desde el teléfono ───────────────────────────────────────────────

  readonly link = inject(DeviceLinkService);

  /** Se está enseñando el código en vez del formulario. */
  readonly linking = signal(false);

  readonly secondsLeft = signal(0);

  private readonly qrCanvas = viewChild<ElementRef<HTMLCanvasElement>>('qr');
  private ticker?: ReturnType<typeof setInterval>;

  readonly countdown = computed(() => {
    const total = this.secondsLeft();
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  });

  /** Pide un código y lo enseña. */
  async startLink(): Promise<void> {
    this.linking.set(true);
    await this.link.start();
  }

  cancelLink(): void {
    this.link.stop();
    this.linking.set(false);
  }
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

    /**
     * Entrar pasa por la descarga, como en el teléfono.
     *
     * Una cuenta recién abierta aquí tiene la sesión y nada más: sin
     * formularios ni ubicaciones no se puede diligenciar, y la aplicación se ve
     * rota aunque esté perfecta. Antes había que ir a mano a Sincronización, y
     * quien no lo sabía entraba a una aplicación vacía.
     *
     * Sin conexión la pantalla de carga lo detecta y entra directo: quien está
     * en campo con sus datos en el equipo tiene derecho a trabajar con ellos.
     */
    const redirect = this.route.snapshot.queryParamMap.get('redirect');

    await this.router.navigate(['/cargando'], {
      queryParams: redirect ? { redirect } : {},

      // Fuera del historial: volver atrás desde la aplicación tiene que llevar
      // a donde el usuario estaba, no a repetir una descarga ya hecha.
      replaceUrl: true,
    });
  }

  displayName(user: User): string {
    return fullName(user) || user.Login;
  }

  avatarInitials(user: User): string {
    return initials(user);
  }

  constructor() {
    void this.initialize();

    /**
     * El código se dibuja cuando llega, no cuando se pide.
     *
     * El lienzo no existe hasta que la pantalla cambia a modo código, así que
     * dibujarlo antes no pintaría nada — y tampoco daría error, que es el fallo
     * más difícil de encontrar de los dos.
     */
    effect(() => {
      const code = this.link.code();
      const canvas = this.qrCanvas()?.nativeElement;

      if (!code || !canvas) return;

      untracked(() => {
        void QRCode.toCanvas(canvas, code, {
          width: 220,
          margin: 1,
          errorCorrectionLevel: 'M',
        }).catch((error: unknown) => console.error('[Login] no se pudo dibujar el código', error));
      });
    });

    // La cuenta atrás: un código sin caducar visible en una pantalla es una
    // sesión al alcance de quien pase por detrás.
    effect(() => {
      const expires = this.link.expiresAt();

      untracked(() => {
        clearInterval(this.ticker);
        if (!expires) return;

        const tick = () => {
          const left = Math.max(0, Math.round((expires.getTime() - Date.now()) / 1000));
          this.secondsLeft.set(left);
          if (left === 0) clearInterval(this.ticker);
        };

        tick();
        this.ticker = setInterval(tick, 1000);
      });
    });

    /**
     * Terminado el traspaso, se entra.
     *
     * La sesión la creó el propio traspaso —ver `AuthService.adoptFromLink`—
     * así que aquí solo queda llevar a la aplicación.
     */
    effect(() => {
      if (this.link.state() !== 'listo') return;

      untracked(() => void this.router.navigateByUrl('/inicio'));
    });
  }
}
