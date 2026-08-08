import { FormPage, asFile, parseQuestions, valueToText } from '../../core/forms/form-schema';
import { AnswerField } from '../../core/forms/form-schema';

/** Cómo se enseña un dato en la ficha. */
export type DetailKind =
  /** Texto corriente. */
  | 'text'
  /** Dirección: se puede abrir en un mapa. */
  | 'address'
  /** Correo: se puede escribir. */
  | 'email'
  /** Teléfono: se puede llamar. */
  | 'phone'
  /** Una imagen o una firma guardada. */
  | 'image'
  /** Un archivo que no es imagen. */
  | 'file';

/** Un dato de la ficha, ya resuelto. */
export interface DetailItem {
  lab: string;
  val: string;
  kind: DetailKind;
  /** GUID del archivo, cuando el dato es uno. */
  binary?: string;
  /** Ocupa el ancho entero: textos largos e imágenes. */
  wide?: boolean;
}

/** Un bloque de datos con su título. */
export interface DetailGroup {
  title: string;
  items: DetailItem[];
}

/**
 * Cómo se lee cada tipo de campo en una ficha.
 *
 * No es lo mismo enseñar un teléfono que una fotografía: el primero se puede
 * marcar y el segundo hay que verlo. Sin esta distinción, una ficha con fotos
 * enseñaría el identificador del archivo como si fuera un dato.
 */
const KIND_BY_TYPE: Record<string, DetailKind> = {
  email: 'email',
  phone: 'phone',
  cellphone: 'phone',
  addressline: 'address',
  picture: 'image',
  signature: 'image',
  image: 'image',
  file: 'file',
  video: 'file',
  audio: 'file',
};

/** Los campos que ocupan el ancho entero por lo que suelen contener. */
const WIDE_TYPES = new Set(['textarea', 'paragraph', 'picture', 'signature', 'image', 'gps']);

/**
 * Convierte las respuestas de una entidad en bloques legibles.
 *
 * ## Por qué agrupados por página
 *
 * El tipo organiza sus campos en páginas con título —«Datos generales»,
 * «Equipamiento»— y esa agrupación es información: dice qué va con qué. Una
 * lista plana de veinte datos obliga a leerlos todos para encontrar uno.
 *
 * ## Por qué se cruza con la estructura
 *
 * Lo guardado son pares de identificador y valor. El nombre de cada campo, su
 * tipo y su orden viven en la estructura del tipo, y sin cruzarlos la ficha
 * sería una lista de códigos sin orden.
 */
export function groupEntityValues(jsonQuestion: unknown, answers: AnswerField[]): DetailGroup[] {
  const pages: FormPage[] = parseQuestions(jsonQuestion);
  const byId = new Map(answers.map((answer) => [answer.id, answer]));

  const groups: DetailGroup[] = [];

  for (const [index, page] of pages.entries()) {
    const items: DetailItem[] = [];

    for (const field of page.fie) {
      // Los títulos y párrafos son rótulos del formulario, no datos: en una
      // ficha de consulta solo añadirían ruido.
      if (field.fty === 'title' || field.fty === 'paragraph') continue;

      const answer = byId.get(field.id);
      if (!answer) continue;

      const file = asFile(answer.val ?? null);
      const value = valueToText(answer.val ?? null);

      // Un campo sin responder no se enseña: una ficha llena de guiones hace
      // más difícil encontrar lo que sí tiene valor.
      if (!file && !value.trim()) continue;

      const kind = KIND_BY_TYPE[field.fty] ?? 'text';

      items.push({
        lab: field.lab || field.id,
        val: value,
        kind,
        binary: file?.bin,
        wide: WIDE_TYPES.has(field.fty) || value.length > 60,
      });
    }

    if (items.length > 0) {
      groups.push({ title: page.lab?.trim() || (pages.length > 1 ? `Bloque ${index + 1}` : ''), items });
    }
  }

  return groups;
}
