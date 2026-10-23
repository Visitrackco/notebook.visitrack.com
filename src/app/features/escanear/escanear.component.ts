import { Component, ElementRef, OnInit, inject, input, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { ResultadoDeEtiqueta, normalizarEtiqueta } from '../../core/services/buscar-por-etiqueta';
import { EtiquetasService } from '../../core/services/etiquetas.service';
import { CodeScannerComponent } from '../../shared/components/code-scanner/code-scanner.component';
import { DescriptorTableComponent } from '../../shared/components/descriptor-table/descriptor-table.component';
import { IconComponent } from '../../shared/components/icon/icon.component';

/**
 * Escanear una etiqueta para comenzar una actividad.
 *
 * Es el botón de escanear de «Apps» en el móvil (`_scanTag`): se lee el código
 * pegado en un equipo o en la puerta de una sede, se busca en las etiquetas
 * (`TagUID`) de las ubicaciones y los activos de este dispositivo, y:
 *
 * - **uno**: se va directo a su ficha, desde donde se comienza la actividad;
 * - **varios**: se listan para elegir (el `QRMultipleScreen` del móvil);
 * - **ninguno**: se dice, con el código leído a la vista para que se vea si
 *   la cámara leyó mal o si de verdad esa etiqueta no está.
 *
 * ## Una pantalla y no solo un diálogo
 *
 * Para que tenga dirección: la paleta de comandos y el menú llevan a rutas, y
 * la lista de varios resultados necesita un sitio donde quedarse mientras se
 * elige. También sirve de respaldo: sin cámara, aquí se escribe el código.
 *
 * Funciona sin red: todo lo que consulta está en IndexedDB.
 */
@Component({
  selector: 'vt-escanear',
  standalone: true,
  imports: [CodeScannerComponent, DescriptorTableComponent, IconComponent, RouterLink],
  templateUrl: './escanear.component.html',
  styleUrl: './escanear.component.scss',
})
export class EscanearComponent implements OnInit {
  private readonly etiquetas = inject(EtiquetasService);
  private readonly router = inject(Router);

  /**
   * Un código ya leído, por la dirección (`/escanear?codigo=…`). Permite buscar
   * sin cámara desde un enlace interno, y volver atrás a la lista de varios
   * resultados sin escanear otra vez.
   */
  readonly codigo = input('');

  private readonly caja = viewChild<ElementRef<HTMLInputElement>>('caja');

  readonly escaneando = signal(false);
  readonly buscando = signal(false);

  /** El último código buscado, tal como se buscó. */
  readonly buscado = signal('');

  /** `null` mientras no se ha buscado nada. */
  readonly resultados = signal<ResultadoDeEtiqueta[] | null>(null);

  ngOnInit(): void {
    const codigo = normalizarEtiqueta(this.codigo());

    // Se llega a escanear: la cámara se abre sola, sin un segundo clic. Con un
    // código en la dirección, en cambio, se busca ese.
    if (codigo) void this.buscar(codigo);
    else this.escaneando.set(true);
  }

  escanear(): void {
    this.escaneando.set(true);
  }

  async onLeido(texto: string): Promise<void> {
    this.escaneando.set(false);
    await this.buscar(texto);
  }

  /** Sin cámara o por gusto: el cursor a la caja de texto. */
  escribir(): void {
    this.escaneando.set(false);
    setTimeout(() => this.caja()?.nativeElement.focus());
  }

  async onEnviar(event: Event): Promise<void> {
    event.preventDefault();
    await this.buscar(this.caja()?.nativeElement.value ?? '');
  }

  async buscar(texto: string): Promise<void> {
    const codigo = normalizarEtiqueta(texto);
    if (!codigo || this.buscando()) return;

    this.buscando.set(true);
    this.buscado.set(codigo);

    try {
      const hallados = await this.etiquetas.buscar(codigo);
      const abribles = hallados.filter((r) => r.ruta);

      // Uno solo que se puede abrir: directo a su ficha, como el móvil. Fuera
      // del historial, para que atrás desde la ficha no reabra la cámara.
      if (hallados.length === 1 && abribles.length === 1) {
        await this.router.navigate(abribles[0].ruta!, { replaceUrl: true });
        return;
      }

      this.resultados.set(hallados);

      // La dirección guarda el código para que recargar no lo pierda, sin
      // apilar una entrada por cada búsqueda.
      await this.router.navigate([], {
        queryParams: { codigo },
        replaceUrl: true,
      });
    } catch (error) {
      console.error('[Escanear] no se pudo buscar la etiqueta', error);
      this.resultados.set([]);
    } finally {
      this.buscando.set(false);
    }
  }
}
