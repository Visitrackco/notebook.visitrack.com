import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';

import { environment } from '../../../environments/environment';
import { SurveyAnswer } from '../models/entities.model';
import { BinaryResourceRepository } from '../repositories/binary.repository';
import { SurveyAnswerRepository } from '../repositories/survey-answer.repository';
import { AuthService } from './auth.service';
import { BinaryStorageService } from './binary-storage.service';
import { DataRevisionService } from '../sync/data-revision.service';
import { EntityUploadService } from '../sync/entity-upload.service';

/** Un compañero al que se le puede pasar la actividad. */
export interface Colleague {
  id: string;
  name: string;
  email: string;
}

/** Por qué no se puede reasignar. Vacío si sí se puede. */
export type ReassignBlock = '' | string;

/**
 * Pasarle una actividad a otra persona.
 *
 * ## Qué implica de verdad
 *
 * Reasignar **transfiere la propiedad en el servidor y borra la copia local**.
 * No es compartir: es entregar. Por eso todo lo que no haya llegado al servidor
 * antes de la transferencia se pierde, y de ahí vienen las validaciones — que
 * son las mismas de la app, en el mismo orden.
 *
 * ## Las cuatro comprobaciones
 *
 * 1. **No puede ser un borrador.** Lo que está a medias solo existe aquí.
 * 2. **No puede estar esperando sus archivos.** Se enviará sola cuando estén en
 *    línea; reasignarla ahora la dejaría sin ellos.
 * 3. **Tiene que estar sincronizada.** Es la única señal de que el servidor ya
 *    tiene todo lo que se respondió.
 * 4. **No puede tener archivos pendientes de subir.** La comprobación se repite
 *    justo antes de ejecutar porque entre elegir a la persona y confirmar puede
 *    haberse capturado una foto más.
 *
 * Las tres primeras se comprueban al abrir; la cuarta, al confirmar.
 */
@Injectable({ providedIn: 'root' })
export class ReassignService {
  private readonly http = inject(HttpClient);
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly binaries = inject(BinaryResourceRepository);
  private readonly storage = inject(BinaryStorageService);
  private readonly auth = inject(AuthService);
  private readonly revisions = inject(DataRevisionService);
  private readonly entities = inject(EntityUploadService);

  private get baseUrl(): string {
    return environment.useLocalApi ? environment.localApiUrl : environment.apiUrl;
  }

  /**
   * ¿Se puede reasignar esta actividad?
   *
   * Devuelve el motivo cuando no, ya redactado para enseñárselo al usuario: el
   * mensaje explica **qué hacer** y no solo qué falla, porque en todos los casos
   * hay una salida.
   */
  canReassign(answer: SurveyAnswer): ReassignBlock {
    if (answer.eraser === 1) {
      return 'No puedes reasignar un borrador. Termínalo y sincronízalo antes de reasignarlo.';
    }

    if (answer.isSaved === 3) {
      return (
        'Esta actividad está esperando que sus archivos terminen de subir. ' +
        'Cuando estén en línea se enviará sola y podrás reasignarla.'
      );
    }

    if (answer.isSaved !== 2) {
      return (
        'La actividad debe estar sincronizada para reasignarla. ' +
        'Sincronízala primero e inténtalo de nuevo.'
      );
    }

    return '';
  }

  /** Cuántos archivos suyos siguen sin llegar al servidor. */
  async pendingFiles(answerGuid: string): Promise<number> {
    return this.binaries.countBlockingByAnswer(answerGuid);
  }

  /**
   * Qué entidad suya sigue sin llegar a Visitrack, si alguna.
   *
   * Reasignar **borra la actividad de este equipo**: es la única copia que
   * queda de lo que aquí se creó. Si su ubicación, su activo o alguno de sus
   * ítems de lista nacieron en este dispositivo y todavía no han subido, al
   * borrarla desaparecen con ella — y el compañero recibe una actividad que
   * apunta a registros que del otro lado no existen. No hay forma de
   * recuperarlo después.
   *
   * Devuelve el motivo, o cadena vacía si no hay nada que esperar.
   */
  async pendingEntities(answer: SurveyAnswer): Promise<string> {
    return this.entities.blockersOf(answer);
  }

  /**
   * Los compañeros de la compañía a los que se puede pasar.
   *
   * Se descartan los inactivos y los borrados. El filtro es defensivo, como en
   * la app: solo se excluye a quien viene marcado explícitamente: si la
   * propiedad falta, la persona se mantiene — dejar fuera a alguien por un dato
   * ausente es peor que ofrecer a alguien de más.
   */
  async colleagues(search = ''): Promise<Colleague[]> {
    const user = this.auth.currentUser();
    if (!user) return [];

    const response = await firstValueFrom(
      this.http
        .get<{ status?: boolean; response?: Record<string, unknown>[]; message?: string }>(
          `${this.baseUrl}/getUsersByCompany`,
          { params: { CompanyID: String(user.CompanyID), text: search } },
        )
        .pipe(timeout(15_000)),
    );

    if (!response?.status) {
      throw new Error(response?.message ?? 'No se pudo consultar los usuarios.');
    }

    return (response.response ?? [])
      .filter((row) => !isOff(row['Active']) && !isOn(row['IsDeleted']))
      .map((row) => ({
        id: String(row['ID'] ?? ''),
        name: [row['FirstName'], row['LastName']].filter(Boolean).join(' ').trim() || 'Sin nombre',
        email: String(row['Email'] ?? ''),
      }))
      .filter((colleague) => colleague.id && colleague.id !== String(user.UserID));
  }

  /**
   * Transfiere la actividad y la retira de este dispositivo.
   *
   * El borrado local es parte de la operación, no una limpieza posterior: la
   * actividad ya es de otra persona, y dejarla aquí permitiría seguir
   * editándola y subiendo cambios sobre algo que ya no es propio.
   */
  async reassign(answer: SurveyAnswer, colleague: Colleague): Promise<void> {
    const user = this.auth.currentUser();
    if (!user) throw new Error('No hay una sesión activa.');

    const blocked = this.canReassign(answer);
    if (blocked) throw new Error(blocked);

    // Se vuelve a comprobar aquí: entre abrir la lista de compañeros y elegir a
    // uno puede haberse capturado un archivo más.
    const pending = await this.pendingFiles(answer.GUID);

    if (pending > 0) {
      throw new Error(
        `No se puede reasignar: hay ${pending} ${pending === 1 ? 'archivo' : 'archivos'} ` +
          'pendientes por subir. Súbelos primero.',
      );
    }

    /**
     * Y lo mismo con las entidades creadas aquí.
     *
     * `ensureFor` intenta subirlas antes de rendirse: en el caso normal —hay
     * red y el servidor responde— la reasignación sigue su curso en la misma
     * pasada y el usuario no llega a enterarse de que hubo algo que esperar.
     */
    const waiting = await this.entities.ensureFor(answer);

    if (waiting) {
      throw new Error(
        `No se puede reasignar: ${waiting.charAt(0).toLowerCase()}${waiting.slice(1)} ` +
          'Al reasignar se borra la actividad de este equipo, y con ella lo que no haya subido.',
      );
    }

    const response = await firstValueFrom(
      this.http
        .post<{ status?: boolean; message?: string }>(
          `${this.baseUrl}/reasignedActivityByUser`,
          {
            GUID: answer.GUID,
            GUIDUSER: user.GUID,
            USERID: colleague.id,
          },
          { headers: { 'Content-Type': 'application/json' } },
        )
        .pipe(timeout(30_000)),
    );

    if (!response?.status) {
      throw new Error(response?.message ?? 'El servidor no aceptó la reasignación.');
    }

    await this.dropLocal(answer);
  }

  /** Retira la actividad y sus archivos del dispositivo. */
  private async dropLocal(answer: SurveyAnswer): Promise<void> {
    try {
      await this.storage.removeByAnswer(answer.GUID);
      if (answer.ID != null) await this.answers.delete(answer.ID);
    } finally {
      // Aunque el borrado falle a medias, las pantallas tienen que releer: la
      // actividad ya cambió de dueño en el servidor.
      this.revisions.touchAll();
    }
  }
}

/** Marcado explícitamente como apagado (`0` / `false`). */
function isOff(value: unknown): boolean {
  return value === 0 || value === false || String(value ?? '').toLowerCase() === 'false' || value === '0';
}

/** Marcado explícitamente como encendido (`1` / `true`). */
function isOn(value: unknown): boolean {
  return value === 1 || value === true || String(value ?? '').toLowerCase() === 'true' || value === '1';
}
