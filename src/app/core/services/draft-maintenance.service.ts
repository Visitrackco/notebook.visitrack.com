import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';

import { SurveyAnswer } from '../models/entities.model';
import { SurveyAnswerRepository } from '../repositories/survey-answer.repository';
import { DataRevisionService } from '../sync/data-revision.service';
import { AlertSoundService } from './alert-sound.service';
import { AuthService } from './auth.service';
import { DraftPolicyService } from './draft-policy.service';
import { RetentionPolicyService } from './retention-policy.service';
import { ToastService } from './toast.service';

/** Cada cuánto se revisa. */
const EVERY_MINUTES = 10;

/**
 * Cuánto antes se avisa de que un borrador va a caducar.
 *
 * Dos horas: suficiente para volver y guardarlo, y no tanto como para que el
 * aviso llegue cuando todavía no había nada que decidir.
 */
const WARN_BEFORE_HOURS = 2;

/** Dónde se recuerda de qué borradores ya se avisó. */
const WARNED_KEY = 'vt.drafts.warned';

/**
 * El mantenimiento de los borradores, por su cuenta.
 *
 * ## Por qué no bastaba con limpiar al entrar al listado
 *
 * Porque quien no entra al listado no limpia nada. Un usuario que trabaja desde
 * la pantalla de consignas, o que deja la pestaña abierta días, acumula
 * borradores caducados que nadie recoge — y esa era exactamente la situación.
 * Ahora se revisa al arrancar y cada diez minutos, mire donde mire el usuario.
 *
 * ## Por qué se avisa antes de borrar
 *
 * Un borrador que desaparece sin avisar se vive como trabajo perdido, aunque la
 * regla estuviera configurada y fuera la correcta. Avisar dos horas antes
 * convierte un borrado silencioso en una decisión: se abre y se guarda, o se
 * deja ir a sabiendas.
 *
 * Cada borrador se avisa **una sola vez**. Repetir el aviso cada diez minutos
 * lo convertiría en ruido, y el ruido se ignora justo cuando importa.
 */
@Injectable({ providedIn: 'root' })
export class DraftMaintenanceService {
  private readonly drafts = inject(DraftPolicyService);
  private readonly retention = inject(RetentionPolicyService);
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly sound = inject(AlertSoundService);
  private readonly revisions = inject(DataRevisionService);
  private readonly router = inject(Router);

  private timer?: ReturnType<typeof setInterval>;

  /**
   * Retira las actividades completadas que cumplieron el plazo del formulario.
   *
   * Se cuenta y se avisa aparte de los borradores porque no son lo mismo: un
   * borrador que desaparece es trabajo perdido; una completada que se retira ya
   * está a salvo en Visitrack y lo único que se libera es el espacio del
   * equipo. Decirlo así evita el susto.
   */
  private async retireCompleted(): Promise<void> {
    try {
      const removed = await this.retention.purgeExpired();
      if (removed === 0) return;

      this.revisions.touchActivities();

      this.toasts.show({
        title:
          removed === 1
            ? 'Se retiró una actividad completada'
            : `Se retiraron ${removed} actividades completadas`,
        detail: 'Siguen en Visitrack: solo se liberó el espacio de este equipo.',
        tone: 'info',
        icon: 'check',
      });
    } catch (error) {
      console.error('[Retención] no se pudo retirar lo completado', error);
    }
  }

  /** Arranca la revisión periódica. Llamarlo más de una vez no hace daño. */
  start(): void {
    if (this.timer) return;

    void this.run();
    this.timer = setInterval(() => void this.run(), EVERY_MINUTES * 60 * 1000);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Una pasada: borra lo caducado y avisa de lo que está por caducar.
   *
   * @returns cuántos borradores se eliminaron.
   */
  async run(): Promise<number> {
    if (!this.auth.currentUser()) return 0;

    try {
      /**
       * Las completadas se retiran en la misma pasada.
       *
       * Es otra regla —la del formulario, no la del equipo— pero el momento de
       * aplicarla es el mismo, y tenerlas en dos procesos habría significado dos
       * temporizadores haciendo lo mismo con distinto nombre.
       *
       * Va antes de avisar: no tiene sentido anunciar que algo se retirará
       * pronto cuando en esta misma vuelta le tocaba.
       */
      await this.retireCompleted();

      const removed = await this.drafts.purgeExpired();

      if (removed > 0) {
        this.revisions.touchActivities();

        this.toasts.show({
          title:
            removed === 1
              ? 'Se eliminó un borrador caducado'
              : `Se eliminaron ${removed} borradores caducados`,
          detail: 'Eran actividades abiertas y nunca guardadas.',
          tone: 'warning',
          icon: 'trash',
        });
      }

      await this.warnExpiring();

      return removed;
    } catch (error) {
      console.error('[Borradores] falló el mantenimiento', error);
      return 0;
    }
  }

  /** Los borradores que caducan dentro de poco. */
  async expiringSoon(): Promise<{ answer: SurveyAnswer; expires: Date }[]> {
    const user = this.auth.currentUser();
    if (!user) return [];

    const drafts = await this.answers.findDrafts(String(user.UserID));
    const limit = Date.now() + WARN_BEFORE_HOURS * 60 * 60 * 1000;

    const soon: { answer: SurveyAnswer; expires: Date }[] = [];

    for (const draft of drafts) {
      const expires = await this.drafts.expiresAt(draft);
      if (expires && expires.getTime() <= limit) soon.push({ answer: draft, expires });
    }

    return soon.sort((a, b) => a.expires.getTime() - b.expires.getTime());
  }

  private async warnExpiring(): Promise<void> {
    const soon = await this.expiringSoon();
    if (soon.length === 0) return;

    const warned = this.warned();
    const fresh = soon.filter((entry) => !warned.has(entry.answer.GUID));

    if (fresh.length === 0) return;

    for (const entry of fresh) warned.add(entry.answer.GUID);
    this.saveWarned(warned);

    const first = fresh[0];

    this.toasts.show({
      title:
        fresh.length === 1
          ? 'Un borrador se borrará pronto'
          : `${fresh.length} borradores se borrarán pronto`,
      detail:
        fresh.length === 1
          ? `«${describe(first.answer)}» caduca ${relative(first.expires)}. Ábrelo y guárdalo para conservarlo.`
          : 'Ábrelos y guárdalos para conservarlos.',
      tone: 'warning',
      icon: 'alert',
      duration: 12_000,
      action: {
        label: 'Ver',
        run: () => void this.router.navigate(['/borradores']),
      },
    });

    void this.sound.notify();
  }

  /**
   * De qué borradores ya se avisó.
   *
   * Se guarda en el navegador y no en memoria: recargar la página no debería
   * volver a avisar de lo mismo, que es la forma más rápida de que el aviso
   * deje de leerse.
   */
  private warned(): Set<string> {
    try {
      const raw = localStorage.getItem(WARNED_KEY);
      return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  }

  private saveWarned(guids: Set<string>): void {
    try {
      // Se conservan los últimos: la lista no puede crecer sin fin, y de un
      // borrador ya eliminado no hay nada que recordar.
      localStorage.setItem(WARNED_KEY, JSON.stringify([...guids].slice(-200)));
    } catch {
      // Sin almacenamiento se avisará otra vez tras recargar. Es molesto, no
      // grave.
    }
  }
}

/** Con qué se reconoce un borrador en un aviso. */
function describe(answer: SurveyAnswer): string {
  return answer.LocationName || answer.AssetName || 'Actividad sin guardar';
}

/** «en 40 minutos», «en 2 horas». */
function relative(date: Date): string {
  const minutes = Math.max(0, Math.round((date.getTime() - Date.now()) / 60000));

  if (minutes < 60) return `en ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`;

  const hours = Math.round(minutes / 60);
  return `en ${hours} ${hours === 1 ? 'hora' : 'horas'}`;
}
