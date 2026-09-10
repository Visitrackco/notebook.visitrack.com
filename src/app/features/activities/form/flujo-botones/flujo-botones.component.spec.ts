import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { BotonPintado, LlamadaPintada } from '../../../../core/forms/flujo-modelo';
import { FlujoBotonesComponent } from './flujo-botones.component';

/**
 * Un botón del flujo que llama a un servicio externo.
 *
 * ## Por qué esto se prueba renderizando y no llamando al método
 *
 * Porque el fallo que hay que impedir no está en la lógica: está en el cable.
 * Un `output` que nadie ata, un `@if` que nunca se cumple o una directiva sin
 * declarar compilan perfectamente y dejan la pantalla sin hacer nada, sin un
 * solo error por ninguna parte. Comprobar `pulsar()` a mano pasaría con el cable
 * cortado, que es justo el caso que se quiere descartar.
 */
describe('El botón que llama a un servicio', () => {
  /** Una llamada tal como la arma el motor para un botón. */
  function llamada(sobre: Partial<LlamadaPintada> = {}): LlamadaPintada {
    return {
      llave: 'padron|documento=C123',
      integracion: 'padron',
      titulo: 'Traer el titular',
      disparo: 'boton',
      modo: 'sincrona',
      segundos: 20,
      entradas: { documento: 'C123' },
      regla: 'sv',
      estado: 'pendiente',
      ...sobre,
    } as LlamadaPintada;
  }

  function boton(sobre: Partial<BotonPintado> = {}): BotonPintado {
    return {
      titulo: 'Consultar el padrón',
      graficas: [],
      llamadas: [llamada()],
      ...sobre,
    } as BotonPintado;
  }

  function montar(botones: BotonPintado[]) {
    const fixture = TestBed.createComponent(FlujoBotonesComponent);
    fixture.componentRef.setInput('botones', botones);
    fixture.detectChanges();

    return fixture;
  }

  const elBoton = (fixture: any): HTMLButtonElement =>
    fixture.nativeElement.querySelector('button.botones__boton');

  it('al pulsarlo saca sus llamadas, y en el orden en que vienen', async () => {
    /*
     * El orden importa: un botón puede lanzar dos consultas donde la segunda usa
     * lo que escribió la primera. Si salieran en cualquier orden, la segunda
     * pediría con las entradas de antes y nadie vería un error.
     */
    const dos = [
      llamada({ llave: 'a', titulo: 'Primera' }),
      llamada({ llave: 'b', titulo: 'Segunda' }),
    ];

    const fixture = montar([boton({ llamadas: dos })]);

    let sacadas: LlamadaPintada[] | null = null;
    fixture.componentInstance.llamar.subscribe((v: LlamadaPintada[]) => (sacadas = v));

    elBoton(fixture).click();

    expect(sacadas).not.toBeNull();
    expect(sacadas!.map((una) => una.llave)).toEqual(['a', 'b']);
  });

  it('mientras una está en vuelo, el botón no se puede volver a pulsar', () => {
    /*
     * No es cosmética. La llamada ya está apuntada por su llave, así que un
     * segundo toque no lanza nada: se quedaría sin respuesta y sin explicación,
     * que se lee como un botón roto.
     */
    const fixture = montar([boton({ llamadas: [llamada({ estado: 'vuelo' })] })]);

    expect(elBoton(fixture).disabled).toBe(true);
  });

  it('y dice a qué servicio está esperando, por su nombre', () => {
    // Con dos consultas en marcha, «cargando» no permite saber cuál va lenta.
    const fixture = montar([boton({ llamadas: [llamada({ estado: 'vuelo' })] })]);

    const texto = fixture.nativeElement.querySelector('.botones__trabajando')?.textContent ?? '';

    expect(texto).toContain('Traer el titular');
  });

  it('un botón sin llamadas se pulsa como siempre y no saca ninguna', () => {
    // La acción es nueva; los botones de siempre no pueden cambiar de conducta.
    const fixture = montar([boton({ llamadas: undefined, graficas: ['resumen'] })]);

    let sacadas: LlamadaPintada[] | null = null;
    fixture.componentInstance.llamar.subscribe((v: LlamadaPintada[]) => (sacadas = v));

    expect(elBoton(fixture).disabled).toBe(false);

    elBoton(fixture).click();

    expect(sacadas).toBeNull();
  });
});
