import { Injectable, computed, signal } from '@angular/core';

import { TEXTOS, type ClaveTexto } from './textos';

/**
 * Idiomas de la interfaz.
 *
 * Español es el de siempre y el que sale por omisión; inglés es el segundo.
 */
export type Idioma = 'es' | 'en';

/** Valores para `{nombre}` dentro de un texto. */
export type ParametrosTexto = Record<string, string | number | null | undefined>;

/** Clave del idioma elegido en `localStorage`. */
const kClaveIdioma = 'vt.idioma';

/** Locale de formato (fechas y cifras) que corresponde a cada idioma. */
const kLocales: Record<Idioma, string> = { es: 'es-CO', en: 'en-US' };

function leerGuardado(): Idioma {
  try {
    const guardado = localStorage.getItem(kClaveIdioma);
    return guardado === 'en' ? 'en' : 'es';
  } catch {
    // Almacenamiento bloqueado (modo privado estricto): se queda en español.
    return 'es';
  }
}

/**
 * El idioma vive a nivel de módulo, no dentro del servicio.
 *
 * Hay funciones sueltas —formateadores de fecha, utilidades que no son
 * componentes— que también tienen que saber en qué idioma pintar, y no tienen
 * inyector a mano. Con la signal aquí arriba todos leen la misma, y como es una
 * signal, cualquier plantilla que la lea se vuelve a pintar sola al cambiar.
 */
const idiomaActual = signal<Idioma>(leerGuardado());

function aplicarAlDocumento(idioma: Idioma): void {
  if (typeof document !== 'undefined') document.documentElement.lang = idioma;
}

aplicarAlDocumento(idiomaActual());

/**
 * Traduce una clave al idioma actual.
 *
 * Los parámetros se escriben `{nombre}` dentro del texto. Si una clave no
 * existiera —no debería: el tipo `ClaveTexto` lo impide— se devuelve la propia
 * clave, que en pantalla se nota enseguida.
 */
export function traducir(clave: ClaveTexto, parametros?: ParametrosTexto): string {
  const par = TEXTOS[clave] as readonly [string, string] | undefined;
  if (!par) return clave;

  let texto = idiomaActual() === 'en' ? par[1] : par[0];
  if (parametros) {
    for (const [nombre, valor] of Object.entries(parametros)) {
      texto = texto.split(`{${nombre}}`).join(valor == null ? '' : String(valor));
    }
  }
  return texto;
}

/** Locale para `toLocaleString`, `Intl` y el pipe `date` (`es-CO` / `en-US`). */
export function localeActual(): string {
  return kLocales[idiomaActual()];
}

/** El idioma actual, para código que no inyecta el servicio. */
export function idiomaDeLaInterfaz(): Idioma {
  return idiomaActual();
}

/**
 * Idioma de la interfaz, cambiable en caliente.
 *
 * ## Por qué así y no con la i18n de Angular
 *
 * La i18n de compilación de Angular genera un paquete por idioma, y aquí hay un
 * solo despliegue: la persona cambia de idioma en el login o en su perfil y lo
 * ve al instante, sin recargar. Para eso basta un diccionario por clave y una
 * signal; el pipe `t` lee la signal, así que todo lo que está en pantalla se
 * vuelve a pintar solo.
 *
 * Solo se traducen los textos fijos de la aplicación. Lo que escribe la gente
 * —etiquetas de formularios, nombres de ubicaciones, mensajes del chat— y lo
 * que manda el servidor se muestra tal cual.
 */
@Injectable({ providedIn: 'root' })
export class IdiomaService {
  /** Idioma actual. */
  readonly idioma = idiomaActual.asReadonly();

  /** Locale de formato que corresponde al idioma actual. */
  readonly locale = computed(() => kLocales[idiomaActual()]);

  /** Opciones para el selector. Los nombres van en su propio idioma. */
  readonly opciones: readonly { valor: Idioma; nombre: string; corto: string }[] = [
    { valor: 'es', nombre: 'Español', corto: 'ES' },
    { valor: 'en', nombre: 'English', corto: 'EN' },
  ];

  cambiar(idioma: Idioma): void {
    if (idioma === idiomaActual()) return;
    idiomaActual.set(idioma);
    aplicarAlDocumento(idioma);
    try {
      localStorage.setItem(kClaveIdioma, idioma);
    } catch {
      // Sin almacenamiento la elección dura lo que dure la pestaña.
    }
  }

  /** Atajo de `traducir` para quien ya inyecta el servicio. */
  t(clave: ClaveTexto, parametros?: ParametrosTexto): string {
    return traducir(clave, parametros);
  }
}
