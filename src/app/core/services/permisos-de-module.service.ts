import { DestroyRef, Injectable, Signal, computed, effect, inject, signal, untracked } from '@angular/core';

import { environment } from '../../../environments/environment';
import { SyncService } from '../sync/sync.service';
import { AuthService } from './auth.service';
import { PermissionsService } from './permissions.service';

/**
 * Seguir a la persona por geocercas.
 *
 * Sin esta clave el navegador no lee la ubicación para geocercas: ni la vigía
 * con `watchPosition` ni la lectura suelta de los momentos de la app.
 */
export const PERMISO_SEGUIMIENTO_GEOCERCAS = 'LOCATOR_GEOFENCE_TRACKING';

/** Cada cuánto se vuelve a preguntar, por si se lo quitaron desde Module. */
const REFRESCAR_CADA_MS = 5 * 60_000;

/** Al volver a la pestaña, no más de una pregunta por minuto. */
const AL_VOLVER_MS = 60_000;

/** Lo que contesta `GET /permissions/de-campo`: la forma de `/getUserRole`. */
interface RespuestaDeCampo {
  status?: boolean;
  permissions?: { moduleKey?: unknown; permissionCode?: unknown }[];
}

/**
 * Los permisos de quien tiene la sesión **según Module**.
 *
 * ## Por qué no basta con `PermissionsService`
 *
 * Porque son otro sistema. Los permisos del inicio de sesión salen de
 * `cloud-server` (`Modules`/`ModulePermissions`), y ahí no hay ni un
 * `LOCATOR_*`. Lo que se configura en Module vive en `cg_permissions` y solo
 * Module lo sabe leer: se le pregunta a `GET /permissions/de-campo`, la misma
 * puerta que usa el teléfono, con el token de la sesión de campo.
 *
 * ## Estricto: sin respuesta, no
 *
 * `PermissionsService` deja pasar mientras no sabe —es la interfaz, y el
 * servidor protege el dato—. Aquí es al revés: estas claves gobiernan cosas
 * que **pasan en el navegador**, como leer el GPS, y ahí nadie más protege a la
 * persona. Una clave vale solo si vino de Module (o si es superadministrador).
 * Mientras Module no haya contestado nunca, todo es «no».
 *
 * ## Lo último que se supo
 *
 * La respuesta se guarda por usuario en `localStorage`: es la web sin red, y
 * recargar la pestaña no puede apagar lo que Module sí permitió. Sigue siendo
 * una respuesta de Module, solo que de hace un rato. Si Module no contesta
 * (sin red, caído, sin la puerta) se conserva; si dice que esta sesión no
 * puede preguntar (401/403), se toma como «ninguna».
 */
@Injectable({ providedIn: 'root' })
export class PermisosDeModuleService {
  private readonly auth = inject(AuthService);
  private readonly sync = inject(SyncService);
  private readonly permisos = inject(PermissionsService);

  /** Las claves que dio Module. `null` mientras no ha contestado nunca. */
  private readonly claves = signal<ReadonlySet<string> | null>(null);

  /** Si Module ya contestó alguna vez para quien tiene la sesión. */
  readonly conocidos = computed(() => this.claves() !== null);

  /** Seguir por geocercas: vigía, momentos e historial. */
  readonly seguimientoGeocercas: Signal<boolean>;

  private readonly porClave = new Map<string, Signal<boolean>>();
  private usuario = '';
  private generacion = 0;
  private enCurso: Promise<void> | null = null;
  private ultimaPregunta = 0;

  constructor() {
    this.seguimientoGeocercas = this.tiene(PERMISO_SEGUIMIENTO_GEOCERCAS);

    // Con cada sesión, lo suyo: iniciar, cambiar de cuenta, «entrar como», cerrar.
    effect(() => {
      const id = String(this.auth.currentUser()?.UserID ?? '');
      untracked(() => this.cambiarDeUsuario(id));
    });

    // Al terminar cada sincronización, como los flujos: pudieron cambiarle el rol.
    const fase = computed(() => this.sync.state().phase);
    effect(() => {
      if (fase() !== 'done') return;
      untracked(() => void this.refrescar());
    });

    const reloj = setInterval(() => void this.refrescar(), REFRESCAR_CADA_MS);
    const alVolver = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - this.ultimaPregunta < AL_VOLVER_MS) return;
      void this.refrescar();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', alVolver);

    inject(DestroyRef).onDestroy(() => {
      clearInterval(reloj);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', alVolver);
    });
  }

  /**
   * Si tiene la clave, como señal. Estricto: falso mientras Module no conteste.
   *
   * Se guarda una señal por clave para que pedirla en una plantilla no cree
   * una nueva en cada pasada.
   */
  tiene(clave: string): Signal<boolean> {
    let s = this.porClave.get(clave);
    if (!s) {
      s = computed(() => this.permisos.isSuperAdmin() || this.claves()?.has(clave) === true);
      this.porClave.set(clave, s);
    }
    return s;
  }

  /**
   * Espera a la pregunta en curso, si hay una. Para quien tiene que decidir
   * ya —un guardia, un momento de la app— y no quiere decidir con «aún no sé».
   */
  async listo(maxMs = 8_000): Promise<void> {
    const enCurso = this.enCurso;
    if (!enCurso) return;
    let reloj: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([enCurso, new Promise<void>((r) => (reloj = setTimeout(r, maxMs)))]);
    } finally {
      if (reloj) clearTimeout(reloj);
    }
  }

  /** Le vuelve a preguntar a Module. No falla nunca: lo peor es quedarse como estaba. */
  refrescar(): Promise<void> {
    const user = this.auth.currentUser();
    const id = String(user?.UserID ?? '');
    const token = user?.Token ?? '';
    if (!id || !token) return Promise.resolve();

    const generacion = this.generacion;
    this.ultimaPregunta = Date.now();

    const pregunta = this.preguntar(token)
      .then((claves) => {
        // Mientras viajaba cambió la sesión: esto ya no es de nadie.
        if (generacion !== this.generacion || id !== this.usuario) return;
        if (claves === undefined) return;
        this.claves.set(claves);
        this.guardar(id, claves);
      })
      .finally(() => {
        if (this.enCurso === pregunta) this.enCurso = null;
      });

    this.enCurso = pregunta;
    return pregunta;
  }

  private cambiarDeUsuario(id: string): void {
    if (id === this.usuario) return;

    this.generacion++;
    this.usuario = id;
    this.enCurso = null;

    // Sin sesión, nada. Con sesión, lo último que se supo de ella mientras se pregunta.
    this.claves.set(id ? this.leer(id) : null);
    if (id) void this.refrescar();
  }

  /**
   * `undefined` si no hubo respuesta que valga; un conjunto (quizá vacío) si la hubo.
   *
   * `fetch` directo y no `HttpClient`: el interceptor cerraría la sesión con
   * un 401 de Module, y no poder preguntar por un permiso no es motivo.
   */
  private async preguntar(token: string): Promise<ReadonlySet<string> | undefined> {
    const corte = new AbortController();
    const reloj = setTimeout(() => corte.abort(), 20_000);
    try {
      const respuesta = await fetch(`${environment.moduleUrl}/permissions/de-campo`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: corte.signal,
      });

      if (respuesta.status === 401 || respuesta.status === 403) return new Set();
      if (!respuesta.ok) return undefined;

      const cuerpo = (await respuesta.json().catch(() => null)) as RespuestaDeCampo | null;
      if (!cuerpo || cuerpo.status === false || !Array.isArray(cuerpo.permissions)) return undefined;

      return new Set(
        cuerpo.permissions
          .map((p) => String(p?.moduleKey ?? '').trim())
          .filter((clave) => clave.length > 0),
      );
    } catch {
      // Sin red o Module caído: se queda lo que se sabía.
      return undefined;
    } finally {
      clearTimeout(reloj);
    }
  }

  private claveDeCache(userId: string): string {
    return `visitrack.permisosModule::${userId}`;
  }

  private leer(userId: string): ReadonlySet<string> | null {
    try {
      const crudo = localStorage.getItem(this.claveDeCache(userId));
      const leido = crudo ? JSON.parse(crudo) : null;
      return Array.isArray(leido) ? new Set(leido.map(String)) : null;
    } catch {
      return null;
    }
  }

  private guardar(userId: string, claves: ReadonlySet<string>): void {
    try {
      localStorage.setItem(this.claveDeCache(userId), JSON.stringify([...claves]));
    } catch {
      // Sin almacenamiento: la próxima recarga vuelve a preguntar antes de dejar pasar.
    }
  }
}
