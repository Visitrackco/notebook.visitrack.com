import { Injectable, inject } from '@angular/core';

import { environment } from '../../../environments/environment';
import { DatabaseService } from '../database/database.service';
import { AuthService } from '../services/auth.service';
import {
  FilaDeEvento,
  FilaGuardada,
  FiltroDeEventos,
  PaginaDeEventos,
  TAM_PAGINA,
  filaDesdeLocal,
  paginaDesdeServidor,
  paginaLocal,
  sumarPendientes,
} from './eventos-de-geocerca';

/** Lo que se espera al servidor antes de quedarse con lo local. */
const ESPERA_MS = 8_000;

/**
 * Trae una página del historial de eventos de geocerca: del servidor si
 * responde, de este navegador si no. Lo que decide cada fila vive en
 * `eventos-de-geocerca.ts`, que es puro y tiene sus pruebas.
 */
@Injectable({ providedIn: 'root' })
export class EventosDeGeocercaService {
  private readonly db = inject(DatabaseService);
  private readonly auth = inject(AuthService);

  async listar(filtro: FiltroDeEventos, pagina = 1): Promise<PaginaDeEventos> {
    // Las dos a la vez: sin red, lo local no tiene por qué esperar al servidor.
    const [servidor, locales] = await Promise.all([this.delServidor(filtro, pagina), this.locales()]);
    if (servidor) return sumarPendientes(servidor, locales, filtro);
    return paginaLocal(locales, filtro, pagina);
  }

  /**
   * `GET /geofence-flows/mis-eventos` en Module, con el token de la sesión.
   *
   * `fetch` directo y no `HttpClient`, como el detalle del evento: un 401 de
   * Module no es motivo para cerrar la sesión. Cualquier cosa que no sea una
   * respuesta legible —sin red, 404 porque aún no está desplegado, error— es
   * `null`, y entonces manda lo local.
   */
  private async delServidor(filtro: FiltroDeEventos, pagina: number): Promise<PaginaDeEventos | null> {
    const token = this.auth.currentUser()?.Token;
    if (!token) return null;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;

    const q = new URLSearchParams({
      desde: filtro.desde,
      hasta: filtro.hasta,
      pagina: String(pagina),
      tam: String(TAM_PAGINA),
    });
    if (filtro.geocerca !== null) q.set('geocerca', String(filtro.geocerca));

    const corte = new AbortController();
    const reloj = setTimeout(() => corte.abort(), ESPERA_MS);
    try {
      const r = await fetch(`${environment.moduleUrl}/geofence-flows/mis-eventos?${q}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: corte.signal,
      });
      if (!r.ok) return null;
      return paginaDesdeServidor(await r.json().catch(() => null));
    } catch {
      return null;
    } finally {
      clearTimeout(reloj);
    }
  }

  /** Los eventos de quien está en `EventosGeocerca`, con el texto de su flujo. */
  private async locales(): Promise<FilaDeEvento[]> {
    const userId = this.auth.currentUser()?.UserID;
    if (!userId) return [];
    try {
      const guardadas = await this.db.transaction<FilaGuardada[]>('EventosGeocerca', 'readonly', (tx) =>
        this.db.request<FilaGuardada[]>(tx.objectStore('EventosGeocerca').index('byUserID').getAll(userId)),
      );
      const flujos = await this.db.transaction<any[]>('FlujosGeocerca', 'readonly', (tx) =>
        this.db.request<any[]>(tx.objectStore('FlujosGeocerca').getAll()),
      );
      // Se leen una vez, no una por evento.
      const jsons = flujos.map((f) => {
        try {
          return JSON.parse(String(f?.JSONMovil || '{}'));
        } catch {
          return null;
        }
      });
      return guardadas
        .map((g) => filaDesdeLocal(g, jsons))
        .filter((f): f is FilaDeEvento => !!f);
    } catch (error) {
      console.warn('[Geocercas] no se pudieron leer los eventos locales', error);
      return [];
    }
  }
}
