import { Injectable, inject } from '@angular/core';

import { environment } from '../../../environments/environment';
import { parseAnswerFields } from '../forms/form-schema';
import { SurveyAnswer } from '../models/entities.model';
import { BinaryResourceRepository } from '../repositories/binary.repository';
import { LocationRepository } from '../repositories/entity.repositories';
import { SurveyAnswerRepository } from '../repositories/survey-answer.repository';
import { ApiFetchService } from '../services/api-fetch.service';
import { AuthService } from '../services/auth.service';
import { NotifyService } from '../services/notify.service';
import { AnswerSubmitService } from '../sync/answer-submit.service';
import { DataRevisionService } from '../sync/data-revision.service';

/** Compañía y estados que entran al barrido. */
const BRILLANTEX = 2259;
const STATUSES = ['19816', '21468'];

/** Destinatario cuando la ubicación no tiene ninguno configurado. */
const FALLBACK = 'operaciones@brillantex.com';

/** Los dos campos de la ubicación donde viven los correos. */
const EMAIL_FIELDS = ['h55KW1Psk8', 'GT2Zjjn3po'];

/**
 * Qué se manda por cada formulario.
 *
 * `mark` es el campo donde queda anotado que el correo salió, y `date` el que
 * lleva la fecha que va en el mensaje. Un formulario que no esté aquí **no se
 * envía**, igual que en la app.
 */
const FORMS: Record<
  string,
  { mark: string; date: string; subject: (loc: string, asset: string) => string; onlyCompleted?: boolean }
> = {
  '15127': {
    mark: 'UpUgEp4PjK',
    date: 'Yb1PI1x8Yt',
    onlyCompleted: true,
    subject: (loc) => `Inspecciòn de aseo de ${loc} enviada por correo`,
  },
  '23075': {
    mark: 'UpUgEp4PjK',
    date: 'Yb1PI1x8Yt',
    onlyCompleted: true,
    subject: (loc) =>
      `Inspecciòn de aseo hospitalario habitaciones de ${loc} enviada por correo`,
  },
  '21854': {
    mark: 'QTegj8ICLM',
    date: 'Yb1PI1x8Yt',
    onlyCompleted: true,
    subject: (loc) => `Inspecciòn de zonas verdes de ${loc} enviada por correo`,
  },
  '15221': {
    mark: '8lV5d5mLUx',
    date: 'de2bvgc2qq',
    subject: (loc) => `Visita operativa de ${loc} enviada por correo`,
  },
  '22324': {
    mark: 'kiq4quvSJq',
    date: 'iaPot356pE',
    subject: (loc) =>
      `Mantenimiento preventivo equipo de aire acondicionado: de ${loc} enviada por correo`,
  },
  '22756': {
    mark: 'kiq4quvSJq',
    date: 'iaPot356pE',
    subject: (loc, asset) =>
      `Mantenimiento preventivo equipo de aire acondicionado: de ${loc} - ${asset} enviada por correo`,
  },
};

/**
 * El correo de Brillantex al terminar una inspección.
 *
 * ## No se dispara al guardar: es un barrido
 *
 * Igual que en la app. Recorre las actividades ya terminadas y manda las que
 * estén listas. Tiene que ser así por una razón concreta: **el correo no puede
 * salir mientras queden fotos sin subir**, porque el mensaje lleva un enlace al
 * informe y ese informe aparecería sin imágenes. Al guardar casi nunca están
 * subidas todavía, así que se reintenta cuando lo estén.
 *
 * Se ejecuta al terminar una sincronización y al abrir la aplicación, que son
 * los dos momentos en que algo pudo haber cambiado.
 *
 * ## Sobre mandarlo dos veces
 *
 * La misma actividad existe en el teléfono y —tras sincronizar— también aquí,
 * así que los dos clientes pueden intentarlo. **No se duplica**: el backend
 * lleva una auditoría por GUID, asunto y destinatario (`Emails_Send_Audit_2259`)
 * y descarta el repetido. Si la actividad cambió después del primer envío, manda
 * uno marcado como «ÚLTIMA MODIFICACIÓN», que es el comportamiento deseado.
 *
 * Por eso este servicio **no** comprueba la marca local antes de llamar: la
 * decisión de si un correo procede es del servidor, que es el único que ve todo.
 */
@Injectable({ providedIn: 'root' })
export class BrillantexMailService {
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly binaries = inject(BinaryResourceRepository);
  private readonly locations = inject(LocationRepository);
  private readonly submitService = inject(AnswerSubmitService);
  private readonly api = inject(ApiFetchService);
  private readonly auth = inject(AuthService);
  private readonly notify = inject(NotifyService);
  private readonly revisions = inject(DataRevisionService);

  private running = false;

  /**
   * Manda lo que esté listo.
   *
   * @returns cuántos correos se pidieron.
   */
  async run(): Promise<number> {
    const user = this.auth.currentUser();

    if (!user || Number(user.CompanyID) !== BRILLANTEX) return 0;
    if (this.running) return 0;

    this.running = true;

    try {
      const all = await this.answers.findByUser(String(user.UserID));
      const targets = all.filter((answer) => STATUSES.includes(String(answer.Status)));

      let sent = 0;

      /**
       * Por qué se descartó cada una.
       *
       * Sin esto, un barrido que no manda nada y uno que no encuentra nada se
       * ven igual desde fuera: en los dos casos no pasa nada. Y las razones por
       * las que se descarta —el formulario no tiene correo, faltan fotos por
       * confirmar, la inspección no llegó a terminarse— son justo las que hay
       * que mirar cuando alguien dice «no me llegó».
       */
      const descartes: string[] = [];

      for (const answer of targets) {
        const outcome = await this.send(answer, String(user.UserID));

        if (outcome === true) sent++;
        else descartes.push(`${answer.GUID.slice(0, 8)} (${outcome})`);
      }

      console.info(
        `[Brillantex] barrido: ${all.length} actividades, ${targets.length} en estado de envío, ` +
          `${sent} enviadas` +
          (descartes.length > 0 ? ` · descartadas: ${descartes.join(', ')}` : ''),
      );

      if (sent > 0) this.revisions.touchActivities();

      return sent;
    } catch (error) {
      console.error('[Brillantex] falló el barrido de correos', error);
      return 0;
    } finally {
      this.running = false;
    }
  }

  /**
   * Manda el informe de una actividad.
   *
   * @returns `true` si salió, o el motivo por el que no. Devolver el motivo y
   *   no un `false` es lo que permite explicar después por qué no llegó un
   *   correo que alguien esperaba.
   */
  private async send(answer: SurveyAnswer, userId: string): Promise<true | string> {
    const form = FORMS[String(answer.SurveyID)];

    if (!form) return `formulario ${answer.SurveyID} sin correo`;

    if (form.onlyCompleted && String(answer.Status) !== '19816') {
      return `estado ${answer.Status}, se espera 19816`;
    }

    // El correo lleva un enlace al informe: con fotos sin confirmar, ese
    // informe saldría incompleto. Se reintenta en el barrido siguiente.
    const blocking = await this.binaries.countBlockingByAnswer(answer.GUID);

    if (blocking > 0) return `${blocking} archivos sin confirmar`;

    try {
      const emails = await this.recipientsOf(answer);
      const fields = parseAnswerFields(answer.Fields);

      const dated = fields.find((entry) => entry.id === form.date);
      const fecha = dated?.val != null ? String(dated.val) : '';

      const base = environment.useLocalApi ? environment.localApiUrl : environment.apiUrl;

      const reply = await this.api.fetch(`${base}/sendBrillantex`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          SurveyID: String(answer.SurveyID),
          UserID: userId,
          GUID: answer.GUID,
          LocationName: answer.LocationName,
          AssetName: answer.AssetName ?? '',
          Fecha: fecha,
          emails: emails.join(','),
        }),
      });

      const body = (await reply.json()) as { status?: boolean; error?: string };

      if (!body?.status) return `el servidor no lo aceptó: ${body?.error ?? reply.status}`;

      await this.markSent(answer, form.mark);

      /**
       * Y se reenvía la actividad con el estado 2.
       *
       * Va después del correo y no antes: si el envío falla, la actividad se
       * queda como estaba y el barrido siguiente lo vuelve a intentar entero.
       */
      // El `2` viaja solo en el envío: aquí la actividad conserva su estado,
      // igual que en la app. Si no fuera así saldría del barrido y un cambio
      // posterior nunca volvería a mandar la «última modificación».
      void this.submitService.submit(answer, 6, { Status: '2' });

      void this.notify.success(
        'Informe enviado',
        form.subject(answer.LocationName ?? '', answer.AssetName ?? ''),
      );

      return true;
    } catch (error) {
      console.error('[Brillantex] no se pudo enviar el informe', answer.GUID, error);
      return 'error al enviar';
    }
  }

  /**
   * A quién se le manda.
   *
   * Los dos correos configurados en la ubicación. Si no hay ninguno —o si la
   * ubicación no está descargada— va al buzón de operaciones, que es lo que
   * hace la app: es preferible que llegue a alguien y no que se pierda.
   */
  private async recipientsOf(answer: SurveyAnswer): Promise<string[]> {
    const user = this.auth.currentUser();
    const found: string[] = [];

    try {
      const location = user
        ? await this.locations.findByLocationId(Number(user.UserID), answer.LocationID)
        : null;

      if (location?.jsonValues) {
        const values = JSON.parse(location.jsonValues) as { id?: string; val?: unknown }[];

        for (const id of EMAIL_FIELDS) {
          const entry = Array.isArray(values) ? values.find((item) => item.id === id) : null;

          if (entry?.val) found.push(String(entry.val));
        }
      }
    } catch (error) {
      console.warn('[Brillantex] no se pudieron leer los correos de la ubicación', error);
    }

    const clean = [...new Set(found.filter((email) => email.trim() !== ''))];

    return clean.length > 0 ? clean : [FALLBACK];
  }

  /** Deja anotado en la actividad que el correo salió. */
  private async markSent(answer: SurveyAnswer, markId: string): Promise<void> {
    if (answer.ID == null) return;

    const fields = parseAnswerFields(answer.Fields).map((entry) => ({ ...entry }));
    const index = fields.findIndex((entry) => entry.id === markId);
    const value = { id: markId, val: 'SI', fty: 'text', hid: false };

    if (index >= 0) fields[index] = { ...fields[index], ...value };
    else fields.push(value as never);

    let titles: { id?: string; lab?: string; val?: string }[] = [];

    try {
      const parsed = JSON.parse(String(answer.Titles ?? '[]'));
      if (Array.isArray(parsed)) titles = parsed;
    } catch {
      titles = [];
    }

    const mark = { id: markId, val: 'SI', lab: 'CORREO ENVIADO' };
    const at = titles.findIndex((entry) => entry.id === markId);

    if (at >= 0) titles[at] = { ...titles[at], ...mark };
    else titles.push(mark);

    await this.answers.update(answer.ID, {
      Fields: JSON.stringify(fields),
      Titles: JSON.stringify(titles),
      UpdatedOn: new Date().toISOString(),
    });
  }
}
