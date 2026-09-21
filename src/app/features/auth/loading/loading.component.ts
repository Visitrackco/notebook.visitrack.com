import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import { ENTITY_LABELS } from '../../../core/sync/entity-mappers';
import { SyncService } from '../../../core/sync/sync.service';
import { AuthService } from '../../../core/services/auth.service';
import { SurveyRepository } from '../../../core/repositories/entity.repositories';
import { ConnectivityService } from '../../../core/services/connectivity.service';
import { IconComponent } from '../../../shared/components/icon/icon.component';

/**
 * La descarga que va entre entrar y trabajar.
 *
 * ## Por qué existe
 *
 * Entrar no es tener los datos. Una cuenta recién abierta en este navegador
 * tiene la sesión y nada más: sin formularios, sin ubicaciones y sin listas no
 * se puede diligenciar nada, y la aplicación se ve rota aunque esté perfecta.
 *
 * El teléfono ya hacía esto —su pantalla de carga sincroniza antes de entrar—
 * y el navegador no, así que había que ir a mano a la pantalla de
 * sincronización. Quien no lo sabía, entraba a una aplicación vacía.
 *
 * ## Por qué no se puede saltar
 *
 * Porque el resultado de saltarla es peor que la espera: se empieza a trabajar
 * creyendo que faltan datos que sí están, o se abre un formulario que todavía
 * no llegó. La descarga es incremental —solo lo que cambió— así que en el uso
 * diario dura un instante; la larga es la primera, que es justo la que no se
 * puede evitar.
 *
 * ## Sin conexión se entra igual
 *
 * Quien abre la aplicación en campo sin señal tiene sus datos en el equipo y
 * derecho a trabajar con ellos. Retenerlo aquí no descargaría nada y le quitaría
 * lo único que sí tiene.
 */
@Component({
  selector: 'vt-loading',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './loading.component.html',
  styleUrl: './loading.component.scss',
})
export class LoadingComponent {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly connectivity = inject(ConnectivityService);
  private readonly auth = inject(AuthService);
  private readonly surveys = inject(SurveyRepository);

  readonly sync = inject(SyncService);

  readonly failed = signal('');

  /** Lo que se está trayendo ahora, para que la espera tenga contenido. */
  readonly detail = computed(() => {
    const entities = Object.entries(this.sync.state().byEntity)
      .filter(([, count]) => count > 0)
      .map(([entity]) => ENTITY_LABELS[Number(entity)] ?? '')
      .filter(Boolean);

    return entities.slice(-3).join(' · ');
  });

  readonly progress = computed(() => {
    const { total, processed } = this.sync.state();
    return total > 0 ? Math.min(1, processed / total) : 0;
  });

  readonly counter = computed(() => {
    const { total, processed } = this.sync.state();
    if (total === 0) return '';

    return `${processed.toLocaleString('es-CO')} de ${total.toLocaleString('es-CO')}`;
  });

  constructor() {
    void this.run();
  }

  private async run(): Promise<void> {
    // Sin conexión no hay nada que traer, y retener a quien tiene sus datos en
    // el equipo sería quitarle lo único que sí tiene.
    if (this.connectivity.isOffline()) {
      await this.enter();
      return;
    }

    try {
      const session = this.auth.currentUser();

      /*
       * Con datos ya en este navegador, se entra **de una**.
       *
       * Antes entrar volvía a pedir todo al servidor —`prepareDevice` con
       * reset— y la pantalla retenía hasta que bajara: con miles de
       * registros eran minutos mirando una barra para llegar a lo mismo que
       * ya estaba aquí. Ahora, si el usuario ya tiene sus formularios en
       * IndexedDB, se pasa al inicio y detrás baja solo lo que el servidor
       * tiene pendiente para este equipo (`isSynced = 0`), que es lo que hace
       * `download` por su cuenta. Volver a pedirlo todo sigue estando en
       * Sincronización → «Sincronizar todo», para cuando de verdad haga falta.
       *
       * La primera vez en el navegador —sin nada guardado— sí se pide todo y
       * se espera: sin datos no hay a dónde entrar.
       */
      if (session && (await this.tieneDatosLocales(session.UserID))) {
        this.sync.download().catch((error) =>
          console.warn('[Carga] la descarga de lo pendiente falló; se reintenta sola', error),
        );

        await this.enter();
        return;
      }

      if (session) {
        await this.sync.prepareDevice(session.UserID, session.DeviceID, true);
      }

      await this.sync.download();
    } catch (error) {
      console.error('[Carga] no se pudo sincronizar al entrar', error);

      // Que falle no impide entrar: puede haber datos de antes, y la
      // aplicación reintenta sola. Lo que no puede es pasar en silencio.
      this.failed.set(
        'No se pudieron traer tus datos. Puedes entrar y reintentar desde Sincronización.',
      );

      return;
    }

    await this.enter();
  }

  /** ¿Este navegador ya tiene los formularios del usuario? */
  private async tieneDatosLocales(userId: string | number): Promise<boolean> {
    try {
      const formularios = await this.surveys.findByUser(Number(userId));
      return formularios.length > 0;
    } catch {
      return false;
    }
  }

  /** Sigue a donde el usuario iba. */
  async enter(): Promise<void> {
    const redirect = this.route.snapshot.queryParamMap.get('redirect');
    await this.router.navigateByUrl(redirect || '/inicio');
  }

  async retry(): Promise<void> {
    this.failed.set('');
    await this.run();
  }
}
