import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import {
  provideRouter,
  withComponentInputBinding,
  withHashLocation,
  withInMemoryScrolling,
} from '@angular/router';

import { routes } from './app.routes';
import { authInterceptor } from './core/interceptors/auth.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),

    /**
     * Sin Zone.js: la detección de cambios se apoya en signals. Es el modo
     * recomendado en Angular moderno y evita los ciclos de verificación que
     * Zone dispara ante cualquier evento del navegador — algo que se nota en
     * listas largas como las de ítems de lista.
     */
    provideZonelessChangeDetection(),

    provideRouter(
      routes,

      /**
       * Rutas con hash: `/#/inicio` en vez de `/inicio`.
       *
       * Con rutas normales, cualquier recarga o enlace directo llega al
       * servidor como una petición real (`GET /perfil`), y si éste no está
       * configurado para devolver siempre el index.html responde 404. Con hash,
       * el navegador nunca envía esa parte al servidor: todo se resuelve del
       * lado del cliente, así que la aplicación funciona en cualquier hosting
       * estático sin configuración adicional.
       */
      withHashLocation(),

      // Permite pasar parámetros de ruta directo a los `input()` del componente.
      withComponentInputBinding(),
      // Al navegar se vuelve arriba, salvo al usar atrás/adelante, donde se
      // restaura la posición previa.
      withInMemoryScrolling({
        scrollPositionRestoration: 'enabled',
        anchorScrolling: 'enabled',
      }),
    ),

    provideHttpClient(withInterceptors([authInterceptor])),
  ],
};
