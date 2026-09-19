/**
 * El timer que corre en este navegador: **uno solo**, de una sola actividad.
 *
 * ## Por qué uno
 *
 * Un timer se evalúa cada medio minuto mientras corre, y con la actividad
 * cerrada eso significa montar su motor a ciegas —flujo, respuestas,
 * familia— en cada tick. Diez actividades con timer serían diez motores cada
 * medio minuto, y el navegador (o el teléfono) se resiente. Así que aquí se
 * lleva la cuenta de cuál corre, y el motor no deja arrancar otro mientras
 * tanto (`Contexto.otroTimerCorriendo`).
 *
 * ## Qué hace
 *
 * - Sabe cuál es el timer activo (lo lee de las actividades al arrancar y lo
 *   actualiza cada vez que alguien escribe un timer).
 * - Da un tick cada medio minuto **aunque la actividad esté cerrada**: si
 *   nadie la tiene abierta, corre el momento `timer` sin pantalla y hace lo
 *   que pidan sus hitos. Si está abierta, el formulario ya lo hace.
 * - Lleva un reloj de un segundo para que la tira del timer cuente en vivo.
 */
import { Injectable, Injector, computed, inject, signal } from '@angular/core';

import { SurveyAnswerRepository } from '../repositories/survey-answer.repository';
import { AuthService } from '../services/auth.service';
import { EstadoDelTimer } from './flujo-modelo';
import { FlujoSinPantallaService } from './flujo-sin-pantalla.service';
import { leerTimer } from './form-engine';

export interface TimerActivo {
  guid: string;
  timer: EstadoDelTimer;
}

@Injectable({ providedIn: 'root' })
export class TimerGlobalService {
  private readonly answers = inject(SurveyAnswerRepository);
  private readonly auth = inject(AuthService);
  private readonly injector = inject(Injector);

  /** El timer que corre (no terminado), o `null`. */
  readonly activo = signal<TimerActivo | null>(null);

  /** Sube cada segundo: para que un reloj en pantalla avance. */
  readonly reloj = signal(Date.now());

  /** La actividad que hay abierta en pantalla, si alguna: esa se evalúa sola. */
  readonly abierta = signal<string>('');

  readonly hayTimer = computed(() => this.activo() !== null);

  private cargado = false;
  private evaluando = false;

  constructor() {
    setInterval(() => this.reloj.set(Date.now()), 1000);
    setInterval(() => void this.tick(), 30_000);
    void this.cargar();
  }

  /** ¿Corre el timer de **otra** actividad? Es lo que frena arrancar uno aquí. */
  otroCorre(guid: string): boolean {
    const a = this.activo();
    return !!a && a.guid !== guid && !a.timer.terminado;
  }

  /** Alguien escribió el timer de una actividad: se toma nota. */
  apuntar(guid: string, timer: EstadoDelTimer | null): void {
    const a = this.activo();

    if (timer && !timer.terminado) {
      this.activo.set({ guid, timer });
      return;
    }

    if (a && a.guid === guid) this.activo.set(null);
  }

  /** Cuánto lleva corriendo el timer activo, en segundos. Cero si no hay. */
  segundosDe(timer: EstadoDelTimer | null | undefined): number {
    if (!timer) return 0;
    const inicio = Date.parse(String(timer.inicio ?? '').replace(' ', 'T'));
    if (!Number.isFinite(inicio)) return 0;
    return Math.max(0, Math.floor((this.reloj() - inicio) / 1000));
  }

  /**
   * Busca entre las actividades cuál tiene un timer corriendo.
   *
   * Una sola vez, al arrancar: después se mantiene con [apuntar]. Si hubiera
   * más de uno —de antes de que existiera esta regla— se queda el más
   * reciente y los demás siguen escritos pero no se evalúan solos.
   */
  private async cargar(): Promise<void> {
    if (this.cargado) return;

    try {
      const user = this.auth.currentUser();
      if (!user) {
        setTimeout(() => void this.cargar(), 5000);
        return;
      }

      const todas = await this.answers.findByUser(String(user.UserID));
      let mejor: TimerActivo | null = null;

      for (const a of todas) {
        const timer = leerTimer(a.Timer);
        if (!timer || timer.terminado) continue;
        if (!mejor || String(timer.inicio) > String(mejor.timer.inicio)) mejor = { guid: a.GUID, timer };
      }

      this.activo.set(mejor);
      this.cargado = true;
    } catch (error) {
      console.warn('[flujo] no se pudo leer qué timer corre', error);
    }
  }

  /**
   * El tick: si el timer activo es de una actividad que nadie tiene abierta,
   * se evalúa sin pantalla. Con la actividad abierta el formulario ya lo
   * evalúa, y hacerlo dos veces sería repetir avisos.
   */
  private async tick(): Promise<void> {
    if (!this.cargado) {
      await this.cargar();
      if (!this.cargado) return;
    }

    const a = this.activo();
    if (!a || a.timer.terminado || this.evaluando) return;
    if (this.abierta() === a.guid) return;

    this.evaluando = true;
    try {
      const answer = await this.answers.findByGuid(a.guid);
      if (!answer) {
        this.activo.set(null);
        return;
      }

      const timer = leerTimer(answer.Timer);
      if (!timer || timer.terminado) {
        this.activo.set(null);
        return;
      }

      const salida = await this.injector.get(FlujoSinPantallaService).evaluar(answer, 'timer');
      if (salida) this.apuntar(a.guid, salida.timer);
    } catch (error) {
      console.warn('[flujo] falló el tick del timer sin pantalla', error);
    } finally {
      this.evaluando = false;
    }
  }
}
