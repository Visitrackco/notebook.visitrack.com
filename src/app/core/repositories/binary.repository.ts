import { Injectable, signal } from '@angular/core';

import { BinaryResource, BinaryState } from '../models/sync.model';
import { BaseRepository } from './base.repository';

/**
 * Estados que **no** dejan enviar la actividad.
 *
 * Los descartados y los irrecuperables sí la dejan pasar: nunca van a llegar al
 * bucket, y esperarlos dejaría la actividad detenida para siempre. Queda
 * constancia de qué se perdió, pero el trabajo del usuario sigue su camino.
 */
export const BLOCKING_STATES: readonly BinaryState[] = [BinaryState.Pending, BinaryState.InRepository];

/**
 * Archivos capturados: fotos, firmas, audio y documentos.
 *
 * Solo los metadatos. El contenido vive en `BinariesData` y se lee por separado
 * a propósito: listar los archivos de una actividad no debe traer megabytes de
 * imágenes a memoria para pintar un contador.
 */
@Injectable({ providedIn: 'root' })
export class BinaryResourceRepository extends BaseRepository<BinaryResource> {
  protected readonly storeName = 'BinariesResources';

  /**
   * Cambia cada vez que se escribe un archivo, para que la pantalla se entere.
   *
   * ## Qué se veía sin esto
   *
   * Un campo de fotografía dice debajo en qué va: «Pendiente de subir», «En
   * servidor», «En línea». Ese rótulo se leía **una sola vez**, al pintar el
   * campo, así que la foto se subía y se confirmaba y el campo seguía diciendo
   * «Pendiente de subir» hasta que alguien cambiara de página y volviera.
   *
   * Y ahora importa más que antes: una llamada a un servicio pone la foto en
   * línea ella sola, justo debajo de ese rótulo. Que diga lo contrario de lo
   * que acaba de pasar es peor que no decir nada.
   *
   * Es un número que solo sirve para avisar de que hay algo nuevo; lo que vale
   * se vuelve a leer de la base. Va aquí, en el repositorio, porque es el único
   * sitio por el que pasan todas las escrituras — subida, verificación,
   * reintento— y así ninguna se puede olvidar de avisar.
   */
  readonly revision = signal(0);

  /** Se anota que hubo cambios. Ver [revision]. */
  private anotarCambio(): void {
    this.revision.update((n) => n + 1);
  }

  override async put(item: BinaryResource): Promise<IDBValidKey> {
    const clave = await super.put(item);
    this.anotarCambio();

    return clave;
  }

  override async putMany(items: readonly BinaryResource[]): Promise<number> {
    const cuantos = await super.putMany(items);
    if (cuantos) this.anotarCambio();

    return cuantos;
  }

  override async delete(id: IDBValidKey): Promise<void> {
    await super.delete(id);
    this.anotarCambio();
  }

  /** Todos los archivos de una actividad. */
  async findByAnswer(answerGuid: string): Promise<BinaryResource[]> {
    if (!answerGuid) return [];
    return this.query({ index: 'byAnswerGUID', range: answerGuid });
  }

  /** Cuántos archivos tiene una actividad. */
  async countByAnswer(answerGuid: string): Promise<number> {
    if (!answerGuid) return 0;
    return this.count({ index: 'byAnswerGUID', range: answerGuid });
  }

  /**
   * Cuántos archivos impiden que la actividad se envíe.
   *
   * Es la comprobación previa a eliminar: borrar una actividad con archivos a
   * medio subir deja huérfano lo que ya llegó al servidor, y el usuario pierde
   * fotos que creía guardadas.
   */
  async countBlockingByAnswer(answerGuid: string): Promise<number> {
    if (!answerGuid) return 0;

    return this.count({
      index: 'byAnswerGUID',
      range: answerGuid,
      filter: (binary) => BLOCKING_STATES.includes(binary.BinaryState),
    });
  }

  /**
   * Devuelve todos los archivos de una actividad al estado inicial.
   *
   * Es la salida cuando algo se atascó: un archivo que el servidor dice haber
   * recibido pero que nunca aparece en el bucket deja la actividad esperando
   * indefinidamente. Volver a marcarlos como pendientes hace que se suban de
   * nuevo en lugar de tener que rehacer la captura.
   *
   * @returns cuántos archivos se marcaron.
   */
  async markPendingByAnswer(answerGuid: string): Promise<number> {
    const binaries = await this.findByAnswer(answerGuid);
    if (binaries.length === 0) return 0;

    const reset = binaries.map((binary) => ({
      ...binary,
      BinaryState: BinaryState.Pending,
      IsSync: 0,
      Uploaded: 0,
      // El contador de intentos vuelve a cero: si no, el reintento arrancaría
      // con la espera más larga del escalonado y parecería que no hace nada.
      VerifyAttempts: 0,
      VerifiedOn: '',
    }));

    await this.putMany(reset);
    return reset.length;
  }

  /** Elimina los archivos de una actividad. Se usa al borrarla. */
  async deleteByAnswer(answerGuid: string): Promise<number> {
    if (!answerGuid) return 0;
    return this.deleteWhere({ index: 'byAnswerGUID', range: answerGuid });
  }
}
