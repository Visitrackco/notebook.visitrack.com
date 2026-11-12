import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { MatMenuModule } from '@angular/material/menu';
import { MatTableModule } from '@angular/material/table';

import { DatabaseService } from '../../core/database/database.service';
import { EntityCard, EntityStatusService } from '../../core/sync/entity-status.service';
import { SyncService } from '../../core/sync/sync.service';
import { AuthService } from '../../core/services/auth.service';
import { ConnectivityService } from '../../core/services/connectivity.service';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { FlujosGuardadosComponent, TipoDeFlujo } from './flujos-guardados/flujos-guardados.component';
import { localeActual, traducir } from '../../core/i18n/idioma.service';
import { TPipe } from '../../core/i18n/t.pipe';
import type { ClaveTexto } from '../../core/i18n/textos';

/** Nombre y descripción de cada entidad en la tabla, por número de entidad. */
const kEtiquetas: Record<number, [ClaveTexto, ClaveTexto]> = {
  0: ['sync.ent.0', 'sync.pista.0'],
  1: ['sync.ent.1', 'sync.pista.1'],
  2: ['sync.ent.2', 'sync.pista.2'],
  7: ['sync.ent.7', 'sync.pista.7'],
  8: ['sync.ent.8', 'sync.pista.8'],
  9: ['sync.ent.9', 'sync.pista.9'],
  10: ['sync.ent.10', 'sync.pista.10'],
  12: ['sync.ent.12', 'sync.pista.12'],
  14: ['sync.ent.14', 'sync.pista.14'],
  15: ['sync.ent.15', 'sync.pista.15'],
  35: ['sync.ent.35', 'sync.pista.35'],
  79: ['sync.ent.79', 'sync.pista.79'],
  100: ['sync.ent.100', 'sync.pista.100'],
  101: ['sync.ent.101', 'sync.pista.101'],
};

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
  imports: [IconComponent, MatTableModule, MatMenuModule, FlujosGuardadosComponent, TPipe],
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

  /**
   * Qué flujos se están consultando, o `null`.
   *
   * Al tocar «Flujos de formularios» (100) o «Flujos de geocerca» (101) se abre
   * debajo de la tabla la lista de los que hay guardados en este navegador.
   */
  readonly verFlujos = signal<TipoDeFlujo | null>(null);

  /** El tipo de flujo de una fila, si la fila es de flujos. */
  tipoDeFlujo(card: EntityCard): TipoDeFlujo | null {
    if (card.entity === 100) return 'formulario';
    if (card.entity === 101) return 'geocerca';
    return null;
  }

  abrirFlujos(card: EntityCard): void {
    const tipo = this.tipoDeFlujo(card);
    if (!tipo) return;
    this.verFlujos.set(this.verFlujos() === tipo ? null : tipo);
    if (this.verFlujos()) {
      setTimeout(() =>
        document.getElementById('sync-flujos')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      );
    }
  }

  /** Columnas de la tabla, en orden. */
  readonly columns = ['entity', 'local', 'server', 'missing', 'status', 'actions'];

  /** Cuándo se comparó por última vez, en formato corto. */
  readonly lastCheck = computed(() => {
    const checkedAt = this.cards().find((c) => c.checkedAt)?.checkedAt;
    if (!checkedAt) return '';

    return new Date(checkedAt).toLocaleTimeString(localeActual(), {
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

    /*
     * Una descarga que termina mientras esta pantalla está abierta —la que
     * dispara el servidor por el socket, o la que lanzó otra pestaña— se
     * refleja en las cifras sin tener que salir y volver. Se mira solo la
     * fase, no todo el estado: el progreso cambia decenas de veces por
     * descarga y no hay que releer la base en cada una.
     */
    effect(() => {
      if (this.fase() !== 'done') return;

      untracked(() => {
        void this.status.loadLocalCounts();
        void this.readStorage();
      });
    });
  }

  /** La fase de la descarga, aislada del resto del estado. */
  private readonly fase = computed(() => this.sync.state().phase);

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
    this.feedback.set(traducir('sync.marcando'));

    try {
      const result = await this.sync.resyncEverything();

      if (!result) {
        this.showFeedback(traducir('sync.sinSesion'));
        return;
      }

      // El número importa: si sale cero es que al usuario no le corresponde
      // nada, que es un problema distinto y en otro sitio.
      this.showFeedback(
        result.pending > 0
          ? traducir('sync.marcados', { n: result.pending })
          : traducir('sync.nadaAsignado'),
      );

      if (result.pending > 0) await this.downloadAll();
    } catch (error) {
      this.showFeedback(
        error instanceof Error ? error.message : traducir('sync.errorMarcar'),
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
      saved > 0 ? traducir('sync.guardados', { n: saved }) : traducir('sync.nadaNuevo'),
    );
  }

  /** Vuelve a comparar contra el servidor sin descargar nada. */
  async check(): Promise<void> {
    const ok = await this.status.checkAgainstServer();
    if (ok) {
      this.showFeedback(
        this.totalMissing() > 0
          ? traducir('sync.faltanN', { n: this.totalMissing() })
          : traducir('sync.todoAlDia'),
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
      this.showFeedback(this.status.lastError() || traducir('sync.errorReenvio'));
      return;
    }

    this.showFeedback(traducir('sync.entidadMarcada', { nombre: this.etiqueta(card) }));
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
        traducir('sync.eliminadosSinReenvio', { nombre: this.etiqueta(card) }) +
          (this.status.lastError() || traducir('sync.intentaReiniciar')),
      );
      return;
    }

    this.showFeedback(traducir('sync.eliminadosDescargando', { nombre: this.etiqueta(card) }));
    await this.downloadAll();
  }

  /** Texto del estado, en términos de lo que el usuario debe entender. */
  statusLabel(card: EntityCard): string {
    switch (card.status) {
      case 'synced':
        return traducir('sync.alDia');
      case 'outdated':
        return traducir('sync.faltanCorto', { n: card.missing });
      case 'ahead':
        return traducir('sync.masQueServidor');
      default:
        return traducir('sync.sinComparar');
    }
  }

  /** Nombre de la entidad en el idioma de la interfaz. */
  etiqueta(card: EntityCard): string {
    const claves = kEtiquetas[card.entity];
    return claves ? traducir(claves[0]) : card.label;
  }

  /** Descripción corta de la entidad en el idioma de la interfaz. */
  pista(card: EntityCard): string {
    const claves = kEtiquetas[card.entity];
    return claves ? traducir(claves[1]) : card.hint;
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
