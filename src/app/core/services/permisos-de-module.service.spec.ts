import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncService } from '../sync/sync.service';
import { AuthService } from './auth.service';
import { PermissionsService } from './permissions.service';
import {
  PERMISO_SEGUIMIENTO_GEOCERCAS,
  PermisosDeModuleService,
} from './permisos-de-module.service';

/**
 * El chequeo estricto de los permisos de Module.
 *
 * Lo que se fija aquí es la diferencia con `PermissionsService`: allí «no sé»
 * deja pasar; aquí no. Una clave vale solo si Module la dio (o si es
 * superadministrador), y un Module caído no puede encender nada.
 */
describe('Los permisos de Module', () => {
  const usuario = signal<any>(null);
  const superadmin = signal(false);
  let respuestas: (() => Promise<Response>)[];
  let fetchFalso: ReturnType<typeof vi.fn>;

  const conClaves = (...claves: string[]) => () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          status: true,
          permissions: claves.map((moduleKey) => ({ moduleKey, permissionCode: 'R' })),
        }),
        { status: 200 },
      ),
    );

  function crear(): PermisosDeModuleService {
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: { currentUser: usuario } },
        { provide: SyncService, useValue: { state: signal({ phase: 'idle' }) } },
        { provide: PermissionsService, useValue: { isSuperAdmin: superadmin } },
      ],
    });
    return TestBed.inject(PermisosDeModuleService);
  }

  beforeEach(() => {
    localStorage.clear();
    usuario.set(null);
    superadmin.set(false);
    respuestas = [];
    fetchFalso = vi.fn(() => (respuestas.shift() ?? (() => Promise.reject(new Error('sin red'))))());
    vi.stubGlobal('fetch', fetchFalso);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  it('sin sesión, no', () => {
    const permisos = crear();
    TestBed.tick();

    expect(permisos.seguimientoGeocercas()).toBe(false);
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it('mientras Module no contesta, no: la clave ausente no se deja pasar', async () => {
    let contestar!: (r: Response) => void;
    respuestas.push(() => new Promise<Response>((r) => (contestar = r)));

    const permisos = crear();
    usuario.set({ UserID: '7', Token: 't' });
    TestBed.tick();

    expect(permisos.conocidos()).toBe(false);
    expect(permisos.seguimientoGeocercas()).toBe(false);

    contestar(await conClaves(PERMISO_SEGUIMIENTO_GEOCERCAS)());
    await permisos.listo();

    expect(permisos.seguimientoGeocercas()).toBe(true);
  });

  it('pregunta a /permissions/de-campo con el token de la sesión', async () => {
    respuestas.push(conClaves());
    const permisos = crear();
    usuario.set({ UserID: '7', Token: 'abc' });
    TestBed.tick();
    await permisos.listo();

    const [url, opciones] = fetchFalso.mock.calls[0];
    expect(String(url)).toMatch(/\/permissions\/de-campo$/);
    expect(opciones.headers.Authorization).toBe('Bearer abc');
  });

  it('con Module caído y sin nada guardado, no', async () => {
    const permisos = crear();
    usuario.set({ UserID: '7', Token: 't' });
    TestBed.tick();
    await permisos.listo();

    expect(permisos.seguimientoGeocercas()).toBe(false);
  });

  it('Module contestó sin la clave: no', async () => {
    respuestas.push(conClaves('LOCATOR_TRACKING'));
    const permisos = crear();
    usuario.set({ UserID: '7', Token: 't' });
    TestBed.tick();
    await permisos.listo();

    expect(permisos.conocidos()).toBe(true);
    expect(permisos.seguimientoGeocercas()).toBe(false);
    expect(permisos.tiene('LOCATOR_TRACKING')()).toBe(true);
  });

  it('el superadministrador la tiene aunque Module no conteste', () => {
    superadmin.set(true);
    const permisos = crear();
    TestBed.tick();

    expect(permisos.seguimientoGeocercas()).toBe(true);
  });

  it('al quitársela en Module, la siguiente pregunta la apaga', async () => {
    respuestas.push(conClaves(PERMISO_SEGUIMIENTO_GEOCERCAS), conClaves());
    const permisos = crear();
    usuario.set({ UserID: '7', Token: 't' });
    TestBed.tick();
    await permisos.listo();
    expect(permisos.seguimientoGeocercas()).toBe(true);

    await permisos.refrescar();
    expect(permisos.seguimientoGeocercas()).toBe(false);
  });

  it('un 403 es «ninguna», no «como estaba»', async () => {
    respuestas.push(
      conClaves(PERMISO_SEGUIMIENTO_GEOCERCAS),
      () => Promise.resolve(new Response('', { status: 403 })),
    );
    const permisos = crear();
    usuario.set({ UserID: '7', Token: 't' });
    TestBed.tick();
    await permisos.listo();

    await permisos.refrescar();
    expect(permisos.seguimientoGeocercas()).toBe(false);
  });

  it('sin red se queda con lo último que dijo Module, también tras recargar', async () => {
    respuestas.push(conClaves(PERMISO_SEGUIMIENTO_GEOCERCAS));
    const primera = crear();
    usuario.set({ UserID: '7', Token: 't' });
    TestBed.tick();
    await primera.listo();
    TestBed.resetTestingModule();

    // Otra carga de la pestaña, sin red: lo guardado de esa persona.
    const segunda = crear();
    TestBed.tick();
    expect(segunda.seguimientoGeocercas()).toBe(true);
    await segunda.listo();
    expect(segunda.seguimientoGeocercas()).toBe(true);
  });

  it('al cerrar sesión se apaga en el acto', async () => {
    respuestas.push(conClaves(PERMISO_SEGUIMIENTO_GEOCERCAS));
    const permisos = crear();
    usuario.set({ UserID: '7', Token: 't' });
    TestBed.tick();
    await permisos.listo();

    usuario.set(null);
    TestBed.tick();
    expect(permisos.seguimientoGeocercas()).toBe(false);
  });

  it('lo de una cuenta no vale para otra', async () => {
    respuestas.push(conClaves(PERMISO_SEGUIMIENTO_GEOCERCAS));
    const permisos = crear();
    usuario.set({ UserID: '7', Token: 't' });
    TestBed.tick();
    await permisos.listo();

    usuario.set({ UserID: '8', Token: 'u' });
    TestBed.tick();
    expect(permisos.seguimientoGeocercas()).toBe(false);
  });
});
