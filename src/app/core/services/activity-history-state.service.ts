import { Injectable, signal } from '@angular/core';

import { HistoryDateField, HistoryPage } from './activity-history.api';

/** Lo que hay que devolver tal cual al volver de una actividad. */
export interface HistorySnapshot {
  /** Sobre qué se estaba consultando. Ver [ActivityHistoryStateService.keyOf]. */
  key: string;

  /** Entidad elegida en la pantalla propia; nula cuando venía fija. */
  /*
   * El tipo viaja con la entidad: al volver de una actividad la línea de
   * arriba se vuelve a pintar tal cual estaba, y sin él diría «Sin tipo» de
   * repente en algo que hace un momento sí lo decía.
   *
   * Es opcional porque una instantánea guardada antes de que existiera este
   * campo tiene que seguir sirviendo — al recuperarla se rellena.
   */
  target: {
    kind: 'ubicación' | 'activo';
    id: string;
    name: string;
    typeName?: string;
  } | null;

  from: string;
  to: string;
  dateField: HistoryDateField;
  term: string;

  /**
   * Los filtros que acotan. Se guardan con el resto porque son justamente los
   * que más cuesta volver a poner: elegir formulario y estado son dos
   * desplegables, y perderlos al volver de mirar una actividad obliga a rehacer
   * lo que ya se había decidido.
   */
  surveyId: string;
  statusId: string;
  mine: boolean;
  /** Activo elegido dentro de una ubicación. */
  assetWithin: string;

  page: number;
  result: HistoryPage | null;

  /** Dónde estaba la vista. */
  scroll: number;
}

/**
 * La consulta anterior, para cuando se vuelve.
 *
 * ## Por qué hace falta
 *
 * Consultar el historial cuesta: se escoge el equipo, se ajusta el rango de
 * fechas, se pasa a la página cuatro. Entrar a una actividad para mirarla y
 * encontrarse todo eso borrado al volver convierte revisar cinco actividades en
 * repetir la consulta cinco veces — y como el listado es en línea, además son
 * cinco viajes al servidor.
 *
 * Se guarda **también el resultado**, no solo los filtros: volver tiene que ser
 * instantáneo, y los datos que se acaban de traer siguen siendo válidos.
 *
 * ## Por qué en un servicio y no en la ruta
 *
 * Podría ir en los parámetros de la URL, pero eso solo devuelve los filtros: el
 * resultado habría que volver a pedirlo, y la posición del desplazamiento se
 * perdería igual. Aquí cabe todo el estado, y el precio es que no sobrevive a
 * recargar la página — que es exactamente cuando **no** se quiere conservar una
 * consulta vieja.
 */
@Injectable({ providedIn: 'root' })
export class ActivityHistoryStateService {
  private readonly snapshot = signal<HistorySnapshot | null>(null);

  /**
   * Identifica sobre qué entidad era la consulta.
   *
   * Restaurar en una entidad distinta sería peor que no restaurar: se verían
   * las actividades de otro equipo bajo el nombre de este.
   */
  keyOf(kind: string, id: string): string {
    return `${kind}:${id}`;
  }

  /** Guarda el estado actual. */
  remember(state: HistorySnapshot): void {
    this.snapshot.set(state);
  }

  /**
   * Recupera el estado si era de esta misma entidad.
   *
   * @param key `null` en la pantalla propia, donde la entidad la elige el
   *   usuario y por lo tanto viene dentro del propio recuerdo.
   */
  recall(key: string | null): HistorySnapshot | null {
    const saved = this.snapshot();

    if (!saved) return null;
    if (key !== null && saved.key !== key) return null;

    return saved;
  }

  /** Olvida lo guardado. Se llama al cambiar de entidad a mano. */
  forget(): void {
    this.snapshot.set(null);
  }
}
