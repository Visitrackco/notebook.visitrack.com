/**
 * Resaltado de lo buscado.
 *
 * Al escribir «bogota» en el buscador de ubicaciones aparece la sede de
 * «Bogotá», pero sin marcar dónde cayó la búsqueda el usuario tiene que leer
 * cada descriptivo para entender por qué salió. Esto parte el texto en trozos
 * —los que coinciden y los que no— para pintarlos con `<mark>`.
 *
 * ## Por qué trozos y no HTML
 *
 * Lo cómodo sería devolver `Bogo<mark>tá</mark>` y meterlo con `innerHTML`,
 * pero el texto viene de lo que alguien escribió en un formulario: un valor
 * con `<img onerror=…>` se ejecutaría. Con trozos, la plantilla los interpola
 * como texto y Angular los escapa; ningún carácter del valor llega a ser HTML.
 *
 * ## Sin mayúsculas ni tildes
 *
 * Se busca sobre una versión normalizada (minúsculas, sin tildes ni diéresis)
 * pero se pinta el texto **original**: quien escribió «Bogotá» lo sigue viendo
 * con su tilde. Como quitar una tilde cambia la longitud de la cadena (`á` en
 * NFD son dos caracteres), se lleva un mapa de cada posición normalizada a su
 * carácter de origen para cortar el original en el sitio correcto.
 */

/** Un trozo del texto: coincide con la búsqueda o no. */
export interface Segmento {
  texto: string;
  resaltado: boolean;
}

/** Marcas diacríticas combinantes (tildes, diéresis, virgulilla de la ñ…). */
const DIACRITICOS = /[̀-ͯ]/g;

/**
 * Forma de comparar: minúsculas y sin tildes. `«Ñandú»` → `«nandu»`.
 *
 * Es la misma regla para filtrar y para resaltar: si no lo fuera, una fila
 * podría salir en los resultados sin nada marcado, o al revés.
 */
export function normalizar(texto: unknown): string {
  return (texto ?? '').toString().normalize('NFD').replace(DIACRITICOS, '').toLowerCase();
}

/**
 * Parte [texto] en trozos según dónde aparece [busqueda], todas las veces.
 *
 * Sin búsqueda (o solo espacios) devuelve el texto entero sin resaltar. Los
 * caracteres especiales de una expresión regular (`.`, `*`, `(`…) se buscan
 * tal cual: aquí no hay expresión regular de por medio.
 */
export function segmentosResaltados(texto: unknown, busqueda: unknown): Segmento[] {
  const original = (texto ?? '').toString();
  if (!original) return [];

  const termino = normalizar(busqueda).trim();
  if (!termino) return [{ texto: original, resaltado: false }];

  // Versión normalizada y, por cada carácter suyo, el índice del carácter del
  // original de donde salió. Se recorre por puntos de código para no partir
  // un emoji o un carácter fuera del plano básico.
  let normalizado = '';
  const origen: number[] = [];
  let indice = 0;
  for (const caracter of original) {
    const forma = normalizar(caracter);
    for (let i = 0; i < forma.length; i++) origen.push(indice);
    normalizado += forma;
    indice += caracter.length;
  }
  origen.push(original.length);

  const segmentos: Segmento[] = [];
  let corte = 0;
  let desde = 0;

  while (desde <= normalizado.length - termino.length) {
    const encontrado = normalizado.indexOf(termino, desde);
    if (encontrado < 0) break;

    const inicio = origen[encontrado];
    // El final es el inicio del carácter que sigue a la coincidencia; así un
    // carácter que se expandió al normalizar entra completo.
    const ultimo = origen[encontrado + termino.length - 1];
    let fin = original.length;
    for (let i = encontrado + termino.length; i < origen.length; i++) {
      if (origen[i] > ultimo) {
        fin = origen[i];
        break;
      }
    }

    if (inicio > corte) segmentos.push({ texto: original.slice(corte, inicio), resaltado: false });
    if (fin > inicio) segmentos.push({ texto: original.slice(Math.max(inicio, corte), fin), resaltado: true });
    corte = Math.max(corte, fin);
    desde = encontrado + termino.length;
  }

  if (corte < original.length) segmentos.push({ texto: original.slice(corte), resaltado: false });
  return segmentos;
}
