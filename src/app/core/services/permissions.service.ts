import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import { resolveCatalogOwnerId } from '../config/company-rules';
import {
  RolePermissionRepository,
  UserConfigRepository,
} from '../repositories/entity.repositories';
import { AuthService } from './auth.service';

/**
 * Roles que no pueden tocar ubicaciones ni activos.
 *
 * Son los mismos que la app: la restricción no distingue entre ubicación y
 * activo, y por eso un rol que no puede crear una sede tampoco puede crear un
 * equipo dentro de ella — un activo sin sede no significa nada.
 */
const NO_ENTITIES = new Set([41, 44]);

/** Roles que no pueden crear ni editar ítems de listas. */
const NO_LISTS = new Set([39, 41]);

/**
 * Compañía con una regla propia sobre los ítems de lista.
 *
 * Además del rol, mira si su módulo está encendido en la configuración que baja
 * del servidor. Es una excepción de una sola compañía, y así está también en la
 * app: no hay un mecanismo general detrás.
 */
const COMPANY_WITH_LIST_MODULE = 2030;

/** Cómo se llama ese módulo en la configuración. El nombre es el dato. */
const LIST_MODULE = 'CREAR LISTAS EN FORMULARIOS';

/**
 * Qué puede hacer el usuario según su rol.
 *
 * ## Por qué por rol y no por permiso suelto
 *
 * El servidor manda los dos: el identificador del rol y una lista de permisos
 * por módulo. Estas restricciones concretas van por rol porque así están
 * definidas en la plataforma y así las aplica la app — moverlas a permisos
 * sueltos aquí las haría diferir entre los dos clientes, y el mismo usuario
 * podría crear desde el navegador lo que el teléfono le prohíbe.
 *
 * ## Crear, editar y eliminar van juntos
 *
 * Quien no puede crear una ubicación tampoco puede modificarla ni borrarla. Es
 * lo que pide la operación: la restricción existe para que el catálogo lo
 * gobierne la plataforma, y permitir editar dejaría abierta justo la puerta que
 * cierra.
 *
 * ## Mientras no se sabe, se permite
 *
 * El rol se lee de la base local y puede tardar un instante. Bloquear por
 * defecto haría parpadear los botones en cada carga —y dejaría sin trabajar a
 * quien sí tiene permiso si la lectura falla—. Lo que de verdad protege el dato
 * es el servidor; esto es la interfaz.
 */
@Injectable({ providedIn: 'root' })
export class PermissionsService {
  private readonly roles = inject(RolePermissionRepository);
  private readonly configs = inject(UserConfigRepository);
  private readonly auth = inject(AuthService);

  /** Rol del usuario. `null` mientras no se ha leído. */
  private readonly roleId = signal<number | null>(null);

  readonly canCreateLocations = computed(() => !this.restricted(NO_ENTITIES));
  readonly canEditLocations = this.canCreateLocations;
  readonly canDeleteLocations = this.canCreateLocations;

  /** Un activo cuelga de una sede: quien no gobierna una, no gobierna el otro. */
  readonly canCreateAssets = this.canCreateLocations;
  readonly canEditAssets = this.canCreateLocations;
  readonly canDeleteAssets = this.canCreateLocations;

  /**
   * El módulo de listas de la compañía 2030.
   *
   * `null` mientras no se sabe —o siempre, para el resto de compañías—, que no
   * es lo mismo que «apagado»: sin configuración descargada se permite, igual
   * que con el rol.
   */
  private readonly listModule = signal<boolean | null>(null);

  readonly canCreateListItems = computed(
    () => !this.restricted(NO_LISTS) && this.listModule() !== false,
  );

  /**
   * Editar usa la misma condición que crear.
   *
   * Son dos nombres porque son dos decisiones distintas para quien lee el
   * código, pero la plataforma no las separa: quien puede dar de alta un ítem
   * puede corregirlo.
   */
  readonly canEditListItems = this.canCreateListItems;

  /** Por qué no se puede, para enseñarlo donde el botón estaría. */
  readonly entitiesReason = computed(() =>
    this.canCreateLocations()
      ? ''
      : 'Tu rol no permite crear ni modificar ubicaciones y activos.',
  );

  readonly listsReason = computed(() => {
    if (this.canCreateListItems()) return '';

    return this.listModule() === false
      ? 'La creación de ítems de listas está desactivada para tu compañía.'
      : 'Tu rol no permite crear ítems de listas.';
  });

  constructor() {
    effect(() => {
      const user = this.auth.currentUser();
      untracked(() => void this.load(user?.UserID));
    });
  }

  private async load(userId: string | undefined): Promise<void> {
    if (!userId) {
      this.roleId.set(null);
      return;
    }

    try {
      const permissions = await this.roles.findByUser(String(userId));
      this.roleId.set(permissions[0]?.RoleID ?? null);
    } catch (error) {
      console.error('[Permisos] no se pudo leer el rol', error);
      this.roleId.set(null);
    }

    await this.loadListModule();
  }

  /** La regla de módulo, solo para la compañía que la tiene. */
  private async loadListModule(): Promise<void> {
    const user = this.auth.currentUser();

    if (!user || Number(user.CompanyID) !== COMPANY_WITH_LIST_MODULE) {
      this.listModule.set(null);
      return;
    }

    try {
      this.listModule.set(
        await this.configs.isModuleActive(resolveCatalogOwnerId(user), LIST_MODULE),
      );
    } catch (error) {
      console.error('[Permisos] no se pudo leer la configuración de módulos', error);
      this.listModule.set(null);
    }
  }

  private restricted(roles: ReadonlySet<number>): boolean {
    const role = this.roleId();
    return role !== null && roles.has(role);
  }
}
