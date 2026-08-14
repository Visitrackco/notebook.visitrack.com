import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import { BLOCKING_STATES, BinaryResourceRepository } from '../repositories/binary.repository';
import { SurveyAnswerRepository } from '../repositories/survey-answer.repository';
import { AuthService } from './auth.service';
import { DataRevisionService } from '../sync/data-revision.service';

/**
 * Los números que van en el menú.
 *
 * ## Por qué en el menú y no dentro de cada pantalla
 *
 * El menú está siempre a la vista, también cuando se está en otra parte. Un
 * número que solo existe dentro de su pantalla no informa de nada: para verlo
 * hay que ir, y si hay que ir ya no hace falta el número.
 *
 * ## Qué cuenta cada uno
 *
 * - **Formularios**: cuántas actividades tiene creadas en total. Es la misma
 *   cuenta que suma lo que se ve dentro, para que el número del menú y el de la
 *   pantalla nunca se contradigan.
 * - **Archivos**: los que **impiden que una actividad salga** —capturados sin
 *   subir, o recibidos por el servidor pero aún no confirmados en el bucket—.
 *   No el total de archivos: ese número no pide ninguna acción, y un distintivo
 *   que nunca baja se aprende a ignorar.
 *
 * Se recuentan al iniciar sesión y cada vez que algo toca las actividades o los
 * archivos. Que **bajen** al resolverse importa tanto como que suban.
 */
@Injectable({ providedIn: 'root' })
export class MenuCountersService {
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly binaries = inject(BinaryResourceRepository);
  private readonly auth = inject(AuthService);
  private readonly revisions = inject(DataRevisionService);

  private readonly activityCount = signal(0);
  private readonly fileCount = signal(0);

  /** Actividades creadas por el usuario, en total. */
  readonly activities = computed(() => this.activityCount());

  /** Archivos que todavía no están confirmados en el bucket. */
  readonly pendingFiles = computed(() => this.fileCount());

  constructor() {
    effect(() => {
      const user = this.auth.currentUser();

      this.revisions.activities();

      untracked(() => void this.recountActivities(user?.UserID));
    });

    // Aparte del anterior: los archivos cambian por su cuenta —una subida, una
    // confirmación— sin que ninguna actividad se toque. Juntarlos haría que
    // cada foto subida recontara también todas las actividades.
    effect(() => {
      const user = this.auth.currentUser();

      this.revisions.binaries();

      untracked(() => void this.recountFiles(Boolean(user)));
    });
  }

  private async recountActivities(userId: string | undefined): Promise<void> {
    if (!userId) {
      this.activityCount.set(0);
      return;
    }

    try {
      const answers = await this.answers.findByUser(String(userId));

      this.activityCount.set(answers.length);
    } catch (error) {
      console.error('[Menú] no se pudieron contar las actividades', error);
      this.activityCount.set(0);
    }
  }

  private async recountFiles(hasSession: boolean): Promise<void> {
    if (!hasSession) {
      this.fileCount.set(0);
      return;
    }

    try {
      const all = await this.binaries.getAll();

      this.fileCount.set(
        all.filter((binary) => BLOCKING_STATES.includes(binary.BinaryState)).length,
      );
    } catch (error) {
      console.error('[Menú] no se pudieron contar los archivos', error);
      this.fileCount.set(0);
    }
  }
}
