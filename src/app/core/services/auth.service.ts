import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { LoginResponse, LoginUserData, User, fullName, initials } from '../models/user.model';
import { RolePermissionRepository } from '../repositories/entity.repositories';
import { UserRepository } from '../repositories/user.repository';
import { ApiError, ApiService } from './api.service';
import { CompanyLogoService } from './company-logo.service';
import { ConnectivityService } from './connectivity.service';
import { DeviceService } from './device.service';

/** Resultado de un intento de inicio de sesión. */
export interface LoginResult {
  success: boolean;
  /** Mensaje para el usuario cuando falla. */
  message?: string;
  /** true si entró con credenciales guardadas por no haber conexión. */
  offline?: boolean;
}

/**
 * Autenticación y sesión activa.
 *
 * ## Inicio de sesión sin conexión
 *
 * Una aplicación que debe funcionar en campo no puede exigir internet para
 * entrar: sería inútil justamente cuando más se necesita. Por eso, si el
 * servidor no responde y esa cuenta ya inició sesión antes en este navegador
 * con las mismas credenciales, se abre la sesión con los datos locales.
 *
 * ## Sobre guardar la contraseña
 *
 * Para poder validar el acceso offline hay que conservar la credencial, igual
 * que hace la app móvil. Queda en IndexedDB, aislada por origen y no accesible
 * desde otro sitio. Aun así es información sensible: si en el futuro se quiere
 * endurecer, el camino es guardar un hash con `crypto.subtle` en vez del texto
 * plano, y comparar contra el hash. Se documenta aquí para que la decisión sea
 * explícita y no un descuido.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(ApiService);
  private readonly users = inject(UserRepository);
  private readonly roles = inject(RolePermissionRepository);
  private readonly device = inject(DeviceService);
  private readonly connectivity = inject(ConnectivityService);
  private readonly logo = inject(CompanyLogoService);

  /** Usuario con sesión abierta. `null` si no hay ninguna. */
  readonly currentUser = signal<User | null>(null);

  /** true mientras se procesa un inicio de sesión. */
  readonly isAuthenticating = signal(false);

  /** Hay sesión abierta. */
  readonly isAuthenticated = computed(() => this.currentUser() !== null);

  /** Nombre completo del usuario activo. */
  readonly displayName = computed(() => {
    const user = this.currentUser();
    return user ? fullName(user) : '';
  });

  /** Iniciales para el avatar. */
  readonly userInitials = computed(() => {
    const user = this.currentUser();
    return user ? initials(user) : '?';
  });

  /** ID del usuario activo, o cadena vacía. Útil para consultar repositorios. */
  readonly currentUserId = computed(() => this.currentUser()?.UserID ?? '');

  /**
   * Recupera la sesión guardada al arrancar la aplicación.
   *
   * Devuelve `true` si había una sesión abierta.
   */
  async restoreSession(): Promise<boolean> {
    const user = await this.users.getActiveSession();

    if (user) {
      this.currentUser.set(user);
      void this.loadCompanyLogo(user.CompanyID, user.UserID);
      return true;
    }

    this.currentUser.set(null);
    return false;
  }

  /**
   * Deja el logo de la compañía disponible.
   *
   * Primero lo pinta desde el almacenamiento local —instantáneo y sin red— y
   * después, si hay conexión, comprueba contra el servidor si cambió. Así el
   * logo aparece de inmediato al recargar la página y se actualiza solo cuando
   * la empresa lo cambia.
   *
   * No se espera a que termine: es información decorativa y no debe retrasar
   * la entrada a la aplicación.
   */
  private async loadCompanyLogo(companyId: number, userId: string): Promise<void> {
    if (!companyId) return;

    try {
      await this.logo.loadFromCache(companyId, userId);
      if (this.connectivity.isOnline()) {
        await this.logo.refresh(companyId, userId);
      }
    } catch (error) {
      console.warn('[Auth] No se pudo cargar el logo de la compañía', error);
    }
  }

  /**
   * Inicia sesión.
   *
   * Intenta contra el servidor; si no hay conexión, cae al modo offline con las
   * credenciales guardadas.
   */
  async login(login: string, password: string): Promise<LoginResult> {
    const cleanLogin = login.trim().toLowerCase();

    if (!cleanLogin || !password) {
      return { success: false, message: 'Escribe tu usuario y contraseña.' };
    }

    this.isAuthenticating.set(true);

    try {
      const response = await firstValueFrom(
        this.api.get<LoginResponse>('/loginTemp', {
          user: cleanLogin,
          password,
          deviceid: this.device.getDeviceId(),
        }),
      );

      // El backend entrega los datos en `response`; se acepta `body` por
      // compatibilidad con despliegues antiguos.
      const data = response?.response ?? response?.body;

      if (!response?.status || !data) {
        return {
          success: false,
          message:
            response?.message ??
            response?.error ??
            'Usuario o contraseña incorrectos.',
        };
      }

      const user = await this.persistFromResponse(cleanLogin, password, data);
      this.currentUser.set(user);

      // Los permisos definen qué secciones ve el usuario. Si falla, no se
      // bloquea el acceso: se entra sin permisos y el menú muestra lo básico.
      try {
        await this.savePermissions(user.UserID, data);
      } catch (error) {
        console.warn('[Auth] No se pudieron guardar los permisos', error);
      }

      // El logo se trae en segundo plano: la aplicación no espera por él.
      void this.loadCompanyLogo(user.CompanyID, user.UserID);

      return { success: true };
    } catch (error) {
      const apiError = error as ApiError;

      // Sin conexión: se intenta validar contra lo que hay guardado.
      if (apiError?.isNetworkError) {
        const offline = await this.loginOffline(cleanLogin, password);
        if (offline.success) return offline;

        return {
          success: false,
          message:
            'No hay conexión con el servidor y esta cuenta no ha iniciado sesión antes en este dispositivo.',
        };
      }

      return {
        success: false,
        message: apiError?.message ?? 'No se pudo iniciar sesión.',
      };
    } finally {
      this.isAuthenticating.set(false);
    }
  }

  /**
   * Entra con las credenciales guardadas cuando no hay servidor.
   *
   * Exige que la contraseña coincida con la de la última sesión correcta: sin
   * esa comprobación, cualquiera podría entrar a la cuenta de otro simplemente
   * desconectando la red.
   */
  private async loginOffline(login: string, password: string): Promise<LoginResult> {
    const stored = await this.users.findByLogin(login);

    if (!stored) return { success: false };
    if (stored.Password !== password) {
      return { success: false, message: 'Usuario o contraseña incorrectos.' };
    }

    const user = await this.users.upsertAndActivate(stored);
    this.currentUser.set(user);

    return { success: true, offline: true };
  }

  /** Guarda la cuenta que devolvió el backend y la deja activa. */
  private async persistFromResponse(
    login: string,
    password: string,
    data: LoginUserData,
  ): Promise<User> {
    const user: User = {
      UserID: String(data.ID ?? ''),
      GUID: data.GUID ?? '',
      CompanyID: Number(data.CompanyID ?? 0),
      FirstName: data.FirstName ?? '',
      LastName: data.LastName ?? '',
      Email: data.Email ?? '',
      Login: login,
      Password: password,
      Token: data.AccessToken ?? '',
      UTCCode: data.UTCCode ?? '',
      DefaultLanguage: data.DefaultLanguage ?? 'es',
      GroupID: Number(data.GroupID ?? 0),
      DivisionID: Number(data.DivisionID ?? 0),
      // `Active` puede llegar como booleano, número o texto según el
      // procedimiento; se normaliza a '1' / '0' para guardarlo siempre igual.
      Active: this.normalizeActive(data.Active),
      WorkZoneID: data.WorkZoneID ?? null,
      apiref1: '',
      Session: '1',
      StatusID: String(data.StatusID ?? ''),
      Phone: String(data.Phone ?? ''),
      DeviceID: this.device.getDeviceId(),
    };

    return this.users.upsertAndActivate(user);
  }

  /**
   * Entra a una cuenta con la sesión que entrega un teléfono vinculado.
   *
   * Es el único camino que crea sesión sin contraseña, y existe porque **la
   * cuenta ya está autenticada en el teléfono**: lo que viaja es esa
   * autenticación, no una credencial nueva. Quien la entrega tuvo que escanear
   * un código de un solo uso y aceptar viendo a qué equipo se la daba.
   *
   * Se toman los campos con los mismos valores por omisión que el login normal:
   * lo que el teléfono no traiga no puede quedar en `undefined`, o la cuenta
   * quedaría a medias y fallaría más adelante sin decir por qué.
   */
  async adoptFromLink(record: Record<string, unknown>): Promise<User> {
    const text = (value: unknown, fallback = '') =>
      value === undefined || value === null ? fallback : String(value);

    const user: User = {
      UserID: text(record['UserID']),
      GUID: text(record['GUID']),
      Login: text(record['Login']).trim().toLowerCase(),
      // El teléfono guarda el nombre en `Name`; aquí la columna es `FirstName`.
      FirstName: text(record['FirstName'], text(record['Name'])),
      LastName: text(record['LastName']),

      /**
       * La contraseña no viaja.
       *
       * El teléfono no la guarda en claro y aquí no hace ninguna falta: la
       * sesión ya está creada. Queda vacía a propósito — al cerrar sesión habrá
       * que entrar como siempre.
       */
      Password: '',
      UTCCode: text(record['UTCCode']),
      Email: text(record['Email']),
      CompanyID: Number(record['CompanyID'] ?? 0),
      Token: text(record['Token']),
      DefaultLanguage: text(record['DefaultLanguage'], 'es'),
      GroupID: Number(record['GroupID'] ?? 0),
      DivisionID: Number(record['DivisionID'] ?? 0),
      Active: this.normalizeActive(record['Active']),
      WorkZoneID: record['WorkZoneID'] === undefined ? null : Number(record['WorkZoneID']),
      apiref1: '',
      Session: '1',
      StatusID: text(record['StatusID']),
      Phone: text(record['Phone']),

      // El identificador es **el de este navegador**, no el del teléfono: son
      // dos equipos distintos y la sincronización los distingue por aquí.
      DeviceID: this.device.getDeviceId(),
    };

    if (!user.UserID || !user.Login) {
      throw new Error('La sesión que llegó del teléfono está incompleta.');
    }

    const saved = await this.users.upsertAndActivate(user);
    this.currentUser.set(saved);

    return saved;
  }

  /** Convierte el `Active` del backend a '1' / '0'. */
  private normalizeActive(value: unknown): string {
    if (value === true || value === 1 || value === '1') return '1';
    if (typeof value === 'string' && value.toLowerCase() === 'true') return '1';
    if (value === undefined || value === null) return '1';
    return value === false || value === 0 || value === '0' ? '0' : '1';
  }

  /** Reemplaza los permisos del usuario con los que llegaron en el login. */
  private async savePermissions(userId: string, data: LoginUserData): Promise<void> {
    const permissions = data.permissions ?? [];

    await this.roles.replaceForUser(
      userId,
      permissions.map((p) => ({
        UserID: userId,
        RoleID: Number(data.RoleID ?? 0),
        RoleName: String(data.RoleName ?? ''),
        RoleCode: String(data.RoleCode ?? ''),
        ModuleKey: p.moduleKey,
        PermissionCode: p.permissionCode,
      })),
    );
  }

  /**
   * Cierra la sesión SIN borrar los datos locales.
   *
   * Se conservan a propósito: puede haber actividades sin sincronizar, y
   * borrarlas al salir las perdería para siempre. Para eliminarlas de verdad
   * está la opción de quitar la cuenta del dispositivo.
   */
  async logout(): Promise<void> {
    await this.users.closeSession();
    this.currentUser.set(null);
    this.logo.clear();
  }

  /**
   * Vuelve a traer el logo de la compañía desde el servidor.
   *
   * Lo usa el botón del perfil. Devuelve `true` si al terminar hay logo.
   */
  async refreshCompanyLogo(): Promise<boolean> {
    const user = this.currentUser();
    if (!user?.CompanyID) return false;

    return this.logo.refresh(user.CompanyID, user.UserID);
  }

  /** Cambia a otra cuenta ya guardada, sin pedir credenciales. */
  async switchAccount(login: string): Promise<boolean> {
    const user = await this.users.switchTo(login);
    if (!user) return false;

    this.currentUser.set(user);
    return true;
  }

  /** Cuentas disponibles en este navegador. */
  async listAccounts(): Promise<User[]> {
    return this.users.listAccounts();
  }

  /**
   * Renueva el token en segundo plano usando las credenciales guardadas.
   *
   * Sirve cuando el backend responde 401 por token expirado y el usuario está
   * a mitad de una tarea. Devuelve si se logró.
   */
  async refreshToken(): Promise<boolean> {
    const user = this.currentUser();
    if (!user || this.connectivity.isOffline()) return false;

    try {
      const response = await firstValueFrom(
        this.api.get<LoginResponse>('/loginTemp', {
          user: user.Login,
          password: user.Password,
          deviceid: this.device.getDeviceId(),
        }),
      );

      const token = (response?.response ?? response?.body)?.AccessToken;
      if (!response?.status || !token) return false;

      await this.users.updateToken(user.UserID, token);
      this.currentUser.set({ ...user, Token: token });

      return true;
    } catch {
      return false;
    }
  }
}
