import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, from, switchMap, throwError } from 'rxjs';

import { AuthService } from '../services/auth.service';
import { SessionEndService } from '../services/session-end.service';

/**
 * Añade el token del usuario a las peticiones al backend.
 *
 * Se omite en `/loginTemp`: es la llamada que produce el token, así que mandar
 * uno viejo ahí no aporta nada y puede confundir el diagnóstico si el token
 * anterior estaba corrupto.
 *
 * El backend acepta el token en la cabecera `x-token`, que es como lo envía la
 * app móvil.
 *
 * ## Cubre `HttpClient`, no todo
 *
 * Lo que se hace con `fetch()` directo —parte de la sincronización, que necesita
 * leer la respuesta como flujo o cancelarla— no pasa por aquí. Eso va por
 * `ApiFetchService`, que pone la misma cabecera y comparte el mismo cierre de
 * sesión.
 *
 * ## Y recoge la sesión cuando el servidor la rechaza
 *
 * Un 401 significa una cosa concreta: **esta sesión ya no vale** —caducó, se
 * cerró desde otro equipo, o el servidor pasó a exigir token y esta versión no
 * lo manda—. Sin tratarlo, la aplicación se queda con una sesión fantasma:
 * parece abierta, no sincroniza nada, y no hay forma de entender por qué.
 *
 * Qué hacer con eso lo decide [SessionEndService], que además garantiza que
 * ocurra una sola vez aunque fallen diez peticiones a la vez.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const sessionEnd = inject(SessionEndService);

  const isLogin = req.url.includes('/loginTemp');

  // El propio cierre de sesión no puede desencadenar otro cierre de sesión.
  const isLogout = req.url.includes('/logout');

  const token = auth.currentUser()?.Token;

  const request =
    isLogin || !token ? req : req.clone({ setHeaders: { 'x-token': token } });

  return next(request).pipe(
    catchError((error: unknown) => {
      const rejected = error instanceof HttpErrorResponse && error.status === 401;

      // En el propio inicio de sesión un 401 es «credenciales incorrectas», y
      // eso lo cuenta la pantalla de login: cerrar la sesión aquí sería
      // responder a un problema distinto del que hubo.
      if (!rejected || isLogin || isLogout) {
        return throwError(() => error);
      }

      const detail = (error as HttpErrorResponse).error?.error ?? '';

      return from(sessionEnd.handle(detail)).pipe(
        switchMap(() => throwError(() => error)),
      );
    }),
  );
};
