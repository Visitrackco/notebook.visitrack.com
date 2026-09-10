import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { GraficaPintada, Orientacion } from '../../../../core/forms/flujo-modelo';

/**
 * La gráfica que una regla del flujo pintó debajo de un campo.
 *
 * ## Qué NO decide este componente
 *
 * **Los números.** Vienen contados por el motor, los mismos que los del
 * teléfono. Aquí solo se reparten en píxeles: si esto sumara, promediara o
 * contara algo por su cuenta, un día la barra del navegador y la del teléfono
 * no medirían lo mismo y no habría forma de saber cuál de las dos miente.
 *
 * ## Por qué se dibuja a mano
 *
 * Porque no hace falta más. Una barra es un rectángulo, un sector es un arco y
 * una línea es una línea. Una biblioteca de gráficas trae su propio tema —que
 * no se parece al del formulario—, cientos de kilobytes que hay que descargar
 * antes de poder responder en campo y una dependencia más que actualizar; todo
 * eso para dibujar tres formas que el navegador ya sabe hacer.
 *
 * Circular y líneas van en SVG. Las barras van en CSS, y no por capricho: lo
 * que más cuesta de una barra horizontal es **el texto** —medirlo, cortarlo,
 * reflujarlo cuando la pantalla se estrecha, respetar el tipo de letra del
 * tema— y eso es exactamente lo que el SVG no sabe hacer y la maquetación
 * normal sí. Los rectángulos son lo de menos.
 */
@Component({
  selector: 'vt-flujo-grafica',
  standalone: true,
  templateUrl: './flujo-grafica.component.html',
  styleUrl: './flujo-grafica.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FlujoGraficaComponent {
  /** La gráfica tal como salió del motor, con los números ya hechos. */
  readonly grafica = input.required<GraficaPintada>();

  readonly titulo = computed(() => (this.grafica()?.titulo ?? '').trim());

  /** Barras si el tipo no se reconoce: es el que se lee sin saber nada. */
  readonly tipo = computed<'barras' | 'circular' | 'lineas'>(() => {
    const t = this.grafica()?.tipo;

    return t === 'circular' || t === 'lineas' ? t : 'barras';
  });

  /*
   * ── Los ejes ─────────────────────────────────────────────────────────────
   *
   * Vienen ya filtrados por el motor: en una circular no llegan, porque una
   * circular no tiene ejes. Aquí no se vuelve a decidir qué aplica a cada tipo
   * —esa es la clase de decisión que el teléfono y el navegador acabarían
   * tomando de dos maneras distintas—; se pinta lo que hay.
   */

  readonly ejeX = computed(() => (this.grafica()?.ejeX ?? '').trim());
  readonly ejeY = computed(() => (this.grafica()?.ejeY ?? '').trim());

  /**
   * Tumbadas o de pie.
   *
   * `horizontal` cuando el motor no dice nada, que es como se han dibujado
   * siempre: la etiqueta tiene todo el ancho de la izquierda y se lee entera.
   * De pie caben más columnas y se comparan mejor entre sí, a cambio de que la
   * etiqueta no tenga más sitio que el ancho de su columna.
   */
  readonly orientacion = computed<Orientacion>(() =>
    this.grafica()?.orientacion === 'vertical' ? 'vertical' : 'horizontal',
  );

  /**
   * ¿La gráfica está escondida hasta que un botón la pida?
   *
   * Quien decide **si** está escondida es el motor; quien recuerda que alguien
   * ya pulsó el botón es la pantalla, con `destapada`. Son dos cosas distintas
   * y por eso van por separado: lo primero es del flujo —se recalcula en cada
   * tecla— y lo segundo es de quien está mirando, y no puede depender de lo que
   * conteste después.
   */
  readonly destapada = input(false);

  readonly seVe = computed(() => this.grafica()?.oculta !== true || this.destapada());

  /**
   * Los datos con el color ya resuelto y el texto ya formateado.
   *
   * Se resuelve una vez y no en la plantilla porque los tres dibujos leen lo
   * mismo: el color de un sector tiene que ser el de su renglón de la leyenda,
   * y calculándolo en cada sitio bastaría con un descuido para que dejaran de
   * coincidir.
   */
  readonly datos = computed(() => {
    const crudos = this.grafica()?.datos ?? [];

    return crudos.map((d, i) => {
      const val = Number(d?.val) || 0;

      return {
        txt: String(d?.txt ?? ''),
        val,
        etiqueta: comoTexto(val),

        // El que diga la regla; si no, el que le toque por su sitio. Así una
        // gráfica sin colores configurados ya sale legible.
        color: colorValido(d?.color) ?? `var(--vt-grafica-${(i % 6) + 1})`,
      };
    });
  });

  /** El mayor, que es el que llena la barra. Nunca cero: se divide por él. */
  private readonly mayor = computed(() =>
    Math.max(...this.datos().map((d) => Math.abs(d.val)), 1e-9),
  );

  /** El total de la circular. Los negativos no reparten tarta: se ignoran. */
  private readonly total = computed(() =>
    this.datos().reduce((suma, d) => suma + Math.max(0, d.val), 0),
  );

  /**
   * ¿No hay nada que enseñar todavía?
   *
   * Todo a cero no es un error: es un formulario que aún no se ha respondido.
   * Pero unas barras a ras de suelo sin explicación parecen algo roto, así que
   * se dice con palabras. En la circular vale lo mismo cuando no queda nada
   * positivo que repartir: un anillo vacío no se distingue de uno que no cargó.
   */
  readonly vacia = computed(() => {
    if (!this.datos().length) return true;
    if (this.tipo() === 'circular') return this.total() <= 0;

    return this.datos().every((d) => d.val === 0);
  });

  /**
   * Cuánto ocupa cada barra, en porcentaje del carril.
   *
   * El mismo número sirve tumbada y de pie: en una es el ancho y en la otra el
   * alto. Calcularlo dos veces sería la forma más fácil de que la misma barra
   * midiera distinto según cómo estuviera puesta.
   */
  proporcionDe(val: number): string {
    const parte = Math.min(1, Math.max(0, val) / this.mayor());

    return `${parte * 100}%`;
  }

  // ── Circular ───────────────────────────────────────────────────────────────

  /**
   * Los sectores del anillo, con su trazado ya escrito.
   *
   * Se dibujan como **anillo** y no como tarta con un disco encima tapando el
   * centro: el disco tendría que ir del color de la superficie, y sobre un
   * campo pintado por una regla —que los hay— se vería el parche.
   */
  readonly sectores = computed(() => {
    const total = this.total();
    if (total <= 0) return [];

    const salida: { d: string; color: string }[] = [];

    // Se empieza arriba y se gira como las agujas del reloj, que es como se lee
    // una tarta. Sin esto empezaría a las tres en punto.
    let desde = -Math.PI / 2;

    for (const dato of this.datos()) {
      const parte = Math.max(0, dato.val) / total;
      if (parte <= 0) continue;

      /*
       * Un sector nunca barre la vuelta entera.
       *
       * Con una sola serie el arco empezaría y acabaría en el mismo punto, y un
       * arco de SVG entre dos puntos que coinciden no dibuja nada: el anillo
       * desaparecía justo en el caso más simple. Dejarle una rendija imposible
       * de ver lo resuelve sin casos especiales.
       */
      const barre = Math.min(parte, 0.9999) * 2 * Math.PI;

      salida.push({ d: anillo(desde, desde + barre), color: dato.color });
      desde += barre;
    }

    return salida;
  });

  /** Qué parte del total es cada dato, para la leyenda. */
  porcentajeDe(val: number): string {
    const total = this.total();
    if (total <= 0) return '';

    return `${Math.round((Math.max(0, val) / total) * 100)} %`;
  }

  // ── Líneas ─────────────────────────────────────────────────────────────────

  /** Los puntos de la polilínea, en coordenadas del `viewBox`. */
  readonly puntos = computed(() =>
    this.coordenadas()
      .map((p) => `${p.x},${p.y}`)
      .join(' '),
  );

  /** Los mismos puntos, para marcarlos uno a uno. */
  readonly coordenadas = computed(() => {
    const valores = this.datos().map((d) => d.val);
    if (!valores.length) return [];

    const alto = Math.max(...valores);
    const bajo = Math.min(...valores);

    /*
     * El suelo es el cero mientras los números sean positivos.
     *
     * Arrancar la escala en el valor más bajo exagera las diferencias: tres
     * datos parecidos salen como una montaña rusa y quien lo mire creerá que
     * pasó algo. Solo cuando hay negativos se baja el suelo, porque entonces no
     * queda otra.
     */
    const suelo = Math.min(0, bajo);
    const techo = Math.max(alto, suelo + 1e-9);
    const rango = techo - suelo;
    const util = LIENZO_ALTO - MARGEN * 2;

    return valores.map((v, i) => ({
      x:
        valores.length === 1
          ? LIENZO_ANCHO / 2
          : // Los extremos se meten hacia dentro para que el punto no salga
            // cortado por el borde del lienzo.
            MARGEN + ((LIENZO_ANCHO - MARGEN * 2) / (valores.length - 1)) * i,
      y: MARGEN + util - ((v - suelo) / rango) * util,
    }));
  });

  /** Las tres guías de fondo: sin ellas, una línea flotando no dice a qué altura va. */
  readonly guias = computed(() => {
    const util = LIENZO_ALTO - MARGEN * 2;

    return [0, 1, 2].map((i) => MARGEN + (util / 2) * i);
  });

  /** El color de la línea: el del primer dato, que es el de la serie. */
  readonly colorLinea = computed(() => this.datos()[0]?.color ?? 'var(--vt-grafica-1)');

  protected readonly anchoLienzo = LIENZO_ANCHO;
  protected readonly altoLienzo = LIENZO_ALTO;
}

// ── Medidas del lienzo ───────────────────────────────────────────────────────

/*
 * El `viewBox` es fijo y el SVG se estira al ancho disponible.
 *
 * Escalar de forma uniforme mantiene el grosor del trazo proporcional al
 * dibujo; estirarlo solo a lo ancho (`preserveAspectRatio="none"`) dejaría los
 * puntos como óvalos en cuanto la columna fuera más ancha que alta.
 */
const LIENZO_ANCHO = 300;
const LIENZO_ALTO = 120;
const MARGEN = 10;

/** El centro y los dos radios del anillo, en coordenadas del `viewBox`. */
const CENTRO = 50;
const RADIO_FUERA = 46;

/**
 * El agujero.
 *
 * Una rosquilla se lee mejor que una tarta maciza porque los sectores pequeños
 * se distinguen por su longitud y no por su punta, que es donde todos miden lo
 * mismo.
 */
const RADIO_DENTRO = 27;

/**
 * El trazado de un sector del anillo, de un ángulo a otro.
 *
 * Va por fuera en el sentido del reloj y vuelve por dentro al revés: es lo que
 * cierra la figura sobre sí misma sin pasar por el centro.
 */
function anillo(desde: number, hasta: number): string {
  const grande = hasta - desde > Math.PI ? 1 : 0;

  const f1 = enElBorde(desde, RADIO_FUERA);
  const f2 = enElBorde(hasta, RADIO_FUERA);
  const d1 = enElBorde(hasta, RADIO_DENTRO);
  const d2 = enElBorde(desde, RADIO_DENTRO);

  return [
    `M ${f1.x} ${f1.y}`,
    `A ${RADIO_FUERA} ${RADIO_FUERA} 0 ${grande} 1 ${f2.x} ${f2.y}`,
    `L ${d1.x} ${d1.y}`,
    `A ${RADIO_DENTRO} ${RADIO_DENTRO} 0 ${grande} 0 ${d2.x} ${d2.y}`,
    'Z',
  ].join(' ');
}

function enElBorde(angulo: number, radio: number): { x: number; y: number } {
  return {
    x: +(CENTRO + radio * Math.cos(angulo)).toFixed(3),
    y: +(CENTRO + radio * Math.sin(angulo)).toFixed(3),
  };
}

/**
 * Un color escrito en la regla, si se entiende. Lo que no, no pinta.
 *
 * Se comprueba con una expresión y no se pasa tal cual: lo que llega es un
 * texto de una configuración que viaja por la red, y acaba en un atributo de
 * estilo. Un color que no sea un color simplemente cede el sitio al de la
 * paleta, que es lo que habría pasado si la regla no hubiera dicho nada.
 */
function colorValido(crudo: unknown): string | null {
  const texto = String(crudo ?? '').trim();

  return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(texto) ? texto : null;
}

/** Un número sin decimales de más: `4` se lee «4», y `3.5` se lee «3.5». */
function comoTexto(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
