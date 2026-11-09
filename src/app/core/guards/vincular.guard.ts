import { inject } from '@angular/core';
import { CanActivateFn, RedirectCommand, Router } from '@angular/router';

import { ConfigDeCompaniaService } from '../services/config-de-compania.service';

/**
 * `/vincular` solo para las compañías que tienen «Vincular dispositivo».
 *
 * Se pregunta antes de decir que no, por si se entró directo a la dirección. Se
 * devuelve al inicio reemplazando el historial, como `permisoDeModuleGuard`.
 */
export const vincularGuard: CanActivateFn = async () => {
  const config = inject(ConfigDeCompaniaService);
  const router = inject(Router);

  if (!config.vincularDispositivo()) await config.cargar();
  if (config.vincularDispositivo()) return true;

  return new RedirectCommand(router.createUrlTree(['/inicio']), { replaceUrl: true });
};
