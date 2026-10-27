import { DestroyRef, Injectable, inject, signal } from '@angular/core';

/** Cada cuánto se pregunta si hay versión nueva. */
const CADA_MS = 5 * 60_000;

/** «Más tarde» esconde la barra este rato; después vuelve a salir. */
const POSPONER_MS = 30 * 60_000;

/**
 * Avisa cuando se publicó una versión nueva de la web.
 *
 * ## Cómo lo sabe
 *
 * El build pone a cada paquete un nombre con su huella (`main-AB12CD.js`,
 * `outputHashing: all`): cualquier cambio de código cambia el nombre. La
 * pestaña sabe con cuál arrancó —está en su propio `<script>`— y de vez en
 * cuando pide `index.html` al servidor, sin caché, para ver cuál anuncia
 * ahora. Si son distintos, hay versión nueva.
 *
 * Así no hace falta ningún paso extra al compilar ni un archivo de versión que
 * alguien olvide actualizar: subir el `dist/` nuevo ya es avisar.
 *
 * Sin service worker a propósito (la web no es PWA, ver docs): no se
 * descarga nada por detrás ni se cambia el código bajo los pies de nadie. Se
 * avisa, y quien está trabajando decide cuándo recargar.
 *
 * ## Cuándo pregunta
 *
 * Cada cinco minutos con la pestaña a la vista, al volver a ella y al
 * recuperar la conexión. Con la pestaña de fondo no: nadie vería la barra.
 */
@Injectable({ providedIn: 'root' })
export class NuevaVersionService {
  /** Hay una versión más nueva que la que corre. */
  readonly hayNueva = signal(false);
  /** La barra está escondida por «Más tarde». */
  readonly pospuesta = signal(false);

  private readonly actual = NuevaVersionService.paqueteDe(document);
  private reloj?: ReturnType<typeof setInterval>;
  private temporizadorPospuesta?: ReturnType<typeof setTimeout>;
  private preguntando = false;

  private readonly alVolver = () => {
    if (document.visibilityState === 'visible') void this.revisar();
  };
  private readonly alConectar = () => void this.revisar();

  constructor() {
    inject(DestroyRef).onDestroy(() => this.detener());
  }

  /**
   * Empieza a vigilar. Idempotente. En desarrollo (`ng serve`) el paquete no
   * lleva huella y no hay nada que comparar: no hace nada.
   */
  iniciar(): void {
    if (this.reloj || !this.actual) return;

    this.reloj = setInterval(() => {
      if (document.visibilityState === 'visible') void this.revisar();
    }, CADA_MS);
    document.addEventListener('visibilitychange', this.alVolver);
    window.addEventListener('online', this.alConectar);
  }

  detener(): void {
    clearInterval(this.reloj);
    clearTimeout(this.temporizadorPospuesta);
    this.reloj = undefined;
    document.removeEventListener('visibilitychange', this.alVolver);
    window.removeEventListener('online', this.alConectar);
  }

  /** Pide el `index.html` publicado y compara su paquete con el que corre. */
  async revisar(): Promise<void> {
    if (!this.actual || this.preguntando || this.hayNueva()) return;
    this.preguntando = true;
    try {
      const url = new URL('./', document.baseURI);
      url.searchParams.set('v', String(Date.now()));
      const r = await fetch(url.toString(), { cache: 'no-store', credentials: 'same-origin' });
      if (!r.ok) return;

      const html = await r.text();
      const publicado = NuevaVersionService.paqueteDeTexto(html);

      // Sin paquete en la respuesta —una página de error, un portal cautivo—
      // no se concluye nada.
      if (publicado && publicado !== this.actual) this.hayNueva.set(true);
    } catch {
      // Sin red o el servidor caído: se pregunta otra vez más tarde.
    } finally {
      this.preguntando = false;
    }
  }

  /** Esconde la barra un rato. */
  posponer(): void {
    this.pospuesta.set(true);
    clearTimeout(this.temporizadorPospuesta);
    this.temporizadorPospuesta = setTimeout(() => this.pospuesta.set(false), POSPONER_MS);
  }

  /** Recarga la página: el navegador baja la versión nueva. */
  actualizar(): void {
    window.location.reload();
  }

  /** El `main-<huella>.js` con el que arrancó esta página. */
  private static paqueteDe(doc: Document): string {
    for (const s of Array.from(doc.querySelectorAll<HTMLScriptElement>('script[src]'))) {
      const m = /main-[A-Za-z0-9]+\.js/.exec(s.getAttribute('src') ?? '');
      if (m) return m[0];
    }
    return '';
  }

  private static paqueteDeTexto(html: string): string {
    return /main-[A-Za-z0-9]+\.js/.exec(html)?.[0] ?? '';
  }
}
