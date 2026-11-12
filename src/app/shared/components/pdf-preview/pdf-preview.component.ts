import { Component, OnDestroy, inject, input, output, signal } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';

import { ConnectivityService } from '../../../core/services/connectivity.service';
import { IconComponent } from '../icon/icon.component';
import { TPipe } from '../../../core/i18n/t.pipe';

/**
 * Vista previa del PDF de una actividad, dentro de la aplicación.
 *
 * ## Por qué basta un `iframe`
 *
 * El generador responde `Content-Disposition: inline` cuando se le pide con
 * `preview=1`. Esa cabecera es toda la diferencia: con `attachment` el
 * navegador entiende «esto es una descarga» y se niega a pintarlo, que es por
 * lo que hasta ahora el PDF solo podía abrirse en otra pestaña. Con `inline`,
 * el visor del propio navegador lo muestra con zoom, búsqueda, impresión y
 * descarga sin que haya que traer un motor de render.
 *
 * ## Por qué se avisa cuando no hay conexión
 *
 * El resto de la aplicación funciona sin red —esa es su razón de ser— y aquí
 * eso no se puede: el documento lo arma el servidor en el momento. Decirlo
 * antes evita la pantalla en blanco que parece un fallo.
 */
@Component({
  selector: 'vt-pdf-preview',
  standalone: true,
  imports: [IconComponent, TPipe],
  templateUrl: './pdf-preview.component.html',
  styleUrl: './pdf-preview.component.scss',
})
export class PdfPreviewComponent implements OnDestroy {
  private readonly sanitizer = inject(DomSanitizer);
  readonly connectivity = inject(ConnectivityService);

  /** Dirección del documento. Debe responder `inline`. */
  readonly url = input.required<string>();

  readonly titulo = input('Actividad');
  readonly subtitulo = input('');

  /** Con qué nombre se descarga. Ver `nombreDelPdf`. */
  readonly nombreArchivo = input('Actividad.pdf');

  readonly descargando = signal(false);

  readonly cerrado = output<void>();

  /** El `iframe` ya terminó de cargar. Hasta entonces se ve el indicador. */
  readonly listo = signal(false);

  /**
   * La dirección, marcada como confiable.
   *
   * Angular bloquea cualquier `src` de `iframe` que venga de una variable, y
   * hace bien: es la vía clásica de inyección. Aquí la dirección la construye
   * la propia aplicación a partir de un GUID, no llega de fuera.
   */
  readonly fuente = signal<SafeResourceUrl | null>(null);

  private teclado = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.cerrado.emit();
  };

  constructor() {
    // La dirección se marca una sola vez, al abrir.
    queueMicrotask(() => {
      this.fuente.set(this.sanitizer.bypassSecurityTrustResourceUrl(this.url()));
    });

    document.addEventListener('keydown', this.teclado);
  }

  /** Abrir en otra pestaña sigue estando: para verlo a pantalla completa. */
  abrirEnPestana(): void {
    window.open(this.url(), '_blank', 'noopener');
  }

  /**
   * Descarga con el nombre de la actividad.
   *
   * El visor del navegador nombra el archivo a su manera y no se puede cambiar
   * desde aquí, así que se pide el documento y se guarda como archivo propio. Si
   * falla, queda abrirlo aparte.
   */
  async descargar(): Promise<void> {
    this.descargando.set(true);

    try {
      const respuesta = await fetch(this.url());
      if (!respuesta.ok) throw new Error(String(respuesta.status));

      const direccion = URL.createObjectURL(await respuesta.blob());
      const enlace = document.createElement('a');
      enlace.href = direccion;
      enlace.download = this.nombreArchivo();
      enlace.click();
      URL.revokeObjectURL(direccion);
    } catch {
      this.abrirEnPestana();
    } finally {
      this.descargando.set(false);
    }
  }

  cerrarSiEsElVelo(e: MouseEvent): void {
    if (e.target === e.currentTarget) this.cerrado.emit();
  }

  ngOnDestroy(): void {
    document.removeEventListener('keydown', this.teclado);
  }
}
