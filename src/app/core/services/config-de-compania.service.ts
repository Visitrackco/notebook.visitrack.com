import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';

import { environment } from '../../../environments/environment';

/**
 * Lo que el superadministrador decidió de la compañía en Module.
 *
 * Aquí solo importa «Vincular dispositivo»: apagado, no sale en el menú ni se
 * entra a `/vincular`. La sesión única la aplica el servidor solo.
 *
 * Apagado hasta saber lo contrario. Esconder la opción no es la protección: el
 * servidor rechaza el traspaso igual (`/link/claim`).
 */
@Injectable({ providedIn: 'root' })
export class ConfigDeCompaniaService {
  private readonly http = inject(HttpClient);

  readonly vincularDispositivo = signal(false);

  private enCurso: Promise<void> | null = null;

  /** Pregunta una vez; quien llame mientras tanto espera la misma respuesta. */
  cargar(): Promise<void> {
    this.enCurso ??= this.preguntar().finally(() => (this.enCurso = null));
    return this.enCurso;
  }

  private async preguntar(): Promise<void> {
    try {
      const r: any = await firstValueFrom(
        this.http.get(`${environment.apiUrl}/miCompania/config`).pipe(timeout(15000)),
      );
      this.vincularDispositivo.set(r?.response?.vincularDispositivo === true);
    } catch {
      // Un servidor sin la ruta o sin señal: se queda como estaba.
    }
  }
}
