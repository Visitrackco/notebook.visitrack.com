/**
 * Reducción de fotografías antes de guardarlas.
 *
 * ## Por qué hace falta
 *
 * Una captura de webcam en 1080p pesa entre uno y dos megas, y una fotografía
 * arrastrada desde el disco —doce megapíxeles— entre cuatro y seis. La app
 * móvil, en cambio, deja cada foto en unos cien kilobytes: la reduce a 700
 * píxeles con calidad 70 antes de tocar el disco.
 *
 * En una inspección de veinte fotos esa diferencia es **dos megas contra
 * ochenta**. Y no es solo espacio: es lo que hay que subir desde donde haya
 * señal, y lo que ocupa un almacenamiento —el del navegador— que tiene un tope
 * y que al llenarse hace fallar el guardado.
 *
 * ## Qué no se toca
 *
 * Solo las fotografías. Una firma es un PNG pequeño y opaco cuyo trazo hay que
 * conservar; pasarla a JPEG con calidad 70 le añadiría suciedad alrededor de
 * las líneas para no ahorrar nada. Los audios, videos y documentos van tal cual.
 */

/**
 * Los tres niveles de la app, con sus mismos valores.
 *
 * `[lado mayor, calidad]`. Se replican en vez de inventar otros para que una
 * misma cuenta produzca fotografías comparables desde el teléfono y desde el
 * navegador: si el informe de una sede mezcla fotos de 700 y de 1600 píxeles,
 * la diferencia se lee como que unas están peor tomadas.
 */
export const IMAGE_PRESETS: Record<string, [number, number]> = {
  alta: [1200, 80],
  media: [900, 75],
  baja: [700, 70],
};

/** El de la app: baja. */
export const IMAGE_QUALITY_DEFAULT = 'baja';

/** La clave del ajuste, la misma que guarda el teléfono. */
export const IMAGE_QUALITY_KEY = 'imageQualityLevel';

/** Lado mayor al que se reduce por omisión. */
export const IMAGE_LIMIT = IMAGE_PRESETS[IMAGE_QUALITY_DEFAULT][0];

/** Calidad del JPEG resultante, de 1 a 100. */
export const IMAGE_QUALITY = IMAGE_PRESETS[IMAGE_QUALITY_DEFAULT][1];

/** El preset de un nivel, cayendo al de la app si el nombre no existe. */
export function presetOf(level: string): [number, number] {
  return IMAGE_PRESETS[level] ?? IMAGE_PRESETS[IMAGE_QUALITY_DEFAULT];
}

export interface CompressOptions {
  limit?: number;
  /** De 1 a 100, como en la app. Aquí se traduce al 0–1 que espera el lienzo. */
  quality?: number;
}

/**
 * Devuelve la imagen reducida, o la original si no se pudo o no valía la pena.
 *
 * **Nunca falla hacia arriba**: una foto que no se pudo reducir se guarda como
 * estaba. Perder calidad es un ajuste; perder la fotografía de una inspección
 * es perder la prueba de que se hizo.
 */
export async function compressImage(blob: Blob, options: CompressOptions = {}): Promise<Blob> {
  const limit = options.limit ?? IMAGE_LIMIT;
  const quality = (options.quality ?? IMAGE_QUALITY) / 100;

  try {
    const bitmap = await createImageBitmap(blob);

    const { width, height } = bitmap;
    const mayor = Math.max(width, height);

    // Ya es pequeña: recomprimirla solo le quitaría calidad.
    if (mayor <= limit) {
      bitmap.close();
      return blob;
    }

    const escala = limit / mayor;
    const ancho = Math.round(width * escala);
    const alto = Math.round(height * escala);

    const canvas = document.createElement('canvas');
    canvas.width = ancho;
    canvas.height = alto;

    const ctx = canvas.getContext('2d');

    if (!ctx) {
      bitmap.close();
      return blob;
    }

    ctx.drawImage(bitmap, 0, 0, ancho, alto);
    bitmap.close();

    const reducida = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality),
    );

    // Si el resultado no es más liviano —pasa con imágenes ya muy
    // comprimidas— se conserva el original.
    if (!reducida || reducida.size >= blob.size) return blob;

    return reducida;
  } catch (error) {
    console.warn('[Imagen] no se pudo reducir; se guarda como está', error);
    return blob;
  }
}
