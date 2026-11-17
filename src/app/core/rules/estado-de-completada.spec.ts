import { describe, expect, it } from 'vitest';

import { elegirEstadoDeCompletada, idsDelFormulario, queLeToca } from './estado-de-completada';

/** El catálogo de Solarpy (3870): el caso que originó la regla. */
const solarpy = [
  { DispatchID: 27612, Name: 'COMPLETADO', IsCompleted: 1, BaseStatusID: 3 },
  { DispatchID: 27614, Name: 'PAGO PENDIENTE', IsCompleted: 0, BaseStatusID: 1 },
  { DispatchID: 27615, Name: 'PAGO COMPLETO', IsCompleted: 0, BaseStatusID: 3 },
  { DispatchID: 27872, Name: 'SOPORTE DE PAGO PENDIENTE', IsCompleted: 0, BaseStatusID: 1 },
];

const id = (s: { DispatchID: number } | null) => (s ? String(s.DispatchID) : null);

describe('estado de completada', () => {
  it('lee JSONStatuses en sus tres formas y en su orden', () => {
    expect(idsDelFormulario('[27615,27614]')).toEqual(['27615', '27614']);
    expect(idsDelFormulario('["27615","27614"]')).toEqual(['27615', '27614']);
    expect(idsDelFormulario('[{"DispatchID":27615},{"id":27614},{"ID":1}]')).toEqual(['27615', '27614', '1']);
    expect(idsDelFormulario('')).toEqual([]);
    expect(idsDelFormulario('no es json')).toEqual([]);
  });

  it('formulario con estados propios sin IsCompleted: el primero de base Completado', () => {
    expect(id(elegirEstadoDeCompletada(solarpy, ['27615', '27614', '27872']))).toBe('27615');
  });

  it('formulario con estados propios: gana el IsCompleted, en el orden del formulario', () => {
    const catalogo = [
      { DispatchID: 5, IsCompleted: 1, BaseStatusID: 3 },
      { DispatchID: 6, IsCompleted: 1, BaseStatusID: 3 },
      { DispatchID: 7, IsCompleted: 0, BaseStatusID: 3 },
    ];
    expect(id(elegirEstadoDeCompletada(catalogo, ['7', '6', '5']))).toBe('6');
  });

  it('formulario con estados propios sin ninguno de completada: ninguno, nunca el de la compañía', () => {
    expect(elegirEstadoDeCompletada(solarpy, ['27614', '27872'])).toBeNull();
  });

  it('formulario sin estados propios: el IsCompleted de la compañía, el de menor DispatchID', () => {
    const catalogo = [
      { DispatchID: 90, IsCompleted: 1, BaseStatusID: 3 },
      { DispatchID: 12, IsCompleted: 1, BaseStatusID: 3 },
    ];
    expect(id(elegirEstadoDeCompletada(catalogo, []))).toBe('12');
    expect(id(elegirEstadoDeCompletada(solarpy, []))).toBe('27612');
  });

  it('sin ningún estado de completada: ninguno', () => {
    expect(elegirEstadoDeCompletada([{ DispatchID: 1, IsCompleted: 0, BaseStatusID: 1 }], [])).toBeNull();
  });

  it('cuándo se pone: sin estado lo recibe; con uno lo conserva; 2259 y 3502 siempre', () => {
    const base = { meta: '27615', compania: 3870, formulario: '23032' };
    expect(queLeToca({ ...base, actual: '', cerrado: false })).toBe('27615');
    expect(queLeToca({ ...base, actual: '27614', cerrado: true })).toBeNull();
    expect(queLeToca({ ...base, actual: '27612', cerrado: false })).toBe('27612');
    expect(queLeToca({ ...base, compania: 3502, actual: '27614', cerrado: true })).toBe('27615');
    expect(queLeToca({ ...base, meta: null, actual: '', cerrado: false })).toBeNull();
    expect(queLeToca({ meta: '1', compania: 2259, formulario: '16681', actual: '', cerrado: false })).toBeNull();
  });
});
