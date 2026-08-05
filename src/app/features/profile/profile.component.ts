import { Component, inject, signal } from '@angular/core';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { Router } from '@angular/router';

import { environment } from '../../../environments/environment';
import { DatabaseService } from '../../core/database/database.service';
import { User, fullName, initials } from '../../core/models/user.model';
import { SETTING_KEYS, SettingsRepository } from '../../core/repositories/settings.repository';
import { AuthService } from '../../core/services/auth.service';
import { CompanyLogoService } from '../../core/services/company-logo.service';
import { ConnectivityService } from '../../core/services/connectivity.service';
import { DeviceService } from '../../core/services/device.service';
import { BRAND_PRESETS, ThemeMode, ThemeService } from '../../core/services/theme.service';
import { IconComponent } from '../../shared/components/icon/icon.component';

/**
 * Perfil del usuario: sus datos, el estado del almacenamiento local, las
 * preferencias y el cambio de cuenta.
 *
 * Las preferencias que afectan a los datos se guardan **por usuario**, no por
 * navegador. En la app móvil eran globales y eso produjo un problema real: la
 * configuración de una persona se le aplicaba a quien iniciara sesión después
 * en el mismo equipo, y podía hacerle perder trabajo sin que lo hubiera pedido.
 */
@Component({
  selector: 'vt-profile',
  standalone: true,
  imports: [IconComponent, MatSlideToggleModule],
  templateUrl: './profile.component.html',
  styleUrl: './profile.component.scss',
})
export class ProfileComponent {
  private readonly settings = inject(SettingsRepository);
  private readonly db = inject(DatabaseService);
  private readonly device = inject(DeviceService);
  private readonly router = inject(Router);

  readonly auth = inject(AuthService);
  readonly connectivity = inject(ConnectivityService);
  readonly theme = inject(ThemeService);

  /** Colores sugeridos para el selector de marca. */
  readonly brandPresets = BRAND_PRESETS;

  /** Opciones del modo de color. */
  readonly themeModes: { value: ThemeMode; label: string; icon: string }[] = [
    { value: 'light', label: 'Claro', icon: 'sun' },
    { value: 'dark', label: 'Oscuro', icon: 'moon' },
    { value: 'system', label: 'Automático', icon: 'refresh' },
  ];

  readonly appVersion = environment.appVersion;
  readonly deviceInfo = this.device.getDeviceInfo();
  readonly deviceId = this.device.getDeviceId();

  readonly accounts = signal<User[]>([]);
  readonly storage = signal<{ used: string; quota: string; percent: number } | null>(null);
  readonly persistentGranted = signal(false);

  /** Preferencia: conservar las actividades a medias. */
  readonly draftsEnabled = signal(true);
  /** Horas que sobrevive un borrador antes de limpiarse solo. */
  readonly draftHours = signal(12);

  readonly savingPreference = signal(false);
  readonly feedback = signal('');

  /** Logo de la compañía, para mostrarlo en el encabezado del perfil. */
  readonly companyLogo = inject(CompanyLogoService).logoUrl;
  readonly syncingLogo = signal(false);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    const userId = this.auth.currentUserId();

    this.accounts.set(await this.auth.listAccounts());

    this.draftsEnabled.set(
      (await this.settings.getUserSetting(SETTING_KEYS.DRAFT_MODE, userId, 'enabled')) !==
        'disabled',
    );
    this.draftHours.set(await this.settings.getNumber(SETTING_KEYS.DRAFT_HOURS, userId, 12));

    const estimate = await this.db.storageEstimate();
    if (estimate) {
      this.storage.set({
        used: this.formatBytes(estimate.usage),
        quota: this.formatBytes(estimate.quota),
        percent: estimate.quota > 0 ? Math.round((estimate.usage / estimate.quota) * 100) : 0,
      });
    }

    if (navigator.storage?.persisted) {
      this.persistentGranted.set(await navigator.storage.persisted());
    }
  }

  displayName(user: User): string {
    return fullName(user) || user.Login;
  }

  avatarInitials(user: User): string {
    return initials(user);
  }

  /** Activa o desactiva la conservación de borradores para ESTA cuenta. */
  async toggleDrafts(): Promise<void> {
    this.savingPreference.set(true);

    try {
      const next = !this.draftsEnabled();
      await this.settings.setUserSetting(
        SETTING_KEYS.DRAFT_MODE,
        this.auth.currentUserId(),
        next ? 'enabled' : 'disabled',
      );
      this.draftsEnabled.set(next);
      this.showFeedback('Preferencia guardada.');
    } finally {
      this.savingPreference.set(false);
    }
  }

  async changeDraftHours(event: Event): Promise<void> {
    const value = Number((event.target as HTMLInputElement).value);
    if (!Number.isFinite(value) || value < 1) return;

    this.draftHours.set(value);
    await this.settings.setNumber(SETTING_KEYS.DRAFT_HOURS, this.auth.currentUserId(), value);
    this.showFeedback('Preferencia guardada.');
  }

  /** Trae de nuevo el logo de la compañía desde el servidor. */
  async syncCompanyLogo(): Promise<void> {
    if (this.syncingLogo()) return;

    this.syncingLogo.set(true);

    try {
      const ok = await this.auth.refreshCompanyLogo();
      this.showFeedback(
        ok
          ? 'Logo actualizado.'
          : 'Tu compañía todavía no tiene un logo configurado en Visitrack.',
      );
    } catch {
      this.showFeedback('No se pudo traer el logo. Inténtalo de nuevo.');
    } finally {
      this.syncingLogo.set(false);
    }
  }

  /** Cambia entre claro, oscuro y automático. */
  setThemeMode(mode: ThemeMode): void {
    this.theme.setMode(mode);
    this.showFeedback('Apariencia actualizada.');
  }

  /** Cambia el color de marca de toda la aplicación. */
  setBrandColor(color: string): void {
    this.theme.setBrandColor(color);
    this.showFeedback('Color actualizado.');
  }

  /** Aplica el color elegido en el selector nativo. */
  onCustomColor(event: Event): void {
    this.setBrandColor((event.target as HTMLInputElement).value);
  }

  resetBrandColor(): void {
    this.theme.resetBrandColor();
    this.showFeedback('Se restauró el color original.');
  }

  /** Pide al navegador que no borre los datos locales si falta espacio. */
  async requestPersistence(): Promise<void> {
    const granted = await this.db.requestPersistentStorage();
    this.persistentGranted.set(granted);

    this.showFeedback(
      granted
        ? 'Tus datos quedaron protegidos en este navegador.'
        : 'El navegador no concedió el permiso. Puedes intentarlo de nuevo más adelante.',
    );
  }

  async switchAccount(user: User): Promise<void> {
    if (user.Login === this.auth.currentUser()?.Login) return;

    if (await this.auth.switchAccount(user.Login)) {
      await this.router.navigate(['/inicio']);
    }
  }

  async logout(): Promise<void> {
    await this.auth.logout();
    await this.router.navigate(['/login']);
  }

  private showFeedback(message: string): void {
    this.feedback.set(message);
    setTimeout(() => this.feedback.set(''), 3000);
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
}
