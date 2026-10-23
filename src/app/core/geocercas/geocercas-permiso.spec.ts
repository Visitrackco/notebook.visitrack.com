import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DatabaseService } from '../database/database.service';
import { LocationRepository } from '../repositories/entity.repositories';
import { SurveyAnswerRepository } from '../repositories/survey-answer.repository';
import { ActivityService } from '../services/activity.service';
import { AuthService } from '../services/auth.service';
import { ConnectivityService } from '../services/connectivity.service';
import { PermisosDeModuleService } from '../services/permisos-de-module.service';
import { ToastService } from '../services/toast.service';
import { SyncService } from '../sync/sync.service';
import { GeocercasService } from './geocercas.service';

/**
 * Las geocercas y su permiso de Module.
 *
 * Lo que se fija es la privacidad: sin `LOCATOR_GEOFENCE_TRACKING` el navegador
 * no lee la ubicación por geocercas —ni la vigía ni los momentos—, aunque haya
 * flujos en la base local; y al perderlo, `watchPosition` se suelta en el acto.
 */
describe('Las geocercas sin el permiso de Module', () => {
  const usuario = signal<any>(null);
  const permitido = signal(false);

  const FLUJO = JSON.stringify({
    id: 1,
    activo: true,
    geocercas: [{ id: 5, nombre: 'Sede', activa: true, forma: 'CIRCLE', puntos: [] }],
    reglas: [
      { id: 'r1', cuando: 'entrar', geocercas: [5], acciones: [] },
      { id: 'r2', cuando: 'actividad-guardar', geocercas: [5], acciones: [] },
    ],
  });

  let watch: ReturnType<typeof vi.fn>;
  let clear: ReturnType<typeof vi.fn>;
  let current: ReturnType<typeof vi.fn>;
  let geolocalizacionOriginal: PropertyDescriptor | undefined;

  function crear(): GeocercasService {
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: { currentUser: usuario } },
        {
          provide: DatabaseService,
          useValue: {
            transaction: async () => [{ IsActive: 1, IsDeleted: 0, JSONMovil: FLUJO }],
            request: async () => [],
          },
        },
        { provide: SyncService, useValue: { state: signal({ phase: 'idle' }) } },
        { provide: SurveyAnswerRepository, useValue: {} },
        { provide: ActivityService, useValue: {} },
        { provide: LocationRepository, useValue: {} },
        { provide: ToastService, useValue: { show: () => {} } },
        { provide: ConnectivityService, useValue: { browserOnline: signal(false) } },
        { provide: Router, useValue: { navigate: () => Promise.resolve(true) } },
        {
          provide: PermisosDeModuleService,
          useValue: { seguimientoGeocercas: permitido, listo: () => Promise.resolve() },
        },
      ],
    });
    return TestBed.inject(GeocercasService);
  }

  /** Deja correr las promesas de la recarga (lectura de la base, etc.). */
  const esperar = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  beforeEach(() => {
    usuario.set(null);
    permitido.set(false);
    watch = vi.fn(() => 42);
    clear = vi.fn();
    current = vi.fn();
    geolocalizacionOriginal = Object.getOwnPropertyDescriptor(navigator, 'geolocation');
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { watchPosition: watch, clearWatch: clear, getCurrentPosition: current },
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    if (geolocalizacionOriginal) Object.defineProperty(navigator, 'geolocation', geolocalizacionOriginal);
    else delete (navigator as any).geolocation;
  });

  it('con flujos pero sin el permiso, no se le pide la ubicación al navegador', async () => {
    const geocercas = crear();
    usuario.set({ UserID: '7', CompanyID: 1, Token: 't' });
    TestBed.tick();
    await geocercas.recargar();
    await esperar();

    expect(watch).not.toHaveBeenCalled();
    expect(geocercas.estado()).toBe('apagada');
    expect(geocercas.visible()).toBe(false);
  });

  it('un momento de la app sin el permiso no lee el GPS', async () => {
    const geocercas = crear();
    usuario.set({ UserID: '7', CompanyID: 1, Token: 't' });
    TestBed.tick();

    await geocercas.momento('actividad-guardar', { answerGuid: 'g', surveyId: 1 });

    expect(current).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
  });

  it('con el permiso arranca la vigía; al perderlo suelta watchPosition en el acto', async () => {
    permitido.set(true);
    const geocercas = crear();
    usuario.set({ UserID: '7', CompanyID: 1, Token: 't' });
    TestBed.tick();
    await geocercas.recargar();
    await esperar();

    expect(watch).toHaveBeenCalledTimes(1);
    expect(geocercas.estado()).toBe('vigilando');
    expect(geocercas.visible()).toBe(true);

    permitido.set(false);
    // La pastilla se va sin esperar a nadie: es una señal derivada.
    expect(geocercas.visible()).toBe(false);
    TestBed.tick();
    await esperar();

    expect(clear).toHaveBeenCalledWith(42);
    expect(geocercas.estado()).toBe('apagada');
  });

  it('al recuperarlo vuelve a vigilar', async () => {
    const geocercas = crear();
    usuario.set({ UserID: '7', CompanyID: 1, Token: 't' });
    TestBed.tick();
    await esperar();
    expect(watch).not.toHaveBeenCalled();

    permitido.set(true);
    TestBed.tick();
    await esperar();

    expect(watch).toHaveBeenCalledTimes(1);
    expect(geocercas.estado()).toBe('vigilando');
  });
});
