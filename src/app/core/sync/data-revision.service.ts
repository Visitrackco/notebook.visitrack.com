import { Injectable, signal } from '@angular/core';

/**
 * Latido de los datos locales.
 *
 * ## Qué problema resuelve
 *
 * Los datos viven en IndexedDB, no en memoria, así que una pantalla no se
 * entera de que algo cambió: los leyó al abrirse y ahí se quedó. Cuando el
 * proceso de subida cambia el estado de una actividad, el listado sigue
 * mostrando el anterior hasta que el usuario recarga a mano — y eso hace
 * parecer que la sincronización no funciona cuando sí lo hizo.
 *
 * Estos contadores son la señal que faltaba. Quien escribe llama a `touch…`;
 * quien muestra lo lee dentro de un `effect` y se recarga.
 *
 * ## Por qué contadores y no booleanos
 *
 * Dos cambios seguidos tienen que producir dos recargas. Con un booleano, el
 * segundo pasa inadvertido si el primero todavía no se consumió.
 *
 * ## Por qué un servicio propio
 *
 * Estaba dentro de `ActivityService`, que arrastra media docena de
 * repositorios. Los servicios de subida solo quieren avisar, no cargar con esa
 * dependencia —y hacerlo habría creado ciclos entre ellos—. Aquí no depende de
 * nada, así que cualquiera puede llamarlo.
 */
@Injectable({ providedIn: 'root' })
export class DataRevisionService {
  /** Sube con cada cambio en actividades: estado, envío, borrado. */
  readonly activities = signal(0);

  /** Sube con cada cambio en archivos: captura, subida, confirmación. */
  readonly binaries = signal(0);

  /**
   * Sube con cada cambio en ubicaciones y activos.
   *
   * Ahora se crean y se editan desde el navegador, así que el listado no puede
   * confiar en que lo que leyó al montarse siga siendo cierto.
   */
  readonly entities = signal(0);

  touchActivities(): void {
    this.activities.update((value) => value + 1);
  }

  touchBinaries(): void {
    this.binaries.update((value) => value + 1);
  }

  touchEntities(): void {
    this.entities.update((value) => value + 1);
  }

  /**
   * Ambas cosas cambiaron.
   *
   * Lo usa el proceso de subida al terminar: una corrida toca los archivos
   * —los sube y los confirma— y las actividades que salen gracias a ellos, y
   * las dos pantallas tienen que enterarse.
   */
  touchAll(): void {
    this.touchActivities();
    this.touchBinaries();
  }
}
