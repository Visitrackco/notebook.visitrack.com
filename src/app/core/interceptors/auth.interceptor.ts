import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';

import { AuthService } from '../services/auth.service';

/**
 * Añade el token del usuario a las peticiones al backend.
 *
 * Se omite en `/loginTemp`: es la llamada que produce el token, así que mandar
 * uno viejo ahí no aporta nada y puede confundir el diagnóstico si el token
 * anterior estaba corrupto.
 *
 * El backend acepta el token en la cabecera `x-token`, que es como lo envía la
 * app móvil.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.url.includes('/loginTemp')) return next(req);

  const token = inject(AuthService).currentUser()?.Token;
  if (!token) return next(req);

  return next(
    req.clone({
      setHeaders: { 'x-token': token },
    }),
  );
};
