import { Injectable } from '@angular/core';

import { ContextoDeMomento, MomentoDeLaApp } from './vigia-de-geocercas';

type Oyente = (
  momento: MomentoDeLaApp,
  contexto: ContextoDeMomento | null,
  esperaGpsMs?: number,
) => Promise<void>;

/**
 * El aviso de que pasó algo en la aplicación —se creó, guardó, actualizó o
 * eliminó una actividad; se inició o se cerró sesión— para las reglas de
 * geocerca que se disparan por un momento.
 *
 * ## Por qué un servicio aparte y sin dependencias
 *
 * Porque quien avisa (`AuthService`, `ActivityService`, el formulario) es a la
 * vez algo que `GeocercasService` necesita: si lo inyectaran directamente,
 * Angular encontraría un ciclo al construirlos. Aquí no se inyecta nada; la
 * vigilancia se apunta como oyente al arrancar.
 *
 * ## Nunca frena a quien avisa
 *
 * [avisar] no espera: la evaluación pide una lectura de GPS que puede tardar
 * diez segundos, y guardar una actividad no puede quedarse esperando eso.
 * Solo el cierre de sesión espera, y con tope ([avisarYEsperar]): después de
 * cerrarla el token ya no vale y el evento no podría contarse.
 */
@Injectable({ providedIn: 'root' })
export class MomentosDeLaAppService {
  private oyente: Oyente | null = null;

  escuchar(oyente: Oyente): void {
    this.oyente = oyente;
  }

  /** En segundo plano: devuelve en el acto. */
  avisar(momento: MomentoDeLaApp, contexto: ContextoDeMomento | null = null): void {
    const oyente = this.oyente;
    if (!oyente) return;
    oyente(momento, contexto).catch((error) =>
      console.warn(`[Geocercas] el momento «${momento}» no se pudo evaluar`, error),
    );
  }

  /** Espera a que se evalúe y se cuente, pero nunca más de `ms`. */
  async avisarYEsperar(
    momento: MomentoDeLaApp,
    contexto: ContextoDeMomento | null,
    ms: number,
  ): Promise<void> {
    const oyente = this.oyente;
    if (!oyente) return;
    let reloj: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        // El GPS con menos margen que el tope: tiene que quedar tiempo para contarlo.
        oyente(momento, contexto, Math.max(1000, ms - 3000)).catch((error) =>
          console.warn(`[Geocercas] el momento «${momento}» no se pudo evaluar`, error),
        ),
        new Promise<void>((resolve) => (reloj = setTimeout(resolve, ms))),
      ]);
    } finally {
      if (reloj) clearTimeout(reloj);
    }
  }
}
