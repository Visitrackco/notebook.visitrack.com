/**
 * El contenido de un Blob como bytes.
 *
 * Se guardan bytes y no el Blob en `BinariesData` porque Safari en navegación
 * privada rechaza guardar un Blob en IndexedDB (ver `BinaryData`).
 * `Blob.arrayBuffer` falta en Safari anterior a iOS 14: ahí se lee con
 * `FileReader`, que está en todos.
 */
export function aBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();

  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onload = () => resolve(lector.result as ArrayBuffer);
    lector.onerror = () => reject(lector.error);
    lector.readAsArrayBuffer(blob);
  });
}

/** El contenido guardado en `BinariesData` como Blob: el nuevo (bytes) o el de antes. */
export function comoBlob(data: { blob?: Blob; bytes?: ArrayBuffer; mimeType?: string } | undefined): Blob | null {
  if (data?.bytes) return new Blob([data.bytes], { type: data.mimeType || '' });
  return data?.blob ?? null;
}
