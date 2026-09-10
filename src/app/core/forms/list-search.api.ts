import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';

import { apiBaseUrl } from '../config/api-base';
import { ListDetail } from '../models/entities.model';

/** Lo que espera `/searchList`. Los nombres son los del backend, sin traducir. */
export interface ListSearchQuery {
  /** Lista de la que salen los ítems. Nulo cuando la consulta es de inventario. */
  ListID: string | null;
  /** Tipo de ítem de inventario. Nulo cuando la consulta es de lista. */
  ItemID: string | null;
  /** Lista hija: el servidor resuelve su `ListIDBD` a partir de este. */
  lsChild: string | null;
  /** Texto de búsqueda. */
  txt: string;
  /** GUID del ítem padre. */
  parent: string;
  /** Ubicación de la actividad. */
  loc: string;
  /** Activo de la actividad. */
  ass: string;
  /** GUID elegido en el campo del que depende esta lista. */
  parentlist: string;
  /** La lista son usuarios. */
  users: boolean;
  /** La lista se filtra por el usuario dueño de cada ítem. */
  byusers: boolean;
  byuserList: string;
}

export interface ListSearchResult {
  ok: boolean;
  items: ListDetail[];
  error?: string;
}

/**
 * Búsqueda de ítems contra el servidor.
 *
 * ## Cuándo se usa
 *
 * Una lista con `IsForSync = 0` es una lista que el usuario **no descargó**:
 * sus ítems no están en el dispositivo. Suelen ser los catálogos grandes, de
 * decenas de miles de registros, que no tiene sentido bajar enteros para elegir
 * uno.
 *
 * Esas se consultan aquí, escribiendo. La contrapartida es que necesitan
 * conexión — y por eso el usuario puede marcar la lista para descarga si
 * trabaja donde no la hay.
 */
@Injectable({ providedIn: 'root' })
export class ListSearchApi {
  private readonly http = inject(HttpClient);

  private get baseUrl(): string {
    /*
     * Por `apiBaseUrl` y no leyendo el entorno directamente.
     *
     * En modo publico —un formulario abierto desde un enlace, sin sesion— esa
     * funcion antepone `/public/enlace/<token>`, que es donde vive la lista
     * blanca de rutas que el servidor sirve sin pedir sesion. Ver
     * `core/config/api-base.ts`.
     */
    return apiBaseUrl();
  }

  async search(
    query: ListSearchQuery,
    session: { companyId: string | number; userId: string | number },
  ): Promise<ListSearchResult> {
    const body = {
      ...query,
      CompanyID: session.companyId,
      UserID: session.userId,
    };

    // El servidor no admite las dos formas de filtrar por padre a la vez: si
    // llegan juntas devuelve un conjunto vacío. La app resuelve la ambigüedad
    // dando prioridad al ítem concreto, y aquí se hace igual.
    if (body.parentlist && body.parent) body.parentlist = '';

    try {
      const response = await firstValueFrom(
        this.http
          .put<{ status?: boolean; response?: ListDetail[]; error?: string }>(
            `${this.baseUrl}/searchList`,
            body,
            { headers: { 'Content-Type': 'application/json' } },
          )
          .pipe(timeout(120_000)),
      );

      if (response?.status) return { ok: true, items: response.response ?? [] };

      return {
        ok: false,
        items: [],
        error: response?.error ?? 'El servidor no devolvió resultados.',
      };
    } catch (error) {
      const status = (error as { status?: number })?.status;

      return {
        ok: false,
        items: [],
        error:
          status === 0 || status === undefined
            ? 'Esta lista se consulta en línea y no hay conexión. Descárgala desde Sincronización para usarla sin red.'
            : `No se pudo consultar la lista (${status}).`,
      };
    }
  }
}
