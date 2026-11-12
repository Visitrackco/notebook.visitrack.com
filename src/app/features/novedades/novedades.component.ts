import { DatePipe } from '@angular/common';
import { IdiomaService } from '../../core/i18n/idioma.service';
import { TPipe } from '../../core/i18n/t.pipe';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';

import { AuthService } from '../../core/services/auth.service';
import { environment } from '../../../environments/environment';

interface Novedad {
  id: number;
  version: string;
  titulo: string;
  contenido: string;
  videoUrl: string | null;
  creadaEn: string;
}

interface VideoDeNovedad {
  tipo: 'marco' | 'archivo' | 'enlace';
  url: string;
}

/**
 * Cómo se muestra una URL de video. La misma regla que `videoDeNovedad` en Module.
 *
 * YouTube y Vimeo van en un marco con su dirección de incrustar, armada aquí con
 * el identificador y no con lo que se escribió. Un archivo va en `<video>`. Lo
 * demás se queda como enlace: no se mete en un marco lo que no se conoce.
 */
function videoDeNovedad(url: string): VideoDeNovedad {
  const youtube = url.match(/^https:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/i);
  if (youtube) return { tipo: 'marco', url: `https://www.youtube-nocookie.com/embed/${youtube[1]}` };

  const vimeo = url.match(/^https:\/\/(?:www\.)?vimeo\.com\/(\d+)/i);
  if (vimeo) return { tipo: 'marco', url: `https://player.vimeo.com/video/${vimeo[1]}` };

  if (/^https:\/\/\S+\.(mp4|webm|ogg|mov)(\?\S*)?$/i.test(url)) return { tipo: 'archivo', url };

  return { tipo: 'enlace', url };
}

/**
 * Novedades: qué trae cada versión.
 *
 * Se escriben en Module y aquí solo se leen. `fetch` directo y no `HttpClient`:
 * el interceptor cerraría la sesión con un 401 de Module, y no poder leer las
 * novedades no es motivo.
 */
@Component({
  selector: 'vt-novedades',
  standalone: true,
  imports: [DatePipe, TPipe],
  templateUrl: './novedades.component.html',
  styleUrl: './novedades.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NovedadesComponent implements OnInit {
  protected readonly idioma = inject(IdiomaService);
  private readonly auth = inject(AuthService);
  private readonly sanitizer = inject(DomSanitizer);

  readonly novedades = signal<Novedad[]>([]);
  readonly cargando = signal(true);
  readonly error = signal(false);

  /** Un marco por URL: crear uno nuevo en cada pintada recargaría el video. */
  private readonly marcos = new Map<string, SafeResourceUrl>();

  ngOnInit(): void {
    void this.cargar();
  }

  async cargar(): Promise<void> {
    this.cargando.set(true);
    this.error.set(false);

    try {
      const respuesta = await fetch(`${environment.moduleUrl}/novedades/de-campo?app=web`, {
        headers: { Authorization: `Bearer ${this.auth.currentUser()?.Token ?? ''}` },
      });

      if (!respuesta.ok) throw new Error(String(respuesta.status));

      this.novedades.set((await respuesta.json()) as Novedad[]);
    } catch {
      this.error.set(true);
    } finally {
      this.cargando.set(false);
    }
  }

  video(url: string): VideoDeNovedad {
    return videoDeNovedad(url);
  }

  /** La URL ya viene armada por `videoDeNovedad`, solo con YouTube o Vimeo. */
  marco(url: string): SafeResourceUrl {
    let seguro = this.marcos.get(url);
    if (!seguro) {
      seguro = this.sanitizer.bypassSecurityTrustResourceUrl(url);
      this.marcos.set(url, seguro);
    }
    return seguro;
  }
}
