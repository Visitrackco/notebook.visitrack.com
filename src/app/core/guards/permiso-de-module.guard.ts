import { inject } from '@angular/core';
import { CanActivateFn, RedirectCommand, Router } from '@angular/router';

import { PermisosDeModuleService } from '../services/permisos-de-module.service';

/**
 * Una pantalla que exige una clave de Module.
 *
 * Estricto como `PermisosDeModuleService`: si Module no la dio, no se entra.
 * Antes de decir que no se espera a la pregunta en curso —recién iniciada la
 * sesión, o al recargar la pestaña en esa pantalla—, para no echar a quien sí
 * la tiene solo porque la respuesta venía de camino.
 *
 * Se devuelve al inicio **reemplazando** la entrada del historial: si no, el
 * botón atrás volvería a la ruta rechazada y quedaría atrapado.
 */
export function permisoDeModuleGuard(clave: string): CanActivateFn {
  return async () => {
    const permisos = inject(PermisosDeModuleService);
    const router = inject(Router);
    const tiene = permisos.tiene(clave);

    if (!tiene()) await permisos.listo();
    if (tiene()) return true;

    return new RedirectCommand(router.createUrlTree(['/inicio']), { replaceUrl: true });
  };
}
