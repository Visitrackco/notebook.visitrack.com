import { describe, expect, it } from 'vitest';

import { matchesEntity } from './descriptors';
import { normalizar, segmentosResaltados } from './resaltado';

/** Los trozos como texto legible: lo resaltado entre corchetes. */
const pintar = (texto: unknown, busqueda: unknown) =>
  segmentosResaltados(texto, busqueda)
    .map((s) => (s.resaltado ? `[${s.texto}]` : s.texto))
    .join('');

describe('normalizar', () => {
  it('quita tildes, diéresis y mayúsculas', () => {
    expect(normalizar('Ñandú Güero ÁÉÍÓÚ')).toBe('nandu guero aeiou');
    expect(normalizar(null)).toBe('');
  });
});

describe('segmentosResaltados', () => {
  it('sin búsqueda devuelve el texto entero sin marcar', () => {
    expect(segmentosResaltados('Bogotá', '')).toEqual([{ texto: 'Bogotá', resaltado: false }]);
    expect(segmentosResaltados('Bogotá', '   ')).toEqual([{ texto: 'Bogotá', resaltado: false }]);
    expect(segmentosResaltados('Bogotá', null)).toEqual([{ texto: 'Bogotá', resaltado: false }]);
  });

  it('sin texto no devuelve trozos', () => {
    expect(segmentosResaltados('', 'a')).toEqual([]);
    expect(segmentosResaltados(undefined, 'a')).toEqual([]);
  });

  it('no distingue mayúsculas y pinta el original', () => {
    expect(pintar('Planta NORTE', 'norte')).toBe('Planta [NORTE]');
    expect(pintar('planta norte', 'NORTE')).toBe('planta [norte]');
  });

  it('no distingue tildes en ningún sentido y conserva la del original', () => {
    expect(pintar('Bogotá D.C.', 'bogota')).toBe('[Bogotá] D.C.');
    expect(pintar('Bogota', 'bogotá')).toBe('[Bogota]');
    expect(pintar('Medellín', 'LLIN')).toBe('Mede[llín]');
    expect(pintar('Peñalosa', 'nal')).toBe('Pe[ñal]osa');
  });

  it('respeta tildes escritas como carácter combinante (NFD)', () => {
    const descompuesto = 'Bogotá centro';
    expect(pintar(descompuesto, 'bogota')).toBe('[Bogotá] centro');
  });

  it('marca todas las ocurrencias', () => {
    expect(pintar('Ana y ana y ANA', 'ana')).toBe('[Ana] y [ana] y [ANA]');
    expect(pintar('aaaa', 'aa')).toBe('[aa][aa]');
  });

  it('busca los caracteres especiales de regex tal cual', () => {
    expect(pintar('Filtro (A.1) *nuevo* [x]', '(a.1)')).toBe('Filtro [(A.1)] *nuevo* [x]');
    expect(pintar('1+1=2 y 1.1', '1.1')).toBe('1+1=2 y [1.1]');
    expect(pintar('precio $100^2', '$100^')).toBe('precio [$100^]2');
    expect(pintar('a\\b', '\\')).toBe('a[\\]b');
    expect(pintar('abc', '.')).toBe('abc');
  });

  it('no marca nada si no hay coincidencia', () => {
    expect(segmentosResaltados('Compresor', 'filtro')).toEqual([{ texto: 'Compresor', resaltado: false }]);
  });

  it('no parte emojis ni caracteres fuera del plano básico', () => {
    expect(pintar('🔧 Taller 🔧', 'taller')).toBe('🔧 [Taller] 🔧');
  });

  it('lo que encuentra matchesEntity es lo que se resalta', () => {
    const descriptivos = [{ lab: 'Ciudad', val: 'Bogotá' }];
    expect(matchesEntity('Sede', descriptivos, 'BOGOTA')).toBe(true);
    expect(pintar('Bogotá', 'BOGOTA')).toBe('[Bogotá]');
    expect(matchesEntity('Sede Medellín', [], 'medellin')).toBe(true);
  });
});
