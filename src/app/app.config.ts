import { DATE_PIPE_DEFAULT_OPTIONS } from '@angular/common';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  ApplicationConfig,
  inject,
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
import { ZonaHorariaService } from './core/services/zona-horaria.service';

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

    /**
     * Las fechas se pintan en la zona de la persona, no en la del navegador.
     *
     * Todo `| date` de la aplicación formateaba con la zona del equipo desde el
     * que se mira. A alguien con la zona de México apuntada en la plataforma,
     * abriendo el navegador en Colombia, se le pintaba todo en hora colombiana
     * — y no hay forma de notarlo: las horas se ven plausibles, solo están
     * corridas una hora.
     *
     * Se arregla aquí, en el valor por omisión del pipe, y no plantilla por
     * plantilla: así vale para las que ya hay y para las que se escriban
     * después, sin que nadie tenga que acordarse de pasar la zona.
     *
     * `timezone` es un **getter**, no un valor. `DatePipe` lee la propiedad en
     * cada `transform`, así que devolviendo el valor en el momento la zona
     * cambia sola al entrar o salir de una cuenta, sin recargar la página. Con
     * un valor fijo se congelaría la del primero que entró en esta pestaña.
     *
     * `undefined` cuando la plataforma no tiene zona apuntada, que es lo que
     * hace que el pipe siga con la del navegador. Ver `ZonaHorariaService`.
     */
    {
      provide: DATE_PIPE_DEFAULT_OPTIONS,
      useFactory: () => {
        const zona = inject(ZonaHorariaService);

        return {
          get timezone(): string | undefined {
            return zona.paraElPipe();
          },
        };
      },
    },
  ],
};
