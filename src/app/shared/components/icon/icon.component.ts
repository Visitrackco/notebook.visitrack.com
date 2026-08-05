import { Component, input } from '@angular/core';

/**
 * Iconos SVG en línea.
 *
 * Se definen aquí en vez de usar una librería por dos razones: la aplicación
 * debe funcionar sin conexión y una fuente de iconos externa fallaría en el
 * primer arranque offline, y un paquete completo pesaría cientos de kilobytes
 * para las quince formas que realmente se usan.
 *
 * ## Por qué `@switch` y no `innerHTML`
 *
 * La versión anterior inyectaba los trazados con `[innerHTML]` y **no dibujaba
 * nada**: el navegador crea los elementos de una cadena HTML en el namespace
 * HTML, no en el de SVG, así que un `<path>` insertado de esa forma existe en
 * el DOM pero no se renderiza. Además Angular sanitiza esa cadena y descarta
 * las etiquetas que no reconoce como HTML.
 *
 * Escribiéndolos en la plantilla, el compilador de Angular los crea en el
 * namespace correcto. Es más verboso, pero es lo que funciona.
 *
 * Todos comparten `viewBox="0 0 24 24"`, trazo de 1.8 y extremos redondeados,
 * para que se lean como un conjunto y no como recortes de sitios distintos.
 */
@Component({
  selector: 'vt-icon',
  standalone: true,
  template: `
    <svg
      [attr.width]="size()"
      [attr.height]="size()"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      @switch (name()) {
        @case ('home') {
          <path d="M3 10.5 12 3l9 7.5" />
          <path d="M5.5 9.5V20h13V9.5" />
          <path d="M9.5 20v-6h5v6" />
        }
        @case ('clipboard') {
          <rect x="5" y="4" width="14" height="17" rx="2" />
          <path d="M9 4V3h6v1" />
          <path d="M9 10h6M9 14h6M9 18h3" />
        }
        @case ('map-pin') {
          <path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z" />
          <circle cx="12" cy="10" r="2.6" />
        }
        @case ('box') {
          <path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5v-9Z" />
          <path d="M3.5 7.5 12 12l8.5-4.5" />
          <path d="M12 12v9" />
        }
        @case ('refresh') {
          <path d="M20 11a8 8 0 0 0-13.7-5.3L3.5 8.5" />
          <path d="M4 13a8 8 0 0 0 13.7 5.3l2.8-2.8" />
          <path d="M3.5 4v4.5H8" />
          <path d="M20.5 20v-4.5H16" />
        }
        @case ('image') {
          <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
          <circle cx="9" cy="10" r="1.8" />
          <path d="m4.5 17 4.2-4a1.6 1.6 0 0 1 2.2 0l4.4 4.2" />
          <path d="m14.5 14.5 1.6-1.5a1.6 1.6 0 0 1 2.2 0l1.2 1.1" />
        }
        @case ('user') {
          <circle cx="12" cy="8" r="4" />
          <path d="M4.5 20c0-4 3.4-6.5 7.5-6.5s7.5 2.5 7.5 6.5" />
        }
        @case ('logout') {
          <path d="M15 4.5h3a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3" />
          <path d="M10 16.5 14.5 12 10 7.5" />
          <path d="M14.5 12H3.5" />
        }
        @case ('menu') {
          <path d="M4 7h16M4 12h16M4 17h16" />
        }
        @case ('close') {
          <path d="M6 6l12 12M18 6 6 18" />
        }
        @case ('chevron') {
          <path d="m9 5 7 7-7 7" />
        }
        @case ('wifi') {
          <path d="M2.5 9a15 15 0 0 1 19 0" />
          <path d="M5.5 12.5a10.5 10.5 0 0 1 13 0" />
          <path d="M8.5 16a6 6 0 0 1 7 0" />
          <circle cx="12" cy="19.5" r="1" />
        }
        @case ('wifi-off') {
          <path d="M2.5 9a15 15 0 0 1 6-3.4" />
          <path d="M15.5 5.8A15 15 0 0 1 21.5 9" />
          <path d="M8.5 16a6 6 0 0 1 7 0" />
          <circle cx="12" cy="19.5" r="1" />
          <path d="m3 3 18 18" />
        }
        @case ('check') {
          <path d="m5 12.5 4.5 4.5L19 7" />
        }
        @case ('alert') {
          <path d="M12 4.5 2.8 20h18.4L12 4.5Z" />
          <path d="M12 10v4" />
          <circle cx="12" cy="17" r=".7" fill="currentColor" stroke="none" />
        }
        @case ('info') {
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 11v5.5" />
          <circle cx="12" cy="8" r=".8" fill="currentColor" stroke="none" />
        }
        @case ('database') {
          <ellipse cx="12" cy="6" rx="7.5" ry="3" />
          <path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6" />
          <path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" />
        }
        @case ('shield') {
          <path d="M12 3 5 6v6c0 4.5 3 8.6 7 9.5 4-.9 7-5 7-9.5V6l-7-3Z" />
          <path d="m9 12 2 2 4-4.5" />
        }
        @case ('building') {
          <path d="M5 21V5.5a1.5 1.5 0 0 1 1.5-1.5h7A1.5 1.5 0 0 1 15 5.5V21" />
          <path d="M15 10h3.5A1.5 1.5 0 0 1 20 11.5V21" />
          <path d="M3.5 21h17" />
          <path d="M8 8h4M8 12h4M8 16h4" />
        }
        @case ('sun') {
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" />
        }
        @case ('moon') {
          <path d="M20 13.5A8.2 8.2 0 0 1 10.5 4a8.5 8.5 0 1 0 9.5 9.5Z" />
        }
        @case ('mail') {
          <rect x="3" y="5.5" width="18" height="13" rx="2" />
          <path d="m3.5 7 8.5 6 8.5-6" />
        }
        @case ('phone') {
          <path
            d="M6.5 3.5h3l1.5 4-2 1.5a12 12 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2Z"
          />
        }
        @case ('file') {
          <path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5L13.5 3Z" />
          <path d="M13.5 3v5.5H19" />
          <path d="M9 13h6M9 17h4" />
        }
        @case ('trash') {
          <path d="M4.5 6.5h15" />
          <path d="M9 6.5V4.5h6v2" />
          <path d="M6.5 6.5 7.5 20a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4l1-13.5" />
          <path d="M10.5 10.5v6M13.5 10.5v6" />
        }
        @case ('copy') {
          <rect x="9" y="9" width="11" height="12" rx="2" />
          <path d="M15.5 6.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h.5" />
        }
        @case ('send') {
          <path d="M21 3 10.5 13.5" />
          <path d="M21 3 14.5 21l-4-7.5L3 9.5 21 3Z" />
        }
        @case ('cloud-upload') {
          <path d="M7 18.5a4 4 0 0 1-.4-8A5.5 5.5 0 0 1 17.4 9.5a3.8 3.8 0 0 1 .6 7.5" />
          <path d="M12 21v-8" />
          <path d="m9 15.5 3-3 3 3" />
        }
        @case ('camera') {
          <path d="M3 8.5A2 2 0 0 1 5 6.5h2.4l1.3-2h6.6l1.3 2H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8.5Z" />
          <circle cx="12" cy="13" r="3.6" />
        }
        @case ('mic') {
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
          <path d="M12 18v3" />
          <path d="M9 21h6" />
        }
        @case ('video') {
          <rect x="3" y="6" width="12.5" height="12" rx="2" />
          <path d="m15.5 10.5 5-3v9l-5-3v-3Z" />
        }
        @case ('play') {
          <path d="M8 5.5 18.5 12 8 18.5v-13Z" />
        }
        @case ('stop') {
          <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
        }
        @case ('download') {
          <path d="M12 3.5v11" />
          <path d="m8 11 4 4 4-4" />
          <path d="M4.5 19.5h15" />
        }
        @case ('pen') {
          <path d="M4 20h4L19 9a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5 4 20Z" />
          <path d="m14.5 6.5 3.5 3.5" />
        }
      }
    </svg>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
        flex-shrink: 0;
        align-items: center;
        justify-content: center;
      }
    `,
  ],
})
export class IconComponent {
  /** Nombre del icono. Si no coincide con ninguno, el SVG queda vacío. */
  readonly name = input.required<string>();

  /** Lado del icono en píxeles. */
  readonly size = input(20);
}
