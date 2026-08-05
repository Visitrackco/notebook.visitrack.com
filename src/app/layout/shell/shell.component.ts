import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { environment } from '../../../environments/environment';
import { NAVIGATION, NavItem } from '../../core/config/navigation';
import { AuthService } from '../../core/services/auth.service';
import { CompanyLogoService } from '../../core/services/company-logo.service';
import { ConnectivityService } from '../../core/services/connectivity.service';
import { PendingUploadService } from '../../core/sync/pending-upload.service';
import { IconComponent } from '../../shared/components/icon/icon.component';

/** Clave donde se recuerda si la barra quedó colapsada. */
const SIDEBAR_KEY = 'visitrack.sidebarCollapsed';

/**
 * Estructura de la aplicación autenticada: barra lateral, cabecera y contenido.
 *
 * La barra tiene dos comportamientos según el ancho:
 *
 *  - **Escritorio**: fija, colapsable a solo iconos. La elección se recuerda
 *    entre sesiones, porque quien trabaja a diario con la herramienta ya sabe
 *    dónde está cada cosa y prefiere el espacio.
 *  - **Móvil**: oculta, se despliega sobre el contenido y se cierra al navegar.
 */
@Component({
  selector: 'vt-shell',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, IconComponent],
  templateUrl: './shell.component.html',
  styleUrl: './shell.component.scss',
})
export class ShellComponent {
  private readonly router = inject(Router);
  private readonly pendingUploads = inject(PendingUploadService);
  readonly auth = inject(AuthService);
  readonly connectivity = inject(ConnectivityService);

  readonly navigation = NAVIGATION;

  /** Actividades en cola, para el distintivo del menú. */
  readonly pendingCount = this.pendingUploads.pendingCount;

  /** Barra reducida a iconos (solo escritorio). */
  readonly collapsed = signal(localStorage.getItem(SIDEBAR_KEY) === '1');

  /** Barra desplegada sobre el contenido (solo móvil). */
  readonly mobileOpen = signal(false);

  /** Menú de la cuenta abierto. */
  readonly accountMenuOpen = signal(false);

  readonly userName = this.auth.displayName;
  readonly userInitials = this.auth.userInitials;

  readonly userEmail = computed(() => this.auth.currentUser()?.Email ?? '');

  /** Logo de la compañía, ya resuelto a una URL de objeto. */
  readonly companyLogo = inject(CompanyLogoService).logoUrl;

  readonly appVersion = environment.appVersion;

  /**
   * Nombre para el encabezado cuando no hay logo.
   *
   * El backend no entrega el nombre de la compañía en el login, solo su ID, así
   * que se muestra el identificador. Cuando el servicio lo devuelva, basta con
   * cambiar esta línea.
   */
  readonly companyName = computed(() => {
    const id = this.auth.currentUser()?.CompanyID;
    return id ? `Compañía ${id}` : 'Visitrack';
  });

  /** Inicial de respaldo mientras el logo carga o si la empresa no tiene. */
  readonly companyInitial = computed(() => {
    const name = this.companyName();
    return name.charAt(0).toUpperCase();
  });

  constructor() {
    /**
     * El proceso de subida arranca con el armazón.
     *
     * Aquí y no en el arranque de la aplicación porque este componente solo
     * existe cuando hay sesión: lanzarlo antes intentaría subir el trabajo de
     * un usuario que todavía no se identificó.
     *
     * El temporizador sigue vivo tras cerrar sesión —el servicio es de raíz—,
     * pero cada corrida comprueba que haya usuario antes de tocar nada, así
     * que no sube el trabajo de nadie a la cuenta equivocada.
     */
    this.pendingUploads.start();
  }

  toggleSidebar(): void {
    this.collapsed.update((value) => {
      const next = !value;
      localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0');
      return next;
    });
  }

  toggleMobile(): void {
    this.mobileOpen.update((value) => !value);
  }

  closeMobile(): void {
    this.mobileOpen.set(false);
  }

  toggleAccountMenu(): void {
    this.accountMenuOpen.update((value) => !value);
  }

  closeAccountMenu(): void {
    this.accountMenuOpen.set(false);
  }

  /** Al navegar se cierra el panel móvil; en escritorio no estorba. */
  onNavigate(item: NavItem, event: Event): void {
    if (item.comingSoon) {
      event.preventDefault();
      return;
    }
    this.closeMobile();
  }

  async logout(): Promise<void> {
    this.closeAccountMenu();
    await this.auth.logout();
    await this.router.navigate(['/login']);
  }
}
