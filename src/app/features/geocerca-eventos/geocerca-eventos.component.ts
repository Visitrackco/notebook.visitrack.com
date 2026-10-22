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
  FilaDeEvento,
  FiltroDeEventos,
  PaginaDeEventos,
  TAM_PAGINA,
  diaLocal,
  rangoPorDefecto,
} from '../../core/geocercas/eventos-de-geocerca';
import { EventosDeGeocercaService } from '../../core/geocercas/eventos-de-geocerca.service';
import { ConnectivityService } from '../../core/services/connectivity.service';
import { IconComponent } from '../../shared/components/icon/icon.component';

/** Un día de la lista, con su encabezado. */
interface GrupoDelDia {
  dia: string;
  titulo: string;
  filas: FilaDeEvento[];
}

/**
 * «Eventos de geocerca»: el historial de lo que dispararon las geocercas.
 *
 * Hasta ahora a un evento solo se llegaba tocando su alerta; si se perdía la
 * alerta, se perdía el camino. Aquí están todos, del más reciente al más
 * viejo, de 25 en 25, con un rango de fechas y la geocerca como filtros. Tocar
 * uno abre su detalle (`geocerca-evento/:clave`), que sabe volver aquí.
 *
 * ## Los filtros viven en la dirección
 *
 * `?desde=…&hasta=…&geocerca=…&pagina=…`: así «Volver» desde el detalle
 * regresa a la misma página con los mismos filtros, y recargar no los pierde.
 *
 * ## Con y sin red
 *
 * Los da cloud-gold; sin él —sin red, caído o sin desplegar— salen de
 * `EventosGeocerca`, con un aviso. Lo que este navegador aún no ha contado al
 * servidor se marca como «pendiente de enviar».
 */
@Component({
  selector: 'vt-geocerca-eventos',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './geocerca-eventos.component.html',
  styleUrl: './geocerca-eventos.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GeocercaEventosComponent {
  private readonly servicio = inject(EventosDeGeocercaService);
  private readonly router = inject(Router);
  private readonly conexion = inject(ConnectivityService);

  /** De la dirección; vacíos, los de por defecto. */
  readonly desde = input<string | undefined>();
  readonly hasta = input<string | undefined>();
  readonly geocerca = input<string | undefined>();
  readonly pagina = input<string | undefined>();

  readonly filtro = computed<FiltroDeEventos>(() => {
    const porDefecto = rangoPorDefecto();
    const fecha = (v: string | undefined, def: string) =>
      v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : def;
    const id = Number(this.geocerca());
    return {
      desde: fecha(this.desde(), porDefecto.desde),
      hasta: fecha(this.hasta(), porDefecto.hasta),
      geocerca: this.geocerca() && Number.isFinite(id) ? id : null,
    };
  });

  readonly numeroDePagina = computed(() => Math.max(1, Math.floor(Number(this.pagina()) || 1)));

  readonly cargando = signal(true);
  readonly resultado = signal<PaginaDeEventos | null>(null);
  readonly fallo = signal(false);

  readonly filas = computed(() => this.resultado()?.filas ?? []);
  readonly sinRed = computed(() => this.resultado()?.origen === 'local');
  readonly pendientes = computed(() => this.filas().filter((f) => f.pendiente).length);
  readonly total = computed(() => this.resultado()?.total ?? 0);

  readonly paginas = computed(() => Math.max(1, Math.ceil(this.total() / (this.resultado()?.tam || TAM_PAGINA))));

  /** Las geocercas del selector; la elegida siempre está, aunque no traiga eventos. */
  readonly geocercas = computed(() => {
    const lista = this.resultado()?.geocercas ?? [];
    const elegida = this.filtro().geocerca;
    if (elegida === null || lista.some((g) => g.id === elegida)) return lista;
    return [...lista, { id: elegida, nombre: `Geocerca ${elegida}` }];
  });

  readonly hayFiltrosPropios = computed(() => {
    const f = this.filtro();
    const d = rangoPorDefecto();
    return f.geocerca !== null || f.desde !== d.desde || f.hasta !== d.hasta;
  });

  /** «Hoy», «Ayer» y luego el día en palabras: la lista se lee por días. */
  readonly grupos = computed<GrupoDelDia[]>(() => {
    const hoy = diaLocal(new Date());
    const ayerFecha = new Date();
    ayerFecha.setDate(ayerFecha.getDate() - 1);
    const ayer = diaLocal(ayerFecha);

    const grupos: GrupoDelDia[] = [];
    for (const f of this.filas()) {
      const fecha = new Date(f.en);
      const dia = Number.isNaN(fecha.getTime()) ? '' : diaLocal(fecha);
      let grupo = grupos[grupos.length - 1];
      if (!grupo || grupo.dia !== dia) {
        const titulo =
          dia === hoy
            ? 'Hoy'
            : dia === ayer
              ? 'Ayer'
              : dia
                ? fecha.toLocaleDateString('es-CO', {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                    year: fecha.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
                  })
                : 'Sin fecha';
        grupo = { dia, titulo, filas: [] };
        grupos.push(grupo);
      }
      grupo.filas.push(f);
    }
    return grupos;
  });

  /** Para descartar respuestas viejas si se cambia el filtro a mitad de carga. */
  private turno = 0;

  constructor() {
    effect(() => {
      const filtro = this.filtro();
      const pagina = this.numeroDePagina();
      untracked(() => void this.cargar(filtro, pagina));
    });

    // Al volver la red, lo del servidor: lo local era el respaldo.
    effect(() => {
      const enLinea = this.conexion.browserOnline();
      if (enLinea && untracked(() => this.sinRed() && !this.cargando())) {
        untracked(() => void this.cargar());
      }
    });
  }

  async cargar(filtro = this.filtro(), pagina = this.numeroDePagina()): Promise<void> {
    const turno = ++this.turno;
    this.cargando.set(true);
    this.fallo.set(false);
    try {
      const r = await this.servicio.listar(filtro, pagina);
      if (turno === this.turno) this.resultado.set(r);
    } catch (error) {
      console.warn('[Geocercas] no se pudo cargar el historial', error);
      if (turno === this.turno) {
        this.resultado.set(null);
        this.fallo.set(true);
      }
    } finally {
      if (turno === this.turno) this.cargando.set(false);
    }
  }

  // ─── Filtros y páginas: todo pasa por la dirección ─────────────────────────

  private ir(cambios: Partial<FiltroDeEventos> & { pagina?: number }): void {
    const f = { ...this.filtro(), ...cambios };
    // Un rango al revés se endereza en vez de quedar sin resultados.
    if (f.desde && f.hasta && f.desde > f.hasta) [f.desde, f.hasta] = [f.hasta, f.desde];
    const d = rangoPorDefecto();
    void this.router.navigate([], {
      queryParams: {
        desde: f.desde !== d.desde ? f.desde : null,
        hasta: f.hasta !== d.hasta ? f.hasta : null,
        geocerca: f.geocerca ?? null,
        pagina: cambios.pagina && cambios.pagina > 1 ? cambios.pagina : null,
      },
      replaceUrl: true,
    });
  }

  cambiarDesde(valor: string): void {
    this.ir({ desde: valor || rangoPorDefecto().desde });
  }

  cambiarHasta(valor: string): void {
    this.ir({ hasta: valor || rangoPorDefecto().hasta });
  }

  cambiarGeocerca(valor: string): void {
    this.ir({ geocerca: valor ? Number(valor) : null });
  }

  /** Atajos de rango: hoy, 7 y 30 días. */
  ultimosDias(n: number): void {
    const hoy = new Date();
    const desde = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - (n - 1));
    this.ir({ desde: diaLocal(desde), hasta: diaLocal(hoy) });
  }

  esRango(n: number): boolean {
    const hoy = new Date();
    const desde = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - (n - 1));
    const f = this.filtro();
    return f.desde === diaLocal(desde) && f.hasta === diaLocal(hoy);
  }

  limpiar(): void {
    void this.router.navigate([], { queryParams: {}, replaceUrl: true });
  }

  irAPagina(p: number): void {
    if (p < 1 || p > this.paginas()) return;
    this.ir({ pagina: p });
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  abrir(f: FilaDeEvento): void {
    void this.router.navigate(['/geocerca-evento', f.clave], {
      queryParams: { titulo: f.evento || null, volver: 'eventos' },
    });
  }

  // ─── Cómo se lee ───────────────────────────────────────────────────────────

  hora(iso: string): string {
    const fecha = new Date(iso);
    if (Number.isNaN(fecha.getTime())) return '';
    return fecha.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' });
  }

  /** «a 35 m del borde», con kilómetros si son muchos. */
  distancia(m: number): string {
    if (m < 1) return 'en el borde';
    const cifra =
      m >= 1000 ? `${(m / 1000).toLocaleString('es', { maximumFractionDigits: 1 })} km` : `${Math.round(m)} m`;
    return `a ${cifra} del borde`;
  }

  /** El color del disco de cada tipo; la palabra va en el texto. */
  claseDeTipo(tipo: string): string {
    switch (tipo) {
      case 'ENTRAR':
        return 'gev__tipo--entrar';
      case 'SALIR':
        return 'gev__tipo--salir';
      case 'MOMENTO':
        return 'gev__tipo--momento';
      default:
        return 'gev__tipo--otro';
    }
  }

  iconoDeTipo(tipo: string): string {
    switch (tipo) {
      case 'MOMENTO':
        return 'clipboard';
      case 'PERMANECER':
        return 'timer';
      default:
        return 'map-pin';
    }
  }

  rangoTexto(): string {
    const r = this.resultado();
    if (!r || !r.total) return '';
    const inicio = (r.pagina - 1) * r.tam + 1;
    const fin = Math.min(r.total, inicio + r.tam - 1);
    return r.total <= r.tam ? `${r.total} evento${r.total === 1 ? '' : 's'}` : `${inicio}–${fin} de ${r.total}`;
  }
}
