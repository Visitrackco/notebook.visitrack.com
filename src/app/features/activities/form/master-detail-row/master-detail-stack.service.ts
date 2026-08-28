import { Location } from '@angular/common';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Router, Scroll } from '@angular/router';
import { filter, firstValueFrom, race, timer } from 'rxjs';

import { FormEngine } from '../../../../core/forms/form-engine';

/** Cómo se cerró una fila. */
export type RowOutcome =
  /** Con el botón de guardar, y estaba completa. */
  | 'save'
  /** El usuario decidió salir dejándola. */
  | 'discard'
  /** Se salió por el navegador: decide quien la abrió. */
  | 'auto';

/** Una fila abierta, con todo lo que hace falta para dibujarla. */
export interface RowLevel {
  /** Identificador del nivel en la URL. */
  trail: string;

  /** Nombre del campo del que salió: «Equipos revisados». */
  title: string;

  /** Nombre de la fila: el ítem elegido. */
  name: string;

  /**
   * GUID del ítem del que nació la fila.
   *
   * Lo heredan las tablas de detalle que vivan dentro: sus registros son los
   * ítems que cuelgan de este. Ver `DetailContext.parent`.
   */
  listDetGuid: string;

  engine: FormEngine;

  /** Actividad abierta, para los campos de archivo de dentro. */
  answerGuid: string;

  /** Se creó ahora y todavía no se ha guardado nada en ella. */
  fresh: boolean;

  /** Avisa del cierre a quien la abrió. Se llama una sola vez. */
  settle: (outcome: RowOutcome) => void;
}

/**
 * La pila de filas abiertas.
 *
 * ## Por qué una pila y no una ventana
 *
 * El formulario de una fila **es un formulario**: páginas, fotos, firmas, y a
 * veces otra tabla de detalle dentro. Encajar eso en una ventana flotante
 * obliga a apilar ventanas sobre ventanas, y deja el botón atrás del navegador
 * haciendo lo contrario de lo que el usuario espera — sale de la actividad
 * entera en vez de cerrar lo que tiene delante.
 *
 * Como ruta hija, cada fila es una pantalla: atrás la cierra, la dirección dice
 * dónde se está, y un MasterDetail dentro de otro es simplemente un nivel más.
 *
 * ## Los niveles no se destruyen
 *
 * Al abrir un nivel más profundo, los anteriores siguen montados —ocultos— y no
 * se descartan. Es lo que permite que el campo que abrió la fila siga vivo
 * esperando el resultado: si se destruyera, nadie quedaría para escribir lo
 * respondido de vuelta en la actividad.
 */
@Injectable({ providedIn: 'root' })
export class MasterDetailStackService {
  private readonly router = inject(Router);
  private readonly location = inject(Location);

  private readonly stack = signal<RowLevel[]>([]);

  readonly levels = computed(() => this.stack());
  readonly current = computed(() => this.stack().at(-1) ?? null);

  /** Ruta de la actividad, de la que cuelgan las filas. */
  private base: unknown[] = [];

  /** La fija la pantalla de la actividad al montarse. */
  setBase(commands: unknown[]): void {
    this.base = commands;
  }

  /** La ruta de la actividad, para quien más cuelgue pantallas de ella. */
  baseCommands(): unknown[] {
    return this.base;
  }

  /**
   * Abre una fila y espera a que se cierre.
   *
   * El rastro se construye sobre el del nivel actual, así que una tabla dentro
   * de otra queda anidada sin que nadie tenga que llevar la cuenta: basta con
   * que el campo llame a esto desde donde esté.
   */
  open(input: {
    fieldId: string;
    rowGuid: string;
    title: string;
    name: string;
    listDetGuid: string;
    engine: FormEngine;
    answerGuid: string;
    fresh: boolean;
  }): Promise<RowOutcome> {
    const parent = this.current()?.trail ?? '';
    const step = `${input.fieldId}~${input.rowGuid}`;
    const trail = parent ? `${parent},${step}` : step;

    return new Promise<RowOutcome>((resolve) => {
      let done = false;

      const level: RowLevel = {
        trail,
        title: input.title,
        name: input.name,
        listDetGuid: input.listDetGuid,
        engine: input.engine,
        answerGuid: input.answerGuid,
        fresh: input.fresh,
        settle: (outcome) => {
          // Una fila puede cerrarse por el botón y a la vez por el cambio de
          // dirección que ese botón provoca. Solo cuenta la primera.
          if (done) return;
          done = true;
          resolve(outcome);
        },
      };

      this.stack.update((levels) => [...levels, level]);
      void this.router.navigate([...this.base, 'registro', trail]);
    });
  }

  /**
   * Cierra la fila de arriba con un resultado explícito.
   *
   * Se retrocede en el historial en vez de navegar hacia adelante: abrir la
   * fila añadió una entrada, y cerrarla tiene que deshacerla. Navegando hacia
   * adelante, el botón atrás volvería a una fila que ya no existe y el usuario
   * quedaría dando vueltas entre dos pantallas.
   */
  close(outcome: Exclude<RowOutcome, 'auto'>): void {
    const level = this.current();
    if (!level) return;

    this.stack.update((levels) => levels.slice(0, -1));
    this.location.back();

    /**
     * El aviso llega **después** de volver, no antes.
     *
     * Quien abrió la fila encadena cosas al cerrarse —la principal, devolver la
     * vista a su campo—, y eso no se puede hacer mientras el formulario sigue
     * oculto detrás de esta pantalla. Avisar antes de tiempo dejaba el
     * formulario apareciendo por arriba del todo después de editar un registro.
     *
     * Con un tope de espera: si la navegación no llega a completarse, más vale
     * avisar tarde que no avisar — quien espera se quedaría colgado.
     */
    void this.afterNavigation().then(() => level.settle(outcome));
  }

  /**
   * Espera a que la navegación **y el desplazamiento del router** terminen.
   *
   * Se espera al evento `Scroll` y no a `NavigationEnd`, y la diferencia
   * importa: cerrar una fila es un «atrás» del navegador, y el router tiene
   * encendida la restauración de posición, así que después de `NavigationEnd`
   * **él** mueve la página a la posición que guardó para esa entrada del
   * historial. Avisando en `NavigationEnd`, quien devuelve la vista a su campo
   * colocaba bien y el router lo deshacía un instante después: el formulario
   * aparecía arriba del todo tras editar un registro.
   *
   * `Scroll` llega justo después de que el router haya hecho lo suyo, que es
   * cuando de verdad se puede colocar la vista.
   *
   * Con un tope de espera: si la navegación no llega a completarse, más vale
   * avisar tarde que no avisar — quien espera se quedaría colgado.
   */
  private afterNavigation(): Promise<unknown> {
    return firstValueFrom(
      race(
        this.router.events.pipe(filter((event) => event instanceof Scroll)),
        timer(1200),
      ),
    );
  }

  /**
   * Ajusta la pila a lo que dice la dirección.
   *
   * Es lo que hace que el botón atrás del navegador funcione: al retroceder, la
   * dirección deja de coincidir con el nivel de arriba y este se cierra. Los
   * que se cierran así lo hacen con `auto`, para que sea el campo —que sabe si
   * la fila es nueva y si está completa— quien decida qué hacer con ella.
   */
  syncTo(trail: string): void {
    while (this.stack().length > 0 && this.current()!.trail !== trail) {
      const level = this.current()!;
      this.stack.update((levels) => levels.slice(0, -1));
      level.settle('auto');
    }
  }

  /** Cierra todo. Se llama al salir de la actividad. */
  clear(): void {
    const levels = this.stack();
    this.stack.set([]);

    for (const level of levels.reverse()) level.settle('auto');
  }

  /**
   * Vuelve a la actividad porque no hay ninguna fila que enseñar.
   *
   * Pasa al recargar la página sobre la dirección de una fila: el estado vive en
   * memoria y no sobrevive. Se **reemplaza** la entrada del historial en vez de
   * añadir otra, o el botón atrás traería de vuelta a la misma dirección vacía
   * una y otra vez.
   */
  backToActivity(): void {
    void this.router.navigate(this.base, { replaceUrl: true });
  }
}
