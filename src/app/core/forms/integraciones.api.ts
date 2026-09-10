import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';

import { apiBaseUrlDirecta, cabeceraDeEnlace } from '../config/api-base';
import { SEGUNDOS_DE_LLAMADA } from './flujo-modelo';

/**
 * Lo que respondió una llamada a un servicio externo.
 *
 * Tres desenlaces y no dos, que es justo lo que había que distinguir:
 *
 * - **respondió** (`ok`), con sus datos;
 * - **el servicio dijo que no** (`ok:false` con 200), con su código y su mensaje
 *   ya redactado en español por el intermediario;
 * - **no se pudo preguntar** — sin red, se acabó el tiempo, el servidor devolvió
 *   algo que no se entiende.
 *
 * Los dos últimos son errores, pero no el mismo error, y quien está
 * diligenciando necesita saber cuál: uno se arregla buscándose una conexión y el
 * otro no se arregla de ninguna manera.
 */
/**
 * El archivo que devolvió una integración de PDF, imagen o archivo.
 *
 * Se separa de `datos` porque no es un dato: no se puede recorrer con una ruta
 * ni escribir en un campo de texto. Lo que sí se puede escribir es su ficha
 * —las tres primeras claves—, que es exactamente lo que el lienzo ofrece al
 * configurar las salidas de una integración de este tipo.
 */
export interface ArchivoDeIntegracion {
  nombre: string;
  tipoMime: string;

  /** Cuánto ocupa de verdad, en bytes. No es el tamaño del base64. */
  tamano: number;

  contenidoBase64: string;
}

/** La ficha del archivo: lo que se le entrega al motor como respuesta. */
export function fichaDelArchivo(
  archivo: ArchivoDeIntegracion,
): Record<string, unknown> {
  return {
    nombre: archivo.nombre,
    tipoMime: archivo.tipoMime,
    tamano: archivo.tamano,
  };
}

/**
 * Cómo se ve lo que respondió un servicio, para la traza.
 *
 * Lo que hace falta para casar una `ruta` con la respuesta son **las claves** y
 * la forma, no el contenido entero: una respuesta de cien registros llenaría la
 * consola sin decir nada más que las tres primeras líneas. Por eso se nombran
 * las claves de primer nivel y se recorta el resto.
 *
 * Gemela de `_comoSeVeLaRespuesta` en la app.
 */
export function comoSeVeLaRespuesta(datos: unknown): string {
  if (datos === null || datos === undefined) return 'sin datos';

  let forma: string;

  if (Array.isArray(datos)) {
    forma = `una lista de ${datos.length}`;
  } else if (typeof datos === 'object') {
    forma = `un objeto con ${Object.keys(datos as object).join(', ')}`;
  } else {
    forma = 'un valor suelto';
  }

  try {
    const texto = JSON.stringify(datos);

    return `${forma} — ${texto.length > 400 ? `${texto.slice(0, 400)}…` : texto}`;
  } catch {
    // Algo que no se puede serializar no impide contar la forma, que es lo que
    // de verdad hace falta para casar la ruta.
    return forma;
  }
}

export interface RespuestaDeIntegracion {
  ok: boolean;

  /**
   * Lo que respondió el servicio. Cualquier cosa que quepa en un JSON.
   *
   * Cuando la integración devuelve un archivo, aquí llega su ficha y el
   * contenido va aparte, en [archivo].
   */
  datos?: unknown;

  /** El archivo, cuando la integración devuelve uno. Ausente en las de JSON. */
  archivo?: ArchivoDeIntegracion;

  /** Qué clase de fallo fue, en una palabra. Ver [CODIGOS_DEL_INTERMEDIARIO]. */
  codigo?: string;

  /** Qué pasó, con palabras y en español, listo para enseñárselo a alguien. */
  mensaje?: string;

  reintentable?: boolean;
}

/**
 * Los códigos que puede devolver el intermediario.
 *
 * Se anotan para tenerlos a la vista y **no para traducirlos**: cada uno llega
 * con su `mensaje` ya redactado pensando en quien está diligenciando, y escribir
 * otro encima daría dos redacciones del mismo fallo.
 */
export const CODIGOS_DEL_INTERMEDIARIO = [
  'tiempo-agotado',
  'no-autorizado',
  'no-encontrado',
  'servicio-caido',
  'respuesta-ilegible',
  'peticion-rechazada',
  'limite-excedido',
  'limite-local-excedido',
  'destino-no-permitido',
  'respuesta-demasiado-grande',
  'demasiadas-redirecciones',
  'certificado-invalido',
  'configuracion-incompleta',
  'error-interno',

  /*
   * Lo declarado y lo que llegó no coinciden.
   *
   * El caso que lo motivó: una sesión caducada que devuelve la pantalla de
   * acceso con un 200. Sin este código eso se guardaría como si fuera el
   * certificado que se esperaba. Su `mensaje` ya viene nombrando las dos cosas.
   */
  'tipo-inesperado',
] as const;

/** Los que pone el navegador, para lo que pasa antes de llegar al intermediario. */
export const CODIGO_SIN_CONEXION = 'sin-conexion';

/**
 * El cliente del intermediario de integraciones.
 *
 * ## Qué no sabe
 *
 * A dónde llama de verdad cada integración, y con qué credencial. Eso lo sabe el
 * intermediario y solo él: aquí viaja el identificador de la integración y lo que
 * se le manda, nada más. Un flujo se descarga a todos los aparatos que
 * sincronizan ese formulario, así que una credencial escrita en la regla es una
 * credencial repartida por ahí.
 *
 * Modelado sobre `ListSearchApi`: devuelve el fallo en vez de lanzarlo, porque
 * un servicio de un tercero que no responde no puede tumbar el formulario de
 * quien está trabajando.
 */
@Injectable({ providedIn: 'root' })
export class IntegracionesApi {
  private readonly http = inject(HttpClient);

  /**
   * Dónde se pide la llamada.
   *
   * El servidor de siempre, el mismo de la sincronización. El navegador **no**
   * habla con el intermediario: allí llega por una puerta de este servidor
   * —`/integrations/ejecutar`—, que es quien conoce su dirección y quien se
   * identifica ante él. Así aquí no hay ninguna dirección más que mantener ni
   * ninguna segunda credencial: vale la sesión con la que ya se sincroniza, que
   * es la que pone `authInterceptor`.
   */
  private get baseUrl(): string {
    /*
     * Sin el prefijo del enlace, **a proposito**.
     *
     * Esta llamada va a la ruta de siempre, `/integrations/ejecutar`, tambien
     * cuando el formulario se abrio desde un enlace publico. Quien dice de parte
     * de quien va es la cabecera `x-enlace`, no un tramo de la direccion: una
     * credencial va en una cabecera, y en la URL se colaria en el registro del
     * servidor y en el de cualquier proxy.
     *
     * Del otro lado la reconoce `middlewares/auth.js`, que resuelve el enlace y
     * planta la identidad que `ejecutar` exige.
     */
    return apiBaseUrlDirecta();
  }

  /**
   * Lo que se espera de más sobre lo que dijo la regla.
   *
   * El intermediario tiene su **propio** tope para el servicio de terceros
   * —hasta 60 s por integración— y, cuando se le acaba, todavía tiene que
   * redactar su respuesta y devolverla. Si el navegador cortara justo en el
   * segundo que dijo la regla, esa carrera la ganaría siempre el navegador: se
   * perdería el mensaje del intermediario, que es el que explica qué pasó.
   *
   * Con este margen gana el intermediario cuando los dos plazos coinciden, y el
   * corte local se queda para lo que de verdad tiene que cubrir: que no conteste
   * nadie.
   */
  private static readonly MARGEN_SEGUNDOS = 5;

  /**
   * Ejecuta una integración. **Nunca lanza.**
   *
   * [segundos] es el tope que dijo la regla. Se respeta tal cual: quien lo
   * configuró sabe cuánto tarda su servicio, y acortarlo por nuestra cuenta
   * convertiría una integración lenta pero buena en una que siempre falla.
   */
  async ejecutar(
    integracionId: string,
    entradas: Record<string, string>,
    segundos = SEGUNDOS_DE_LLAMADA,
  ): Promise<RespuestaDeIntegracion> {
    /*
     * Sin red no se marca.
     *
     * Se comprueba antes de salir para poder decir «no hay conexión» en vez de
     * esperar a que se agote el tiempo y decir algo más vago.
     */
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return {
        ok: false,
        codigo: CODIGO_SIN_CONEXION,
        mensaje:
          'No hay conexión a internet. Esta consulta necesita red; ' +
          'inténtalo otra vez cuando vuelvas a tenerla.',
        reintentable: true,
      };
    }

    return this.intentar(integracionId, entradas, segundos);
  }

  /** La llamada, y la lectura de lo que conteste. */
  private async intentar(
    integracionId: string,
    entradas: Record<string, string>,
    segundos: number,
  ): Promise<RespuestaDeIntegracion> {
    try {
      const respuesta = await firstValueFrom(
        this.http
          .post<{
            ok?: boolean;
            datos?: unknown;
            archivo?: Partial<ArchivoDeIntegracion>;
            error?: Record<string, unknown>;
          }>(
            `${this.baseUrl}/integrations/ejecutar`,
            // Numérico: el intermediario lo exige así, y en el flujo se guarda
            // como texto porque es una clave más dentro de un JSON.
            { integracionId: Number(integracionId) || integracionId, entradas },
            { headers: { 'Content-Type': 'application/json', ...cabeceraDeEnlace() } },
          )
          .pipe(timeout((segundos + IntegracionesApi.MARGEN_SEGUNDOS) * 1000)),
      );

      if (respuesta?.ok === true) {
        /*
         * Una integración de PDF, imagen o archivo responde `archivo` y **no
         * trae `datos`**.
         *
         * Leer solo `datos` daba un éxito con la respuesta vacía: el campo no se
         * llenaba, no había mensaje de error y desde fuera parecía que el
         * servicio no había contestado.
         */
        const archivo = this.leerArchivo(respuesta.archivo);

        if (archivo) return { ok: true, datos: fichaDelArchivo(archivo), archivo };

        return { ok: true, datos: respuesta.datos };
      }

      const error = (respuesta?.error ?? {}) as Record<string, unknown>;
      const mensaje = String(error['mensaje'] ?? '').trim();

      return {
        ok: false,
        codigo: String(error['codigo'] ?? 'error-interno').trim(),

        // El mensaje del intermediario manda. Solo se pone algo cuando viene en
        // blanco, porque un fallo mudo es indistinguible de una app rota.
        mensaje: mensaje || 'El servicio no pudo responder.',
        reintentable: error['reintentable'] === true,
      };
    } catch (error: unknown) {
      /*
       * Un fallo del servicio de un tercero llega como **200** con `ok:false`,
       * así que llegar hasta aquí es otra cosa: el intermediario no está, se
       * acabó el tiempo, o la red se cayó a mitad. Se distingue, porque no se
       * arregla igual.
       */
      const status = (error as { status?: number })?.status ?? 0;

      // Se acabó el plazo local. No es lo mismo que quedarse sin red —el
      // servidor puede estar contestando ahora mismo— y por eso se dice
      // distinto, igual que en la app.
      if ((error as { name?: string })?.name === 'TimeoutError') {
        return {
          ok: false,
          codigo: 'tiempo-agotado',
          mensaje: `La consulta tardó más de ${segundos} segundos y se canceló. Puedes volver a intentarlo.`,
          reintentable: true,
        };
      }

      if (status === 0) {
        return {
          ok: false,
          codigo: CODIGO_SIN_CONEXION,
          mensaje:
            'No se pudo llegar al servidor. Revisa tu conexión e inténtalo otra vez.',
          reintentable: true,
        };
      }

      return {
        ok: false,
        codigo: 'servicio-caido',
        mensaje: `El servidor de integraciones respondió con un error (${status}). Inténtalo de nuevo en un momento.`,
        reintentable: true,
      };
    }
  }

  /**
   * El archivo de la respuesta, si lo hay y está entero.
   *
   * Se exige el contenido: sin él no hay archivo que enseñar, y devolver una
   * ficha suelta dejaría en pantalla el nombre de algo que no llegó.
   */
  private leerArchivo(
    crudo: Partial<ArchivoDeIntegracion> | undefined,
  ): ArchivoDeIntegracion | null {
    const contenido = String(crudo?.contenidoBase64 ?? '');
    if (!contenido) return null;

    const nombre = String(crudo?.nombre ?? '').trim();
    const tipoMime = String(crudo?.tipoMime ?? '').trim();

    return {
      // Sin nombre se le pone uno: el archivo se nombra en pantalla, y un
      // renglón que dice «llegó «»» no se entiende.
      nombre: nombre || 'archivo',
      tipoMime: tipoMime || 'application/octet-stream',
      tamano: Number(crudo?.tamano) || 0,
      contenidoBase64: contenido,
    };
  }
}
