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
   * Pide al servidor reenviar toda la entidad.
   *
   * Es la salida cuando una entidad se queda corta y las descargas normales no
   * la completan, porque sus registros ya fueron dados por entregados.
   */
  async resetEntity(card: EntityCard): Promise<void> {
    const ok = await this.status.resetEntity(card.entity);
    this.showFeedback(
      ok
        ? `${card.label}: el servidor volverá a enviar sus datos en la próxima descarga.`
        : this.status.lastError() || 'No se pudo solicitar el reenvío.',
    );
  }

  /** Borra la entidad en local para que se descargue completa de nuevo. */
  async clearEntity(card: EntityCard): Promise<void> {
    await this.status.clearEntity(card.entity);
    await this.readStorage();
    this.showFeedback(`${card.label}: datos locales eliminados.`);
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
