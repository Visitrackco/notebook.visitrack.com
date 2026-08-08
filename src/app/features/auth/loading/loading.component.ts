import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import { ENTITY_LABELS } from '../../../core/sync/entity-mappers';
import { SyncService } from '../../../core/sync/sync.service';
import { AuthService } from '../../../core/services/auth.service';
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
      /**
       * Entrar vuelve a pedir **todo**.
       *
       * El servidor lleva por separado qué le corresponde al usuario y qué le
       * falta a cada equipo, y lo segundo se desajusta con facilidad: una
       * descarga que se cortó a la mitad deja filas marcadas como entregadas
       * que nunca llegaron, y a partir de ahí ese equipo no las vuelve a pedir
       * jamás. El síntoma es este — sincronizar y que no baje nada.
       *
       * Iniciar sesión es el momento adecuado para deshacer ese desajuste: es
       * raro, hay una pantalla contándolo, y la descarga que viene detrás
       * ignora lo que ya está por GUID, así que volver a pedirlo no duplica
       * nada ni pisa lo que está pendiente de subir.
       */
      const session = this.auth.currentUser();

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
