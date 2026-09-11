import { environment } from '../../../environments/environment';

/**
 * Configuración que se resuelve al arrancar, no al compilar.
 *
 * ## El problema
 *
 * `environment.ts` se hornea dentro del paquete: la dirección del backend queda
 * escrita en un `.js` con hash en el nombre. Cambiarla obliga a recompilar y
 * volver a desplegar, y eso convierte «apunta a preproducción un rato» en una
 * tarea de despliegue. Peor: el mismo `dist/` no puede servir para dos entornos,
 * así que lo que se prueba nunca es exactamente lo que se publica.
 *
 * ## Cómo se resuelve
 *
 * Antes de levantar la aplicación se pide `config.json` a quien la esté
 * sirviendo. El servidor de Node lo genera **en cada petición** a partir de sus
 * variables de entorno, así que cambiar la dirección es cambiar la variable —
 * no hay compilación de por medio.
 *
 * Lo que venga en ese archivo pisa lo compilado. Lo que no venga, se queda como
 * está: `config.json` es un juego de excepciones, no la configuración entera.
 *
 * ## Si no hay archivo
 *
 * No pasa nada y es a propósito. Con `ng serve` no existe, y en un hosting
 * estático puede no existir nunca: en ambos casos la aplicación sigue con los
 * valores compilados. Un arranque que falla porque falta un archivo opcional
 * deja la pantalla en blanco sin decir por qué, que es la peor forma de avisar.
 */

/** Las claves que pueden cambiarse desde fuera, con el tipo que se espera. */
const OVERRIDABLE = {
  apiUrl: 'string',
  platformUrl: 'string',
  localApiUrl: 'string',
  binariesUrl: 'string',

  // Donde vive el chat. Se puede cambiar desde fuera como las demas: en una
  // instalacion propia Module no esta en la direccion de siempre.
  moduleUrl: 'string',
  useLocalApi: 'boolean',
  requestTimeout: 'number',
  syncIntervalMinutes: 'number',
} as const;

type Overridable = keyof typeof OVERRIDABLE;

/**
 * Trae `config.json` y aplica lo que traiga sobre `environment`.
 *
 * Se llama **antes** de `bootstrapApplication`. Ahí está lo que hace que
 * funcione sin tocar los dieciséis archivos que leen `environment`: ninguno
 * guarda el valor al cargarse —todos lo leen dentro de un método, en el momento
 * de usarlo—, así que para cuando el primero pregunte, el objeto ya está
 * corregido.
 */
export async function loadRuntimeConfig(): Promise<void> {
  try {
    /**
     * Relativo al `<base href>` y no a la raíz: así sigue funcionando si algún
     * día la aplicación cuelga de un subdirectorio.
     */
    const url = new URL('config.json', document.baseURI);

    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return;

    /**
     * Un servidor de una sola página responde `index.html` a lo que no
     * encuentra, con estado 200. Sin esta comprobación se intentaría leer ese
     * HTML como JSON y el fallo aparecería como un error de sintaxis en
     * consola, que no se parece en nada a «falta config.json».
     */
    if (!response.headers.get('content-type')?.includes('json')) return;

    apply(await response.json());
  } catch {
    // Sin configuración externa: quedan los valores compilados.
  }
}

/** Copia las claves conocidas, comprobando el tipo de cada una. */
function apply(config: unknown): void {
  if (!config || typeof config !== 'object') return;

  const source = config as Record<string, unknown>;
  const target = environment as Record<string, unknown>;

  for (const [key, expected] of Object.entries(OVERRIDABLE) as [Overridable, string][]) {
    const value = source[key];

    /**
     * Un tipo que no cuadra se ignora en vez de escribirse. `requestTimeout`
     * como la cadena `"30"` haría que todas las peticiones vencieran de
     * inmediato, y el síntoma —la aplicación no conecta— no señalaría al
     * archivo de configuración.
     */
    if (typeof value !== expected) continue;

    target[key] = value;
  }
}
