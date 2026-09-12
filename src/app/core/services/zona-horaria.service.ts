import { Injectable, computed, inject, signal } from '@angular/core';

import { AuthService } from './auth.service';

/**
 * Con qué hora se pintan las fechas en esta aplicación.
 *
 * ## Qué estaba mal
 *
 * Todas las fechas salían por el pipe `| date` de Angular, que formatea con la
 * zona **del navegador**. `UTCCode` viajaba en la respuesta del login y no lo
 * usaba nadie para formatear: solo se enseñaba como texto en el perfil.
 *
 * Así que a alguien con la zona de México apuntada en la plataforma, abriendo
 * el navegador desde Colombia, se le pintaba todo en hora colombiana. Y no hay
 * forma de notarlo mirando: las horas se ven plausibles, solo están corridas.
 * Se descubre cuando alguien compara con un correo o con el teléfono.
 *
 * ## De dónde sale
 *
 * Del catálogo de la plataforma, resuelto **en el servidor**: la zona del
 * usuario, o la de su compañía, o la más repetida entre sus compañeros —
 * `Users.UTCCode` está vacía en más de mil usuarios—, y con el horario de
 * verano vigente aplicado. Ver `zonaHorariaDe` en `cloud-server`.
 *
 * El cliente no consulta ninguna tabla ni decide nada: recibe los minutos y los
 * usa. Es lo único que garantiza que el web, Module y el teléfono pinten la
 * misma hora para el mismo dato.
 *
 * ## Sin zona apuntada, la del navegador
 *
 * `null` no es cero. Cero es una zona de verdad —Londres en invierno— y `null`
 * es «la plataforma no lo tiene apuntado». Ahí se deja el pipe como estaba, con
 * la del aparato: no es inventársela, es dónde está el equipo desde el que se
 * mira, y acierta casi siempre. Pintar Greenwich no acierta casi nunca y encima
 * se lee como un dato correcto.
 */
@Injectable({ providedIn: 'root' })
export class ZonaHorariaService {
  private readonly auth = inject(AuthService);

  /**
   * Los minutos respecto a UTC, o `null` si no se saben.
   *
   * Se lee del usuario en sesión en cada consulta y no se copia a una variable:
   * al cambiar de cuenta sin recargar la página, una copia se quedaría con la
   * zona del anterior.
   */
  readonly minutos = computed(() => {
    const valor = this.auth.currentUser()?.UTCMinutes;

    return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
  });

  /**
   * El desfase como lo espera Angular: `+0530`, `-0500`.
   *
   * `undefined` cuando no se sabe, que es justo lo que hace que `DatePipe`
   * siga usando la del navegador. Ver el encabezado.
   */
  readonly paraElPipe = computed<string | undefined>(() => {
    const m = this.minutos();
    if (m === null) return undefined;

    const signo = m < 0 ? '-' : '+';
    const total = Math.abs(m);
    const dos = (n: number) => String(Math.floor(n)).padStart(2, '0');

    return `${signo}${dos(total / 60)}${dos(total % 60)}`;
  });

  /** Cómo se lee, para poder enseñarlo: `UTC-05:00`. */
  readonly comoSeLee = computed(() => {
    const m = this.minutos();
    if (m === null) return 'la de este equipo';

    const signo = m < 0 ? '-' : '+';
    const total = Math.abs(m);
    const dos = (n: number) => String(Math.floor(n)).padStart(2, '0');

    return `UTC${signo}${dos(total / 60)}:${dos(total % 60)}`;
  });

  /**
   * Una fecha en la zona de esta persona, para el código que no usa el pipe.
   *
   * Devuelve un `Date` cuyos campos locales —`getHours`, `getDate`— ya son los
   * de su zona. **No** es un instante: es una fecha para leer, y usarla para
   * calcular diferencias daría el desfase aplicado dos veces.
   */
  comoLaVe(cuando: Date | string | null | undefined): Date | null {
    if (!cuando) return null;

    const t = cuando instanceof Date ? cuando : new Date(cuando);
    if (Number.isNaN(t.getTime())) return null;

    const m = this.minutos();
    if (m === null) return t;

    /*
     * Se suma el desfase de la persona y se resta el del navegador.
     *
     * Lo segundo es lo que se olvida: `getHours` de un `Date` ya aplica la zona
     * del aparato, así que sumando solo el desfase de la persona quedaría el
     * del navegador encima. Es el fallo clásico de esto, y sale una hora que
     * parece razonable — que es lo que lo hace difícil de ver.
     */
    return new Date(t.getTime() + (m + t.getTimezoneOffset()) * 60_000);
  }

  /**
   * Una fecha ya escrita, en la zona de esta persona.
   *
   * Para el código que formatea a mano con `toLocaleString` en vez de usar el
   * pipe. Ese camino **no** pasa por `DATE_PIPE_DEFAULT_OPTIONS`, así que sin
   * esto se quedaría con la del navegador aunque el resto de la aplicación ya
   * pinte bien — que es peor que si estuviera mal en todas partes, porque
   * entonces dos pantallas enseñan horas distintas del mismo dato.
   *
   * `toLocaleString` solo entiende nombres de zona («America/Bogota»), y de la
   * plataforma llegan minutos. Así que se corre la fecha y se escribe en UTC:
   * el resultado es el mismo y no hace falta traducir el catálogo a nombres.
   */
  comoTexto(
    cuando: Date | string | null | undefined,
    opciones: Intl.DateTimeFormatOptions,
  ): string {
    if (!cuando) return '';

    const t = cuando instanceof Date ? cuando : new Date(cuando);
    if (Number.isNaN(t.getTime())) return typeof cuando === 'string' ? cuando : '';

    const m = this.minutos();

    if (m === null) return t.toLocaleString('es', opciones);

    return new Date(t.getTime() + m * 60_000)
      .toLocaleString('es', { ...opciones, timeZone: 'UTC' });
  }

  /** Solo para las pruebas: fijar la zona sin pasar por el login. */
  readonly forzada = signal<number | null | undefined>(undefined);
}
