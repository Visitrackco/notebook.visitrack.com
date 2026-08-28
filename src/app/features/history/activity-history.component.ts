import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { Asset, LocationForm } from '../../core/models/entities.model';
import { AssetRepository, LocationRepository } from '../../core/repositories/entity.repositories';
import { ActivityHistoryStateService } from '../../core/services/activity-history-state.service';
import {
  ActivityHistoryApi,
  HistoryDateField,
  HistoryFacets,
  HistoryItem,
  HistoryPage,
} from '../../core/services/activity-history.api';
import { AuthService } from '../../core/services/auth.service';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { ToTopComponent } from '../../shared/components/to-top/to-top.component';

/** Cuánto abarca el filtro de fechas por omisión. */
const DEFAULT_MONTHS = 12;

/** Una entidad sobre la que se puede consultar. */
interface Target {
  kind: 'ubicación' | 'activo';
  id: string;
  name: string;
}

/**
 * Historial de actividades de una ubicación o un activo.
 *
 * ## La pregunta que responde
 *
 * *«¿Qué se le ha hecho antes a este equipo?»*. Hoy no tiene respuesta desde
 * ningún cliente: el dispositivo solo guarda **mis** actividades, y la
 * inspección anterior probablemente la hizo otra persona, hace meses y con otro
 * formulario.
 *
 * Por eso esta pantalla es la única de la aplicación que **no** funciona sin
 * conexión, y lo dice cuando no la hay en vez de aparecer vacía.
 *
 * ## Se usa en dos sitios
 *
 * Con `locationId` o `assetId` va embebida en el detalle de la entidad, que es
 * donde la pregunta surge sola. Sin ellos se comporta como pantalla propia y
 * pide primero sobre qué consultar.
 *
 * ## Al volver de una actividad, la consulta sigue ahí
 *
 * Filtros, página, resultado y posición del desplazamiento se guardan en
 * [ActivityHistoryStateService]. Revisar cinco actividades no puede costar
 * cinco consultas repetidas a mano.
 */
@Component({
  selector: 'vt-activity-history',
  standalone: true,
  imports: [FormsModule, IconComponent, RouterLink, ToTopComponent],
  templateUrl: './activity-history.component.html',
  styleUrl: './activity-history.component.scss',
})
export class ActivityHistoryComponent {
  private readonly api = inject(ActivityHistoryApi);
  private readonly locations = inject(LocationRepository);
  private readonly assets = inject(AssetRepository);
  private readonly auth = inject(AuthService);
  private readonly state = inject(ActivityHistoryStateService);

  /** Ubicación fija cuando va embebida. */
  readonly locationId = input<string | null>(null);
  /** Activo fijo cuando va embebida. */
  readonly assetId = input<string | null>(null);
  /** Nombre de la entidad fija, para el encabezado. */
  readonly entityName = input<string>('');

  /** Dentro del detalle de una entidad: sin título propio ni selector. */
  readonly embedded = input(false);

  // ── Entidad elegida en modo pantalla propia ────────────────────────────────

  readonly search = signal('');
  readonly suggestions = signal<Target[]>([]);
  readonly picked = signal<Target | null>(null);

  // ── Filtros ───────────────────────────────────────────────────────────────

  readonly from = signal(monthsAgo(DEFAULT_MONTHS));
  readonly to = signal(today());
  readonly dateField = signal<HistoryDateField>('CreatedOn');
  readonly term = signal('');

  /**
   * Los filtros que acotan. Vacío significa «todos».
   *
   * `assetId` aquí es **el activo elegido dentro de una ubicación**, distinto
   * del `assetId()` de entrada, que fija la entidad de la consulta. Al mandarlo
   * al servidor manda sobre la ubicación, que es lo que se quiere: pedir la
   * historia de un equipo dentro de la sede es pedir la del equipo.
   */
  readonly surveyId = signal('');
  readonly statusId = signal('');
  readonly mine = signal(false);
  readonly assetWithin = signal('');

  /** Con qué se puede acotar esta historia. Lo dice el servidor. */
  readonly facets = signal<HistoryFacets>({ surveys: [], statuses: [], assets: [] });

  // ── Resultado ─────────────────────────────────────────────────────────────

  readonly page = signal(1);
  readonly result = signal<HistoryPage | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');

  /**
   * Qué consulta refleja lo que está en pantalla.
   *
   * Es lo que evita volver a pedir al servidor lo que se acaba de restaurar: si
   * la clave no cambió, no hay nada que traer.
   */
  private loadedKey = '';

  /** Qué entidad y qué rango tienen cargadas las opciones de filtro. */
  private facetsKey = '';

  /** Sobre qué se está consultando ahora mismo. */
  readonly target = computed<Target | null>(() => {
    if (this.assetId()) {
      return { kind: 'activo', id: String(this.assetId()), name: this.entityName() };
    }

    if (this.locationId()) {
      return { kind: 'ubicación', id: String(this.locationId()), name: this.entityName() };
    }

    return this.picked();
  });

  readonly items = computed(() => this.result()?.items ?? []);
  readonly total = computed(() => this.result()?.total ?? 0);
  readonly pages = computed(() => this.result()?.pages ?? 0);

  readonly counter = computed(() => {
    const total = this.total();

    if (total === 0) return 'Sin actividades en el rango';

    const size = this.result()?.size ?? 0;
    const first = (this.page() - 1) * size + 1;
    const last = Math.min(first + this.items().length - 1, total);

    return `${first}–${last} de ${total}`;
  });

  constructor() {
    // Restaurar antes de que el efecto mire nada: si la consulta anterior sigue
    // siendo válida, la clave ya coincidirá y no se pedirá de nuevo.
    this.restore();

    effect(() => {
      const target = this.target();
      const page = this.page();

      untracked(() => {
        if (!target) {
          this.result.set(null);
          return;
        }

        const key = this.keyOf(target, page);

        if (key === this.loadedKey) return;

        void this.load(target, page);
      });
    });
  }

  // ── Memoria de la consulta ────────────────────────────────────────────────

  /** Clave de una consulta concreta: entidad, filtros y página. */
  private keyOf(target: Target, page: number): string {
    return [
      this.state.keyOf(target.kind, target.id),
      this.from(),
      this.to(),
      this.dateField(),
      this.term(),
      this.surveyId(),
      this.statusId(),
      this.mine() ? 'mias' : '',
      this.assetWithin(),
      page,
    ].join('|');
  }

  /**
   * Trae las opciones de filtro si cambió algo que las afecte.
   *
   * Dependen de la entidad y del rango, **no** de los filtros ya elegidos: si
   * dependieran, elegir un formulario dejaría el desplegable con esa única
   * opción y no habría manera de cambiar de idea sin limpiarlo antes.
   *
   * Por eso tampoco entran en la clave de la consulta: pasar de la página 2 a la
   * 3 no puede costar tres agregados sobre toda la historia de la sede.
   */
  private ensureFacets(target: Target): void {
    const key = [
      this.state.keyOf(target.kind, target.id),
      this.from(),
      this.to(),
      this.dateField(),
    ].join('|');

    if (key === this.facetsKey) return;

    this.facetsKey = key;

    // No se espera: el listado es lo que se vino a ver. Los desplegables llegan
    // cuando lleguen y, si no llegan, las fechas siguen filtrando.
    void this.loadFacets(target);
  }

  private async loadFacets(target: Target): Promise<void> {
    const facets = await this.api.facets({
      locationId: target.kind === 'ubicación' ? target.id : null,
      assetId: target.kind === 'activo' ? target.id : null,
      from: this.from(),
      to: this.endOfDay(this.to()),
      dateField: this.dateField(),
    });

    this.facets.set(facets);

    /**
     * Lo elegido puede haber dejado de existir al mover las fechas.
     *
     * Un formulario que ya no aparece en el nuevo rango seguiría filtrando en
     * silencio y daría cero resultados sin que nada explicara por qué — con su
     * nombre puesto en un desplegable donde ya no está la opción.
     */
    if (this.surveyId() && !facets.surveys.some((entry) => entry.id === this.surveyId())) {
      this.surveyId.set('');
    }

    if (this.statusId() && !facets.statuses.some((entry) => entry.id === this.statusId())) {
      this.statusId.set('');
    }

    if (this.assetWithin() && !facets.assets.some((entry) => entry.id === this.assetWithin())) {
      this.assetWithin.set('');
    }
  }

  /** Ningún filtro puesto más allá del rango de fechas. */
  readonly hasNarrowing = computed(
    () => !!(this.surveyId() || this.statusId() || this.mine() || this.assetWithin() || this.term()),
  );

  /** Quita lo que acota y deja el rango. */
  clearFilters(): void {
    this.surveyId.set('');
    this.statusId.set('');
    this.mine.set(false);
    this.assetWithin.set('');
    this.term.set('');

    this.apply();
  }

  private restore(): void {
    const fixed = this.assetId()
      ? this.state.keyOf('activo', String(this.assetId()))
      : this.locationId()
        ? this.state.keyOf('ubicación', String(this.locationId()))
        : null;

    const saved = this.state.recall(fixed);

    if (!saved) return;

    this.from.set(saved.from);
    this.to.set(saved.to);
    this.dateField.set(saved.dateField);
    this.term.set(saved.term);
    this.surveyId.set(saved.surveyId);
    this.statusId.set(saved.statusId);
    this.mine.set(saved.mine);
    this.assetWithin.set(saved.assetWithin);
    this.page.set(saved.page);
    this.result.set(saved.result);

    if (saved.target) {
      this.picked.set(saved.target);
      this.search.set(saved.target.name);
    }

    const target = this.target();

    if (target) {
      this.loadedKey = this.keyOf(target, saved.page);

      // El resultado se restauró y no se va a volver a pedir, pero las opciones
      // de filtro no se guardan: sin esto los desplegables volverían vacíos y
      // parecería que los filtros elegidos salieron de la nada.
      this.ensureFacets(target);
    }

    // Después de que el listado esté pintado; si no, no hay a dónde bajar.
    if (saved.scroll > 0) {
      setTimeout(() => window.scrollTo({ top: saved.scroll }), 0);
    }
  }

  /** Guarda el estado. Lo llama el enlace de cada actividad, antes de salir. */
  keep(): void {
    const target = this.target();

    if (!target) return;

    this.state.remember({
      key: this.state.keyOf(target.kind, target.id),
      target: this.picked(),
      from: this.from(),
      to: this.to(),
      dateField: this.dateField(),
      term: this.term(),
      surveyId: this.surveyId(),
      statusId: this.statusId(),
      mine: this.mine(),
      assetWithin: this.assetWithin(),
      page: this.page(),
      result: this.result(),
      scroll: window.scrollY,
    });
  }

  // ── Selector de entidad ───────────────────────────────────────────────────

  /**
   * Sugerencias contra los datos **locales**.
   *
   * Se busca en lo que el usuario tiene descargado, no en el servidor: son sus
   * sedes y sus equipos, y así el selector funciona igual de rápido con o sin
   * señal aunque la consulta que viene después necesite conexión.
   */
  async suggest(): Promise<void> {
    const user = this.auth.currentUser();
    const term = this.search().trim();

    if (!user || term.length < 2) {
      this.suggestions.set([]);
      return;
    }

    const userId = Number(user.UserID);
    const needle = term.toLowerCase();

    const [locations, assets] = await Promise.all([
      this.locations.search(userId, term),
      this.assets.findByUser(userId),
    ]);

    const fromLocations: Target[] = locations.slice(0, 10).map((location: LocationForm) => ({
      kind: 'ubicación',
      id: String(location.LocationID ?? ''),
      name: location.Name ?? '',
    }));

    const fromAssets: Target[] = assets
      .filter((asset: Asset) => (asset.Name ?? '').toLowerCase().includes(needle))
      .slice(0, 10)
      .map((asset: Asset) => ({
        kind: 'activo',
        id: String(asset.AssetID ?? ''),
        name: asset.Name ?? '',
      }));

    this.suggestions.set([...fromAssets, ...fromLocations].filter((entry) => entry.id));
  }

  choose(target: Target): void {
    this.picked.set(target);
    this.suggestions.set([]);
    this.search.set(target.name);
    this.page.set(1);
  }

  clearTarget(): void {
    this.state.forget();
    this.picked.set(null);
    this.result.set(null);
    this.search.set('');
    this.loadedKey = '';
  }

  // ── Consulta ──────────────────────────────────────────────────────────────

  /**
   * Aplica los filtros. Vuelve a la primera página: filtrar y quedarse en la
   * página siete de un resultado que ya no existe desconcierta.
   */
  apply(): void {
    const target = this.target();

    if (!target) return;

    if (this.page() === 1) {
      void this.load(target, 1);
      return;
    }

    this.page.set(1);
  }

  go(page: number): void {
    if (page < 1 || page > this.pages() || page === this.page()) return;

    this.page.set(page);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  private async load(target: Target, page: number): Promise<void> {
    this.loading.set(true);
    this.error.set('');

    // Aquí y no en cada sitio que consulta: `load` es el único paso por el que
    // todos pasan —el efecto, «Consultar» y el paginador—, y `ensureFacets`
    // decide por su cuenta si hace falta pedirlas.
    this.ensureFacets(target);

    /**
     * El activo elegido dentro de la sede gana sobre la sede.
     *
     * El servidor ya da precedencia al activo, así que basta con mandarlo: pedir
     * la historia de un equipo dentro de una ubicación es pedir la del equipo.
     */
    const within = target.kind === 'ubicación' ? this.assetWithin() : '';

    const reply = await this.api.search({
      locationId: target.kind === 'ubicación' && !within ? target.id : null,
      assetId: target.kind === 'activo' ? target.id : within || null,
      from: this.from(),
      to: this.endOfDay(this.to()),
      page,
      dateField: this.dateField(),
      search: this.term(),
      surveyId: this.surveyId(),
      statusId: this.statusId(),
      mine: this.mine(),
    });

    this.loading.set(false);

    if (!reply.ok) {
      this.error.set(reply.error ?? 'No se pudo consultar.');
      this.result.set(null);
      this.loadedKey = '';
      return;
    }

    this.result.set(reply.page ?? null);
    this.loadedKey = this.keyOf(target, page);
  }

  /**
   * El «hasta» incluye el día entero.
   *
   * Sin esto, filtrar «hasta el 8 de agosto» deja fuera todo lo del 8, porque
   * la fecha sola se compara contra la medianoche. Es el error clásico de los
   * rangos y se reporta como «me faltan las de hoy».
   */
  private endOfDay(date: string): string {
    return date ? `${date} 23:59:59.997` : '';
  }

  // ── Presentación ──────────────────────────────────────────────────────────

  dateOf(item: HistoryItem): string {
    const raw = item[this.dateField()] ?? item.CreatedOn;

    if (!raw) return 'Sin fecha';

    const date = new Date(raw);

    return Number.isNaN(date.getTime())
      ? String(raw).slice(0, 16)
      : date.toLocaleString('es', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
  }

  placeOf(item: HistoryItem): string {
    return [item.AssetName, item.LocationName].filter(Boolean).join(' · ');
  }
}

/** Fecha de hoy en el formato que espera un `<input type="date">`. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function monthsAgo(months: number): string {
  const date = new Date();

  date.setMonth(date.getMonth() - months);

  return date.toISOString().slice(0, 10);
}
