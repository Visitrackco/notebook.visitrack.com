import { Location } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { Router } from '@angular/router';

import {
  Eleccion,
  dibujarGeocerca,
  enlaceAGoogleMaps,
} from '../../core/geocercas/evento-de-geocerca';
import { EventoDeGeocercaService } from '../../core/geocercas/evento-de-geocerca.service';
import { IconComponent } from '../../shared/components/icon/icon.component';

/**
 * «Evento de geocerca»: a donde lleva tocar una alerta de geocerca.
 *
 * Arriba lo que decía la alerta (título y texto, que llegan en la dirección);
 * debajo, qué pasó de verdad: el evento, quién, cuándo, con qué flujo y regla,
 * si estaba dentro o fuera y la foto del mapa.
 *
 * ## Con y sin red
 *
 * Los datos los da cloud-gold; sin él —sin red, caído— se arma la vista con el
 * evento guardado en este navegador y la geometría del flujo. Y en vez de la
 * foto del mapa, que necesita red, un dibujo de la geocerca con el punto de la
 * persona. Si la foto falla al cargar, también el dibujo.
 */
@Component({
  selector: 'vt-geocerca-evento',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './geocerca-evento.component.html',
  styleUrl: './geocerca-evento.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GeocercaEventoComponent {
  private readonly servicio = inject(EventoDeGeocercaService);
  private readonly router = inject(Router);
  private readonly location = inject(Location);

  /** De la ruta: `geocerca-evento/:clave?titulo=…&texto=…`. */
  readonly clave = input.required<string>();
  readonly titulo = input<string | undefined>();
  readonly texto = input<string | undefined>();
  /** `eventos` si se llegó desde el historial «Eventos de geocerca». */
  readonly volverA = input<string | undefined>(undefined, { alias: 'volver' });

  readonly desdeLaLista = computed(() => this.volverA() === 'eventos');

  readonly cargando = signal(true);
  readonly eleccion = signal<Eleccion | null>(null);

  /** La foto del mapa: cargando, lista o rota (y entonces, el dibujo). */
  readonly foto = signal<'cargando' | 'lista' | 'rota'>('cargando');

  readonly vista = computed(() => {
    const e = this.eleccion();
    return e?.estado === 'listo' ? e.vista : null;
  });

  readonly dibujo = computed(() => {
    const v = this.vista();
    return v ? dibujarGeocerca(v.geocerca, v.lat, v.lng) : null;
  });

  readonly mostrarFoto = computed(() => !!this.vista()?.mapaUrl && this.foto() !== 'rota');

  readonly googleMaps = computed(() => {
    const v = this.vista();
    return v ? enlaceAGoogleMaps(v.lat, v.lng) : '';
  });

  readonly tituloAlerta = computed(() => (this.titulo() ?? '').trim() || 'Alerta de geocerca');

  readonly abriendo = signal(false);

  constructor() {
    effect(() => {
      const clave = this.clave();
      untracked(() => void this.cargar(clave));
    });
  }

  async cargar(clave = this.clave()): Promise<void> {
    this.cargando.set(true);
    this.foto.set('cargando');
    try {
      this.eleccion.set(await this.servicio.cargar(clave));
    } finally {
      this.cargando.set(false);
    }
  }

  /** La hora local, en palabras: «jueves, 22 de octubre, 3:40 p. m.». */
  cuando(iso: string): string {
    const fecha = new Date(iso);
    if (Number.isNaN(fecha.getTime())) return iso;
    return fecha.toLocaleString('es-CO', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: fecha.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  /** «a 35 m del borde», con kilómetros si son muchos. */
  distancia(m: number): string {
    if (m < 1) return 'justo en el borde';
    const cifra = m >= 1000 ? `${(m / 1000).toLocaleString('es', { maximumFractionDigits: 1 })} km` : `${m} m`;
    return `a ${cifra} del borde`;
  }

  async abrirActividad(): Promise<void> {
    const ctx = this.vista()?.contexto;
    if (!ctx) return;
    this.abriendo.set(true);
    try {
      await this.router.navigate(await this.servicio.rutaDeActividad(ctx.answerGuid, ctx.surveyId));
    } finally {
      this.abriendo.set(false);
    }
  }

  volver(): void {
    // Desde la lista, a la lista: «atrás» conserva sus filtros y su página; si
    // se abrió el enlace suelto, la lista desde el principio.
    if (this.desdeLaLista()) {
      if (history.length > 1) this.location.back();
      else void this.router.navigate(['/geocerca-eventos']);
      return;
    }
    if (history.length > 1) this.location.back();
    else void this.router.navigate(['/inicio']);
  }
}
