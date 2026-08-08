import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';

import { SurveyAnswer } from '../../../core/models/entities.model';
import { Colleague, ReassignService } from '../../../core/services/reassign.service';
import { IconComponent } from '../../../shared/components/icon/icon.component';

/**
 * A quién se le pasa la actividad.
 *
 * ## Por qué avisa antes de listar
 *
 * Reasignar **entrega** la actividad: pasa a ser de otra persona y desaparece
 * de este dispositivo. Quien abre esta ventana buscando «compartir» tiene que
 * enterarse antes de elegir un nombre, no después.
 *
 * ## Por qué se pide la lista al servidor cada vez
 *
 * Los compañeros no se sincronizan al dispositivo: quién trabaja hoy en la
 * compañía es justo el dato que más cambia, y una copia local ofrecería a
 * personas que ya no están. Sin conexión no se puede reasignar, y eso también
 * se dice.
 */
@Component({
  selector: 'vt-reassign-dialog',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './reassign-dialog.component.html',
  styleUrl: './reassign-dialog.component.scss',
})
export class ReassignDialogComponent {
  private readonly service = inject(ReassignService);

  readonly open = input(false);

  /** Actividad que se va a entregar. */
  readonly answer = input<SurveyAnswer | null>(null);

  /** Con qué se reconoce en el aviso: la sede, el activo. */
  readonly label = input('');

  readonly done = output<Colleague>();
  readonly cancel = output<void>();

  readonly loading = signal(false);
  readonly working = signal(false);
  readonly error = signal('');
  readonly search = signal('');

  readonly colleagues = signal<Colleague[]>([]);

  /** Compañero elegido, a la espera de confirmación. */
  readonly chosen = signal<Colleague | null>(null);

  /** Archivos que todavía no han subido. Impiden entregar. */
  readonly pendingFiles = signal(0);

  /**
   * Entidad creada aquí que todavía no ha subido, si la hay.
   *
   * Impide entregar por la misma razón que los archivos, y es más grave:
   * reasignar borra la actividad de este equipo, así que una ubicación o un
   * ítem de lista sin subir se perderían para siempre.
   */
  readonly pendingEntities = signal('');

  readonly blocked = computed(() => {
    const answer = this.answer();
    if (!answer) return '';

    const reason = this.service.canReassign(answer);
    if (reason) return reason;

    const pending = this.pendingFiles();

    if (pending > 0) {
      return (
        `Hay ${pending} ${pending === 1 ? 'archivo' : 'archivos'} sin terminar de subir. ` +
        'Súbelos antes de reasignar.'
      );
    }

    const entities = this.pendingEntities();

    return entities
      ? `${entities} Al reasignar se borra la actividad de este equipo, y con ella lo que no haya subido.`
      : '';
  });

  readonly visible = computed(() => {
    const needle = this.search().trim().toLowerCase();
    if (!needle) return this.colleagues();

    return this.colleagues().filter(
      (person) =>
        person.name.toLowerCase().includes(needle) ||
        person.email.toLowerCase().includes(needle),
    );
  });

  constructor() {
    effect(() => {
      if (!this.open()) return;

      untracked(() => {
        this.chosen.set(null);
        this.error.set('');
        this.search.set('');
        void this.load();
      });
    });
  }

  private async load(): Promise<void> {
    const answer = this.answer();
    if (!answer) return;

    this.loading.set(true);

    try {
      this.pendingFiles.set(await this.service.pendingFiles(answer.GUID));
      this.pendingEntities.set(await this.service.pendingEntities(answer));

      // Sin poder entregarla no hace falta preguntar a quién.
      if (this.blocked()) return;

      this.colleagues.set(await this.service.colleagues());
    } catch (error) {
      this.error.set(
        error instanceof Error ? error.message : 'No se pudo consultar los usuarios.',
      );
    } finally {
      this.loading.set(false);
    }
  }

  onSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  choose(person: Colleague): void {
    this.chosen.set(person);
  }

  back(): void {
    this.chosen.set(null);
  }

  /** Entrega la actividad. */
  async confirm(): Promise<void> {
    const answer = this.answer();
    const person = this.chosen();

    if (!answer || !person || this.working()) return;

    this.working.set(true);
    this.error.set('');

    try {
      await this.service.reassign(answer, person);
      this.done.emit(person);
    } catch (error) {
      this.error.set(
        error instanceof Error ? error.message : 'No se pudo reasignar la actividad.',
      );
    } finally {
      this.working.set(false);
    }
  }

  close(): void {
    if (this.working()) return;
    this.cancel.emit();
  }

  /** Iniciales para el disco de cada persona. */
  initialsOf(name: string): string {
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('');
  }
}
