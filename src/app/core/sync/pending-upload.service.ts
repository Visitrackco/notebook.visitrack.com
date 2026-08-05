import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';

import { ANSWER_STATE } from '../models/activity.model';
import { SurveyAnswer } from '../models/entities.model';
import { BinaryResourceRepository } from '../repositories/binary.repository';
import { SurveyAnswerRepository } from '../repositories/survey-answer.repository';
import { ActivityService } from '../services/activity.service';
import { AuthService } from '../services/auth.service';
import { ConnectivityService } from '../services/connectivity.service';
import { AnswerSubmitService } from './answer-submit.service';
import { BinaryUploadService } from './binary-upload.service';
import { BinaryVerifyService } from './binary-verify.service';

/** Una actividad esperando salir, con el detalle de por qué. */
export interface PendingActivity {
  answer: SurveyAnswer;
  /** Archivos que impiden enviarla. */
  blockingFiles: number;
  /** Archivos que tiene en total. */
  totalFiles: number;
}

/** Resumen de una corrida. */
export interface RunSummary {
  uploadedFiles: number;
  confirmedFiles: number;
  sentActivities: number;
  stillWaiting: number;
  message: string;
}

/** Cada cuánto corre el proceso automático. */
const INTERVAL_MS = 60_000;

/**
 * El proceso que vacía la cola de pendientes.
 *
 * Corre cada minuto y hace las tres cosas en el único orden que funciona:
 *
 * 1. **Subir** los archivos que solo están en el navegador.
 * 2. **Confirmar** contra el servidor cuáles llegaron ya al bucket.
 * 3. **Enviar** las actividades cuyos archivos estén todos confirmados.
 *
 * Invertir cualquier paso rompe la garantía: enviar antes de confirmar deja
 * actividades apuntando a fotos inexistentes, y confirmar antes de subir
 * pregunta por archivos que el servidor nunca recibió.
 *
 * ## Por qué un temporizador y no un service worker
 *
 * Un service worker seguiría corriendo con la pestaña cerrada, que sería mejor,
 * pero necesita `Background Sync` —que Safari no implementa— y no puede tocar
 * IndexedDB con la misma capa de repositorios que usa el resto. Con el
 * temporizador el proceso vive mientras la aplicación esté abierta, que es el
 * caso real: quien diligencia formularios tiene la pestaña delante.
 *
 * Lo que sí se hace es **no trabajar en balde**: si la pestaña está oculta o no
 * hay conexión, la corrida se salta entera.
 */
@Injectable({ providedIn: 'root' })
export class PendingUploadService {
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly binaries = inject(BinaryResourceRepository);
  private readonly uploads = inject(BinaryUploadService);
  private readonly verify = inject(BinaryVerifyService);
  private readonly submit = inject(AnswerSubmitService);
  private readonly activities = inject(ActivityService);
  private readonly connectivity = inject(ConnectivityService);
  private readonly auth = inject(AuthService);

  readonly running = signal(false);
  readonly lastRun = signal<Date | null>(null);
  readonly lastSummary = signal<RunSummary | null>(null);

  /** Actividades pendientes, para la pantalla de pendientes por subir. */
  readonly pending = signal<PendingActivity[]>([]);

  readonly pendingCount = computed(() => this.pending().length);

  readonly waitingCount = computed(
    () => this.pending().filter((entry) => entry.blockingFiles > 0).length,
  );

  private timer?: ReturnType<typeof setInterval>;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  /**
   * Arranca el proceso automático.
   *
   * Lo llama el armazón de la aplicación una vez iniciada la sesión. Es
   * idempotente: llamarlo dos veces no crea dos temporizadores.
   */
  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);

    // Una primera pasada al arrancar: si la sesión anterior se cerró con cosas
    // pendientes, esperar un minuto para empezar a resolverlas no tiene sentido.
    void this.refresh();
    void this.tick();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Una corrida automática.
   *
   * Se salta cuando no aportaría nada: sin sesión, sin conexión, con otra
   * corrida en marcha o con la pestaña en segundo plano. Lo último importa más
   * de lo que parece — subir fotos desde una pestaña que nadie mira consume la
   * batería y los datos del usuario sin que él lo haya pedido.
   */
  private async tick(): Promise<void> {
    if (!this.auth.currentUser()) return;
    if (!this.connectivity.isOnline()) return;
    if (this.running()) return;
    if (typeof document !== 'undefined' && document.hidden) return;

    await this.run();
  }

  /**
   * Vacía la cola. Es también lo que ejecuta el botón de «Subir ahora».
   *
   * @param answerGuid limita el trabajo a una sola actividad.
   */
  async run(answerGuid?: string): Promise<RunSummary> {
    if (this.running()) {
      return this.lastSummary() ?? emptySummary('Ya hay una subida en curso.');
    }

    this.running.set(true);

    try {
      const uploadedFiles = await this.uploads.uploadPending(answerGuid);

      // Confirmar en bloque y no actividad por actividad: una sola llamada
      // resuelve todos los archivos, y el servidor responde igual de rápido
      // para uno que para cincuenta.
      const report = await this.verify.verifyAll(false);

      const targets = await this.collectPending(answerGuid);
      let sent = 0;

      for (const entry of targets) {
        // Rondas cortas: aquí no hay nadie esperando en pantalla, y si todavía
        // no está lista se reintenta en la corrida siguiente.
        const result = await this.submit.submit(entry.answer, 1);
        if (result.outcome === 'sent') sent++;
      }

      await this.refresh();
      this.activities.notifyChanged();

      const summary: RunSummary = {
        uploadedFiles,
        confirmedFiles: report.confirmed,
        sentActivities: sent,
        stillWaiting: this.pendingCount(),
        message: describe(uploadedFiles, report.confirmed, sent, this.pendingCount()),
      };

      this.lastRun.set(new Date());
      this.lastSummary.set(summary);
      return summary;
    } finally {
      this.running.set(false);
    }
  }

  /** Reenvía una sola actividad, desde el botón de su tarjeta. */
  async retry(answer: SurveyAnswer): Promise<string> {
    const result = await this.submit.submit(answer, 2);

    await this.refresh();
    this.activities.notifyChanged();

    return result.message;
  }

  /** Vuelve a leer la cola. La usan las pantallas al abrirse. */
  async refresh(): Promise<void> {
    this.pending.set(await this.collectPending());
  }

  /**
   * Las actividades que faltan por llegar a Visitrack.
   *
   * Son las pendientes y las que esperan archivos. Los borradores no cuentan:
   * el usuario nunca pulsó guardar, y subirlos sería enviar trabajo a medias
   * que nadie dio por terminado.
   */
  private async collectPending(answerGuid?: string): Promise<PendingActivity[]> {
    const user = this.auth.currentUser();
    if (!user) return [];

    const all = await this.answers.query({ index: 'byUserID', range: user.UserID });

    const candidates = all.filter(
      (answer) =>
        answer.eraser !== 1 &&
        answer.IsDelete !== '1' &&
        (answer.isSaved === ANSWER_STATE.PENDING ||
          answer.isSaved === ANSWER_STATE.WAITING_BINARIES) &&
        (!answerGuid || answer.GUID === answerGuid),
    );

    const result: PendingActivity[] = [];

    for (const answer of candidates) {
      const files = await this.binaries.findByAnswer(answer.GUID);

      result.push({
        answer,
        totalFiles: files.length,
        blockingFiles: await this.binaries.countBlockingByAnswer(answer.GUID),
      });
    }

    // Primero las que ya pueden salir: son las que se van a resolver en la
    // siguiente corrida, y verlas arriba explica el orden en que desaparecen.
    return result.sort((a, b) => a.blockingFiles - b.blockingFiles);
  }
}

function describe(
  uploaded: number,
  confirmed: number,
  sent: number,
  waiting: number,
): string {
  const parts: string[] = [];

  if (uploaded > 0) parts.push(`${uploaded} archivo(s) subidos`);
  if (confirmed > 0) parts.push(`${confirmed} confirmado(s)`);
  if (sent > 0) parts.push(`${sent} actividad(es) enviadas`);

  if (parts.length === 0) {
    return waiting > 0
      ? 'Nada nuevo por ahora. Los archivos siguen procesándose en el servidor.'
      : 'Todo está al día.';
  }

  return parts.join(' · ');
}

function emptySummary(message: string): RunSummary {
  return {
    uploadedFiles: 0,
    confirmedFiles: 0,
    sentActivities: 0,
    stillWaiting: 0,
    message,
  };
}
