import { Component, computed, inject, input, output, signal } from '@angular/core';

import {
  GeolocationService,
  GpsError,
  GpsErrorKind,
  GpsReading,
} from '../../../../../core/services/geolocation.service';
import { ConfirmDialogComponent } from '../../../../../shared/components/confirm-dialog/confirm-dialog.component';
import { IconComponent } from '../../../../../shared/components/icon/icon.component';

/** Qué diálogo está abierto. */
type GpsDialog = 'none' | 'explain' | 'error' | 'remove';

/**
 * Campo de ubicación GPS.
 *
 * Replica el flujo de la app: explicar antes de pedir el permiso, avisar
 * mientras se busca señal, y mostrar la lectura con su precisión.
 *
 * ## Por qué se explica antes de pedir permiso
 *
 * El navegador solo pregunta **una vez**. Si el usuario dice que no —y muchos
 * lo hacen por reflejo ante un aviso que no esperaban—, la única forma de
 * revertirlo es entrar a la configuración del navegador, que casi nadie
 * encuentra. Explicar primero para qué se necesita convierte esa decisión en
 * una elección informada, y es lo que hace la app móvil con su propio diálogo.
 *
 * ## El valor
 *
 * Se guarda como el objeto de la app —`{lat, lng, pro, tim, tph, alt, acc}`—
 * para que una actividad diligenciada aquí y otra desde el teléfono lleguen
 * iguales a Visitrack.
 */
@Component({
  selector: 'vt-gps-field',
  standalone: true,
  imports: [ConfirmDialogComponent, IconComponent],
  templateUrl: './gps-field.component.html',
  styleUrl: './gps-field.component.scss',
})
export class GpsFieldComponent {
  private readonly geo = inject(GeolocationService);

  readonly label = input('Ubicación');
  readonly help = input('');
  readonly required = input(false);
  readonly readOnly = input(false);
  readonly invalid = input(false);

  /** Lectura guardada, o `null` si el campo está vacío. */
  readonly reading = input<GpsReading | null>(null);

  readonly readingChange = output<GpsReading | null>();

  readonly capturing = signal(false);
  readonly dialog = signal<GpsDialog>('none');
  readonly error = signal<GpsError | null>(null);

  /** El navegador puede dar la ubicación en este contexto. */
  readonly available = computed(() => this.geo.isSupported && this.geo.isSecureContext);

  /** Precisión en palabras, no en metros sueltos. */
  readonly accuracy = computed(() => {
    const value = this.reading();
    return value ? this.geo.describeAccuracy(value.acc) : null;
  });

  /** Momento de la captura, legible. */
  readonly capturedAt = computed(() => {
    const value = this.reading();
    if (!value?.tim) return '';

    return new Date(value.tim).toLocaleString('es', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  });

  /** Enlace al mapa, para comprobar que la lectura cae donde debe. */
  readonly mapUrl = computed(() => {
    const value = this.reading();
    if (!value) return '';
    return `https://www.google.com/maps/search/?api=1&query=${value.lat},${value.lng}`;
  });

  /** Título del aviso de error, según el motivo. */
  readonly errorTitle = computed(() => {
    switch (this.error()?.kind) {
      case 'denied':
        return 'Sin permiso de ubicación';
      case 'timeout':
        return 'No se encontró señal';
      case 'insecure':
        return 'Conexión no segura';
      case 'unsupported':
        return 'Navegador sin ubicación';
      default:
        return 'No se pudo capturar';
    }
  });

  /** Qué puede hacer el usuario al respecto. Es la parte útil del aviso. */
  readonly errorAdvice = computed<string>(() => ADVICE[this.error()?.kind ?? 'unavailable']);

  // ───────────────────────────────────────────────────────────────────────────
  // Captura
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Pide la ubicación.
   *
   * Si el permiso todavía no se ha decidido, primero se explica. Si ya está
   * concedido, se captura directamente: volver a explicar cada vez sería un
   * paso de más en el gesto que más se repite.
   */
  async requestCapture(): Promise<void> {
    if (this.readOnly() || this.capturing()) return;

    const permission = await this.geo.checkPermission();

    if (permission === 'granted') {
      await this.capture();
      return;
    }

    if (permission === 'denied') {
      this.error.set(new GpsError('denied', 'El permiso está bloqueado.'));
      this.dialog.set('error');
      return;
    }

    // 'prompt' o 'unknown': se explica antes de que el navegador pregunte.
    this.dialog.set('explain');
  }

  /** El usuario aceptó la explicación: ahora sí se pide al navegador. */
  async confirmExplain(): Promise<void> {
    this.dialog.set('none');
    await this.capture();
  }

  private async capture(): Promise<void> {
    this.capturing.set(true);
    this.error.set(null);

    try {
      const reading = await this.geo.capture();
      this.readingChange.emit(reading);
    } catch (error) {
      this.error.set(
        error instanceof GpsError
          ? error
          : new GpsError('unavailable', 'No se pudo leer la ubicación.'),
      );
      this.dialog.set('error');
    } finally {
      this.capturing.set(false);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Borrado
  // ───────────────────────────────────────────────────────────────────────────

  askRemove(): void {
    if (this.readOnly()) return;
    this.dialog.set('remove');
  }

  confirmRemove(): void {
    this.dialog.set('none');
    this.readingChange.emit(null);
  }

  closeDialog(): void {
    this.dialog.set('none');
  }
}

/**
 * Qué hacer ante cada fallo.
 *
 * Un mensaje que solo dice qué salió mal deja al usuario en el mismo sitio; lo
 * que resuelve la situación es el paso siguiente, y depende del motivo.
 */
const ADVICE: Record<GpsErrorKind, string> = {
  denied:
    'Toca el icono de candado o de ubicación en la barra de direcciones del navegador y permite el acceso para este sitio. Después vuelve a intentarlo.',
  timeout:
    'Sal al exterior o acércate a una ventana y espera unos segundos. Bajo techo el GPS puede tardar en fijar la posición.',
  unavailable:
    'Comprueba que la ubicación del dispositivo esté activada y vuelve a intentarlo.',
  insecure:
    'Esta página se abrió sin HTTPS y el navegador bloquea la ubicación. Avisa al administrador para que se acceda por una dirección segura.',
  unsupported:
    'Este navegador no permite obtener la ubicación. Prueba con otro, o diligencia este campo desde la app móvil.',
};
