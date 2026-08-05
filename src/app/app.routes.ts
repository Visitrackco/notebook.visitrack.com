import { Routes } from '@angular/router';

import { authGuard, guestGuard } from './core/guards/auth.guard';

/**
 * Rutas de la aplicación.
 *
 * Van en español porque la URL es parte de la interfaz: el usuario la ve, la
 * comparte y a veces la escribe.
 *
 * Todo lo autenticado cuelga del `ShellComponent`, que aporta la barra lateral
 * y la cabecera. Cada pantalla se carga de forma diferida (`loadComponent`)
 * para que el primer arranque descargue solo lo indispensable — algo que
 * importa cuando alguien abre la aplicación por primera vez con mala señal.
 */
export const routes: Routes = [
  {
    path: 'login',
    canActivate: [guestGuard],
    title: 'Iniciar sesión · Visitrack',
    loadComponent: () =>
      import('./features/auth/login/login.component').then((m) => m.LoginComponent),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./layout/shell/shell.component').then((m) => m.ShellComponent),
    children: [
      {
        path: 'inicio',
        title: 'Inicio · Visitrack',
        loadComponent: () => import('./features/home/home.component').then((m) => m.HomeComponent),
      },
      {
        path: 'formularios',
        title: 'Formularios · Visitrack',
        loadComponent: () =>
          import('./features/forms/forms.component').then((m) => m.FormsComponent),
      },

      /**
       * Flujo de apertura de una actividad.
       *
       * Cada paso es una ruta propia y la actividad viaja en la URL. Podría
       * resolverse con estado en memoria y menos rutas, pero entonces recargar
       * la página en mitad del flujo —o compartir el enlace, o volver con el
       * botón atrás del navegador— dejaría al usuario en una pantalla sin
       * contexto y con una actividad ya creada de la que no volvería a saber.
       */
      {
        path: 'formularios/:surveyId',
        title: 'Actividades · Visitrack',
        loadComponent: () =>
          import('./features/activities/activities.component').then((m) => m.ActivitiesComponent),
      },
      {
        path: 'formularios/:surveyId/ubicaciones',
        title: 'Elegir ubicación · Visitrack',
        loadComponent: () =>
          import('./features/activities/location-picker.component').then(
            (m) => m.LocationPickerComponent,
          ),
      },
      {
        path: 'formularios/:surveyId/activos',
        title: 'Elegir activo · Visitrack',
        loadComponent: () =>
          import('./features/activities/asset-picker.component').then((m) => m.AssetPickerComponent),
      },
      {
        path: 'formularios/:surveyId/actividad/:guid',
        title: 'Actividad · Visitrack',
        loadComponent: () =>
          import('./features/activities/activity-detail.component').then(
            (m) => m.ActivityDetailComponent,
          ),
      },
      {
        path: 'perfil',
        title: 'Mi perfil · Visitrack',
        loadComponent: () =>
          import('./features/profile/profile.component').then((m) => m.ProfileComponent),
      },
      {
        path: 'sincronizacion',
        title: 'Sincronización · Visitrack',
        loadComponent: () => import('./features/sync/sync.component').then((m) => m.SyncComponent),
      },
      {
        path: 'pendientes',
        title: 'Pendientes por subir · Visitrack',
        loadComponent: () =>
          import('./features/pending/pending.component').then((m) => m.PendingComponent),
      },
      {
        path: 'archivos',
        title: 'Archivos · Visitrack',
        loadComponent: () =>
          import('./features/binaries/binaries.component').then((m) => m.BinariesComponent),
      },
      { path: '', pathMatch: 'full', redirectTo: 'inicio' },
    ],
  },
  { path: '**', redirectTo: '' },
];
