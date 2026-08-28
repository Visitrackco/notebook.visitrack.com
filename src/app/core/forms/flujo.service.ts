import { Injectable, inject } from '@angular/core';

import { DatabaseService } from '../database/database.service';
import { UserRepository } from '../repositories/user.repository';
import { Flujo } from './flujo-modelo';

/**
 * El flujo de trabajo que le toca a un formulario.
 *
 * Los flujos bajan como entidad 100 y se guardan en el store `Workflows`. Aquí
 * solo se resuelve **cuál aplica** y se entrega listo para el motor.
 *
 * ## El más específico gana, y no se mezclan
 *
 * Si hay flujo para el usuario se usa ese; si no, el general. Dos juegos de
 * reglas fusionándose es imposible de predecir cuando algo sale mal, y aquí
 * «algo sale mal» significa un formulario que no deja guardar.
 */
@Injectable({ providedIn: 'root' })
export class FlujoService {
  private readonly db = inject(DatabaseService);
  private readonly users = inject(UserRepository);

  /**
   * El flujo activo de un formulario, o `null`.
   *
   * Nunca lanza: un flujo que no se puede leer es un formulario que se
   * comporta como siempre, y eso es mucho mejor que un formulario que no abre.
   */
  async paraFormulario(surveyId: number | string): Promise<Flujo | null> {
    try {
      const session = await this.users.getActiveSession();
      if (!session) return null;

      const id = Number(surveyId);
      if (!id) return null;

      const todos = await this.db.transaction<any[]>('Workflows', 'readonly', async (tx) =>
        this.db.request<any[]>(tx.objectStore('Workflows').index('bySurveyID').getAll(id)),
      );

      const mios = todos.filter(
        (w) =>
          Number(w?.IsActive) === 1 &&
          Number(w?.IsDeleted) !== 1 &&
          // `WorkflowUserID` es a quién va dirigido; `UserID`, quién lo bajó.
          (w?.WorkflowUserID == null || Number(w.WorkflowUserID) === Number(session.UserID)),
      );

      if (!mios.length) return null;

      // El de usuario manda sobre el general.
      const elegido = mios.find((w) => w?.WorkflowUserID != null) ?? mios[0];

      const flujo = JSON.parse(elegido?.JSONFlow || '{}');
      return Array.isArray(flujo?.reglas) ? (flujo as Flujo) : null;
    } catch {
      return null;
    }
  }
}
