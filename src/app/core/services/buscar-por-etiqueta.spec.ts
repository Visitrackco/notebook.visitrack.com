import { describe, expect, it } from 'vitest';

import { Asset, LocationForm } from '../models/entities.model';
import { armarResultados, etiquetaCoincide, normalizarEtiqueta, sedeDe } from './buscar-por-etiqueta';

/**
 * Búsqueda por etiqueta (`TagUID`): qué cuenta como coincidencia y cómo se
 * arma la lista que ve quien escaneó.
 */

const sede = (parcial: Partial<LocationForm>): LocationForm =>
  ({ GUID: 'L-1', LocationID: '10', Name: 'Sede Norte', typeTitle: 'Sede', ...parcial }) as LocationForm;

const activo = (parcial: Partial<Asset>): Asset =>
  ({ GUID: 'A-1', LocationID: 10, Name: 'Bomba 1', typeTitle: 'Bomba', ...parcial }) as Asset;

describe('normalizarEtiqueta', () => {
  it('quita los espacios y saltos de los extremos, no los de dentro', () => {
    expect(normalizarEtiqueta('  AB 12 \n')).toBe('AB 12');
  });

  it('trata nulos y números', () => {
    expect(normalizarEtiqueta(null)).toBe('');
    expect(normalizarEtiqueta(undefined)).toBe('');
    expect(normalizarEtiqueta(1234)).toBe('1234');
  });
});

describe('etiquetaCoincide', () => {
  it('casa ignorando los espacios sobrantes de los dos lados', () => {
    expect(etiquetaCoincide(' 7701234567890', '7701234567890 ')).toBe(true);
  });

  it('respeta las mayúsculas, como el móvil', () => {
    expect(etiquetaCoincide('ab12', 'AB12')).toBe(false);
  });

  it('un código vacío no casa con las entidades sin etiqueta', () => {
    expect(etiquetaCoincide('', '   ')).toBe(false);
    expect(etiquetaCoincide(null, '')).toBe(false);
  });

  it('no casa por coincidencia parcial', () => {
    expect(etiquetaCoincide('AB123', 'AB12')).toBe(false);
  });
});

describe('sedeDe', () => {
  const sedes = new Map([
    ['L-1', sede({})],
    ['L-2', sede({ GUID: 'L-2', LocationID: '20', Name: 'Sede Sur' })],
  ]);

  it('prefiere el GUID de la sede', () => {
    expect(sedeDe({ LocationID: 10, LocationGUID: 'L-2' }, sedes)?.Name).toBe('Sede Sur');
  });

  it('cae al identificador del servidor', () => {
    expect(sedeDe({ LocationID: 20 }, sedes)?.GUID).toBe('L-2');
  });

  it('sin sede en el dispositivo, nada', () => {
    expect(sedeDe({ LocationID: 0 }, sedes)).toBeNull();
    expect(sedeDe({ LocationID: 99 }, sedes)).toBeNull();
  });
});

describe('armarResultados', () => {
  it('pone primero las ubicaciones y lleva cada una a su ficha', () => {
    const sedes = new Map([['L-1', sede({})]]);
    const resultados = armarResultados(
      [sede({ GUID: 'L-9', Name: 'Bodega', FullAddress: 'Calle 1' })],
      [activo({})],
      sedes,
    );

    expect(resultados.map((r) => r.tipo)).toEqual(['ubicacion', 'activo']);
    expect(resultados[0]).toMatchObject({ ruta: ['/ubicaciones', 'L-9'], detalle: 'Calle 1' });
    expect(resultados[1]).toMatchObject({
      ruta: ['/ubicaciones', 'L-1', 'activo', 'A-1'],
      detalle: 'En Sede Norte',
    });
  });

  it('no enseña una dirección que es solo puntuación', () => {
    const [resultado] = armarResultados([sede({ FullAddress: ' , ', City: '' })], [], new Map());
    expect(resultado.detalle).toBe('');
  });

  it('un activo sin su sede en el dispositivo se lista pero no se abre', () => {
    const [resultado] = armarResultados([], [activo({ LocationID: 0 })], new Map());
    expect(resultado.ruta).toBeNull();
  });

  it('ordena por nombre dentro de cada grupo', () => {
    const resultados = armarResultados(
      [sede({ GUID: 'b', Name: 'Zeta' }), sede({ GUID: 'a', Name: 'alfa' })],
      [],
      new Map(),
    );
    expect(resultados.map((r) => r.nombre)).toEqual(['alfa', 'Zeta']);
  });
});
