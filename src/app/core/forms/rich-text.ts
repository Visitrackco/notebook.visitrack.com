/**
 * Texto enriquecido de los campos de área.
 *
 * ## El contrato con la app
 *
 * El valor se guarda como **HTML sanitizado**, y como **texto plano** cuando no
 * lleva ningún formato. Es lo que hace `RichTextHelpers.serializeForStorage` en
 * la app, y respetarlo es lo que permite que una actividad diligenciada en el
 * móvil se lea aquí y al revés.
 *
 * Guardar Delta de Quill —el formato nativo del editor del móvil— habría atado
 * los dos clientes a una librería concreta; guardar HTML los deja hablando un
 * idioma que cualquiera entiende.
 *
 * ## Por qué se sanea en los dos sentidos
 *
 * Al **guardar**, porque el contenido pasa por `innerHTML` de un elemento
 * editable y ahí el usuario puede pegar cualquier cosa: una tabla de Excel trae
 * estilos, y una página web pegada puede traer un `<script>`.
 *
 * Al **leer**, porque el HTML puede venir del servidor o de otro cliente. Si
 * alguien manipulara el valor en la base de datos, este es el punto donde se
 * detiene antes de acabar en el DOM.
 */

/** Etiquetas que sobreviven. Las mismas que admite la app. */
const ALLOWED_TAGS = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li', 'span']);

/**
 * Etiquetas que pueden llevar `style`.
 *
 * Al combinar negrita y color, el editor emite `<strong style="color:…">` en
 * vez de envolver en un `<span>`, así que restringir el estilo solo a `span`
 * perdería el color del usuario.
 */
const TAGS_WITH_STYLE = new Set(['span', 'strong', 'b', 'em', 'i', 'u', 'p']);

/** Propiedades CSS admitidas: color de letra y de resaltado, nada más. */
const ALLOWED_CSS = new Set(['color', 'background-color']);

/** Etiquetas que se eliminan **con su contenido**, no solo la etiqueta. */
const DANGEROUS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'style',
  'link',
  'meta',
  'svg',
  'math',
]);

/** ¿Este valor lleva formato, o es texto plano? */
export function isHtml(value: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(value ?? '');
}

/**
 * Deja el HTML en lo que se puede mostrar sin riesgo.
 *
 * Se apoya en el propio analizador del navegador y no en expresiones
 * regulares: un HTML mal formado a propósito —etiquetas sin cerrar,
 * comentarios a medias— engaña a una expresión regular pero no al analizador,
 * que es el que después va a interpretar el resultado.
 *
 * El árbol se construye con `DOMParser`, que **no ejecuta nada**: los scripts
 * no corren y las imágenes no se descargan, a diferencia de asignar a
 * `innerHTML`.
 */
export function sanitizeHtml(raw: string): string {
  const value = raw ?? '';
  if (!value || !isHtml(value)) return value;

  const doc = new DOMParser().parseFromString(value, 'text/html');

  // Primero lo que se va entero, con su contenido dentro.
  for (const tag of DANGEROUS) {
    doc.body.querySelectorAll(tag).forEach((node) => node.remove());
  }

  clean(doc.body);
  return doc.body.innerHTML;
}

/**
 * Recorre el árbol quitando lo que no está admitido.
 *
 * Una etiqueta fuera de la lista **no se borra con su contenido**: se
 * reemplaza por lo que llevaba dentro. Un `<div>` que envuelve un párrafo es
 * ruido, pero el párrafo es lo que el usuario escribió.
 */
function clean(parent: Element): void {
  // Copia del listado: se va a modificar el árbol mientras se recorre.
  for (const node of [...parent.children]) {
    const tag = node.tagName.toLowerCase();

    if (!ALLOWED_TAGS.has(tag)) {
      clean(node);
      node.replaceWith(...node.childNodes);
      continue;
    }

    const style = TAGS_WITH_STYLE.has(tag) ? sanitizeStyle(node.getAttribute('style')) : '';

    // Todos los atributos fuera: `onclick`, `href="javascript:"`, `class`…
    // Solo vuelve el estilo, ya filtrado.
    for (const attribute of [...node.attributes]) node.removeAttribute(attribute.name);
    if (style) node.setAttribute('style', style);

    clean(node);
  }
}

/** Conserva solo el color y el resaltado, y solo si son valores reconocibles. */
function sanitizeStyle(raw: string | null): string {
  if (!raw) return '';

  const kept: string[] = [];

  for (const rule of raw.split(';')) {
    const [name, ...rest] = rule.split(':');
    const property = (name ?? '').trim().toLowerCase();
    const value = rest.join(':').trim();

    if (!ALLOWED_CSS.has(property) || !value) continue;

    // Solo colores literales. Descarta `url(...)`, `expression(...)` y
    // cualquier función, que es por donde se cuela lo demás.
    if (!/^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]+)$/i.test(value)) continue;

    kept.push(`${property}: ${value}`);
  }

  return kept.join('; ');
}

/**
 * Prepara el valor para guardarlo.
 *
 * Sin formato se guarda el texto plano: un `<p>hola</p>` para escribir «hola»
 * ensucia los descriptivos del listado y las exportaciones. Es la misma
 * decisión que toma la app.
 */
export function serializeForStorage(html: string): string {
  const clean = sanitizeHtml(html ?? '');
  const text = toPlainText(clean).trimEnd();

  if (!text) return '';

  // Sin etiquetas de formato de verdad —solo párrafos o saltos— vale el texto.
  return hasFormatting(clean) ? clean : text;
}

/** ¿Lleva algo más que párrafos y saltos de línea? */
function hasFormatting(html: string): boolean {
  if (!isHtml(html)) return false;

  const doc = new DOMParser().parseFromString(html, 'text/html');

  return [...doc.body.querySelectorAll('*')].some((node) => {
    const tag = node.tagName.toLowerCase();
    return (tag !== 'p' && tag !== 'br') || node.hasAttribute('style');
  });
}

/** El texto sin etiquetas, para contar caracteres y para los descriptivos. */
export function toPlainText(value: string): string {
  if (!value) return '';
  if (!isHtml(value)) return value;

  const doc = new DOMParser().parseFromString(value, 'text/html');
  return doc.body.textContent ?? '';
}
