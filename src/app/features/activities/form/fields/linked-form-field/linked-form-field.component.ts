import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';

import { FieldValue, FormField } from '../../../../../core/forms/form-schema';
import { LinkedFormService } from '../../../../../core/forms/linked-form.service';
import { SurveyAnswer } from '../../../../../core/models/entities.model';
import { SurveyAnswerRepository } from '../../../../../core/repositories/survey-answer.repository';
import { ANSWER_STATE } from '../../../../../core/models/activity.model';
import { IconComponent } from '../../../../../shared/components/icon/icon.component';

/**
 * Un formulario vinculado: otra actividad que cuelga de esta.
 *
 * ## Por qué es un enlace y no un formulario embebido
 *
 * Lo que hay detrás es **una actividad completa** —con su ubicación, sus
 * archivos, su estado y su propio envío a Visitrack—, no una sección de ésta.
 * Dibujarla dentro obligaría a decidir qué significa guardar la de fuera cuando
 * la de dentro está a medias, y en la app tampoco se hace así: se abre.
 *
 * ## Qué enseña
 *
 * Antes de crearla, el nombre del formulario y un botón. Después, en qué va: si
 * está sin responder, guardada o ya enviada. Eso es lo que permite saber, desde
 * el padre, qué visitas quedan pendientes sin entrar a cada una.
 */
@Component({
  selector: 'vt-linked-form-field',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './linked-form-field.component.html',
  styleUrl: './linked-form-field.component.scss',
})
export class LinkedFormFieldComponent {
  private readonly linked = inject(LinkedFormService);
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly router = inject(Router);

  readonly field = input.required<FormField>();
  readonly value = input<FieldValue>(null);
  readonly readOnly = input(false);

  /** La actividad que estamos diligenciando, de la que colgará la hija. */
  readonly parentGuid = input.required<string>();

  readonly valueChange = output<FieldValue>();

  readonly child = signal<SurveyAnswer | null>(null);
  readonly title = signal('');
  readonly missing = signal(false);
  readonly working = signal(false);

  readonly exists = computed(() => this.child() !== null);

  /** En qué va la actividad hija. */
  readonly state = computed(() => {
    const answer = this.child();

    if (!answer) return '';
    if (answer.eraser === 1) return 'Sin responder';

    switch (answer.isSaved) {
      case ANSWER_STATE.SYNCED:
        return 'Enviada';
      case ANSWER_STATE.WAITING_BINARIES:
        return 'Esperando archivos';
      case ANSWER_STATE.PENDING:
        return 'Guardada, por enviar';
      default:
        return 'Sin guardar';
    }
  });

  constructor() {
    effect(() => {
      const fid = String(this.field().fid ?? '');
      const value = this.value();

      untracked(() => void this.load(fid, value));
    });
  }

  private async load(fid: string, value: FieldValue): Promise<void> {
    const { answer, survey } = await this.linked.resolve(fid, value);

    this.child.set(answer);

    // El título sale del formulario; si no está descargado, del propio valor,
    // que lo guardó cuando sí lo estaba.
    const stored = (value as { tit?: unknown })?.tit;

    this.title.set(survey?.Title || String(stored ?? '') || this.field().lab);

    /**
     * El formulario hijo no está en este dispositivo.
     *
     * Pasa cuando no se le asignó al usuario. La app lo dice al pulsar; aquí se
     * dice antes, porque un botón que solo sirve para dar un error no debería
     * verse como disponible.
     */
    this.missing.set(!survey && !answer);
  }

  /** Abre la actividad hija, creándola la primera vez. */
  async open(): Promise<void> {
    if (this.working() || this.missing()) return;

    this.working.set(true);

    try {
      const existing = this.child();

      if (existing) {
        await this.goTo(existing);
        return;
      }

      const parent = await this.answers.findByGuid(this.parentGuid());
      const { survey } = await this.linked.resolve(String(this.field().fid ?? ''), null);

      if (!parent || !survey) {
        this.missing.set(true);
        return;
      }

      const created = await this.linked.create(parent, survey, this.value());

      if (!created) return;

      // El campo del padre guarda el enlace: sin esto, volver a entrar crearía
      // otra actividad y la primera quedaría huérfana.
      this.valueChange.emit(created.value as unknown as FieldValue);
      this.child.set(created.answer);

      await this.goTo(created.answer);
    } finally {
      this.working.set(false);
    }
  }

  private async goTo(answer: SurveyAnswer): Promise<void> {
    await this.router.navigate(['/actividades', answer.SurveyID, answer.GUID]);
  }
}
