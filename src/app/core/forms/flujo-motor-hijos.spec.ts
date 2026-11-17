import { describe, expect, it } from 'vitest';

import { Campo, HIJOS_VISTOS, SEPARADOR_DE_CAMPOS_VISTOS } from './flujo-modelo';
import {
  camposVistosDeHijos,
  camposVistosDeLaHuella,
  huellaDeValorDeHijo,
  leerValor,
  mismosHijos,
  referenciaCampoDeHijos,
  referenciaHijos,
} from './flujo-motor';

/**
 * Los campos de los hijos vistos desde el padre: `HIJOS:<fid>:<CAMPO>@…`.
 *
 * La batería compartida (`casos.json`) prueba lo que decide `evaluar`. Aquí se
 * prueba lo que usa `ParientesService` para armar la huella `HijosVistos`,
 * que es lo que hace que `@cambio` no repita acciones en cada apertura.
 */
describe('Campos de los hijos', () => {
  it('desarma la referencia y no la confunde con las preguntas de siempre', () => {
    expect(referenciaCampoDeHijos('HIJOS:F_INSP:RESULTADO@alguno')).toEqual({
      fid: 'F_INSP',
      campo: 'RESULTADO',
      agregado: 'alguno',
      valor: '',
    });
    expect(referenciaCampoDeHijos('HIJOS::RESULTADO@veces=ok')?.valor).toBe('ok');
    expect(referenciaCampoDeHijos('HIJOS:F_INSP:RESULTADO@veces=')).toBeNull();
    expect(referenciaCampoDeHijos('HIJOS:F_INSP:RESULTADO@suma=3')).toBeNull();
    expect(referenciaCampoDeHijos('HIJOS:F_INSP@todos:5')).toBeNull();
    expect(referenciaCampoDeHijos('HIJOS@existen')).toBeNull();

    // Sigue siendo «de los hijos» para despertar la regla al cambiar un vinculado.
    expect(referenciaHijos('HIJOS:F_INSP:RESULTADO@cambio')).not.toBeNull();
  });

  it('huellea igual que el teléfono: por ID, y los enteros sin decimales', () => {
    expect(huellaDeValorDeHijo({ id: 'ok', txt: 'Aprobado' })).toBe('3hmjl');
    expect(huellaDeValorDeHijo(8)).toBe('3t0d');
    expect(huellaDeValorDeHijo('4')).toBe('3t01');
    expect(huellaDeValorDeHijo('')).toBe('');
    expect(huellaDeValorDeHijo(null)).toBe('');
  });

  it('arma la parte de campos de la huella con lo respondido, en orden', () => {
    const valores = {
      'HIJO:INSP2:PUNTOS': '4',
      'HIJO:INSP1:RESULTADO': { id: 'ok', txt: 'Aprobado' },
      'HIJO:INSP1:PUNTOS': 8,
      'HIJO:INSP1:estado': '5',
      'HIJO:INSP1@existe': 'Sí',
      'HIJO:INSP2:NOTA': '',
    };

    const parte = camposVistosDeHijos(valores);
    expect(parte).toBe('INSP1:PUNTOS=3t0d;INSP1:RESULTADO=3hmjl;INSP2:PUNTOS=3t01');

    const huella = `INSP1=g1|5|1|0|x${SEPARADOR_DE_CAMPOS_VISTOS}${parte}`;
    expect(camposVistosDeLaHuella(huella)).toEqual({
      'INSP1:PUNTOS': '3t0d',
      'INSP1:RESULTADO': '3hmjl',
      'INSP2:PUNTOS': '3t01',
    });
    expect(camposVistosDeLaHuella('INSP1=g1|5|1|0|x')).toBeNull();
  });

  it('una huella de antes, sin la parte de campos, es la misma familia', () => {
    expect(mismosHijos('A=g|5|1|0|x\nA:B=1', 'A=g|5|1|0|x')).toBe(true);
    expect(mismosHijos('A=g|5|1|0|x\nA:B=1', 'A=g|5|1|0|y\nA:B=1')).toBe(false);
  });

  it('@cambio mira lo que el padre vio', () => {
    const campos: Record<string, Campo> = {
      INSP1: { apiId: 'INSP1', fty: 'form', fid: 'F' },
    };
    const valores: Record<string, unknown> = {
      'HIJO:INSP1@existe': 'Sí',
      'HIJO:INSP1:PUNTOS': 8,
      [HIJOS_VISTOS]: 'INSP1=g\nINSP1:PUNTOS=3t0d',
    };

    expect(leerValor('HIJOS:F:PUNTOS@cambio', valores, campos)).toBe('No');

    valores['HIJO:INSP1:PUNTOS'] = 9;
    expect(leerValor('HIJOS:F:PUNTOS@cambio', valores, campos)).toBe('Sí');
  });
});
