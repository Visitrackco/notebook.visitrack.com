import { Injectable, inject } from '@angular/core';

import { resolveCatalogOwnerId } from '../config/company-rules';
import { LocationForm } from '../models/entities.model';
import { AssetRepository, LocationRepository } from '../repositories/entity.repositories';
import { AuthService } from './auth.service';
import { ResultadoDeEtiqueta, armarResultados, normalizarEtiqueta } from './buscar-por-etiqueta';

/**
 * Lo que hay en este dispositivo con una etiqueta dada.
 *
 * El equivalente de `getByTag` del móvil: se busca en local, sin red, porque
 * se escanea delante del equipo y ahí es donde más falla la señal. Se busca
 * bajo el dueño del catálogo (`resolveCatalogOwnerId`) y no bajo el usuario a
 * secas: las compañías con catálogo compartido guardan sedes y activos bajo
 * otra cuenta, y el móvil hace la misma excepción.
 */
@Injectable({ providedIn: 'root' })
export class EtiquetasService {
  private readonly auth = inject(AuthService);
  private readonly locations = inject(LocationRepository);
  private readonly assets = inject(AssetRepository);

  async buscar(codigo: string): Promise<ResultadoDeEtiqueta[]> {
    const user = this.auth.currentUser();
    const buscado = normalizarEtiqueta(codigo);
    if (!user || !buscado) return [];

    const owner = resolveCatalogOwnerId(user);

    const [ubicaciones, activos] = await Promise.all([
      this.locations.findByTag(owner, buscado),
      this.assets.findByTag(owner, buscado),
    ]);

    // Las sedes de los activos hallados, para nombrarlas y armar su ficha. Se
    // traen solo las que hacen falta: un activo por etiqueta es lo normal, y
    // leer veinte mil sedes para nombrar una sería absurdo.
    const sedes = new Map<string, LocationForm>();

    for (const activo of activos) {
      const porGuid = activo.LocationGUID
        ? await this.locations.getByIndex('byGUID', activo.LocationGUID)
        : null;

      // `0` es «sin sede asignada» y no el identificador de ninguna.
      const id = String(activo.LocationID ?? '');
      const sede =
        porGuid ?? (id && id !== '0' ? await this.locations.findByLocationId(owner, id) : null);

      if (sede && sede.isDeleted !== '1') sedes.set(sede.GUID, sede);
    }

    return armarResultados(ubicaciones, activos, sedes);
  }
}
