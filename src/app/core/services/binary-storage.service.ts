import { Injectable, inject } from '@angular/core';

import { DatabaseService } from '../database/database.service';
import { FileValue } from '../forms/form-schema';
import { BinaryData, BinaryResource, BinaryState, BinaryType } from '../models/sync.model';
import { BinaryResourceRepository } from '../repositories/binary.repository';
import { DataRevisionService } from '../sync/data-revision.service';
import { AuthService } from './auth.service';
import { SettingsRepository } from '../repositories/settings.repository';
import {
  IMAGE_QUALITY_DEFAULT,
  IMAGE_QUALITY_KEY,
  compressImage,
  presetOf,
} from '../../shared/utils/image';

/**
 * Valor que guarda un campo binario dentro de `Fields`.
 *
 * Son las claves de la app móvil, sin traducir: `bin` apunta al archivo y el
 * resto viaja junto por compatibilidad, aunque hoy la mayoría vaya vacío. El
 * backend espera esta forma.
 *
 * Se define en el esquema del formulario —donde vive la unión de valores de un
 * campo— y aquí solo se le pone el nombre con el que se lee en esta capa. Que
 * fueran dos tipos distintos con la misma forma dejaría al compilador sin
 * detectar el día en que uno cambiara y el otro no.
 */
export type BinaryValue = FileValue;

/** Lo que hace falta para guardar un archivo. */
export interface SaveBinaryInput {
  blob: Blob;
  answerGuid: string;
  fieldId: string;
  type: BinaryType;
  /** Extensión sin punto: `jpg`, `png`, `webm`… */
  ext: string;
  /** Texto asociado, si el tipo lo usa. */
  sig?: string;
  /** Identificador de tipo del campo. La app envía el `TypeID` del esquema. */
  typeId?: number;
  /** GUID a reemplazar. Su archivo se borra antes de escribir el nuevo. */
  replaces?: string;
}

/**
 * Archivos capturados: fotos, firmas, audio, video y documentos.
 *
 * ## Dónde vive el contenido
 *
 * En el móvil el archivo va al sistema de archivos y `BinariesResources.base`
 * guarda su ruta. En un navegador no hay rutas, así que el contenido se guarda
 * como `Blob` en el store `BinariesData` y `base` conserva el **GUID** que
 * apunta a él. La forma del registro no cambia, y por eso el backend recibe lo
 * mismo desde las dos plataformas.
 *
 * Separar contenido y metadatos no es un capricho: listar los archivos de una
 * actividad para contar cuántos faltan por subir no debe traer megabytes de
 * imágenes a memoria.
 */
@Injectable({ providedIn: 'root' })
export class BinaryStorageService {
  private readonly db = inject(DatabaseService);
  private readonly binaries = inject(BinaryResourceRepository);
  private readonly revisions = inject(DataRevisionService);
  private readonly auth = inject(AuthService);
  private readonly settings = inject(SettingsRepository);

  /**
   * El nivel de reducción de la cuenta.
   *
   * Se lee del mismo ajuste que guarda el teléfono (`imageQualityLevel`), así
   * que quien lo cambió allá lo encuentra respetado aquí. Si no lo configuró
   * nunca, el de la app: **baja**.
   */
  private async preset(): Promise<{ limit: number; quality: number }> {
    try {
      const user = this.auth.currentUser();

      const level = await this.settings.getUserSetting(
        IMAGE_QUALITY_KEY,
        String(user?.UserID ?? ''),
        IMAGE_QUALITY_DEFAULT,
      );

      const [limit, quality] = presetOf(level);

      return { limit, quality };
    } catch {
      const [limit, quality] = presetOf(IMAGE_QUALITY_DEFAULT);
      return { limit, quality };
    }
  }

  /**
   * URLs de objeto entregadas, por GUID.
   *
   * `createObjectURL` reserva memoria hasta que se revoca explícitamente; sin
   * llevar la cuenta, abrir un formulario con veinte fotos varias veces deja
   * esa memoria retenida hasta recargar la pestaña.
   */
  private readonly urls = new Map<string, string>();

  /**
   * Guarda un archivo y devuelve el valor que va en `Fields`.
   *
   * El GUID se recorta a 49 caracteres como en la app: la columna del servidor
   * no admite más, y un identificador truncado más tarde deja de casar con su
   * registro.
   */
  async save(input: SaveBinaryInput): Promise<BinaryValue> {
    const user = this.auth.currentUser();
    if (!user) throw new Error('No hay una sesión activa.');

    if (input.replaces) await this.remove(input.replaces);

    /**
     * Las fotografías se reducen antes de guardarse.
     *
     * Aquí y no en cada sitio que captura: por este método pasan la cámara, el
     * archivo elegido, el que se suelta encima y el que sale del editor. Puesto
     * en uno solo de ellos, los otros tres seguirían guardando el original.
     *
     * Solo las fotografías: ver `compressImage`.
     */
    const blob =
      input.type === BinaryType.Image ? await compressImage(input.blob, await this.preset()) : input.blob;

    const guid = crypto.randomUUID().slice(0, 49);
    const now = Date.now();

    await this.db.transaction('BinariesData', 'readwrite', (tx) =>
      this.db.request(
        tx.objectStore('BinariesData').put({
          GUID: guid,
          blob,
          mimeType: blob.type || 'application/octet-stream',
          createdAt: new Date().toISOString(),
        } satisfies BinaryData),
      ),
    );

    const resource: BinaryResource = {
      // En web, `base` apunta al contenido en `BinariesData` en vez de a una
      // ruta del sistema de archivos.
      base: guid,
      GUID: guid,
      TypeBinarie: input.type,
      TypeID: input.typeId ?? 1,
      Uploaded: 0,
      AnswerGUID: input.answerGuid,
      IDField: input.fieldId,
      Lat: '',
      Lng: '',
      tim: String(now),
      UserID: user.UserID,
      IsSync: 0,
      Ext: input.ext,
      Size: String(input.blob.size),
      BinaryState: BinaryState.Pending,
      VerifyAttempts: 0,
      VerifiedOn: '',
    };

    await this.binaries.put(resource);
    this.revisions.touchBinaries();

    return {
      bin: guid,
      sig: input.sig ?? '',
      lat: '',
      lng: '',
      acc: 0,
      pro: 'gps',
      tim: now,
      tph: now,
    };
  }

  /** Metadatos de un archivo. `null` si ya no está. */
  async find(guid: string): Promise<BinaryResource | null> {
    if (!guid) return null;
    return this.binaries.getByIndex('byGUID', guid);
  }

  /** El contenido de un archivo. */
  async loadBlob(guid: string): Promise<Blob | null> {
    if (!guid) return null;

    const data = await this.db.transaction('BinariesData', 'readonly', (tx) =>
      this.db.request<BinaryData | undefined>(tx.objectStore('BinariesData').get(guid)),
    );

    return data?.blob ?? null;
  }

  /**
   * URL para mostrar el archivo en un `<img>`, `<audio>` o `<video>`.
   *
   * Se reutiliza la misma para el mismo GUID: pedirla dos veces crearía dos
   * reservas de memoria para el mismo contenido.
   */
  async objectUrl(guid: string): Promise<string> {
    if (!guid) return '';

    const existing = this.urls.get(guid);
    if (existing) return existing;

    const blob = await this.loadBlob(guid);
    if (!blob) return '';

    const url = URL.createObjectURL(blob);
    this.urls.set(guid, url);
    return url;
  }

  /**
   * Libera la URL de un archivo.
   *
   * Lo llaman los componentes al destruirse. No borra nada del almacenamiento:
   * solo suelta la memoria que reservó el navegador para servir ese contenido.
   */
  releaseUrl(guid: string): void {
    const url = this.urls.get(guid);
    if (!url) return;

    URL.revokeObjectURL(url);
    this.urls.delete(guid);
  }

  /** Elimina un archivo: su contenido, su registro y su URL. */
  async remove(guid: string): Promise<void> {
    if (!guid) return;

    this.releaseUrl(guid);

    const resource = await this.find(guid);
    if (resource?.ID != null) await this.binaries.delete(resource.ID);

    await this.db.transaction('BinariesData', 'readwrite', (tx) =>
      this.db.request(tx.objectStore('BinariesData').delete(guid)),
    );

    this.revisions.touchBinaries();
  }

  /**
   * Elimina todos los archivos de una actividad.
   *
   * Va uno a uno en lugar de borrar las fichas en bloque porque el contenido
   * está en otro store: quitar solo las fichas dejaría los `Blob` sin dueño,
   * ocupando la cuota del navegador sin que nada vuelva a nombrarlos. Con
   * veinte fotos por actividad, eso son decenas de megabytes que no se
   * recuperan hasta borrar los datos del sitio.
   *
   * @returns cuántos archivos se eliminaron.
   */
  async removeByAnswer(answerGuid: string): Promise<number> {
    if (!answerGuid) return 0;

    const binaries = await this.binaries.findByAnswer(answerGuid);
    for (const binary of binaries) await this.remove(binary.GUID);

    return binaries.length;
  }

  /** Archivos de un campo concreto de una actividad. */
  async listByField(answerGuid: string, fieldId: string): Promise<BinaryResource[]> {
    const all = await this.binaries.findByAnswer(answerGuid);
    return all.filter((binary) => binary.IDField === fieldId);
  }

  /** Tamaño legible, para mostrarlo junto al archivo. */
  formatSize(bytes: number | string): string {
    const value = Number(bytes) || 0;

    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
}
