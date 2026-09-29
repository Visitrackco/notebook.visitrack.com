/**
 * Un GUID v4, también en navegadores sin `crypto.randomUUID`.
 *
 * `randomUUID` solo existe en contextos seguros y en Safari desde iOS 15.4: en
 * un iPhone más viejo lanzaba y, entre otras cosas, no se podía guardar ninguna
 * foto («No se pudo guardar el archivo»). `getRandomValues` está en todos; y
 * si ni eso hubiera, `Math.random`, que para un identificador local basta.
 */
export function nuevoGuid(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();

  const b = new Uint8Array(16);
  if (typeof c?.getRandomValues === 'function') {
    c.getRandomValues(b);
  } else {
    for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  }

  // Versión 4 y variante RFC 4122.
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;

  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
