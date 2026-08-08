import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { environment } from '../../../environments/environment';
import { NAVIGATION, NavItem } from '../../core/config/navigation';
import { AuthService } from '../../core/services/auth.service';
import { CompanyLogoService } from '../../core/services/company-logo.service';
import { ConnectivityService } from '../../core/services/connectivity.service';
import { PendingUploadService } from '../../core/sync/pending-upload.service';
import { DispatchCounterService } from '../../core/services/dispatch-counter.service';
import { DraftMaintenanceService } from '../../core/services/draft-maintenance.service';
import { ShortcutsService } from '../../core/services/shortcuts.service';
import { CommandPaletteComponent } from '../../shared/components/command-palette/command-palette.component';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { ShortcutsHelpComponent } from '../../shared/components/shortcuts-help/shortcuts-help.component';
import { ToastsComponent } from '../../shared/components/toasts/toasts.component';

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
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    IconComponent,
    CommandPaletteComponent,
    ShortcutsHelpComponent,
    ToastsComponent,
  ],

  host: {
    // El único escuchador de teclado de la aplicación. Repartirlo por pantallas
    // dejaría varias compitiendo por la misma tecla, y ninguna sabría si otra
    // ya la atendió.
    '(document:keydown)': 'onKey($event)',
  },
  templateUrl: './shell.component.html',
  styleUrl: './shell.component.scss',
})
export class ShellComponent {
  private readonly router = inject(Router);
  private readonly shortcuts = inject(ShortcutsService);
  private readonly dispatches = inject(DispatchCounterService);
  private readonly draftMaintenance = inject(DraftMaintenanceService);
  private readonly pendingUploads = inject(PendingUploadService);
  readonly auth = inject(AuthService);
  readonly connectivity = inject(ConnectivityService);

  readonly navigation = NAVIGATION;

  /** Actividades en cola, para el distintivo del menú. */
  readonly pendingCount = this.pendingUploads.pendingCount;

  /** Consignas por hacer, para su distintivo. */
  readonly dispatchCount = this.dispatches.pending;

  /** Hay teclado: se ofrece el botón de atajos y funcionan las teclas. */
  readonly hasKeyboard = this.shortcuts.enabled;

  /**
   * Los atajos que valen en cualquier pantalla.
   *
   * Las secuencias que empiezan por `g` («go») son las de navegación: se
   * teclean seguidas —`g` y luego `f`— y no obligan a estirar la mano hasta los
   * modificadores. Es la convención de las herramientas que se usan a diario con
   * teclado, y por eso se respeta en vez de inventar otra.
   */
  private registerShortcuts(): void {
    const go = (route: string) => () => void this.router.navigate([route]);

    this.shortcuts.registerAll([
      {
        id: 'palette',
        keys: 'ctrl+k',
        label: 'Buscar y saltar a cualquier sitio',
        group: 'General',
        run: () => this.shortcuts.togglePalette(),
      },
      {
        id: 'help',
        keys: '?',
        label: 'Ver los atajos',
        group: 'General',
        run: () => this.shortcuts.toggleHelp(),
      },
      {
        id: 'close',
        keys: 'escape',
        label: 'Cerrar lo que esté abierto',
        group: 'General',
        run: () => this.shortcuts.closeAll(),
      },
      {
        id: 'focus-search',
        keys: '/',
        label: 'Buscar en esta pantalla',
        group: 'General',

        /**
         * Enfoca el buscador de la pantalla, sea cual sea.
         *
         * Se busca en el documento en vez de que cada listado registre el suyo:
         * todos usan `type="search"`, y así el atajo funciona también en las
         * pantallas que se añadan después sin tocar nada.
         */
        run: () => {
          const field = document.querySelector<HTMLInputElement>(
            'input[type=search]:not([hidden])',
          );

          field?.focus();
          field?.select();
        },
      },
      {
        id: 'go-dispatches',
        keys: 'g c',
        label: 'Mis consignas',
        group: 'Navegación',
        run: go('/consignas'),
      },
      {
        id: 'go-forms',
        keys: 'g f',
        label: 'Formularios',
        group: 'Navegación',
        run: go('/formularios'),
      },
      {
        id: 'go-drafts',
        keys: 'g b',
        label: 'Borradores',
        group: 'Navegación',
        run: go('/borradores'),
      },
      {
        id: 'go-pending',
        keys: 'g p',
        label: 'Pendientes por subir',
        group: 'Navegación',
        run: go('/pendientes'),
      },
      {
        id: 'go-locations',
        keys: 'g u',
        label: 'Ubicaciones',
        group: 'Navegación',
        run: go('/ubicaciones'),
      },
      {
        id: 'go-sync',
        keys: 'g s',
        label: 'Sincronización',
        group: 'Navegación',
        run: go('/sincronizacion'),
      },
      {
        id: 'go-files',
        keys: 'g a',
        label: 'Archivos',
        group: 'Navegación',
        run: go('/archivos'),
      },
      {
        id: 'go-home',
        keys: 'g i',
        label: 'Inicio',
        group: 'Navegación',
        run: go('/inicio'),
      },
    ]);
  }

  onKey(event: KeyboardEvent): void {
    this.shortcuts.handle(event);
  }

  /** Abre la paleta desde el botón, para quien no conoce el atajo. */
  openPalette(): void {
    this.shortcuts.togglePalette();
  }

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

    /**
     * El mantenimiento de borradores arranca con el armazón.
     *
     * Antes solo corría al entrar al listado de actividades, y quien trabaja
     * desde otra pantalla acumulaba borradores caducados que nadie recogía.
     */
    this.draftMaintenance.start();

    this.registerShortcuts();
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
