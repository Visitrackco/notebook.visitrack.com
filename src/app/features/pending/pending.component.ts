import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { ANSWER_STATE } from '../../core/models/activity.model';
import { SurveyAnswer } from '../../core/models/entities.model';
import { ConnectivityService } from '../../core/services/connectivity.service';
import { PendingActivity, PendingUploadService } from '../../core/sync/pending-upload.service';
import { IconComponent } from '../../shared/components/icon/icon.component';

/**
 * Lo que falta por llegar a Visitrack.
 *
 * ## Por qué merece una pantalla propia
 *
 * El trabajo de campo se hace sin cobertura y se envía después. Entre esos dos
 * momentos hay una cola que hasta ahora era invisible: el usuario guardaba una
 * actividad, la veía en el listado y no tenía forma de saber si había salido
 * del dispositivo. La pregunta —*¿ya se envió lo de ayer?*— no tenía dónde
 * responderse.
 *
 * Aquí está la cola, por qué cada actividad sigue en ella, y el botón para
 * forzarla sin esperar al proceso automático.
 */
@Component({
  selector: 'vt-pending',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './pending.component.html',
  styleUrl: './pending.component.scss',
})
export class PendingComponent {
  private readonly router = inject(Router);

  readonly uploads = inject(PendingUploadService);
  readonly connectivity = inject(ConnectivityService);

  readonly feedback = signal('');
  readonly loading = signal(true);

  /** GUID de la actividad que se está reenviando a mano. */
  readonly retrying = signal('');

  readonly pending = this.uploads.pending;
  readonly running = this.uploads.running;

  /** Listas para salir en cuanto haya conexión. */
  readonly ready = computed(() =>
    this.pending().filter((entry) => entry.blockingFiles === 0),
  );

  /** Detenidas esperando a que sus archivos se publiquen. */
  readonly waiting = computed(() =>
    this.pending().filter((entry) => entry.blockingFiles > 0),
  );

  readonly lastRunLabel = computed(() => {
    const date = this.uploads.lastRun();
    if (!date) return 'Todavía no se ha ejecutado en esta sesión.';

    return `Última revisión: ${date.toLocaleTimeString('es-CO', {
      hour: '2-digit',
      minute: '2-digit',
    })}`;
  });

  constructor() {
    void this.reload();
  }

  async reload(): Promise<void> {
    this.loading.set(true);

    try {
      await this.uploads.refresh();
    } finally {
      this.loading.set(false);
    }
  }

  /** Fuerza una corrida completa. */
  async runNow(): Promise<void> {
    this.feedback.set('');
    const summary = await this.uploads.run();
    this.feedback.set(summary.message);
  }

  /** Reintenta una sola actividad. */
  async retry(entry: PendingActivity): Promise<void> {
    this.retrying.set(entry.answer.GUID);
    this.feedback.set('');

    try {
      this.feedback.set(await this.uploads.retry(entry.answer));
    } finally {
      this.retrying.set('');
    }
  }

  /** Abre la actividad para revisarla o completarla. */
  open(entry: PendingActivity): void {
    void this.router.navigate([
      '/formularios',
      entry.answer.SurveyID,
      'actividad',
      entry.answer.GUID,
    ]);
  }

  // ── Presentación ───────────────────────────────────────────────────────────

  /**
   * Descriptivos de la actividad.
   *
   * Vienen como JSON en la columna `Titles`. Un fallo al leerla devuelve un
   * texto neutro: la pantalla tiene que seguir mostrando la cola aunque una
   * actividad concreta traiga los descriptivos mal formados.
   */
  title(answer: SurveyAnswer): string {
    if (!answer.Titles?.trim()) return 'Actividad sin descriptivos';

    try {
      const parsed = JSON.parse(answer.Titles);
      const values = Array.isArray(parsed)
        ? parsed.map((item) => String(item?.val ?? '')).filter(Boolean)
        : [];

      return values.length > 0 ? values.slice(0, 3).join(' · ') : 'Actividad sin descriptivos';
    } catch {
      return 'Actividad sin descriptivos';
    }
  }

  /** Por qué esta actividad sigue en la cola. */
  reason(entry: PendingActivity): string {
    if (entry.blockingFiles === 0) {
      return this.connectivity.isOnline()
        ? 'Lista para enviarse. Saldrá en la próxima revisión.'
        : 'Lista para enviarse en cuanto vuelva la conexión.';
    }

    return entry.blockingFiles === 1
      ? 'Falta 1 archivo por publicarse en el servidor.'
      : `Faltan ${entry.blockingFiles} archivos por publicarse en el servidor.`;
  }

  /** Cuándo se guardó. */
  when(answer: SurveyAnswer): string {
    const raw = answer.UpdatedOn || answer.CreatedOn;
    const date = raw ? new Date(raw) : null;

    if (!date || Number.isNaN(date.getTime())) return '';

    return date.toLocaleString('es-CO', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  isWaiting(entry: PendingActivity): boolean {
    return entry.answer.isSaved === ANSWER_STATE.WAITING_BINARIES;
  }
}
