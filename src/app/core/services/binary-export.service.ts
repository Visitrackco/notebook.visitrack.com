import { Injectable, inject } from '@angular/core';

import { BinaryResource } from '../models/sync.model';
import { SurveyAnswer } from '../models/entities.model';
import { BinaryResourceRepository } from '../repositories/binary.repository';
import { SurveyAnswerRepository } from '../repositories/survey-answer.repository';
import { AuthService } from './auth.service';
import { BinaryStorageService } from './binary-storage.service';

/** En qué va la exportación, para poder contarlo. */
export interface ExportProgress {
  done: number;
  total: number;
  /** Nombre del archivo que se está escribiendo. */
  current: string;
}

export interface ExportResult {
  ok: boolean;
  files: number;
  bytes: number;
  message: string;
}

/**
 * Tope del formato ZIP clásico, sin ZIP64.
 *
 * Por encima de esto los desplazamientos del directorio central no caben en
 * cuatro bytes y el archivo sale corrupto. Se avisa antes en vez de generar
 * algo que no abre.
 */
const ZIP_LIMIT = 4 * 1024 * 1024 * 1024 - 1;

/**
 * Sacar al computador los archivos que están en el navegador.
 *
 * ## Por qué hace falta
 *
 * En el móvil las fotos son archivos en el disco del teléfono: se conectan por
 * cable y se copian. En la web no existen como archivos — son `Blob` dentro de
 * IndexedDB, que es una base de datos del navegador. Están ahí, ocupan espacio,
 * y no hay ninguna forma de llegar a ellos desde el explorador de archivos.
 *
 * Este servicio es esa forma.
 *
 * ## Dos caminos
 *
 * - **Carpeta**: se elige una del computador y los archivos se escriben dentro,
 *   uno a uno. Es lo mejor cuando son muchos —no hay que esperar a que se arme
 *   nada ni cabe todo en memoria— pero depende de un permiso que hoy solo dan
 *   los navegadores basados en Chromium.
 * - **Comprimido**: un único `.zip` que descarga el navegador. Funciona en
 *   todos, a cambio de armarlo en memoria.
 *
 * El ZIP se escribe **sin comprimir** (método *store*). Las fotos, los audios y
 * los videos ya vienen comprimidos: pasarles *deflate* gasta tiempo y memoria
 * para ahorrar un uno por ciento. El .zip aquí sirve para empaquetar, no para
 * apretar.
 */
@Injectable({ providedIn: 'root' })
export class BinaryExportService {
  private readonly binaries = inject(BinaryResourceRepository);
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly storage = inject(BinaryStorageService);
  private readonly auth = inject(AuthService);

  /** ¿Puede este navegador escribir en una carpeta del computador? */
  get canWriteFolder(): boolean {
    return typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
  }

  /**
   * Todo lo que hay guardado, o solo lo de una actividad.
   *
   * @param answerGuid actividad concreta; sin él, todo lo del usuario.
   */
  async collect(answerGuid?: string): Promise<BinaryResource[]> {
    const user = this.auth.currentUser();
    if (!user) return [];

    const all = answerGuid
      ? await this.binaries.findByAnswer(answerGuid)
      : await this.binaries.getAll();

    // Sin `base` no hay contenido guardado: es una ficha de un archivo que
    // todavía no se ha podido traer. Exportarla dejaría un archivo de cero
    // bytes, que es peor que no dejar nada.
    return all.filter((binary) => !!binary.base);
  }

  /**
   * Escribe los archivos en una carpeta del computador.
   *
   * Pide la carpeta al usuario: el navegador nunca da acceso al disco sin que
   * alguien la escoja a mano.
   */
  async toFolder(
    files: readonly BinaryResource[],
    onProgress?: (progress: ExportProgress) => void,
  ): Promise<ExportResult> {
    if (!this.canWriteFolder) {
      return {
        ok: false,
        files: 0,
        bytes: 0,
        message: 'Este navegador no permite escribir en una carpeta. Descarga el comprimido.',
      };
    }

    try {
      const picker = (window as unknown as {
        showDirectoryPicker: (options?: { mode?: string }) => Promise<FileSystemDirectoryHandle>;
      }).showDirectoryPicker;

      const root = await picker({ mode: 'readwrite' });
      const names = await this.namesOf(files);

      const folders = new Map<string, FileSystemDirectoryHandle>();

      let done = 0;
      let bytes = 0;

      for (const file of files) {
        const path = names.get(file.GUID)!;
        const blob = await this.storage.loadBlob(file.GUID);

        done++;
        onProgress?.({ done, total: files.length, current: path.name });

        if (!blob) continue;

        let folder = folders.get(path.folder);

        if (!folder) {
          folder = await root.getDirectoryHandle(path.folder, { create: true });
          folders.set(path.folder, folder);
        }

        const handle = await folder.getFileHandle(path.name, { create: true });
        const stream = await handle.createWritable();

        await stream.write(blob);
        await stream.close();

        bytes += blob.size;
      }

      return {
        ok: true,
        files: done,
        bytes,
        message: `${done} archivo${done === 1 ? '' : 's'} en la carpeta elegida.`,
      };
    } catch (error) {
      // Cerrar el selector de carpeta no es un fallo: es decir que no.
      if ((error as { name?: string })?.name === 'AbortError') {
        return { ok: false, files: 0, bytes: 0, message: '' };
      }

      console.error('[Exportar] no se pudo escribir en la carpeta', error);

      return { ok: false, files: 0, bytes: 0, message: 'No se pudo escribir en la carpeta.' };
    }
  }

  /** Empaqueta todo en un `.zip` y lo descarga. */
  async toZip(
    files: readonly BinaryResource[],
    onProgress?: (progress: ExportProgress) => void,
  ): Promise<ExportResult> {
    try {
      const names = await this.namesOf(files);
      const entries: ZipEntry[] = [];

      let bytes = 0;
      let done = 0;

      for (const file of files) {
        const path = names.get(file.GUID)!;
        const blob = await this.storage.loadBlob(file.GUID);

        done++;
        onProgress?.({ done, total: files.length, current: path.name });

        if (!blob) continue;

        const data = new Uint8Array(await blob.arrayBuffer());

        bytes += data.byteLength;

        if (bytes > ZIP_LIMIT) {
          return {
            ok: false,
            files: 0,
            bytes: 0,
            message:
              'Son demasiados archivos para un solo comprimido. Exporta a una carpeta, o hazlo por actividad.',
          };
        }

        entries.push({ name: `${path.folder}/${path.name}`, data });
      }

      if (entries.length === 0) {
        return { ok: false, files: 0, bytes: 0, message: 'No hay archivos con contenido guardado.' };
      }

      const zip = buildZip(entries);
      const stamp = new Date().toISOString().slice(0, 10);

      this.saveBlob(zip, `archivos-visitrack-${stamp}.zip`);

      return {
        ok: true,
        files: entries.length,
        bytes,
        message: `${entries.length} archivo${entries.length === 1 ? '' : 's'} en el comprimido.`,
      };
    } catch (error) {
      console.error('[Exportar] no se pudo armar el comprimido', error);

      return { ok: false, files: 0, bytes: 0, message: 'No se pudo armar el comprimido.' };
    }
  }

  /**
   * Cómo se llama cada archivo al salir.
   *
   * Una carpeta por actividad, y dentro el campo que originó el archivo. Un
   * volcado plano de doscientos GUID no le sirve a nadie: lo que se busca
   * después es «las fotos de la inspección del martes», no un identificador.
   */
  private async namesOf(
    files: readonly BinaryResource[],
  ): Promise<Map<string, { folder: string; name: string }>> {
    const answers = new Map<string, SurveyAnswer | null>();
    const names = new Map<string, { folder: string; name: string }>();
    const used = new Set<string>();

    for (const file of files) {
      if (!answers.has(file.AnswerGUID)) {
        answers.set(file.AnswerGUID, await this.answers.findByGuid(file.AnswerGUID));
      }

      const answer = answers.get(file.AnswerGUID) ?? null;
      const folder = safeName(this.folderNameOf(answer, file.AnswerGUID));

      const ext = (file.Ext || 'bin').replace(/^\./, '');
      const base = safeName(`${file.IDField || 'campo'}-${file.GUID.slice(0, 8)}`);

      // Dos archivos del mismo campo en la misma actividad existirían con el
      // mismo nombre; el sufijo evita que uno pise al otro al escribir.
      let name = `${base}.${ext}`;
      let n = 2;

      while (used.has(`${folder}/${name}`)) {
        name = `${base}-${n++}.${ext}`;
      }

      used.add(`${folder}/${name}`);
      names.set(file.GUID, { folder, name });
    }

    return names;
  }

  private folderNameOf(answer: SurveyAnswer | null, guid: string): string {
    if (!answer) return `actividad-${guid.slice(0, 8)}`;

    const date = (answer.CreatedOn || '').slice(0, 10);
    const label = answer.Consecutive || answer.AnswerID || guid.slice(0, 8);
    const place = answer.AssetName || answer.LocationName || '';

    return [date, label, place].filter(Boolean).join(' ');
  }

  private saveBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = filename;
    link.click();

    // Se libera después de que el navegador tomó el archivo; hacerlo en el acto
    // cancela la descarga en algunos navegadores.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ZIP mínimo, método "store"
// ─────────────────────────────────────────────────────────────────────────────

interface ZipEntry {
  name: string;
  /**
   * El búfer se declara concreto y no `ArrayBufferLike`.
   *
   * `Blob` no acepta una vista sobre un `SharedArrayBuffer`, y sin precisarlo
   * TypeScript asume el tipo ancho y rechaza el ensamblado entero.
   */
  data: Uint8Array<ArrayBuffer>;
}

/**
 * Tabla de CRC-32, que es lo único que el formato exige calcular.
 *
 * Se construye una vez y se reutiliza: hacerla por archivo son 256 iteraciones
 * de más por cada foto.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let i = 0; i < 256; i++) {
    let c = i;

    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }

    table[i] = c >>> 0;
  }

  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;

  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Arma el `.zip` en memoria.
 *
 * Sin compresión y sin ZIP64: un contenedor, no un compresor. Ver el porqué en
 * la documentación de [BinaryExportService].
 */
function buildZip(entries: readonly ZipEntry[]): Blob {
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];

  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const localBuffer = new ArrayBuffer(30);
    const local = new DataView(localBuffer);

    local.setUint32(0, 0x04034b50, true); // firma
    local.setUint16(4, 20, true); // versión necesaria
    local.setUint16(6, 0x0800, true); // nombres en UTF-8
    local.setUint16(8, 0, true); // método: sin comprimir
    local.setUint16(10, 0, true); // hora
    local.setUint16(12, 0, true); // fecha
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true); // sin campos extra

    parts.push(new Uint8Array(localBuffer), name, entry.data);

    const headerBuffer = new ArrayBuffer(46);
    const header = new DataView(headerBuffer);

    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, 20, true); // versión que lo creó
    header.setUint16(6, 20, true);
    header.setUint16(8, 0x0800, true);
    header.setUint16(10, 0, true);
    header.setUint16(12, 0, true);
    header.setUint16(14, 0, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, size, true);
    header.setUint32(24, size, true);
    header.setUint16(28, name.length, true);
    header.setUint16(30, 0, true);
    header.setUint16(32, 0, true);
    header.setUint16(34, 0, true);
    header.setUint16(36, 0, true);
    header.setUint32(38, 0, true);
    header.setUint32(42, offset, true);

    const record = new Uint8Array(46 + name.length);

    record.set(new Uint8Array(headerBuffer), 0);
    record.set(name, 46);

    central.push(record);

    offset += 30 + name.length + size;
  }

  const directorySize = central.reduce((total, record) => total + record.length, 0);
  const endBuffer = new ArrayBuffer(22);
  const end = new DataView(endBuffer);

  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, 0, true);

  return new Blob([...parts, ...central, new Uint8Array(endBuffer)], {
    type: 'application/zip',
  });
}

/** Un nombre que ningún sistema de archivos rechace. */
function safeName(value: string): string {
  return (
    value
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'sin-nombre'
  );
}
