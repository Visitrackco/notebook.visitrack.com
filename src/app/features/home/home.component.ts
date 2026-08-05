import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { DatabaseService } from '../../core/database/database.service';
import { AuthService } from '../../core/services/auth.service';
import { ConnectivityService } from '../../core/services/connectivity.service';
import { IconComponent } from '../../shared/components/icon/icon.component';

/** Tarjeta de resumen del inicio. */
interface SummaryCard {
  key: string;
  label: string;
  value: number;
  icon: string;
  hint: string;
  /**
   * Familia de color del icono.
   *
   * Cada tipo de dato lleva la suya para poder distinguirlos de un vistazo sin
   * leer el rótulo. Se traduce a una clase en la plantilla, no a un color
   * literal, para que el tema siga controlando los tonos.
   */
  accent: 'brand' | 'amber' | 'blue' | 'green';
}

/**
 * Pantalla de inicio.
 *
 * Muestra el estado de los datos locales. Todavía no hay actividades porque el
 * motor de formularios no está construido, así que por ahora resume lo que sí
 * existe: los catálogos descargados.
 */
@Component({
  selector: 'vt-home',
  standalone: true,
  imports: [RouterLink, IconComponent],
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
})
export class HomeComponent {
  private readonly db = inject(DatabaseService);
  readonly auth = inject(AuthService);
  readonly connectivity = inject(ConnectivityService);

  readonly cards = signal<SummaryCard[]>([]);
  readonly loading = signal(true);
  readonly storageUsed = signal<string>('');

  /** Saludo según la hora, para que la pantalla no se sienta impersonal. */
  readonly greeting = this.buildGreeting();

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const counts = await this.db.counts();

      this.cards.set([
        {
          key: 'surveys',
          label: 'Formularios',
          value: counts['Surveys'] ?? 0,
          icon: 'clipboard',
          hint: 'Disponibles para diligenciar',
          accent: 'brand',
        },
        {
          key: 'locations',
          label: 'Ubicaciones',
          value: counts['LocationsForms'] ?? 0,
          icon: 'map-pin',
          hint: 'Sedes y puntos de trabajo',
          accent: 'amber',
        },
        {
          key: 'assets',
          label: 'Activos',
          value: counts['Assets'] ?? 0,
          icon: 'box',
          hint: 'Equipos registrados',
          accent: 'blue',
        },
        {
          key: 'answers',
          label: 'Actividades',
          value: counts['SurveyAnswers'] ?? 0,
          icon: 'check',
          hint: 'Guardadas en este equipo',
          accent: 'green',
        },
      ]);

      const estimate = await this.db.storageEstimate();
      if (estimate) {
        this.storageUsed.set(this.formatBytes(estimate.usage));
      }
    } catch (error) {
      console.error('[Home] No se pudo cargar el resumen', error);
    } finally {
      this.loading.set(false);
    }
  }

  private buildGreeting(): string {
    const hour = new Date().getHours();
    if (hour < 12) return 'Buenos días';
    if (hour < 19) return 'Buenas tardes';
    return 'Buenas noches';
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
