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
  /**
   * La descarga que va entre entrar y trabajar.
   *
   * Fuera del armazón a propósito: no hay menú al que ir ni nada que consultar
   * todavía. Es el equivalente de la pantalla de carga del teléfono.
   */
  {
    path: 'cargando',
    canActivate: [authGuard],
    title: 'Preparando tus datos · Visitrack',
    loadComponent: () =>
      import('./features/auth/loading/loading.component').then((m) => m.LoadingComponent),
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
        children: [
          /**
           * Una fila de tabla de detalle.
           *
           * **Hija de la actividad, no hermana**, y eso es lo que la hace
           * funcionar: como ruta hermana, abrir una fila destruiría la pantalla
           * de la actividad —y con ella el campo que está esperando lo que se
           * responda en la fila—. Como hija, la actividad sigue montada detrás.
           *
           * Que sea una ruta y no una ventana flotante es lo que hace que el
           * botón atrás cierre la fila en vez de salir de la actividad entera, y
           * que una tabla dentro de otra sea solo un rastro más largo.
           *
           * El rastro identifica la fila: `campo~fila`, y separados por comas
           * los niveles anidados.
           */
          {
            path: 'registro/:trail',
            title: 'Registro · Visitrack',
            loadComponent: () =>
              import(
                './features/activities/form/master-detail-row/master-detail-row.component'
              ).then((m) => m.MasterDetailRowComponent),
          },

          /**
           * El listado completo de una tabla de detalle.
           *
           * En el formulario solo caben unos pocos registros; aquí se ven
           * todos, en tabla y con buscador. Igual que la fila, es una pantalla y
           * no una ventana para que el botón atrás devuelva al formulario.
           */
          {
            path: 'registros/:panel',
            title: 'Registros · Visitrack',
            loadComponent: () =>
              import(
                './features/activities/form/master-detail-row/master-detail-list.component'
              ).then((m) => m.MasterDetailListComponent),
          },
        ],
      },
      /**
       * Consignas: el trabajo que llega asignado.
       *
       * Aparte de los formularios porque responde otra pregunta: no «¿qué he
       * hecho?» sino «¿qué me toca?». Repartidas dentro de cada formulario, con
       * tres formularios hay que mirar en tres sitios.
       */
      {
        path: 'consignas',
        title: 'Mis consignas · Visitrack',
        loadComponent: () =>
          import('./features/dispatches/dispatches.component').then((m) => m.DispatchesComponent),
      },

      /**
       * Traer al navegador el trabajo que está en el teléfono.
       *
       * Fuera del flujo de sincronización a propósito: no es una descarga del
       * servidor, es un traspaso entre dos equipos de la misma persona.
       */
      {
        path: 'vincular',
        title: 'Vincular teléfono · Visitrack',
        loadComponent: () => import('./features/link/link.component').then((m) => m.LinkComponent),
      },

      /**
       * Lo creado aquí que todavía no está en Visitrack.
       *
       * Aparte de «Pendientes», que son actividades: una entidad sin subir
       * bloquea a las actividades que la usan, así que es una cola propia con
       * su propia razón de existir.
       */
      {
        path: 'entidades',
        title: 'Entidades por subir · Visitrack',
        loadComponent: () =>
          import('./features/entities/entities.component').then((m) => m.EntitiesComponent),
      },

      /**
       * Ubicaciones: el catálogo, no el selector.
       *
       * Es donde se consultan las sedes con sus datos, sus activos y sus
       * actividades, y donde se crean las que faltan. Distinto de
       * `formularios/:surveyId/ubicaciones`, que solo sirve para elegir una al
       * abrir una actividad.
       */
      {
        path: 'ubicaciones',
        title: 'Ubicaciones · Visitrack',
        loadComponent: () =>
          import('./features/locations/locations.component').then((m) => m.LocationsComponent),
      },
      {
        path: 'ubicaciones/nueva',
        title: 'Nueva ubicación · Visitrack',
        loadComponent: () =>
          import('./features/locations/entity-editor.component').then(
            (m) => m.EntityEditorComponent,
          ),
      },
      {
        path: 'ubicaciones/:guid',
        title: 'Ubicación · Visitrack',
        loadComponent: () =>
          import('./features/locations/location-detail.component').then(
            (m) => m.LocationDetailComponent,
          ),
      },
      {
        path: 'ubicaciones/:guid/editar',
        title: 'Editar ubicación · Visitrack',
        loadComponent: () =>
          import('./features/locations/entity-editor.component').then(
            (m) => m.EntityEditorComponent,
          ),
      },

      /**
       * Los activos cuelgan de su ubicación, también en la dirección.
       *
       * Un activo no existe por su cuenta: es el equipo que está **en** esa
       * sede. Que la dirección lo diga hace que volver atrás lleve a la
       * ubicación, que es de donde se venía.
       *
       * `nuevo` va antes que `:asset` o el editor de creación se leería como la
       * ficha de un activo llamado «nuevo».
       */
      {
        path: 'ubicaciones/:guid/activo/nuevo',
        title: 'Nuevo activo · Visitrack',

        /**
         * `nuevo` es literal en la ruta, así que no llega como parámetro.
         *
         * El editor decide si está trabajando sobre una ubicación o sobre un
         * activo mirando su entrada `asset`, y aquí se quedaba vacía: pulsar
         * «Nuevo activo» abría el editor de **la ubicación**. Se pasa por
         * `data`, que el enlace de entradas del router trata igual que un
         * parámetro de la dirección.
         */
        data: { asset: 'nuevo' },

        loadComponent: () =>
          import('./features/locations/entity-editor.component').then(
            (m) => m.EntityEditorComponent,
          ),
      },
      {
        path: 'ubicaciones/:guid/activo/:asset',
        title: 'Activo · Visitrack',
        loadComponent: () =>
          import('./features/locations/location-detail.component').then(
            (m) => m.LocationDetailComponent,
          ),
      },
      {
        path: 'ubicaciones/:guid/activo/:asset/editar',
        title: 'Editar activo · Visitrack',
        loadComponent: () =>
          import('./features/locations/entity-editor.component').then(
            (m) => m.EntityEditorComponent,
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
      /**
       * Borradores: lo que se abrió y nunca se guardó.
       *
       * Aparte porque caducan: sin un sitio donde verlos, lo que está a medias
       * solo aparece al entrar al formulario del que salió — y para entonces
       * puede haberse borrado solo.
       */
      {
        path: 'borradores',
        title: 'Borradores · Visitrack',
        loadComponent: () =>
          import('./features/drafts/drafts.component').then((m) => m.DraftsComponent),
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
