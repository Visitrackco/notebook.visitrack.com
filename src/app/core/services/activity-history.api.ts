import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';

import { environment } from '../../../environments/environment';
import { AuthService } from './auth.service';

/**
 * Historial de actividades de una ubicación o un activo.
 *
 * ## Por qué es una consulta en línea
 *
 * Lo que hay en el dispositivo son **mis** actividades. La pregunta que se hace
 * en campo —«¿qué se le ha hecho antes a este equipo?»— casi nunca se responde
 * con eso: la inspección anterior la hizo otro, hace ocho meses, con otro
 * formulario. Esa información vive en el servidor y no tiene sentido bajarla
 * entera.
 *
 * Por eso se consulta en línea, se pinta en línea, y solo baja al dispositivo
 * lo que el usuario pide expresamente.
 */

/** Registros por página. Lo fija el servidor; aquí solo se refleja. */
export const HISTORY_PAGE_SIZE = 20;

/** Por qué fecha se filtra y ordena. */
export type HistoryDateField = 'CreatedOn' | 'DueDate' | 'CompletedOn' | 'UpdatedOn';

/** Una fila del listado. Sin respuestas: solo lo que se ve en la tarjeta. */
export interface HistoryItem {
  ID: number;
  GUID: string;
  SurveyID: number;
  SurveyName: string | null;
  Consecutive: string | null;

  LocationID: number | null;
  LocationName: string | null;
  AssetID: number | null;
  AssetName: string | null;

  CreatedOn: string | null;
  CompletedOn: string | null;
  DueDate: string | null;
  UpdatedOn: string | null;

  CompanyStatusID: number | null;
  StatusName: string | null;
  StatusColor: string | null;

  AssignedTo: number | null;
  AssignedToName: string | null;

  /** La actividad es del usuario que consulta. Decide si se podrá editar. */
  isMine: boolean;
}

export interface HistoryPage {
  items: HistoryItem[];
  total: number;
  page: number;
  size: number;
  pages: number;
}

export interface HistoryActivity extends Omit<HistoryItem, 'isMine'> {
  isMine: boolean;

  /**
   * La definición del formulario, cruda y con todos sus campos bloqueados.
   *
   * Cruda a propósito: quien decide **qué páginas y qué campos están ocultos**
   * es el motor de formularios, a partir de lo que se respondió. Un cruce hecho
   * en el servidor no tiene ese contexto y acabaría enseñando secciones que en
   * el formulario real nunca se vieron.
   */
  questions: unknown;
  /** Las respuestas tal como están en el servidor. Es lo que se descarga. */
  JSONAnswers: unknown[];
}

export interface HistoryQuery {
  locationId?: string | number | null;
  assetId?: string | number | null;
  from?: string;
  to?: string;
  page?: number;
  dateField?: HistoryDateField;
  search?: string;
}

interface Reply<T> {
  status?: boolean;
  response?: T;
  error?: string;
}

@Injectable({ providedIn: 'root' })
export class ActivityHistoryApi {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);

  private get baseUrl(): string {
    return environment.useLocalApi ? environment.localApiUrl : environment.apiUrl;
  }

  /**
   * Una página del historial.
   *
   * La paginación la hace la base de datos con `OFFSET/FETCH`: un activo con
   * mil actividades devuelve veinte filas, no mil. Traerlas todas para mostrar
   * veinte es el error que tumbaba la aplicación móvil por memoria, y aquí
   * costaría además el ancho de banda de campo.
   */
  async search(query: HistoryQuery): Promise<{ ok: boolean; page?: HistoryPage; error?: string }> {
    const user = this.auth.currentUser();

    if (!user) return { ok: false, error: 'No hay sesión activa.' };

    const params: Record<string, string> = {
      CompanyID: String(user.CompanyID),
      UserID: String(user.UserID),
      page: String(query.page ?? 1),
      size: String(HISTORY_PAGE_SIZE),
      dateField: query.dateField ?? 'CreatedOn',
    };

    // El activo manda sobre la ubicación: pedir la historia de un equipo no es
    // pedir la de toda su sede.
    if (query.assetId) params['AssetID'] = String(query.assetId);
    else if (query.locationId) params['LocationID'] = String(query.locationId);

    if (query.from) params['from'] = query.from;
    if (query.to) params['to'] = query.to;
    if (query.search?.trim()) params['search'] = query.search.trim();

    try {
      const reply = await firstValueFrom(
        this.http
          .get<Reply<HistoryPage>>(`${this.baseUrl}/activitiesByEntity`, { params })
          .pipe(timeout(environment.requestTimeout * 1000)),
      );

      if (reply?.status && reply.response) return { ok: true, page: reply.response };

      return { ok: false, error: reply?.error ?? 'El servidor no devolvió resultados.' };
    } catch (error) {
      return { ok: false, error: this.messageOf(error) };
    }
  }

  /** Una actividad con sus campos ya cruzados contra la definición del formulario. */
  async detail(
    guid: string,
  ): Promise<{ ok: boolean; activity?: HistoryActivity; error?: string }> {
    const user = this.auth.currentUser();

    if (!user) return { ok: false, error: 'No hay sesión activa.' };

    try {
      const reply = await firstValueFrom(
        this.http
          .get<Reply<HistoryActivity>>(`${this.baseUrl}/activityDetail`, {
            params: {
              CompanyID: String(user.CompanyID),
              UserID: String(user.UserID),
              GUID: guid,
            },
          })
          .pipe(timeout(environment.requestTimeout * 1000)),
      );

      if (reply?.status && reply.response) return { ok: true, activity: reply.response };

      return { ok: false, error: reply?.error ?? 'No se pudo abrir la actividad.' };
    } catch (error) {
      return { ok: false, error: this.messageOf(error) };
    }
  }

  /**
   * Un fallo de red y un fallo del servidor no se cuentan igual.
   *
   * Sin conexión el usuario no tiene nada que arreglar y sí algo que entender:
   * esta pantalla no funciona sin señal, a diferencia del resto de la
   * aplicación.
   */
  private messageOf(error: unknown): string {
    const status = (error as { status?: number })?.status;

    if (status === 0 || status === undefined) {
      return 'El historial se consulta en línea y ahora no hay conexión.';
    }

    return `No se pudo consultar el historial (${status}).`;
  }
}
