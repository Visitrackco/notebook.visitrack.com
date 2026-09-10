import { Component, computed, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { companiaDelEnlace } from '../../core/config/modo-publico';
import { CompanyLogoService } from '../../core/services/company-logo.service';
import { PendingUploadService } from '../../core/sync/pending-upload.service';

/**
 * El armazón de una pestaña que está sirviendo un enlace público.
 *
 * ## Por qué existe, si casi no pinta nada
 *
 * Porque las pantallas de la actividad son **rutas hijas** de un armazón, y con
 * el de siempre traerían consigo la barra lateral entera: sincronización,
 * borradores, historial, perfil, cerrar sesión. Nada de eso significa nada para
 * quien abrió un enlace, y varias de esas pantallas ni siquiera funcionarían.
 *
 * ## Por qué no se cambian las direcciones
 *
 * Las rutas hijas son **exactamente las mismas** que en la aplicación con
 * sesión: `/formularios/:surveyId/actividad/:guid` y las suyas. Eso es lo que
 * permite montar aquí el mismo `ActivityDetailComponent` sin tocarlo — las
 * filas de las tablas de detalle son rutas hijas suyas y arman su dirección de
 * vuelta a partir de esa forma. Con un prefijo propio habría que cambiarlo, y
 * con ello dejar de compartir el renderizador, que era lo que había que evitar.
 *
 * ## La marca
 *
 * Arriba, la de **la compañía dueña del enlace**: quien abre esto no está
 * entrando a Visitrack, está respondiendo algo que le pidió una empresa
 * concreta, y es esa la que tiene que reconocer. Abajo, y en pequeño, de dónde
 * sale la herramienta.
 *
 * La barra mide exactamente `--vt-topbar-height`, que es contra lo que se pega
 * la cabecera de la actividad (`.detail__bar { top: var(--vt-topbar-height) }`).
 * Si cambiara una sin la otra, la cabecera fija quedaría flotando o tapada.
 */
@Component({
  selector: 'vt-publico-shell',
  standalone: true,
  imports: [RouterOutlet],
  templateUrl: './publico-shell.component.html',
  styleUrl: './publico-shell.component.scss',
})
export class PublicoShellComponent {
  private readonly subidas = inject(PendingUploadService);

  /** El logo de la compañía del enlace. `null` si esa compañía no tiene. */
  readonly logo = inject(CompanyLogoService).logoUrl;

  /**
   * Con qué se rotula la barra si no hay logo.
   *
   * Una barra vacía se lee como que la página cargó a medias. El nombre de la
   * compañía no baja en la semilla —no hace falta para nada más— así que se
   * usa lo único que sí está.
   */
  readonly rotulo = computed(() => {
    const nombre = companiaDelEnlace().trim();
    if (nombre) return nombre;

    /*
     * Sin nombre, «Visitrack» y no «Compañia 3502».
     *
     * Ese numero es una llave interna: delante de alguien que no trabaja aqui
     * no significa nada, y ademas deja ver cuantas companias hay y en que orden
     * se dieron de alta. Como respaldo vale mas el nombre del producto.
     */
    return 'Visitrack';
  });

  constructor() {
    /*
     * La cola de subida arranca aquí, igual que en el armazón con sesión.
     *
     * Sin ella, una respuesta que quedara esperando a sus fotos solo volvería a
     * intentarse pulsando el botón de la pantalla de cierre — y quien tiene mala
     * señal es precisamente quien no va a estar mirando esa pantalla.
     */
    this.subidas.start();

    /*
     * Lo que **no** arranca aquí es el mantenimiento de borradores.
     *
     * En la aplicación con sesión, un borrador caducado se borra solo porque
     * hay de dónde volver a sacar el trabajo: el formulario sigue en el menú.
     * En un enlace público el borrador es la única copia que existe de lo que
     * alguien escribió, y nadie puede recuperarla si se borra. Se conserva, y se
     * ofrece retomarla la próxima vez que se abra el enlace.
     */
  }
}
