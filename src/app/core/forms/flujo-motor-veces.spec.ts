import { describe, expect, it } from 'vitest';

import { Campo, Flujo } from './flujo-modelo';
import {
  evaluar,
  itemDeFila,
  itemsAlTope,
  itemsPasados,
  leerNoRepetir,
  leerValor,
  referenciaDetalle,
} from './flujo-motor';

/**
 * Cuántas veces se escoge un mismo ítem en una tabla: el agregado
 * `@veces=<id>` y la acción `no-repetir-items`.
 *
 * La batería compartida (`casos.json`, en Module y en la app) prueba lo que
 * devuelve `evaluar`. Aquí se prueba además lo que solo usan las pantallas:
 * `itemsAlTope`, con la fila que se edita fuera de la cuenta.
 */
describe('Ítems que no se repiten', () => {
  const tabla: Campo = {
    apiId: 'FRUTAS',
    fty: 'masterdetail',
    detalle: [{ apiId: 'VARIEDAD', id: 'f1', fty: 'dropdownlist' }],
  };

  const campos: Record<string, Campo> = { FRUTAS: tabla, VECES: { apiId: 'VECES', fty: 'numeric' } };

  function fila(guid: string, id: string, txt: string, variedad?: [string, string]) {
    const respuestas: unknown[] = [{ id: 'name', fty: 'dropdownlist', val: { id, txt } }];
    if (variedad) respuestas.push({ id: 'f1', val: { id: variedad[0], txt: variedad[1] } });

    return { GUID: guid, Name: txt, JSONValues: respuestas };
  }

  const filas = [
    fila('r1', 'G-1', 'GRANADILLA', ['v1', 'Roja']),
    fila('r2', 'g-1', 'GRANADILLA', ['v2', 'Verde']),
    fila('r3', 'A-2', 'ARMA', ['v1', 'Roja']),
  ];

  it('desarma @veces con el ID tal como se escribió', () => {
    expect(referenciaDetalle('DETALLE:FRUTAS:name@VECES=G-1')).toEqual({
      tabla: 'FRUTAS',
      campo: 'name',
      agregado: 'veces',
      item: 'G-1',
    });

    // Sin ID no es un agregado.
    expect(referenciaDetalle('DETALLE:FRUTAS:name@veces')?.agregado).toBe('');
  });

  it('cuenta por ID, sin distinguir mayúsculas, el ítem de la fila y un desplegable', () => {
    const valores = { FRUTAS: filas };

    expect(leerValor('DETALLE:FRUTAS:name@veces=G-1', valores, campos)).toBe(2);
    expect(leerValor('DETALLE:FRUTAS:NAME@veces=a-2', valores, campos)).toBe(1);
    expect(leerValor('DETALLE:FRUTAS:VARIEDAD@veces=v1', valores, campos)).toBe(2);
    expect(leerValor('DETALLE:FRUTAS:name@veces=X-9', valores, campos)).toBe(0);
  });

  it('una fila sin cabecera usa su ListDetGUID', () => {
    expect(itemDeFila({ GUID: 'r', Name: 'GRANADILLA', ListDetGUID: 'G-1', JSONValues: [] }, 'name')).toEqual({
      id: 'G-1',
      txt: 'GRANADILLA',
    });
  });

  it('itemsAlTope no cuenta la fila que se está editando', () => {
    const regla = leerNoRepetir({ tope: 1 })!;

    expect(itemsAlTope(regla, filas, tabla).map((c) => c.id)).toEqual(['G-1', 'A-2']);

    // Abriendo r3, su ARMA es la suya: ARMA queda libre.
    expect(itemsAlTope(regla, filas, tabla, 'r3').map((c) => c.id)).toEqual(['G-1']);

    // Y sobre un desplegable de dentro.
    const porVariedad = leerNoRepetir({ columna: 'VARIEDAD', tope: 1 })!;
    expect(itemsAlTope(porVariedad, filas, tabla, 'r2').map((c) => c.id)).toEqual(['v1']);
    // Abriendo r1, su Roja no cuenta: queda la de r3, y con tope 1 ya no se
    // puede escoger otra; la Verde de r2 tampoco.
    expect(itemsAlTope(porVariedad, filas, tabla, 'r1').map((c) => c.id)).toEqual(['v2', 'v1']);
  });

  it('itemsPasados solo da los que superan su tope', () => {
    const soloGranadilla = leerNoRepetir({ items: [{ id: 'G-1', txt: 'GRANADILLA', max: 1 }] })!;

    expect(itemsPasados(soloGranadilla, filas, tabla)).toEqual([
      { id: 'G-1', txt: 'GRANADILLA', veces: 2, max: 1 },
    ]);

    const dos = leerNoRepetir({ items: [{ id: 'G-1', max: 2 }] })!;
    expect(itemsPasados(dos, filas, tabla)).toEqual([]);
    expect(itemsAlTope(dos, filas, tabla).map((c) => c.id)).toEqual(['G-1']);
  });

  it('un tope que no se entiende no limita', () => {
    expect(leerNoRepetir({ tope: 'cero', items: [{ id: 'G-1', max: 0 }] })).toBeNull();
    expect(leerNoRepetir('esto no es JSON')).toBeNull();
  });

  it('la acción anota la restricción y no deja guardar con un ítem pasado', () => {
    const flujo: Flujo = {
      version: 1,
      reglas: [
        {
          id: 'n1',
          nombre: 'n1',
          cuando: ['guardar'],
          si: { op: 'y', cond: [] },
          entonces: [
            {
              accion: 'no-repetir-items',
              campo: 'FRUTAS',
              valor: { items: [{ id: 'G-1', txt: 'GRANADILLA', max: 1 }], mensaje: '{item}: {veces} de {max}' },
            },
          ],
        },
      ],
    } as Flujo;

    const resultado = evaluar(flujo, { valores: { FRUTAS: filas }, campos, momento: 'guardar' } as any);

    expect(resultado.campos['FRUTAS']?.noRepetir).toEqual([
      { columna: 'name', tope: 0, items: [{ id: 'G-1', txt: 'GRANADILLA', max: 1 }], mensaje: '{item}: {veces} de {max}' },
    ]);
    expect(resultado.bloqueos).toEqual(['GRANADILLA: 2 de 1']);
  });

  it('@veces en una condición y en una fórmula', () => {
    const flujo: Flujo = {
      version: 1,
      reglas: [
        {
          id: 'v1',
          nombre: 'v1',
          cuando: ['guardar'],
          si: { op: 'y', cond: [{ campo: 'DETALLE:FRUTAS:name@veces=G-1', cmp: 'mayor', valor: '1' }] },
          entonces: [
            { accion: 'bloquear-guardado', valor: 'Solo una GRANADILLA' },
            { accion: 'calcular', campo: 'VECES', valor: 'DETALLE:FRUTAS:name@veces=G-1 * 10' },
          ],
        },
      ],
    } as Flujo;

    const resultado = evaluar(flujo, { valores: { FRUTAS: filas }, campos, momento: 'guardar' } as any);

    expect(resultado.bloqueos).toEqual(['Solo una GRANADILLA']);
    expect(resultado.campos['VECES']?.valor).toBe(20);
  });
});
