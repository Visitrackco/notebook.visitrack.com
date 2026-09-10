import { inject } from '@angular/core';
import { CanActivateFn, RedirectCommand, Router } from '@angular/router';

import { esModoPublico, guidPublico, RUTA_ENLACE } from '../config/modo-publico';

/**
 * Rutas que una pestaña en modo público puede abrir.
 *
 * Solo la actividad —con sus rutas hijas de tablas de detalle— y la pantalla de
 * cierre. Todo lo demás —inicio, sincronización, borradores, historial, perfil,
 * vincular— o no significa nada sin sesión, o directamente no funcionaría: son
 * pantallas que dan por hecho un usuario que inició sesión y una base que
 * sincronizó.
 *
 * Ojo con lo que **no** entra: `/formularios/:id` a secas, que es el listado de
 * actividades del formulario. Existe y funcionaría —es el mismo formulario y el
 * mismo usuario—, pero es una pantalla de la aplicación con sesión, con su
 * histórico y su botón de crear, y quien abrió un enlace no viene a eso. A ella
 * lleva la flecha de volver de la actividad, así que sin esta regla se llegaba
 * por accidente.
 */
const PERMITIDAS = [/^\/formularios\/[^/]+\/actividad(\/|$)/, /^\/gracias(\/|$)/];

/**
 * Mantiene una pestaña pública dentro de lo suyo.
 *
 * ## Qué problema resuelve
 *
 * El modo público dura lo que dure la pestaña, no lo que dure la dirección. Eso
 * es a propósito —recargar en mitad del formulario tiene que seguir funcionando,
 * y para entonces la dirección ya no es la del enlace—, pero deja una puerta
 * abierta: escribir a mano `#/inicio`, o llegar ahí por el historial, montaría
 * las pantallas de la aplicación con sesión sobre la base pública. No sería una
 * fuga de datos —esa base solo tiene lo que el enlace sembró— pero sí una
 * pantalla que promete cosas que ahí no existen.
 *
 * Se devuelve a la puerta del enlace, que sabe qué contar en cada caso.
 *
 * ## Y al revés
 *
 * Fuera del modo público este guardia no hace nada. Es la aplicación normal, y
 * sus guardias son los de siempre.
 */
export const publicoGuard: CanActivateFn = (_route, state) => {
  if (!esModoPublico()) return true;

  const destino = state.url.split('?')[0];

  if (PERMITIDAS.some((permitida) => permitida.test(destino))) return true;

  const router = inject(Router);

  /*
   * Se **reemplaza** la entrada del historial.
   *
   * Sin eso, el botón atrás llevaría de vuelta a la ruta que acaba de
   * rechazarse, el guardia volvería a redirigir, y quien lo intenta quedaría
   * atrapado sin poder retroceder.
   */
  return new RedirectCommand(router.createUrlTree(['/', RUTA_ENLACE, guidPublico()]), {
    replaceUrl: true,
  });
};
