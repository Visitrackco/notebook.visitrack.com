import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { LlamadaPintada } from '../../../../core/forms/flujo-modelo';
import { FlujoLlamadasComponent } from './flujo-llamadas.component';

/**
 * La lista de llamadas, cuando alguna ya tiene su propio botón de flujo.
 *
 * ## La distinción que se fija aquí
 *
 * Que **no** se dibuje un segundo botón, y que **sí** se siga viendo la llamada.
 * Son dos cosas distintas y es fácil confundirlas: esconder la llamada entera
 * arreglaría el botón duplicado y dejaría a quien diligencia con un botón que se
 * queda pensando y nunca explica qué está esperando ni por qué falló.
 */
describe('Una llamada que ya tiene botón de flujo', () => {
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

  function montar(llamadas: LlamadaPintada[], conBotonPropio: string[] = []) {
    const fixture = TestBed.createComponent(FlujoLlamadasComponent);
    fixture.componentRef.setInput('llamadas', llamadas);
    fixture.componentRef.setInput('conBotonPropio', conBotonPropio);
    fixture.detectChanges();

    return fixture;
  }

  it('no dibuja su botón', () => {
    const fixture = montar([llamada()], ['padron|documento=C123']);

    expect(fixture.nativeElement.querySelector('button.llamadas__boton')).toBeNull();
  });

  it('pero sigue apareciendo, con lo que está esperando', () => {
    const fixture = montar([llamada({ estado: 'vuelo' })], ['padron|documento=C123']);

    const texto = fixture.nativeElement.textContent ?? '';

    expect(texto).toContain('Traer el titular');
  });

  it('y sigue contando por qué falló', () => {
    /*
     * Es lo que más se pierde al esconder de más: el mensaje viene redactado por
     * el intermediario para quien está en campo —«esa cédula no está en el
     * padrón»— y sin él no hay forma de saber si está roto o es a propósito.
     */
    const fixture = montar(
      [llamada({ estado: 'error', mensaje: 'Esa cédula no está en el padrón' })],
      ['padron|documento=C123'],
    );

    expect(fixture.nativeElement.textContent).toContain('Esa cédula no está en el padrón');
  });

  it('y la que no tiene botón de flujo conserva el suyo', () => {
    // El caso de siempre: sin esto, arreglar el duplicado dejaría sin botón a
    // todas las llamadas de botón del formulario.
    const fixture = montar([llamada()], []);

    expect(fixture.nativeElement.querySelector('button.llamadas__boton')).not.toBeNull();
  });

  it('con dos llamadas, solo pierde el botón la que lo tiene arriba', () => {
    const fixture = montar(
      [llamada({ llave: 'con-boton' }), llamada({ llave: 'sin-boton', titulo: 'Otra' })],
      ['con-boton'],
    );

    const botones = fixture.nativeElement.querySelectorAll('button.llamadas__boton');

    expect(botones.length).toBe(1);
    expect(botones[0].textContent?.trim()).toBe('Otra');
  });
});
