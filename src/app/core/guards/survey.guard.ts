import { inject } from '@angular/core';
import { CanActivateFn, RedirectCommand, Router } from '@angular/router';

import { ActivityService } from '../services/activity.service';

/**
 * Exige que el formulario exista en este equipo.
 *
 * ## Qué problema resuelve
 *
 * `/formularios/:surveyId` ya sabe qué hacer cuando el formulario no está: lo
 * dice y ofrece volver. Sus rutas hijas —elegir ubicación, elegir activo, la
 * actividad, una fila de tabla de detalle— no lo sabían, y a ellas se llega sin
 * pasar por el listado: un enlace guardado, el historial del navegador, o
 * recargar la página en mitad del flujo después de que ese formulario dejara de
 * estar asignado.
 *
 * Lo que salía entonces no era un aviso sino una pantalla a medias: un selector
 * de ubicaciones sin saber para qué, o una actividad sin preguntas que dibujar.
 * Y esa pantalla no dice lo único que hay que saber —que el formulario ya no
 * está aquí—, así que quien la ve lo intenta otra vez en vez de sincronizar.
 *
 * ## Por qué un guard y no una comprobación en cada pantalla
 *
 * Son cinco rutas y cada una carga cosas distintas. Repetido cinco veces, basta
 * que una se quede sin la comprobación —o que mañana se agregue una sexta— para
 * que el agujero vuelva. El guard se declara junto a la ruta, así que agregar
 * una ruta hija sin él se ve al leer el archivo de rutas.
 *
 * ## A dónde manda
 *
 * A `/formularios/:surveyId`, que es donde ya vive el mensaje. No se duplica
 * aquí: un segundo sitio que diga lo mismo con otras palabras es un sitio más
 * que corregir el día que el texto cambie.
 *
 * Se **reemplaza** la entrada del historial. Sin eso, el botón atrás llevaría
 * de vuelta a la ruta que acaba de rechazarse, el guard volvería a redirigir, y
 * el usuario quedaría atrapado sin poder retroceder.
 *
 * Eso exige `RedirectCommand`: devolver un `UrlTree` a secas redirige igual,
 * pero `createUrlTree` no admite `replaceUrl` —solo construye la dirección— y
 * la entrada rechazada se quedaría en el historial.
 */
export const surveyGuard: CanActivateFn = async (route) => {
  const activities = inject(ActivityService);
  const router = inject(Router);

  /**
   * El parámetro puede estar en un ancestro.
   *
   * Las rutas de una fila (`registro/:trail`) y del listado
   * (`registros/:panel`) cuelgan de la actividad, y `:surveyId` se declaró dos
   * niveles más arriba. `paramMap` de la ruta activa solo trae lo suyo, así que
   * desde ahí llegaría vacío y el guard rechazaría formularios que sí existen.
   */
  let snapshot: typeof route | null = route;
  let surveyId: string | null = null;

  while (snapshot && !surveyId) {
    surveyId = snapshot.paramMap.get('surveyId');
    snapshot = snapshot.parent;
  }

  if (!surveyId) return true;

  if (await activities.findSurvey(surveyId)) return true;

  return new RedirectCommand(router.createUrlTree(['/formularios', surveyId]), {
    replaceUrl: true,
  });
};
