import { Component, OnDestroy, computed, effect, inject, input, signal } from '@angular/core';

import { FormEngine } from '../../../../core/forms/form-engine';
import { FieldValue, FormField, ResolvedDescriptor } from '../../../../core/forms/form-schema';
import { AlertSoundService } from '../../../../core/services/alert-sound.service';
import { HintComponent } from '../../../../shared/components/hint/hint.component';
import { IconComponent } from '../../../../shared/components/icon/icon.component';
import { ToTopComponent } from '../../../../shared/components/to-top/to-top.component';
import { FieldHostComponent } from '../fields/field-host.component';
import { FlujoBotonesComponent } from '../flujo-botones/flujo-botones.component';
import { FlujoGraficaComponent } from '../flujo-grafica/flujo-grafica.component';
import { MissingEntry } from '../required-dialog/required-dialog.component';
import { MasterDetailPanelsService } from './master-detail-panels.service';
import { MasterDetailStackService, RowLevel } from './master-detail-stack.service';

/**
 * La pantalla de una fila de tabla de detalle.
 *
 * ## Por qué es una ruta y no una ventana
 *
 * Dentro de una fila hay un formulario entero —páginas, fotos, firmas, y a
 * veces otra tabla de detalle—. Como ventana flotante eso obliga a apilar
 * ventanas y deja el botón atrás del navegador saliendo de la actividad en vez
 * de cerrar lo que se tiene delante. Como ruta hija, cada fila es una pantalla
 * con su dirección propia y atrás hace lo que se espera.
 *
 * ## Dibuja la pila entera, no solo la fila de arriba
 *
 * Los niveles anteriores siguen montados y ocultos. No es un descuido: el campo
 * que abrió la fila vive dentro del nivel de abajo y está esperando el
 * resultado. Destruirlo al abrir un nivel más profundo dejaría a nadie para
 * escribir lo respondido de vuelta en la actividad.
 */
@Component({
  selector: 'vt-master-detail-row',
  standalone: true,
  imports: [
    FieldHostComponent,
    FlujoBotonesComponent,
    FlujoGraficaComponent,
    HintComponent,
    IconComponent,
    ToTopComponent,
  ],
  templateUrl: './master-detail-row.component.html',
  styleUrl: './master-detail-row.component.scss',
})
export class MasterDetailRowComponent implements OnDestroy {
  private readonly stack = inject(MasterDetailStackService);
  private readonly sound = inject(AlertSoundService);
  private readonly panels = inject(MasterDetailPanelsService);

  /** Rastro de la fila, desde la dirección. */
  readonly trail = input('');

  readonly levels = computed(() => this.stack.levels());
  readonly current = computed(() => this.stack.current());

  /** Se está avisando de que faltan obligatorios. */
  readonly asking = signal(false);

  /*
   * Las gráficas que un botón destapó, mientras la fila esté abierta.
   *
   * Se van al cerrarla, y está bien que sea así: abrir una fila es empezar de
   * nuevo con ese registro, y encontrarse destapado lo que se destapó en la
   * fila anterior sería enseñar el resumen de otra cosa. Ver el mismo apartado
   * en `FormRunnerComponent`, donde se explica por qué esto no vive en el motor.
   */
  private readonly destapadas = signal<ReadonlySet<string>>(new Set());

  destapar(nombres: string[]): void {
    this.destapadas.set(new Set([...this.destapadas(), ...nombres]));
  }

  estaDestapada(grafica: { id?: string }): boolean {
    const nombre = (grafica?.id ?? '').trim();

    return !!nombre && this.destapadas().has(nombre);
  }

  constructor() {
    /**
     * La dirección manda.
     *
     * Al retroceder con el navegador, el rastro deja de coincidir con el nivel
     * de arriba y la pila se ajusta. Y si alguien llega aquí de vuelta —una
     * recarga, un enlace pegado— no hay nada abierto que enseñar: se vuelve a
     * la actividad, que es de donde se sale a llenar una fila.
     */
    effect(() => {
      const trail = this.trail();
      this.stack.syncTo(trail);

      if (this.stack.levels().length === 0) this.stack.backToActivity();
    });
  }

  ngOnDestroy(): void {
    // Se salió de la ruta por completo: no queda nadie que dibuje las filas.
    this.stack.clear();
  }

  // ── El formulario de la fila ───────────────────────────────────────────────

  isTop(level: RowLevel): boolean {
    return level.trail === this.current()?.trail;
  }


  /**
   * Longitud del aro, en unidades del `viewBox`.
   *
   * Es la circunferencia (2πr con r = 18): así el trazo tiene exactamente una
   * raya del largo del aro, y desplazarla con `stroke-dashoffset` descubre la
   * porción que corresponde al porcentaje. El mismo recurso que el anillo de
   * progreso del formulario.
   */
  readonly ringLength = computed(() => 2 * Math.PI * 18);

  /** Cuánto se retrae el trazo de esta fila. */
  ringOffset(level: RowLevel): number {
    return this.ringLength() * (1 - level.engine.progress().percent / 100);
  }

  pagesOf(level: RowLevel): { index: number; label: string }[] {
    return level.engine.pages.map((page, index) => ({
      index,
      label: page.lab?.trim() || `Página ${index + 1}`,
    }));
  }

  onValue(level: RowLevel, field: FormField, value: FieldValue): void {
    level.engine.setValue(field, value);
  }

  /**
   * Los límites que una regla puso a un campo de la fila, si puso alguno.
   *
   * `null` cuando no hay ninguno, para que el campo no tenga que distinguir
   * entre «sin límites» y «con límites vacíos». Es el mismo criterio que en el
   * formulario de fuera.
   */
  limitesDe(estado: { desde?: string; hasta?: string; dias?: string } | undefined) {
    if (!estado?.desde && !estado?.hasta && !estado?.dias) return null;

    return { desde: estado.desde, hasta: estado.hasta, dias: estado.dias };
  }

  /**
   * El sello de un campo, para la clave del `@for`.
   *
   * Sale del nivel que se está viendo: los de debajo quedan inertes y no se
   * miran. Angular no deja usar la variable del `@for` de niveles dentro de una
   * expresión de `track` —solo `field`, `$index` y lo del componente—, así que
   * el nivel se resuelve aquí.
   */
  selloDe(fieldId: string): number {
    return this.current()?.engine.selloDe(fieldId) ?? 0;
  }

  onDescriptors(level: RowLevel, field: FormField, values: ResolvedDescriptor[]): void {
    level.engine.setDescriptors(field.id, values);
  }

  // ── Guardar y salir ────────────────────────────────────────────────────────

  /**
   * Lo que falta en la fila: sus campos y sus tablas de dentro.
   *
   * Una tabla anidada no se valida sola. El motor ve un arreglo con registros y
   * la da por respondida, pero un registro a medias es tan incompleto como una
   * pregunta en blanco — y llega igual al servidor. Se añaden con su propio
   * destino: pulsarlas lleva **dentro**, al registro que hay que corregir.
   */
  readonly missing = computed<MissingEntry[]>(() => {
    const level = this.current();
    if (!level) return [];

    const fromDetails: MissingEntry[] = [];

    for (const panel of this.panels.childrenOf(level.trail)) {
      const rows = panel.incompleteRows();
      if (rows.length === 0) continue;

      const entry = locate(level.engine, panel.fieldId);
      if (!entry) continue;

      fromDetails.push({
        ...entry,
        note:
          rows.length === 1
            ? '1 registro sin completar'
            : `${rows.length} registros sin completar`,
        go: () => panel.open(rows[0]),
      });
    }

    return [...level.engine.missing(), ...fromDetails];
  });

  /**
   * Guarda la fila.
   *
   * Con obligatorios sin responder no se guarda: se enseña qué falta y dónde,
   * como en la app. Una fila a medias que se cuela en la actividad llega
   * incompleta al servidor y ya no hay quien la complete.
   */
  save(): void {
    const level = this.current();
    if (!level) return;

    level.engine.markSubmitted();

    if (this.missing().length > 0) {
      this.alert();
      return;
    }

    this.stack.close('save');
  }

  /**
   * Salir.
   *
   * Con la fila completa, salir **guarda**: lo respondido no se pierde por
   * cerrar una pantalla. Solo cuando faltan obligatorios se pregunta, que es
   * cuando hay algo que decidir.
   */
  leave(): void {
    const level = this.current();
    if (!level) return;

    if (this.missing().length > 0) {
      this.alert();
      return;
    }

    this.stack.close('save');
  }

  /**
   * Abre el aviso y lo hace sonar.
   *
   * En campo la pantalla se mira a ratos: se pulsa guardar, se levanta la vista
   * y se da por hecho que quedó. Un aviso solo visual se pierde justo ahí.
   */
  private alert(): void {
    this.asking.set(true);
    void this.sound.warn();
  }

  /** Vuelve al formulario a corregir lo que falta. */
  keepEditing(): void {
    this.asking.set(false);
  }

  /**
   * Lleva a un campo concreto de los que faltan.
   *
   * Cambia de página si hace falta y espera al repintado: el campo puede estar
   * en otra página y no existir todavía en el documento cuando se pide.
   */
  goToField(entry: MissingEntry): void {
    const level = this.current();
    if (!level) return;

    this.asking.set(false);

    // Una tabla de dentro lleva al registro a medias: el campo en sí está
    // lleno a la vista y no hay nada que corregir en él.
    if (entry.go) {
      entry.go();
      return;
    }

    level.engine.goTo(entry.page);

    setTimeout(() => {
      const element = document.getElementById(`row-field-${entry.field.id}`);
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      element
        ?.querySelector<HTMLElement>('input, textarea, select')
        ?.focus({ preventScroll: true });
    });
  }

  /** Sale dejando la fila. Quien la abrió decide si la descarta. */
  discard(): void {
    this.asking.set(false);
    this.stack.close('discard');
  }

  /**
   * ¿Salir descarta la fila?
   *
   * Solo si se acaba de crear: nació de pulsar «agregar» y no había nada antes.
   * Una fila ya guardada se conserva tal como estaba.
   */
  readonly discardsOnExit = computed(() => this.current()?.fresh === true);
}

/** Dónde vive un campo dentro del formulario de la fila. */
function locate(engine: FormEngine, fieldId: string): MissingEntry | null {
  for (const [page, content] of engine.pages.entries()) {
    const field = content.fie.find((entry) => entry.id === fieldId);
    if (field) return { field, page };
  }

  return null;
}
