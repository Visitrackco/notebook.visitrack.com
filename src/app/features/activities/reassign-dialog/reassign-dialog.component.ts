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
/** Cómo terminó: a quién, cuántas pasaron y por qué no las demás. */
export interface ReasignacionHecha {
  person: Colleague;
  hechas: number;
  fallidas: string[];
  omitidas: string[];
}

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

  /**
   * Varias de una vez, a la misma persona. Si viene, manda sobre [answer].
   *
   * Cada una se revisa con las mismas reglas que una sola: las que no se
   * pueden entregar se omiten con su motivo y las demás siguen.
   */
  readonly answers = input<SurveyAnswer[]>([]);

  /** Con qué se reconoce en el aviso: la sede, el activo. */
  readonly label = input('');

  readonly done = output<ReasignacionHecha>();
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

  /** Lo que se va a entregar: las varias, o la una. */
  readonly todas = computed(() => {
    const varias = this.answers();
    if (varias.length) return varias;
    const una = this.answer();
    return una ? [una] : [];
  });

  readonly varias = computed(() => this.todas().length > 1);

  /** Con varias: las que sí se pueden entregar, y por qué no las demás. */
  readonly aptas = signal<SurveyAnswer[]>([]);
  readonly omitidas = signal<string[]>([]);

  readonly blocked = computed(() => {
    if (this.varias()) {
      return this.loading() || this.aptas().length
        ? ''
        : 'Ninguna de las seleccionadas se puede reasignar. ' + (this.omitidas()[0] ?? '');
    }

    const answer = this.answer() ?? this.todas()[0] ?? null;
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
    const todas = this.todas();
    const answer = todas[0];
    if (!answer) return;

    this.loading.set(true);

    try {
      if (this.varias()) {
        await this.revisarVarias(todas);
        if (!this.aptas().length) return;
        this.colleagues.set(await this.service.colleagues());
        return;
      }

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

  /** Las mismas tres comprobaciones de una sola, para cada una. */
  private async revisarVarias(todas: SurveyAnswer[]): Promise<void> {
    const aptas: SurveyAnswer[] = [];
    const omitidas: string[] = [];

    for (const a of todas) {
      const nombre = a.LocationName || a.Consecutive || 'Actividad';
      const regla = this.service.canReassign(a);
      if (regla) {
        omitidas.push(`${nombre}: ${regla}`);
        continue;
      }
      const archivos = await this.service.pendingFiles(a.GUID);
      if (archivos > 0) {
        omitidas.push(`${nombre}: tiene archivos sin terminar de subir.`);
        continue;
      }
      const entidades = await this.service.pendingEntities(a);
      if (entidades) {
        omitidas.push(`${nombre}: ${entidades}`);
        continue;
      }
      aptas.push(a);
    }

    this.aptas.set(aptas);
    this.omitidas.set(omitidas);
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
    const person = this.chosen();
    const lista = this.varias() ? this.aptas() : this.todas();

    if (!lista.length || !person || this.working()) return;

    this.working.set(true);
    this.error.set('');

    try {
      if (!this.varias()) {
        await this.service.reassign(lista[0], person);
        this.done.emit({ person, hechas: 1, fallidas: [], omitidas: [] });
        return;
      }

      // Una por una: si una falla en el servidor, las demás siguen.
      let hechas = 0;
      const fallidas: string[] = [];
      for (const a of lista) {
        try {
          await this.service.reassign(a, person);
          hechas++;
        } catch (error) {
          const nombre = a.LocationName || a.Consecutive || 'Actividad';
          fallidas.push(`${nombre}: ${error instanceof Error ? error.message : 'no se pudo'}`);
        }
      }
      this.done.emit({ person, hechas, fallidas, omitidas: this.omitidas() });
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
