import { Component, effect, inject, input, output, signal } from '@angular/core';

import { resolveCatalogOwnerId } from '../../../core/config/company-rules';
import { DatabaseService } from '../../../core/database/database.service';
import { SurveyRepository } from '../../../core/repositories/entity.repositories';
import { AuthService } from '../../../core/services/auth.service';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { traducir } from '../../../core/i18n/idioma.service';
import { TPipe } from '../../../core/i18n/t.pipe';
import type { ClaveTexto } from '../../../core/i18n/textos';

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

const MOMENTOS: Record<string, ClaveTexto> = {
  // Formulario
  crear: 'flujos.m.crear',
  abrir: 'flujos.m.abrir',
  cambia: 'flujos.m.cambia',
  guardar: 'flujos.m.guardar',
  hijo: 'flujos.m.hijo',
  timer: 'flujos.m.timer',
  // Geocerca
  entrar: 'flujos.m.entrar',
  salir: 'flujos.m.salir',
  cerca: 'flujos.m.cerca',
  permanecer: 'flujos.m.permanecer',
  // Geocerca, por momento de la app
  'actividad-crear': 'flujos.m.actividadCrear',
  'actividad-guardar': 'flujos.m.actividadGuardar',
  'actividad-actualizar': 'flujos.m.actividadActualizar',
  'actividad-eliminar': 'flujos.m.actividadEliminar',
  'sesion-iniciar': 'flujos.m.sesionIniciar',
  'sesion-cerrar': 'flujos.m.sesionCerrar',
  'recorrido-empezar': 'flujos.m.recorridoEmpezar',
  'recorrido-terminar': 'flujos.m.recorridoTerminar',
};

const DONDE: Record<string, ClaveTexto> = {
  dentro: 'flujos.d.dentro',
  fuera: 'flujos.d.fuera',
  cerca: 'flujos.d.cerca',
};

/** Lo que el servidor hace con un evento: no baja al navegador, solo se avisa. */
const ACCIONES: Record<string, ClaveTexto> = {
  'crear-actividad': 'flujos.a.crearActividad',
  notificar: 'flujos.a.notificar',
  'enviar-correo': 'flujos.a.enviarCorreo',
  'enviar-push': 'flujos.a.enviarPush',
  'mensaje-chat': 'flujos.a.mensajeChat',
};

/** Texto de un mapa de claves, o el propio valor si no está. */
function textoDe(mapa: Record<string, ClaveTexto>, valor: string): string {
  const clave = mapa[valor];
  return clave ? traducir(clave) : valor;
}

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
  imports: [IconComponent, TPipe],
  template: `
    <section class="flujos" [attr.aria-label]="titulo()">
      <header class="flujos__head">
        <div>
          <h2>{{ titulo() }}</h2>
          <span class="flujos__meta">
            {{ cargando() ? ('flujos.leyendo' | t) : ((flujos().length === 1 ? 'flujos.guardado1' : 'flujos.guardadosN') | t: { n: flujos().length }) }}
          </span>
        </div>
        <button type="button" class="vt-btn vt-btn-ghost" (click)="cerrar.emit()">
          <vt-icon name="close" [size]="16" />
          {{ 'comun.cerrar' | t }}
        </button>
      </header>

      @if (!cargando() && flujos().length === 0) {
        <p class="flujos__vacio">
          {{ (tipo() === 'geocerca' ? 'flujos.vacioGeocerca' : 'flujos.vacioFormulario') | t }}
        </p>
      }

      <ul class="flujos__lista">
        @for (f of flujos(); track f.id) {
          <li>
            <details class="flujos__item">
              <summary>
                <vt-icon name="chevron" [size]="15" class="flujos__flecha" />
                <span class="flujos__titulo">
                  <strong>{{ f.nombre || ('flujos.sinNombre' | t) }}</strong>
                  <small>{{ f.pertenece }}</small>
                </span>
                @if (f.dirigido) {
                  <span class="flujos__chip">{{ 'flujos.personal' | t }}</span>
                }
                <span class="flujos__chip" [class.flujos__chip--on]="f.activo">
                  {{ (f.activo ? 'flujos.activo' : 'flujos.inactivo') | t }}
                </span>
              </summary>

              <div class="flujos__cuerpo">
                @if (f.ilegible) {
                  <p class="flujos__vacio">{{ 'flujos.ilegible' | t }}</p>
                } @else {
                  <h3>{{ 'flujos.reglas' | t }}</h3>
                  @if (f.reglas.length === 0) {
                    <p class="flujos__vacio">{{ 'flujos.sinReglas' | t }}</p>
                  }
                  <ul class="flujos__reglas">
                    @for (r of f.reglas; track $index) {
                      <li>
                        <span>{{ r.nombre || ('flujos.reglaSinNombre' | t) }}</span>
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
                    <h3>{{ 'flujos.timers' | t }}</h3>
                    <ul class="flujos__reglas">
                      @for (tm of f.timers; track $index) {
                        <li>
                          <span>{{ tm.nombre || ('flujos.timerSinNombre' | t) }}</span>
                          <small class="flujos__cuando">{{ tm.duracion }}</small>
                        </li>
                      }
                    </ul>
                  }

                  @if (f.avisaServidor) {
                    <p class="flujos__nota">
                      {{ 'flujos.avisaServidor' | t }}
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
    traducir(this.tipo() === 'geocerca' ? 'sync.ent.101' : 'sync.ent.100');

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
        ? traducir('flujos.formularioDe', { titulo })
        : traducir('flujos.formularioNoDescargado', { id: f?.SurveyID ?? '' }),
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
        ? traducir(geocercas.length === 1 ? 'flujos.geocerca1' : 'flujos.geocercasN', {
            lista: geocercas.join(', '),
          })
        : traducir('flujos.sinGeocercas');

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
      visto.pertenece = traducir('flujos.sinGeocercas');
    }
    return visto;
  }

  private async accionDe(a: any): Promise<string> {
    const nombre = a?.accion ? textoDe(ACCIONES, String(a.accion)) : traducir('flujos.accion');
    if (a?.accion === 'crear-actividad') {
      const titulo = await this.tituloDelFormulario(a?.surveyId);
      return `${nombre}: ${titulo || traducir('flujos.formularioN', { id: a?.surveyId ?? '' })}`;
    }
    if (a?.accion === 'notificar' && a?.titulo) return `${nombre}: «${a.titulo}»`;
    return nombre;
  }
}

/** El momento de una regla, legible. En geocerca añade los metros o minutos. */
function cuandoDe(cuando: unknown, regla?: any): string {
  const lista = Array.isArray(cuando) ? cuando : cuando ? [cuando] : [];
  const textos = lista.map((c) => {
    const base = textoDe(MOMENTOS, String(c));
    if (c === 'cerca' && regla?.metros) return `${base} (${regla.metros} m)`;
    if (c === 'permanecer' && regla?.minutos) return `${base} (${regla.minutos} min)`;
    // Los momentos de la app dicen además dónde tiene que estar la persona.
    if (regla && /^(actividad|sesion|recorrido)-/.test(String(c))) {
      const donde = String(regla?.donde || 'dentro');
      const metros = donde === 'cerca' && regla?.metros ? ` (${regla.metros} m)` : '';
      return `${base}, ${textoDe(DONDE, donde)}${metros}`;
    }
    return base;
  });
  return textos.join(', ');
}

/** Minutos, en palabras. */
function duracionDe(minutos: number): string {
  if (!Number.isFinite(minutos) || minutos <= 0) return traducir('flujos.sinDuracion');
  if (minutos < 60) return `${minutos} min`;
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  if (h < 24) return m ? `${h} h ${m} min` : `${h} h`;
  const d = Math.floor(h / 24);
  const hr = h % 24;
  return hr ? `${d} d ${hr} h` : `${d} d`;
}
