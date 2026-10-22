import { Component, effect, inject, input, output, signal } from '@angular/core';

import { resolveCatalogOwnerId } from '../../../core/config/company-rules';
import { DatabaseService } from '../../../core/database/database.service';
import { SurveyRepository } from '../../../core/repositories/entity.repositories';
import { AuthService } from '../../../core/services/auth.service';
import { IconComponent } from '../../../shared/components/icon/icon.component';

/** Qué flujos se miran: los de formulario (entidad 100) o los de geocerca (101). */
export type TipoDeFlujo = 'formulario' | 'geocerca';

/** Un flujo, ya traducido a lo que se enseña. */
export interface FlujoVisto {
  id: number;
  nombre: string;
  /** A qué pertenece: el formulario, o los nombres de sus geocercas. */
  pertenece: string;
  /** Solo los de formulario: si va dirigido a una persona y no es el general. */
  dirigido: boolean;
  activo: boolean;
  reglas: { nombre: string; cuando: string; acciones: string[] }[];
  timers: { nombre: string; duracion: string }[];
  /** Solo geocerca: el servidor además hace algo (correo, aviso, chat). */
  avisaServidor: boolean;
  ilegible: boolean;
}

const MOMENTOS: Record<string, string> = {
  // Formulario
  crear: 'al crear',
  abrir: 'al abrir',
  cambia: 'al cambiar un campo',
  guardar: 'al guardar',
  hijo: 'al responder un hijo',
  timer: 'por timer',
  // Geocerca
  entrar: 'al entrar',
  salir: 'al salir',
  cerca: 'cerca de un punto',
  permanecer: 'al quedarse',
  // Geocerca, por momento de la app
  'actividad-crear': 'al crear una actividad',
  'actividad-guardar': 'al guardar una actividad',
  'actividad-actualizar': 'al actualizar una actividad',
  'actividad-eliminar': 'al eliminar una actividad',
  'sesion-iniciar': 'al iniciar sesión',
  'sesion-cerrar': 'al cerrar sesión',
  'recorrido-empezar': 'al empezar el recorrido (solo en la app)',
  'recorrido-terminar': 'al terminar el recorrido (solo en la app)',
};

const DONDE: Record<string, string> = {
  dentro: 'estando dentro',
  fuera: 'estando fuera',
  cerca: 'estando cerca',
};

/** Lo que el servidor hace con un evento: no baja al navegador, solo se avisa. */
const ACCIONES: Record<string, string> = {
  'crear-actividad': 'crear actividad',
  notificar: 'notificar',
  'enviar-correo': 'enviar correo',
  'enviar-push': 'enviar aviso',
  'mensaje-chat': 'mensaje en el chat',
};

/**
 * Los flujos guardados en este navegador, para poder consultarlos.
 *
 * Desde Sincronización, al tocar «Flujos de formularios» o «Flujos de
 * geocerca». Responde a la primera pregunta cuando un formulario o una
 * geocerca no se comporta como se esperaba: **¿llegó el flujo, está activo, y
 * qué reglas trae?** Es lo mismo que «Ver los flujos» en la app.
 */
@Component({
  selector: 'vt-flujos-guardados',
  standalone: true,
  imports: [IconComponent],
  template: `
    <section class="flujos" [attr.aria-label]="titulo()">
      <header class="flujos__head">
        <div>
          <h2>{{ titulo() }}</h2>
          <span class="flujos__meta">
            {{ cargando() ? 'Leyendo…' : flujos().length + (flujos().length === 1 ? ' guardado' : ' guardados') + ' en este navegador' }}
          </span>
        </div>
        <button type="button" class="vt-btn vt-btn-ghost" (click)="cerrar.emit()">
          <vt-icon name="close" [size]="16" />
          Cerrar
        </button>
      </header>

      @if (!cargando() && flujos().length === 0) {
        <p class="flujos__vacio">
          No hay flujos de {{ tipo() === 'geocerca' ? 'geocerca' : 'formulario' }} guardados. Si
          esperabas alguno, descarga los datos o pide esta información de nuevo.
        </p>
      }

      <ul class="flujos__lista">
        @for (f of flujos(); track f.id) {
          <li>
            <details class="flujos__item">
              <summary>
                <vt-icon name="chevron" [size]="15" class="flujos__flecha" />
                <span class="flujos__titulo">
                  <strong>{{ f.nombre || 'Sin nombre' }}</strong>
                  <small>{{ f.pertenece }}</small>
                </span>
                @if (f.dirigido) {
                  <span class="flujos__chip">Personal</span>
                }
                <span class="flujos__chip" [class.flujos__chip--on]="f.activo">
                  {{ f.activo ? 'Activo' : 'Inactivo' }}
                </span>
              </summary>

              <div class="flujos__cuerpo">
                @if (f.ilegible) {
                  <p class="flujos__vacio">No se pudo leer la definición de este flujo.</p>
                } @else {
                  <h3>Reglas</h3>
                  @if (f.reglas.length === 0) {
                    <p class="flujos__vacio">Sin reglas.</p>
                  }
                  <ul class="flujos__reglas">
                    @for (r of f.reglas; track $index) {
                      <li>
                        <span>{{ r.nombre || 'Regla sin nombre' }}</span>
                        @if (r.cuando) {
                          <small class="flujos__cuando">{{ r.cuando }}</small>
                        }
                        @if (r.acciones.length) {
                          <small class="flujos__acciones">{{ r.acciones.join(' · ') }}</small>
                        }
                      </li>
                    }
                  </ul>

                  @if (f.timers.length) {
                    <h3>Timers</h3>
                    <ul class="flujos__reglas">
                      @for (t of f.timers; track $index) {
                        <li>
                          <span>{{ t.nombre || 'Timer sin nombre' }}</span>
                          <small class="flujos__cuando">{{ t.duracion }}</small>
                        </li>
                      }
                    </ul>
                  }

                  @if (f.avisaServidor) {
                    <p class="flujos__nota">
                      Algunas reglas también avisan al servidor, que hace lo que necesita red
                      (correos, avisos, chat).
                    </p>
                  }
                }
              </div>
            </details>
          </li>
        }
      </ul>
    </section>
  `,
  styles: [
    `
      .flujos {
        padding: var(--vt-space-5);
        background: var(--vt-surface);
        border-radius: var(--vt-radius-lg);
        box-shadow: var(--vt-card-shadow);
      }
      .flujos__head {
        display: flex;
        flex-wrap: wrap;
        gap: var(--vt-space-3);
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--vt-space-4);
      }
      .flujos__head h2 {
        font-size: var(--vt-text-md);
      }
      .flujos__meta,
      .flujos__vacio,
      .flujos__nota {
        font-size: var(--vt-text-xs);
        color: var(--vt-text-subtle);
      }
      .flujos__lista,
      .flujos__reglas {
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .flujos__lista > li + li {
        border-top: 1px solid var(--vt-border);
      }
      .flujos__item summary {
        display: flex;
        gap: var(--vt-space-3);
        align-items: center;
        padding: var(--vt-space-3) 0;
        cursor: pointer;
        list-style: none;
      }
      .flujos__item summary::-webkit-details-marker {
        display: none;
      }
      .flujos__flecha {
        flex: none;
        transform: rotate(-90deg);
        transition: transform var(--vt-transition, 0.15s);
      }
      .flujos__item[open] .flujos__flecha {
        transform: rotate(0deg);
      }
      .flujos__titulo {
        display: flex;
        flex: 1;
        flex-direction: column;
        min-width: 0;
      }
      .flujos__titulo small {
        overflow: hidden;
        font-size: var(--vt-text-xs);
        color: var(--vt-text-subtle);
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .flujos__chip {
        flex: none;
        padding: 2px 9px;
        font-size: var(--vt-text-xs);
        font-weight: 600;
        color: var(--vt-text-subtle);
        background: var(--vt-surface-2);
        border-radius: var(--vt-radius-full);
      }
      .flujos__chip--on {
        color: var(--vt-success);
        background: var(--vt-success-bg);
      }
      .flujos__cuerpo {
        padding: 0 0 var(--vt-space-4) calc(15px + var(--vt-space-3));
      }
      .flujos__cuerpo h3 {
        margin: var(--vt-space-2) 0;
        font-size: var(--vt-text-xs);
        font-weight: 700;
        color: var(--vt-text-subtle);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .flujos__reglas li {
        display: flex;
        flex-wrap: wrap;
        gap: 4px var(--vt-space-2);
        align-items: baseline;
        padding: 6px 0;
      }
      .flujos__cuando {
        padding: 1px 8px;
        font-size: var(--vt-text-xs);
        color: var(--vt-info);
        background: var(--vt-info-bg);
        border-radius: var(--vt-radius-full);
      }
      .flujos__acciones {
        flex-basis: 100%;
        font-size: var(--vt-text-xs);
        color: var(--vt-text-subtle);
      }
    `,
  ],
})
export class FlujosGuardadosComponent {
  private readonly db = inject(DatabaseService);
  private readonly auth = inject(AuthService);
  private readonly surveys = inject(SurveyRepository);

  readonly tipo = input.required<TipoDeFlujo>();
  readonly cerrar = output<void>();

  readonly flujos = signal<FlujoVisto[]>([]);
  readonly cargando = signal(true);

  readonly titulo = () =>
    this.tipo() === 'geocerca' ? 'Flujos de geocerca' : 'Flujos de formularios';

  constructor() {
    effect(() => {
      const tipo = this.tipo();
      void this.cargar(tipo);
    });
  }

  private async cargar(tipo: TipoDeFlujo): Promise<void> {
    this.cargando.set(true);
    try {
      const user = this.auth.currentUser();
      if (!user) {
        this.flujos.set([]);
        return;
      }
      const ownerId = resolveCatalogOwnerId(user);
      const store = tipo === 'geocerca' ? 'FlujosGeocerca' : 'Workflows';
      const filas = await this.db.transaction<any[]>(store, 'readonly', (tx) =>
        this.db.request<any[]>(tx.objectStore(store).index('byUserID').getAll(ownerId)),
      );
      const vivas = filas.filter((f) => Number(f?.IsDeleted) !== 1);

      const vistos = await Promise.all(
        vivas.map((f) => (tipo === 'geocerca' ? this.deGeocerca(f) : this.deFormulario(f))),
      );
      // Los activos primero; después, por nombre.
      vistos.sort(
        (a, b) => Number(b.activo) - Number(a.activo) || a.nombre.localeCompare(b.nombre, 'es'),
      );
      if (tipo === this.tipo()) this.flujos.set(vistos);
    } catch (error) {
      console.warn('[Sync] no se pudieron leer los flujos', error);
      this.flujos.set([]);
    } finally {
      this.cargando.set(false);
    }
  }

  private async tituloDelFormulario(surveyId: unknown): Promise<string> {
    const id = String(surveyId ?? '');
    if (!id || id === '0') return '';
    const survey = await this.surveys.findBySurveyId(id).catch(() => null);
    return survey?.Title ?? '';
  }

  private async deFormulario(f: any): Promise<FlujoVisto> {
    const titulo = await this.tituloDelFormulario(f?.SurveyID);
    const visto: FlujoVisto = {
      id: Number(f?.ID),
      nombre: String(f?.Name ?? ''),
      pertenece: titulo
        ? `Formulario: ${titulo}`
        : `Formulario ${f?.SurveyID ?? ''} (no está descargado)`,
      dirigido: f?.WorkflowUserID != null,
      activo: Number(f?.IsActive) === 1,
      reglas: [],
      timers: [],
      avisaServidor: false,
      ilegible: false,
    };

    try {
      const flujo = JSON.parse(String(f?.JSONFlow || '{}'));
      visto.reglas = (Array.isArray(flujo?.reglas) ? flujo.reglas : []).map((r: any) => ({
        nombre: String(r?.nombre ?? ''),
        cuando: cuandoDe(r?.cuando),
        acciones: [],
      }));
      visto.timers = (Array.isArray(flujo?.timers) ? flujo.timers : []).map((t: any) => ({
        nombre: String(t?.nombre ?? ''),
        duracion: duracionDe(Number(t?.duracion)),
      }));
    } catch {
      visto.ilegible = true;
    }
    return visto;
  }

  private async deGeocerca(f: any): Promise<FlujoVisto> {
    const visto: FlujoVisto = {
      id: Number(f?.ID),
      nombre: String(f?.Name ?? ''),
      pertenece: '',
      dirigido: false,
      activo: Number(f?.IsActive) === 1,
      reglas: [],
      timers: [],
      avisaServidor: false,
      ilegible: false,
    };

    try {
      const flujo = JSON.parse(String(f?.JSONMovil || '{}'));
      if (!visto.nombre) visto.nombre = String(flujo?.nombre ?? '');
      const geocercas = (Array.isArray(flujo?.geocercas) ? flujo.geocercas : [])
        .map((g: any) => String(g?.nombre ?? ''))
        .filter(Boolean);
      visto.pertenece = geocercas.length
        ? `${geocercas.length === 1 ? 'Geocerca' : 'Geocercas'}: ${geocercas.join(', ')}`
        : 'Sin geocercas';

      const reglas = Array.isArray(flujo?.reglas) ? flujo.reglas : [];
      visto.avisaServidor = reglas.some((r: any) => r?.avisaServidor === true);
      visto.reglas = await Promise.all(
        reglas.map(async (r: any) => ({
          nombre: String(r?.nombre ?? ''),
          cuando: cuandoDe(r?.cuando, r),
          acciones: await Promise.all(
            (Array.isArray(r?.acciones) ? r.acciones : []).map((a: any) => this.accionDe(a)),
          ),
        })),
      );
    } catch {
      visto.ilegible = true;
      visto.pertenece = 'Sin geocercas';
    }
    return visto;
  }

  private async accionDe(a: any): Promise<string> {
    const nombre = ACCIONES[String(a?.accion ?? '')] ?? String(a?.accion ?? 'acción');
    if (a?.accion === 'crear-actividad') {
      const titulo = await this.tituloDelFormulario(a?.surveyId);
      return `${nombre}: ${titulo || `formulario ${a?.surveyId ?? ''}`}`;
    }
    if (a?.accion === 'notificar' && a?.titulo) return `${nombre}: «${a.titulo}»`;
    return nombre;
  }
}

/** El momento de una regla, legible. En geocerca añade los metros o minutos. */
function cuandoDe(cuando: unknown, regla?: any): string {
  const lista = Array.isArray(cuando) ? cuando : cuando ? [cuando] : [];
  const textos = lista.map((c) => {
    const base = MOMENTOS[String(c)] ?? String(c);
    if (c === 'cerca' && regla?.metros) return `${base} (${regla.metros} m)`;
    if (c === 'permanecer' && regla?.minutos) return `${base} (${regla.minutos} min)`;
    // Los momentos de la app dicen además dónde tiene que estar la persona.
    if (regla && /^(actividad|sesion|recorrido)-/.test(String(c))) {
      const donde = String(regla?.donde || 'dentro');
      const metros = donde === 'cerca' && regla?.metros ? ` (${regla.metros} m)` : '';
      return `${base}, ${DONDE[donde] ?? donde}${metros}`;
    }
    return base;
  });
  return textos.join(', ');
}

/** Minutos, en palabras. */
function duracionDe(minutos: number): string {
  if (!Number.isFinite(minutos) || minutos <= 0) return 'sin duración';
  if (minutos < 60) return `${minutos} min`;
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  if (h < 24) return m ? `${h} h ${m} min` : `${h} h`;
  const d = Math.floor(h / 24);
  const hr = h % 24;
  return hr ? `${d} d ${hr} h` : `${d} d`;
}
