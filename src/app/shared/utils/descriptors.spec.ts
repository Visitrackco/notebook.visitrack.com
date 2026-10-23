import { describe, expect, it } from 'vitest';

import { entityDescriptors, matchesEntity, parseEntityDescriptors } from './descriptors';

/**
 * Descriptivos de ubicaciones y activos: los mismos casos que
 * `test/descriptivos_test.dart` del móvil, para que las dos apps digan lo mismo.
 */

const pares = (lista: { lab: string; val: string }[]) => lista.map(({ lab, val }) => ({ lab, val }));

describe('entityDescriptors', () => {
  it('activo del servidor: definición + jsonValues, sin JSONTitle', () => {
    const activo = {
      Name: 'Compresor 3',
      JSONTitle: '',
      jsonDescriptor: JSON.stringify([
        { id: 'f1', lab: 'Placa' },
        { id: 'f2', lab: 'Estado' },
        { id: 'f3', lab: 'Accesorios' },
      ]),
      jsonValues: JSON.stringify([
        { id: 'f1', fty: 'textline', val: 'ABC-123' },
        { id: 'f2', fty: 'dropdownlist', val: { id: 1, txt: 'Activo' } },
        { id: 'f3', fty: 'checkbox', val: [{ txt: 'Manguera' }, { txt: 'Filtro' }] },
      ]),
    };

    const descriptivos = entityDescriptors(activo);
    expect(pares(descriptivos)).toEqual([
      { lab: 'Placa', val: 'ABC-123' },
      { lab: 'Estado', val: 'Activo' },
      { lab: 'Accesorios', val: 'Manguera, Filtro' },
    ]);

    expect(matchesEntity(activo.Name, descriptivos, 'abc-1')).toBe(true);
    expect(matchesEntity(activo.Name, descriptivos, 'FILTRO')).toBe(true);
    expect(matchesEntity(activo.Name, descriptivos, 'compresor')).toBe(true);
    expect(matchesEntity(activo.Name, descriptivos, 'nada')).toBe(false);
  });

  it('lo escrito localmente (JSONTitle) gana y lo viejo se conserva', () => {
    const activo = {
      jsonDescriptor: JSON.stringify([{ id: 'f1', lab: 'Placa' }]),
      jsonValues: JSON.stringify({ fie: [{ id: 'f1', val: 'VIEJA' }] }),
      JSONTitle: JSON.stringify([
        { ftyId: 'f1', id: 'f1', lab: 'Placa', val: 'NUEVA' },
        { lab: 'Serial', val: 'S-9' },
        { lab: '[DEF]', val: 'x' },
      ]),
    };

    expect(pares(entityDescriptors(activo))).toEqual([
      { lab: 'Placa', val: 'NUEVA' },
      { lab: 'Serial', val: 'S-9' },
    ]);
  });

  it('JSON roto o vacío no revienta', () => {
    expect(entityDescriptors({ jsonDescriptor: '{no', jsonValues: null })).toEqual([]);
    expect(entityDescriptors({})).toEqual([]);
  });

  it('un descriptivo sin valor se conserva con su etiqueta', () => {
    const descriptivos = parseEntityDescriptors(JSON.stringify([{ id: 'f1', lab: 'Ciudad' }]), '[]');
    expect(pares(descriptivos)).toEqual([{ lab: 'Ciudad', val: '' }]);
  });
});
