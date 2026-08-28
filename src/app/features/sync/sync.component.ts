import { Component, computed, inject, signal } from '@angular/core';
import { MatMenuModule } from '@angular/material/menu';
import { MatTableModule } from '@angular/material/table';

import { DatabaseService } from '../../core/database/database.service';
import { EntityCard, EntityStatusService } from '../../core/sync/entity-status.service';
import { SyncService } from '../../core/sync/sync.service';
import { AuthService } from '../../core/services/auth.service';
import { ConnectivityService } from '../../core/services/connectivity.service';
import { IconComponent } from '../../shared/components/icon/icon.component';

/**
 * Sincronización.
 *
 * Una tarjeta por entidad con su conteo local, el del servidor y el resultado
 * de compararlos. Replica lo que hace la pantalla de sincronización del móvil:
 * el usuario debe poder ver **qué** falta, no solo que "algo" falta.
 */
@Component({
  selector: 'vt-sync',
  standalone: true,
  imports: [IconComponent, MatTableModule, MatMenuModule],
  templateUrl: './sync.component.html',
  styleUrl: './sync.component.scss',
})
export class SyncComponent {
  private readonly db = inject(DatabaseService);
  readonly auth = inject(AuthService);
  readonly connectivity = inject(ConnectivityService);
  readonly sync = inject(SyncService);
  readonly status = inject(EntityStatusService);

  readonly storage = signal<{ used: string; quota: string; percent: number } | null>(null);
  readonly feedback = signal('');

  readonly cards = this.status.cards;

  /** Columnas de la tabla, en orden. */
  readonly columns = ['entity', 'local', 'server', 'missing', 'status', 'actions'];

  /** Cuándo se comparó por última vez, en formato corto. */
  readonly lastCheck = computed(() => {
    const checkedAt = this.cards().find((c) => c.checkedAt)?.checkedAt;
    if (!checkedAt) return '';

    return new Date(checkedAt).toLocaleTimeString('es', {
      hour: '2-digit',
      minute: '2-digit',
    });
  });

  readonly totalLocal = computed(() =>
    this.cards().reduce((sum, card) => sum + card.localCount, 0),
  );

  /** Cuántos registros faltan por descargar, sumando todas las entidades. */
  readonly totalMissing = computed(() =>
    this.cards().reduce((sum, card) => sum + card.missing, 0),
  );

  /** Entidades que no están al día. */
  readonly outdatedCount = computed(
    () => this.cards().filter((card) => card.status === 'outdated').length,
  );

  constructor() {
    void this.initialize();
  }

  private async initialize(): Promise<void> {
    await this.status.loadLocalCounts();
    await this.readStorage();

    // Con conexión se compara sola al entrar: es lo que el usuario viene a ver.
    if (this.connectivity.isOnline()) {
      await this.status.checkAgainstServer();
    }
  }

  /** Descarga lo pendiente y vuelve a comparar. */
  /**
   * Vuelve a marcar todo como pendiente para este equipo, y descarga.
   *
   * Es lo que resuelve «sincronizo y no me baja nada». El servidor lleva por
   * separado **qué le corresponde al usuario** y **qué le falta a cada
   * equipo**; si lo segundo quedó desfasado —un dispositivo nuevo, una fila que
   * se marcó como bajada sin llegar— la descarga no encuentra nada que traer
   * aunque el usuario tenga todo asignado.
   */
  async resyncEverything(): Promise<void> {
    this.feedback.set('Marcando tus datos para este equipo…');

    try {
      const result = await this.sync.resyncEverything();

      if (!result) {
        this.showFeedback('No hay una sesión activa.');
        return;
      }

      // El número importa: si sale cero es que al usuario no le corresponde
      // nada, que es un problema distinto y en otro sitio.
      this.showFeedback(
        result.pending > 0
          ? `${result.pending} registros marcados. Descargando…`
          : 'No hay nada asignado a tu usuario. Revisa «Configurar mis datos».',
      );

      if (result.pending > 0) await this.downloadAll();
    } catch (error) {
      this.showFeedback(
        error instanceof Error ? error.message : 'No se pudo marcar los datos.',
      );
    }
  }

  async downloadAll(): Promise<void> {
    const saved = await this.sync.download();

    await this.status.loadLocalCounts();
    await this.readStorage();

    if (this.connectivity.isOnline()) {
      await this.status.checkAgainstServer();
    }

    this.showFeedback(
      saved > 0 ? `Se guardaron ${saved} registros.` : 'No había datos nuevos por descargar.',
    );
  }

  /** Vuelve a comparar contra el servidor sin descargar nada. */
  async check(): Promise<void> {
    const ok = await this.status.checkAgainstServer();
    if (ok) {
      this.showFeedback(
        this.totalMissing() > 0
          ? `Faltan ${this.totalMissing()} registros por descargar.`
          : 'Todo está al día.',
      );
    }
  }

  cancel(): void {
    this.sync.cancel();
  }

  /**
   * Pide al servidor reenviar toda la entidad, y la descarga.
   *
   * Es la salida cuando una entidad se queda corta y las descargas normales no
   * la completan, porque sus registros ya fueron dados por entregados.
   *
   * ## Por qué descarga aquí mismo
   *
   * Antes solo marcaba, y dejaba el mensaje «se enviará en la próxima
   * descarga». Nadie reinicia una entidad para dejarlo a medias: se reinicia
   * **porque falta algo ahora**, y pedir un segundo clic en otro botón era
   * repartir en dos pasos una intención que siempre es una sola. Peor aún, el
   * que se quedaba en el primer paso creía haberlo arreglado y volvía a ver los
   * mismos faltantes.
   */
  async resetEntity(card: EntityCard): Promise<void> {
    const ok = await this.status.resetEntity(card.entity);

    if (!ok) {
      this.showFeedback(this.status.lastError() || 'No se pudo solicitar el reenvío.');
      return;
    }

    this.showFeedback(`${card.label}: marcada. Descargando…`);
    await this.downloadAll();
  }

  /**
   * Borra la entidad en local y la vuelve a traer.
   *
   * Igual que el reinicio: dejar los datos borrados y esperar a que alguien
   * pulse descargar deja la aplicación **peor** de como estaba, con esa
   * entidad a cero. Si algo falla en la descarga, el mensaje lo dice y los
   * botones siguen ahí.
   */
  async clearEntity(card: EntityCard): Promise<void> {
    await this.status.clearEntity(card.entity);
    await this.readStorage();

    /*
     * Y se le pide al servidor que los reenvíe.
     *
     * Sin esto, borrar en local dejaba la entidad **vacía para siempre**: el
     * servidor lleva por separado qué le ha entregado a este equipo, y como
     * para él ya estaban dados, la descarga siguiente no traía ni una fila.
     * El botón prometía «se vuelve a descargar» y hacía justo lo contrario.
     */
    const ok = await this.status.resetEntity(card.entity);

    if (!ok) {
      this.showFeedback(
        `${card.label}: datos eliminados, pero el servidor no aceptó reenviarlos. ` +
          (this.status.lastError() || 'Vuelve a intentarlo con «Reiniciar».'),
      );
      return;
    }

    this.showFeedback(`${card.label}: datos locales eliminados. Descargando…`);
    await this.downloadAll();
  }

  /** Texto del estado, en términos de lo que el usuario debe entender. */
  statusLabel(card: EntityCard): string {
    switch (card.status) {
      case 'synced':
        return 'Al día';
      case 'outdated':
        return `Faltan ${card.missing}`;
      case 'ahead':
        return 'Más que el servidor';
      default:
        return 'Sin comparar';
    }
  }

  private async readStorage(): Promise<void> {
    const estimate = await this.db.storageEstimate();
    if (!estimate) return;

    this.storage.set({
      used: this.formatBytes(estimate.usage),
      quota: this.formatBytes(estimate.quota),
      percent: estimate.quota > 0 ? Math.round((estimate.usage / estimate.quota) * 100) : 0,
    });
  }

  private showFeedback(message: string): void {
    this.feedback.set(message);
    setTimeout(() => this.feedback.set(''), 4000);
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
}
