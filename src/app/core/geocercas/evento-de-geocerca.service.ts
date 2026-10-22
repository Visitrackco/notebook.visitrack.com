import { Injectable, inject } from '@angular/core';

import { environment } from '../../../environments/environment';
import { DatabaseService } from '../database/database.service';
import { ActivityService } from '../services/activity.service';
import { AuthService } from '../services/auth.service';
import {
  Eleccion,
  EventoLocal,
  RespuestaDelServidor,
  VistaDeEvento,
  elegirVista,
  vistaDesdeLocal,
} from './evento-de-geocerca';

/** Lo que se espera al servidor antes de quedarse con lo local. */
const ESPERA_MS = 8_000;

/**
 * Trae un evento de geocerca para la pantalla de su alerta: del servidor si
 * responde, del navegador si no. La decisión vive en [elegirVista], que es pura
 * y tiene sus pruebas; aquí solo se va a buscar cada mitad.
 */
@Injectable({ providedIn: 'root' })
export class EventoDeGeocercaService {
  private readonly db = inject(DatabaseService);
  private readonly auth = inject(AuthService);
  private readonly activities = inject(ActivityService);

  async cargar(clave: string): Promise<Eleccion> {
    // Las dos a la vez: sin red, lo local no tiene por qué esperar al servidor.
    const [servidor, local] = await Promise.all([this.delServidor(clave), this.local(clave)]);
    return elegirVista(servidor, local);
  }

  /**
   * `GET /geofence-flows/eventos/:clave` en Module, con el token de la sesión.
   *
   * `fetch` directo y no `HttpClient`, por lo mismo que la subida de eventos en
   * `GeocercasService`: un 401 de Module no es motivo para cerrar la sesión.
   */
  private async delServidor(clave: string): Promise<RespuestaDelServidor> {
    const token = this.auth.currentUser()?.Token;
    if (!token) return { estado: 'sin-respuesta' };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return { estado: 'sin-respuesta' };
    }

    const corte = new AbortController();
    const reloj = setTimeout(() => corte.abort(), ESPERA_MS);
    try {
      const r = await fetch(
        `${environment.moduleUrl}/geofence-flows/eventos/${encodeURIComponent(clave)}`,
        { headers: { Authorization: `Bearer ${token}` }, signal: corte.signal },
      );
      if (r.status === 404) return { estado: 'no-existe' };
      if (!r.ok) return { estado: 'sin-respuesta' };
      const cuerpo = await r.json().catch(() => null);
      return cuerpo ? { estado: 'ok', cuerpo } : { estado: 'sin-respuesta' };
    } catch {
      return { estado: 'sin-respuesta' };
    } finally {
      clearTimeout(reloj);
    }
  }

  /** El evento en `EventosGeocerca` y su flujo en `FlujosGeocerca`, si están. */
  private async local(clave: string): Promise<VistaDeEvento | null> {
    try {
      const fila = await this.db.transaction<any[]>('EventosGeocerca', 'readonly', (tx) =>
        this.db.request<any[]>(tx.objectStore('EventosGeocerca').getAll()),
      );
      const evento = fila.find((e) => String(e?.Clave ?? e?.Payload?.clave) === clave)?.Payload as
        | EventoLocal
        | undefined;
      if (!evento) return null;

      const flujos = await this.db.transaction<any[]>('FlujosGeocerca', 'readonly', (tx) =>
        this.db.request<any[]>(tx.objectStore('FlujosGeocerca').getAll()),
      );
      let flujo: unknown = null;
      for (const f of flujos) {
        try {
          const leido = JSON.parse(String(f?.JSONMovil || '{}'));
          if (Number(leido?.id) === Number(evento.flujoId)) {
            flujo = leido;
            break;
          }
        } catch {
          // Un flujo ilegible no es el que se busca.
        }
      }

      const user = this.auth.currentUser();
      const usuario = `${user?.FirstName ?? ''} ${user?.LastName ?? ''}`.trim();

      let formulario = '';
      const surveyId = evento.contexto?.surveyId;
      if (surveyId) {
        formulario = (await this.activities.findSurvey(String(surveyId)).catch(() => null))?.Title ?? '';
      }

      return vistaDesdeLocal(evento, flujo, usuario, formulario);
    } catch (error) {
      console.warn('[Geocercas] no se pudo leer el evento local', error);
      return null;
    }
  }

  /**
   * A dónde lleva «Abrir actividad»: la actividad local si está en este
   * navegador, o su vista del historial (del servidor) si no.
   */
  async rutaDeActividad(answerGuid: string, surveyId: number | null): Promise<unknown[]> {
    const local = await this.activities.findByGuid(answerGuid).catch(() => null);
    const sid = local?.SurveyID || (surveyId ? String(surveyId) : '');
    if (local && sid) return ['/formularios', sid, 'actividad', answerGuid];
    return ['/historial', answerGuid];
  }
}
