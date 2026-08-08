import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import { SurveyAnswerRepository } from '../repositories/survey-answer.repository';
import { AuthService } from './auth.service';
import { DataRevisionService } from '../sync/data-revision.service';

/**
 * Cuántas consignas quedan por hacer.
 *
 * ## Por qué un servicio y no un cálculo en la pantalla
 *
 * El número se enseña en el menú, que vive en el armazón y está siempre a la
 * vista — también cuando se está en otra pantalla. Calcularlo dentro del
 * listado de consignas significaría que el distintivo solo existiera estando ya
 * en él, que es justo donde no hace falta.
 *
 * ## Cuándo se recuenta
 *
 * Al iniciar sesión y cada vez que algo toca las actividades: una
 * sincronización que trae trabajo nuevo, o una consigna que se termina y deja
 * de contar. Lo segundo importa tanto como lo primero — un distintivo que no
 * baja al terminar el trabajo se aprende a ignorar.
 */
@Injectable({ providedIn: 'root' })
export class DispatchCounterService {
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly auth = inject(AuthService);
  private readonly revisions = inject(DataRevisionService);

  private readonly count = signal(0);

  /** Consignas asignadas que todavía no se han enviado. */
  readonly pending = computed(() => this.count());

  constructor() {
    effect(() => {
      const user = this.auth.currentUser();
      this.revisions.activities();

      untracked(() => void this.recount(user?.UserID));
    });
  }

  private async recount(userId: string | undefined): Promise<void> {
    if (!userId) {
      this.count.set(0);
      return;
    }

    try {
      const answers = await this.answers.findByUser(String(userId));

      this.count.set(
        answers.filter(
          (answer) =>
            // Asignada por la plataforma, viva, y sin terminar de enviarse.
            answer.Sheduled === '1' &&
            answer.IsDelete !== '1' &&
            !(answer.isSaved === 2 && answer.toSync === 0),
        ).length,
      );
    } catch (error) {
      console.error('[Consignas] no se pudo contar', error);
      this.count.set(0);
    }
  }
}
