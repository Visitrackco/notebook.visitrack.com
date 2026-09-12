import { Injectable, Injector, computed, effect, inject, signal } from '@angular/core';

import { AuthService } from './auth.service';

/** Dónde se recuerda la zona entre recargas. */
const CLAVE = 'visitrack.zonaMinutos';
const CLAVE_NOMBRE = 'visitrack.zonaNombre';

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
 *
 * ## De dónde sale, y por qué de dos sitios
 *
 * La resuelve el servidor —la zona de la persona, o la de su compañía, o la
 * más repetida entre sus compañeros, con el horario de verano aplicado— y el
 * cliente solo recibe los minutos. Pero llega por dos caminos:
 *
 *  1. **El inicio de sesión**, en `UTCMinutes`.
 *  2. **Module**, preguntando `GET /chat/zona`.
 *
 * Con solo el primero, la zona únicamente cambiaba **al volver a entrar**: si
 * alguien la corregía en la plataforma, quien ya tenía la sesión abierta
 * seguía viendo las horas viejas hasta cerrar sesión, y recargar no bastaba
 * —al recargar se restaura la sesión guardada, que no la traía—. Eso hace que
 * un cambio parezca no haber surtido efecto, y lo siguiente que se piensa es
 * que el arreglo no funciona.
 *
 * Así que además se le pregunta a Module al arrancar y cada vez que cambia la
 * cuenta. Los dos resuelven con la misma cadena, así que dicen lo mismo; lo
 * que aporta el segundo es que se entera **sin volver a entrar**.
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
   * El inyector, para pedir `ChatApi` solo cuando haga falta.
   *
   * Este servicio lo construye el proveedor de `DATE_PIPE_DEFAULT_OPTIONS`, que
   * corre cuando la aplicación todavía se está montando. Pedir ahí una cadena
   * que acaba en el cliente HTTP y sus interceptores es la forma de encontrarse
   * una dependencia circular en el arranque — y esa falla con un error que no
   * señala a nadie. Pidiéndolo dentro del método, se resuelve con todo en pie.
   */
  private readonly injector = inject(Injector);

  /**
   * Lo último que dijo el servidor, recordado entre recargas.
   *
   * Se lee del almacenamiento **al construir** y no después: si no, la primera
   * pintada usaría la zona del navegador y las horas darían un salto al llegar
   * la respuesta. Un salto en una hora se lee como un error.
   */
  private readonly guardada = signal<number | null>(leerGuardada());

  /** Cómo se llama esa zona, para poder enseñarla. */
  readonly nombre = signal<string>(leerNombre());

  /** De dónde salió la que se está usando, para poder mirarlo. */
  readonly origen = signal<'el servidor' | 'este equipo'>(
    leerGuardada() === null ? 'este equipo' : 'el servidor',
  );

  /** Los minutos respecto a UTC, o `null` si no se saben. */
  readonly minutos = computed<number | null>(() => {
    const delServidor = this.guardada();
    if (delServidor !== null) return delServidor;

    // Lo que trajo el inicio de sesión, mientras Module no conteste.
    const delLogin = this.auth.currentUser()?.UTCMinutes;

    return typeof delLogin === 'number' && Number.isFinite(delLogin) ? delLogin : null;
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

    return `${m < 0 ? '-' : '+'}${dos(Math.abs(m) / 60)}${dos(Math.abs(m) % 60)}`;
  });

  /** Cómo se lee, para poder enseñarlo: `UTC-05:00`. */
  readonly comoSeLee = computed(() => {
    const m = this.minutos();
    if (m === null) return 'la de este equipo';

    return `UTC${m < 0 ? '-' : '+'}${dos(Math.abs(m) / 60)}:${dos(Math.abs(m) % 60)}`;
  });

  /**
   * A quién se le preguntó ya, para no repetirlo en cada repintado.
   *
   * El efecto de abajo corre cada vez que cambia el objeto del usuario en
   * sesión, y ese objeto se reemplaza al renovar el token — sin esto, cada
   * renovación dispararía otra petición.
   */
  private preguntadoPor = '';

  private readonly vigilarLaSesion = effect(() => {
    const quien = this.auth.currentUser()?.UserID ?? '';

    if (!quien) {
      this.preguntadoPor = '';

      return;
    }

    if (quien === this.preguntadoPor) return;

    this.preguntadoPor = quien;
    void this.refrescar();
  });

  /**
   * Se le pregunta a Module con qué hora hay que pintar.
   *
   * Si no contesta —sin red, sesión de chat no válida— se queda lo que
   * hubiera: lo guardado de la vez anterior, o lo que trajo el login. Que no se
   * pueda refrescar la zona no puede dejar la aplicación sin fechas.
   */
  async refrescar(): Promise<void> {
    try {
      const { ChatApi } = await import('../../features/chat/chat.api');
      const zona = await this.injector.get(ChatApi).zona();

      /*
       * Solo se toma si el servidor resolvió un **código**.
       *
       * Sin esa condición, los minutos de una zona que no se pudo averiguar
       * —que llegan como cero— se tomarían por la zona cero, o sea Greenwich, y
       * a quien no tenga zona apuntada le correrían todas las horas sin que
       * nada lo dijera.
       */
      if (!zona?.codigo) return;

      this.guardada.set(zona.minutos);
      this.nombre.set(zona.nombre || zona.codigo);
      this.origen.set('el servidor');

      guardar(zona.minutos, zona.nombre || zona.codigo);
    } catch {
      // Ver el comentario de arriba.
    }
  }

  /** Al cerrar sesión: la zona era de quien se fue. */
  olvidar(): void {
    this.guardada.set(null);
    this.nombre.set('');
    this.origen.set('este equipo');
    this.preguntadoPor = '';

    try {
      localStorage.removeItem(CLAVE);
      localStorage.removeItem(CLAVE_NOMBRE);
    } catch {
      // Un navegador que no deja guardar tampoco deja borrar. No pasa nada: lo
      // de memoria ya está limpio, y es lo que se usa.
    }
  }

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
}

function dos(n: number): string {
  return String(Math.floor(n)).padStart(2, '0');
}

function leerGuardada(): number | null {
  try {
    const crudo = localStorage.getItem(CLAVE);
    if (crudo === null) return null;

    const n = Number(crudo);

    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function leerNombre(): string {
  try {
    return localStorage.getItem(CLAVE_NOMBRE) ?? '';
  } catch {
    return '';
  }
}

function guardar(minutos: number, nombre: string): void {
  try {
    localStorage.setItem(CLAVE, String(minutos));
    localStorage.setItem(CLAVE_NOMBRE, nombre);
  } catch {
    // Un navegador en modo privado, o el almacenamiento lleno. Se queda en
    // memoria para esta sesión y se vuelve a pedir en la siguiente.
  }
}
