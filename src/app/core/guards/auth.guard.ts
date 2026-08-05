import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { AuthService } from '../services/auth.service';

/**
 * Exige sesión abierta.
 *
 * Al recargar la página los signals arrancan vacíos aunque haya sesión en
 * IndexedDB, así que si `currentUser` es `null` se intenta restaurar antes de
 * rechazar. Sin eso, un F5 en cualquier pantalla interna devolvería al login.
 */
export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (auth.isAuthenticated()) return true;

  if (await auth.restoreSession()) return true;

  // Se recuerda a dónde iba para volver ahí después de entrar.
  return router.createUrlTree(['/login'], {
    queryParams: { redirect: state.url },
  });
};

/**
 * Impide entrar al login cuando ya hay sesión.
 *
 * Evita que alguien con sesión abierta llegue a la pantalla de acceso desde el
 * historial y crea que se desconectó.
 */
export const guestGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (auth.isAuthenticated()) return router.createUrlTree(['/inicio']);

  if (await auth.restoreSession()) return router.createUrlTree(['/inicio']);

  return true;
};
