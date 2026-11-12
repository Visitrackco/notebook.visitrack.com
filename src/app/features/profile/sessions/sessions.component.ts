import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { SessionsApi, UserSession } from '../../../core/services/sessions.api';
import { ToastService } from '../../../core/services/toast.service';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { localeActual, traducir } from '../../../core/i18n/idioma.service';
import { TPipe } from '../../../core/i18n/t.pipe';

/** Lo que se está intentando cerrar. */
type Target = { sessionId?: number; others?: boolean; label: string } | null;

/**
 * Dónde tiene sesión abierta el usuario, y cómo cerrarla.
 *
 * ## Por qué merece estar a la vista
 *
 * Una sesión dura treinta días y se renueva sola con el uso. Eso es cómodo —
 * nadie quiere escribir su contraseña cada mañana— pero significa que un
 * teléfono perdido, o el computador prestado de una sede, siguen entrando
 * durante un mes. La única forma de que eso no sea un problema es que la persona
 * pueda **ver dónde está abierta** y cerrarla.
 *
 * ## Cerrar pide la contraseña
 *
 * Aunque ya haya sesión válida. Echar a alguien de un equipo puede dejarlo sin
 * sincronizar en mitad de una jornada de campo, y un navegador abierto un minuto
 * no debería bastar para hacerlo.
 */
@Component({
  selector: 'vt-sessions',
  standalone: true,
  imports: [FormsModule, IconComponent, TPipe],
  templateUrl: './sessions.component.html',
  styleUrl: './sessions.component.scss',
})
export class SessionsComponent {
  private readonly api = inject(SessionsApi);
  private readonly toast = inject(ToastService);

  readonly sessions = signal<UserSession[]>([]);
  readonly loading = signal(false);
  readonly working = signal(false);

  /** Sesión que se va a cerrar, con la contraseña pedida. */
  readonly target = signal<Target>(null);
  readonly password = signal('');
  readonly error = signal('');

  readonly others = computed(() => this.sessions().filter((s) => !s.isCurrent));

  constructor() {
    void this.reload();
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    this.sessions.set(await this.api.list());
    this.loading.set(false);
  }

  // ── Cierre ────────────────────────────────────────────────────────────────

  ask(session: UserSession): void {
    this.open({ sessionId: session.ID, label: this.nameOf(session) });
  }

  askOthers(): void {
    const count = this.others().length;

    this.open({
      others: true,
      label: count === 1 ? traducir('ses.laOtra') : traducir('ses.lasOtras', { n: count }),
    });
  }

  private open(target: Target): void {
    this.target.set(target);
    this.password.set('');
    this.error.set('');
  }

  cancel(): void {
    this.target.set(null);
    this.password.set('');
    this.error.set('');
  }

  async confirm(): Promise<void> {
    const target = this.target();

    if (!target || this.working()) return;

    if (!this.password()) {
      this.error.set(traducir('ses.escribeClave'));
      return;
    }

    this.working.set(true);
    this.error.set('');

    const result = await this.api.close(this.password(), {
      sessionId: target.sessionId,
      others: target.others,
    });

    this.working.set(false);

    if (!result.ok) {
      // El error se queda dentro del diálogo, no en un aviso flotante: quien se
      // equivocó de contraseña la va a volver a escribir ahí mismo.
      this.error.set(result.error ?? traducir('ses.noCerro'));
      return;
    }

    this.cancel();
    await this.reload();

    this.toast.success(
      result.closed === 1 ? traducir('ses.cerrada') : traducir('ses.cerradas', { n: result.closed }),
      traducir('ses.deNuevo'),
    );
  }

  // ── Presentación ──────────────────────────────────────────────────────────

  nameOf(session: UserSession): string {
    if (session.DeviceName) return session.DeviceName;

    return traducir(session.Platform === 'web' ? 'ses.unNavegador' : 'ses.unTelefono');
  }

  /** Cuándo se usó por última vez, en palabras. */
  lastSeen(session: UserSession): string {
    const raw = session.LastSeenOn ?? session.IssuedOn;

    if (!raw) return '';

    const date = new Date(raw);

    if (Number.isNaN(date.getTime())) return '';

    const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);

    if (minutes < 2) return traducir('ses.ahora');
    if (minutes < 60) return traducir('ses.haceMin', { n: minutes });

    const hours = Math.floor(minutes / 60);

    if (hours < 24) return traducir(hours === 1 ? 'ses.haceHora' : 'ses.haceHoras', { n: hours });

    const days = Math.floor(hours / 24);

    if (days < 30) return traducir(days === 1 ? 'ses.haceDia' : 'ses.haceDias', { n: days });

    return date.toLocaleDateString(localeActual(), { dateStyle: 'medium' });
  }
}
