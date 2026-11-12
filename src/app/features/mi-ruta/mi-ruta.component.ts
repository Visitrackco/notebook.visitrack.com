import { HttpClient } from '@angular/common/http';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { environment } from '../../../environments/environment';
import { localeActual } from '../../core/i18n/idioma.service';

interface Punto {
  ID: number;
  Orden: number;
  Nombre: string;
  Estado: string;
  ActividadID: number | null;
  ActividadGUID: string | null;
  HoraEsperada: string | null;
}

interface Jornada {
  ID: number;
  Fecha: string;
  /** ABIERTA, CERRADA… o PROGRAMADA: un día futuro, todavía sin despachar. */
  Estado: string;
  Ruta: string;
  FormMarcacionID: number;
  FormMarcacion: string;
  FormNovedad: string;
  FormNovedadID: number | null;
  MarcacionAsignada: boolean;
  NovedadAsignada: boolean;
  /** Fin del turno (UTC). Desde ahí ya no se diligencia. */
  FinUtc: string | null;
  BorrarAlFinal: boolean;
  puntos: Punto[];
}

const ESTADOS: Record<string, string> = {
  PENDIENTE: 'Pendiente',
  CUMPLIDO: 'Cumplido',
  FUERA_DE_RANGO: 'Fuera de rango',
  NOVEDAD: 'Con novedad',
  INCUMPLIDO: 'Incumplido',
  PROGRAMADO: 'Programado',
};

/**
 * Mi ruta: la ruta del día (control de ingreso), con los puntos que faltan.
 *
 * La configura Module (Localizador → Rutas) y la sirve `GET /miRuta` de
 * cloud-server, igual que al teléfono. Aquí es para mirar: cuántos faltan, cómo
 * quedó cada punto y abrir su consigna. Los estados son los que calificó el
 * servidor, así que un punto guardado en el teléfono aparece como hecho cuando
 * su actividad sube.
 *
 * Por defecto, la ruta del día. Con la fecha se consulta cualquier otro día,
 * en línea y solo para mirar. Con el turno terminado ya no se ofrece abrir.
 */
@Component({
  selector: 'app-mi-ruta',
  standalone: true,
  imports: [RouterLink, FormsModule],
  template: `
    <section class="mr">
      <header class="mr-cab">
        <div>
          <h1>Mi ruta</h1>
          <p>Los puntos de tu ruta, en orden, y cuántos te faltan.</p>
        </div>
        <div class="mr-acciones">
          <label class="mr-fecha-campo">
            Día
            <input type="date" [(ngModel)]="fecha" (change)="cargar()" />
          </label>
          @if (fecha) {
            <button type="button" class="mr-btn" (click)="fecha = ''; cargar()">Hoy</button>
          }
          <button type="button" class="mr-btn" (click)="cargar()" [disabled]="cargando()">
            {{ cargando() ? 'Cargando…' : 'Actualizar' }}
          </button>
        </div>
      </header>

      @if (fecha) {
        <p class="mr-consulta">Consulta del {{ fecha }}: solo para mirar.</p>
      }

      @if (error()) {
        <p class="mr-error">{{ error() }}</p>
      }

      @for (j of jornadas(); track j.ID) {
        <article class="mr-jornada">
          <h2>{{ j.Ruta }}</h2>
          <p class="mr-fecha">{{ j.Fecha }}</p>

          <p class="mr-faltan" [class.mr-completa]="faltan(j) === 0 && j.Estado !== 'PROGRAMADA'">
            @if (j.Estado === 'PROGRAMADA') {
              Ruta programada: sus consignas llegan la noche anterior.
            } @else if (faltan(j) === 0) {
              Ruta completa.
            } @else {
              Te {{ faltan(j) === 1 ? 'falta 1 punto' : 'faltan ' + faltan(j) + ' puntos' }} de {{ j.puntos.length }}.
            }
          </p>

          @if (j.FinUtc && !fecha) {
            <p class="mr-turno" [class.mr-turno-fin]="terminada(j)">
              @if (terminada(j)) {
                Tu turno terminó a las {{ hora(j.FinUtc) }}: ya no puedes diligenciar esta ruta.
              } @else {
                Tu turno termina a las {{ hora(j.FinUtc) }}.
                @if (j.BorrarAlFinal) { Lo que no guardes antes se borra. }
              }
            </p>
          }

          @if (!j.MarcacionAsignada || (j.FormNovedadID && !j.NovedadAsignada)) {
            <p class="mr-sin-form">
              No tienes asignado
              @if (!j.MarcacionAsignada) { el formulario de marcación «{{ j.FormMarcacion }}» }
              @if (!j.MarcacionAsignada && j.FormNovedadID && !j.NovedadAsignada) { ni }
              @if (j.FormNovedadID && !j.NovedadAsignada) { el de novedad «{{ j.FormNovedad }}» }.
              {{ j.MarcacionAsignada ? 'No podrás registrar novedades' : 'No puedes hacer esta ruta' }}:
              pídele a tu administrador que te lo asigne.
            </p>
          }

          <ol class="mr-puntos">
            @for (p of j.puntos; track p.ID) {
              <li [attr.data-estado]="p.Estado" [class.mr-sigue]="p === siguiente(j)">
                <span class="mr-num">{{ p.Orden }}</span>
                <div class="mr-dato">
                  <strong>{{ p.Nombre }}</strong>
                  <small>
                    {{ estados[p.Estado] ?? p.Estado }}
                    @if (p.HoraEsperada) { · a las {{ p.HoraEsperada }} }
                    @if (p === siguiente(j)) { · sigue este }
                  </small>
                </div>
                @if (p.ActividadGUID && j.MarcacionAsignada && !fecha && !terminada(j)) {
                  <a class="mr-abrir" [routerLink]="['/formularios', j.FormMarcacionID, 'actividad', p.ActividadGUID]">Abrir</a>
                } @else if (!p.ActividadGUID) {
                  <span class="mr-espera">Aún sin consigna</span>
                }
              </li>
            }
          </ol>
        </article>
      } @empty {
        @if (!cargando() && !error()) {
          <p class="mr-nada">{{ fecha ? 'No tuviste ruta ese día.' : 'No tienes ruta para hoy.' }}</p>
        }
      }
    </section>
  `,
  styles: `
    .mr { max-width: 820px; margin: 0 auto; padding: 1.25rem; display: flex; flex-direction: column; gap: 1rem; }
    .mr-cab { display: flex; justify-content: space-between; align-items: flex-end; gap: 1rem; }
    .mr-cab h1 { margin: 0; font-size: 22px; }
    .mr-cab p { margin: 0.2rem 0 0; color: var(--text-muted, #6b7280); font-size: 14px; }
    .mr-btn {
      border: 1px solid var(--border, #d1d5db); background: transparent; border-radius: 8px;
      padding: 0.45rem 0.9rem; font-size: 14px; cursor: pointer; color: inherit;
    }
    .mr-error { color: #b91c1c; font-size: 14px; }
    .mr-acciones { display: flex; align-items: flex-end; gap: 0.5rem; flex-wrap: wrap; }
    .mr-fecha-campo { display: flex; flex-direction: column; font-size: 12px; color: var(--text-muted, #6b7280); }
    .mr-fecha-campo input {
      border: 1px solid var(--border, #d1d5db); border-radius: 8px; padding: 0.4rem 0.6rem;
      font-size: 14px; background: transparent; color: inherit;
    }
    .mr-consulta {
      margin: 0; padding: 0.6rem 0.9rem; border-radius: 10px;
      background: #f1f5f9; color: #334155; font-size: 13px;
    }
    .mr-turno {
      margin: 0 0 0.6rem; padding: 0.6rem 0.9rem; border-radius: 10px;
      background: #f8fafc; border: 1px solid var(--border, #e5e7eb); font-size: 13px;
    }
    .mr-turno-fin { background: #fef2f2; border-color: #fca5a5; color: #991b1b; }
    .mr-nada { color: var(--text-muted, #6b7280); font-size: 14px; }
    .mr-jornada { border: 1px solid var(--border, #e5e7eb); border-radius: 14px; padding: 1rem; }
    .mr-jornada h2 { margin: 0; font-size: 17px; }
    .mr-fecha { margin: 0.1rem 0 0.6rem; font-size: 12px; color: var(--text-muted, #6b7280); }
    .mr-faltan {
      margin: 0 0 0.6rem; padding: 0.7rem 0.9rem; border-radius: 10px;
      background: #eef2ff; color: #3730a3; font-weight: 700; font-size: 15px;
    }
    .mr-completa { background: #dcfce7; color: #166534; }
    .mr-sin-form {
      margin: 0 0 0.6rem; padding: 0.7rem 0.9rem; border-radius: 10px;
      background: #fef2f2; color: #991b1b; font-size: 13px;
    }
    .mr-puntos { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .mr-puntos li {
      display: flex; align-items: center; gap: 0.75rem; padding: 0.6rem 0.75rem;
      border: 1px solid var(--border, #e5e7eb); border-radius: 10px;
    }
    .mr-sigue { border: 2px solid #4f46e5 !important; }
    .mr-num {
      flex: none; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center;
      background: #9ca3af; color: #fff; font-weight: 700; font-size: 13px;
    }
    li[data-estado='CUMPLIDO'] .mr-num { background: #16a34a; }
    li[data-estado='FUERA_DE_RANGO'] .mr-num { background: #d97706; }
    li[data-estado='NOVEDAD'] .mr-num { background: #2563eb; }
    li[data-estado='INCUMPLIDO'] .mr-num { background: #dc2626; }
    .mr-sigue .mr-num { background: #4f46e5; }
    .mr-dato { flex: 1; display: flex; flex-direction: column; }
    .mr-dato strong { font-size: 14px; }
    .mr-dato small { font-size: 12px; color: var(--text-muted, #6b7280); }
    .mr-abrir { font-size: 13px; font-weight: 600; text-decoration: none; color: #4f46e5; }
    .mr-espera { font-size: 12px; color: var(--text-muted, #6b7280); }
  `,
})
export class MiRutaComponent implements OnInit {
  private readonly http = inject(HttpClient);

  readonly estados = ESTADOS;
  readonly jornadas = signal<Jornada[]>([]);
  readonly cargando = signal(false);
  readonly error = signal('');

  /** El día consultado (`aaaa-mm-dd`); vacío, la ruta del día. */
  fecha = '';

  ngOnInit(): void {
    void this.cargar();
  }

  async cargar(): Promise<void> {
    this.cargando.set(true);
    this.error.set('');

    try {
      const params: Record<string, string> = this.fecha ? { fecha: this.fecha } : {};
      const r: any = await firstValueFrom(this.http.get(`${environment.apiUrl}/miRuta`, { params }));
      const datos = r?.response ?? r;
      const todas: Jornada[] = Array.isArray(datos?.jornadas) ? datos.jornadas : [];
      // Solo las de la fecha pedida: un servidor viejo ignora el filtro.
      this.jornadas.set(this.fecha ? todas.filter((j) => j.Fecha === this.fecha) : todas);
    } catch {
      this.error.set('No se pudo leer tu ruta. Revisa la conexión e inténtalo de nuevo.');
    } finally {
      this.cargando.set(false);
    }
  }

  terminada(j: Jornada): boolean {
    return !!j.FinUtc && Date.now() >= new Date(j.FinUtc).getTime();
  }

  hora(iso: string): string {
    return new Date(iso).toLocaleTimeString(localeActual(), { hour: '2-digit', minute: '2-digit' });
  }

  faltan(j: Jornada): number {
    return j.puntos.filter((p) => p.Estado === 'PENDIENTE' || p.Estado === 'PROGRAMADO').length;
  }

  /** El primer punto pendiente: el que sigue. En una consulta, ninguno. */
  siguiente(j: Jornada): Punto | null {
    if (this.fecha) return null;
    return j.puntos.find((p) => p.Estado === 'PENDIENTE') ?? null;
  }
}
