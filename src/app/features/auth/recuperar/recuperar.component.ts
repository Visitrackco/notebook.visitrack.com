import { Component, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { environment } from '../../../../environments/environment';
import { ConnectivityService } from '../../../core/services/connectivity.service';
import { traducir } from '../../../core/i18n/idioma.service';
import { SelectorIdiomaComponent } from '../../../core/i18n/selector-idioma.component';
import { TPipe } from '../../../core/i18n/t.pipe';

/** Lo que responden las tres rutas de cloud-server (`RecuperarClave.js`). */
interface Respuesta {
  status: boolean;
  error?: string;
  email?: string;
  aviso?: string;
}

type Paso = 'usuario' | 'codigo' | 'clave' | 'listo';

const LARGO_MINIMO = 8;

/**
 * «¿Olvidaste tu contraseña?», el mismo camino que el teléfono.
 *
 * Tres pasos contra cloud-server, sin sesión: pedir el código (llega al correo
 * del usuario), validarlo y poner la contraseña nueva. El servidor solo deja
 * cambiarla con un código validado hace poco, así que el último paso no se
 * puede saltar desde aquí.
 *
 * Usa el diseño del login (`login.component.scss`) para que se lea como parte
 * de la misma pantalla.
 */
@Component({
  selector: 'vt-recuperar',
  standalone: true,
  imports: [RouterLink, SelectorIdiomaComponent, TPipe],
  templateUrl: './recuperar.component.html',
  styleUrls: ['../login/login.component.scss', './recuperar.component.scss'],
})
export class RecuperarComponent {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  readonly connectivity = inject(ConnectivityService);

  readonly paso = signal<Paso>('usuario');
  readonly usuario = signal('');
  readonly codigo = signal('');
  readonly clave = signal('');
  readonly clave2 = signal('');
  readonly verClave = signal(false);

  readonly correo = signal('');
  readonly error = signal('');
  readonly aviso = signal('');
  readonly enviando = signal(false);

  readonly largoMinimo = LARGO_MINIMO;

  readonly puedeSeguir = computed(() => {
    if (this.enviando() || this.connectivity.isOffline()) return false;
    switch (this.paso()) {
      case 'usuario':
        return this.usuario().trim().length > 0;
      case 'codigo':
        return /^\d{6}$/.test(this.codigo().trim());
      case 'clave':
        return this.clave().length >= LARGO_MINIMO && this.clave() === this.clave2();
      default:
        return false;
    }
  });

  /** Por qué el botón no se deja pulsar en el paso de la clave. */
  readonly faltaEnClave = computed(() => {
    if (!this.clave()) return '';
    if (this.clave().length < LARGO_MINIMO) return traducir('rec.alMenos', { n: LARGO_MINIMO });
    if (this.clave2() && this.clave() !== this.clave2()) return traducir('rec.noCoinciden');
    return '';
  });

  private async llamar(ruta: string, cuerpo: Record<string, string>): Promise<Respuesta> {
    try {
      const r = await firstValueFrom(this.http.post<Respuesta>(`${environment.apiUrl}${ruta}`, cuerpo));
      return r ?? { status: false, error: traducir('rec.respuestaInvalida') };
    } catch (e: any) {
      return { status: false, error: e?.error?.error ?? traducir('rec.sinServidor') };
    }
  }

  async seguir(ev?: Event): Promise<void> {
    ev?.preventDefault();
    if (!this.puedeSeguir()) return;

    this.error.set('');
    this.enviando.set(true);
    try {
      switch (this.paso()) {
        case 'usuario':
          await this.pedirCodigo();
          break;
        case 'codigo': {
          const r = await this.llamar('/validateResetCode', {
            login: this.usuario().trim(),
            code: this.codigo().trim(),
          });
          if (!r.status) return this.error.set(r.error ?? traducir('rec.codigoMal'));
          this.aviso.set('');
          this.paso.set('clave');
          break;
        }
        case 'clave': {
          const r = await this.llamar('/updatePassword', {
            login: this.usuario().trim(),
            newPassword: this.clave(),
          });
          if (!r.status) return this.error.set(r.error ?? traducir('rec.noCambio'));
          this.paso.set('listo');
          break;
        }
      }
    } finally {
      this.enviando.set(false);
    }
  }

  /** Pide el código (también «Reenviar»). */
  async pedirCodigo(): Promise<void> {
    const r = await this.llamar('/sendResetCode', { login: this.usuario().trim() });
    if (!r.status) {
      this.error.set(r.error ?? traducir('rec.noEnvio'));
      return;
    }
    this.correo.set(r.email ?? '');
    // «Ya te enviamos un código»: es un aviso, no un error.
    this.aviso.set(r.aviso ?? '');
    this.codigo.set('');
    this.paso.set('codigo');
  }

  async reenviar(): Promise<void> {
    if (this.enviando()) return;
    this.error.set('');
    this.enviando.set(true);
    try {
      await this.pedirCodigo();
    } finally {
      this.enviando.set(false);
    }
  }

  cambiarUsuario(): void {
    this.paso.set('usuario');
    this.codigo.set('');
    this.error.set('');
    this.aviso.set('');
  }

  irAlLogin(): void {
    void this.router.navigate(['/login']);
  }
}
