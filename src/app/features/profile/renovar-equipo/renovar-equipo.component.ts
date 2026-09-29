import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { esModoPublico } from '../../../core/config/modo-publico';
import { DatabaseService } from '../../../core/database/database.service';
import { ANSWER_STATE } from '../../../core/models/activity.model';
import { BinaryState } from '../../../core/models/sync.model';
import { BinaryResourceRepository } from '../../../core/repositories/binary.repository';
import { SurveyAnswerRepository } from '../../../core/repositories/survey-answer.repository';
import { AuthService } from '../../../core/services/auth.service';
import { EntityUploadService } from '../../../core/sync/entity-upload.service';
import { PendingUploadService } from '../../../core/sync/pending-upload.service';
import { IconComponent } from '../../../shared/components/icon/icon.component';

/**
 * Largo máximo del identificador de un navegador.
 *
 * El identificador viaja a los registros de la base —`ChangesLog`,
 * `SurveysAnswers.Sync_LastUpdatedBy`, versiones— y hay columnas donde no cabe
 * uno más largo. Los navegadores nuevos generan uno de 20 (ver
 * `DeviceService`); los que traen uno más largo pasan por esta pantalla.
 */
export const LARGO_MAXIMO_DEL_EQUIPO = 20;

/** Clave de `DeviceService`: se lee aquí sin generar uno si no hay. */
const CLAVE_DEL_EQUIPO = 'visitrack.deviceId';

/** Para no volver a abrir la pantalla en la misma pestaña tras «Ahora no». */
const CLAVE_YA_SE_PIDIO = 'visitrack.renovarEquipo.pedido';

/**
 * Si este navegador tiene que renovar su identificador.
 *
 * Nunca en un enlace público: ahí no hay sesión ni nada que renovar, y el
 * enlace trabaja contra su propia base.
 */
export function equipoPorRenovar(): boolean {
  if (esModoPublico()) return false;

  try {
    if (sessionStorage.getItem(CLAVE_YA_SE_PIDIO)) return false;
    const id = localStorage.getItem(CLAVE_DEL_EQUIPO) ?? '';
    return id.length > LARGO_MAXIMO_DEL_EQUIPO;
  } catch {
    return false;
  }
}

interface Pendientes {
  actividades: number;
  archivos: number;
  entidades: number;
}

/**
 * Renueva el identificador de un navegador que trae uno demasiado largo.
 *
 * No se puede cambiar sin más: con ese identificador el servidor lleva lo que
 * tiene por entregarle a este navegador. Así que se hace como en un navegador
 * recién estrenado, pero sin perder nada:
 *
 * 1. Se sube **todo** lo pendiente —ubicaciones y activos, archivos,
 *    actividades— con la misma cola de siempre ([PendingUploadService]).
 * 2. Se cuenta lo que queda, de **todas** las cuentas guardadas aquí, porque la
 *    base se borra entera. Si queda algo **no se borra nada** y se dice qué.
 * 3. Se cierra la sesión, se borra la base y el identificador, y se vuelve al
 *    inicio. Al entrar se genera uno de 20 y el servidor vuelve a mandar todo.
 *
 * «Ahora no» deja seguir trabajando; se vuelve a pedir en la siguiente visita.
 */
@Component({
  selector: 'vt-renovar-equipo',
  standalone: true,
  imports: [IconComponent],
  template: `
    <div class="re">
      <div class="re-tarjeta">
        <span class="re-marca"><vt-icon name="refresh" [size]="30" /></span>
        <h1 class="re-titulo">Este navegador necesita un identificador nuevo</h1>
        <p class="re-texto">
          El identificador de este equipo viene de una versión anterior y es demasiado largo. Para
          corregirlo se sube todo lo que tengas pendiente, se borran los datos guardados en este
          navegador y vuelves a iniciar sesión. Después se descarga todo de nuevo.
        </p>

        <div class="re-caja">
          <vt-icon name="refresh" [size]="18" />
          <span>
            @if (pendientes(); as p) {
              @if (hayAlgo(p)) {
                Pendiente por subir: {{ texto(p) }}.
              } @else {
                No tienes nada pendiente por subir.
              }
            } @else {
              Revisando lo pendiente…
            }
          </span>
        </div>

        @if (error()) {
          <div class="re-error" role="alert">{{ error() }}</div>
        }

        <button
          type="button"
          class="vt-btn vt-btn--primary re-boton"
          [disabled]="trabajando()"
          (click)="renovar()"
        >
          {{ trabajando() ? paso() : 'Subir pendientes y actualizar' }}
        </button>
        <button type="button" class="vt-btn vt-btn-ghost" [disabled]="trabajando()" (click)="ahoraNo()">
          Ahora no
        </button>
        <p class="re-nota">
          Si eliges «Ahora no», puedes seguir trabajando. Te lo volveremos a pedir la próxima vez que
          abras Visitrack.
        </p>
      </div>
    </div>
  `,
  styles: `
    .re {
      min-height: 100%;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 32px 16px;
    }
    .re-tarjeta {
      width: 100%;
      max-width: 520px;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 12px;
      text-align: center;
    }
    .re-marca {
      align-self: center;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 60px;
      height: 60px;
      border-radius: 50%;
      background: var(--vt-brand-tint);
      color: var(--vt-brand);
    }
    .re-titulo {
      margin: 0;
      font-size: 1.3rem;
      font-weight: 700;
      color: var(--vt-ink);
    }
    .re-texto,
    .re-nota {
      margin: 0;
      line-height: 1.45;
      color: var(--vt-text-muted);
    }
    .re-nota {
      font-size: 0.8rem;
    }
    .re-caja {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px;
      border: 1px solid var(--vt-border);
      border-radius: 12px;
      text-align: left;
      color: var(--vt-ink);
    }
    .re-error {
      padding: 12px 14px;
      border-radius: 12px;
      background: var(--vt-danger-bg);
      color: var(--vt-danger);
      text-align: left;
    }
    .re-boton {
      padding: 12px;
      justify-content: center;
    }
  `,
})
export class RenovarEquipoComponent {
  private readonly auth = inject(AuthService);
  private readonly db = inject(DatabaseService);
  private readonly router = inject(Router);
  private readonly cola = inject(PendingUploadService);
  private readonly entidades = inject(EntityUploadService);
  private readonly respuestas = inject(SurveyAnswerRepository);
  private readonly archivos = inject(BinaryResourceRepository);

  readonly pendientes = signal<Pendientes | null>(null);
  readonly trabajando = signal(false);
  readonly paso = signal('');
  readonly error = signal('');

  constructor() {
    void this.contar().then((p) => this.pendientes.set(p));
  }

  /**
   * Lo que quedaría perdido al borrar la base, de todas las cuentas.
   *
   * Los archivos que el servidor ya recibió (`InRepository`) no cuentan: están
   * a salvo allá. Sí cuenta la actividad que los espera, que se envía cuando
   * quedan confirmados.
   */
  private async contar(): Promise<Pendientes> {
    const [actividades, archivos, entidades] = await Promise.all([
      this.respuestas.count({
        filter: (a) =>
          a.eraser !== 1 &&
          a.IsDelete !== '1' &&
          (a.isSaved === ANSWER_STATE.PENDING || a.isSaved === ANSWER_STATE.WAITING_BINARIES),
      }),
      this.archivos.count({ filter: (b) => b.BinaryState === BinaryState.Pending }),
      this.entidades.pendingCount(),
    ]);

    return { actividades, archivos, entidades };
  }

  hayAlgo(p: Pendientes): boolean {
    return p.actividades + p.archivos + p.entidades > 0;
  }

  texto(p: Pendientes): string {
    const partes = [
      p.actividades ? `${p.actividades} actividad${p.actividades === 1 ? '' : 'es'}` : '',
      p.archivos ? `${p.archivos} archivo${p.archivos === 1 ? '' : 's'}` : '',
      p.entidades ? `${p.entidades} ubicación${p.entidades === 1 ? '' : 'es'} o activo${p.entidades === 1 ? '' : 's'}` : '',
    ].filter(Boolean);

    return partes.join(', ');
  }

  async renovar(): Promise<void> {
    if (this.trabajando()) return;

    this.trabajando.set(true);
    this.error.set('');

    try {
      // 1. Subir todo con la cola de siempre: entidades, archivos y actividades.
      this.paso.set('Subiendo pendientes…');
      await this.cola.run();

      // 2. Comprobar que no quedó nada.
      this.paso.set('Comprobando…');
      const quedan = await this.contar();
      this.pendientes.set(quedan);

      if (this.hayAlgo(quedan)) {
        this.error.set(
          `No se pudo subir todo: quedan ${this.texto(quedan)}. ` +
            'Revisa la conexión e inténtalo de nuevo. No se borró nada.',
        );
        return;
      }

      // 3. Cerrar sesión y dejar el navegador como recién estrenado.
      this.paso.set('Reiniciando el equipo…');
      await this.auth.logout();
      await this.db.deleteDatabase();
      localStorage.removeItem(CLAVE_DEL_EQUIPO);

      // Recarga completa: ningún servicio debe quedar con la base cerrada en
      // memoria. Al volver se abre una base nueva y se genera el identificador.
      location.replace(new URL('login', document.baseURI).href);
      return;
    } catch (e) {
      this.error.set(
        e instanceof Error && e.message.includes('pestañas')
          ? e.message
          : 'Algo falló al subir los pendientes. No se borró nada. Inténtalo de nuevo.',
      );
    } finally {
      this.trabajando.set(false);
      this.paso.set('');
    }
  }

  ahoraNo(): void {
    try {
      sessionStorage.setItem(CLAVE_YA_SE_PIDIO, '1');
    } catch {
      // Sin almacenamiento: se volverá a pedir, nada más.
    }
    void this.router.navigateByUrl('/inicio');
  }
}
