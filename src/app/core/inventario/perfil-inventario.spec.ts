import { calcularLineas, efecto, leerPerfil, numero, tocaMover } from './perfil-inventario';

/**
 * Mismos casos que `perfil-inventario.spec.ts` de cloud-gold y
 * `perfil_inventario_test.dart` del móvil: la web tiene que leer una actividad
 * igual que el servidor que mueve el stock.
 */
describe('perfil de inventario', () => {
  it('lee los números como se escriban', () => {
    expect(numero(12)).toBe(12);
    expect(numero('12,5')).toBe(12.5);
    expect(numero('1.234,5')).toBe(1234.5);
    expect(numero('1,234.5')).toBe(1234.5);
    expect(numero('1,234,567')).toBe(1234567);
    expect(numero({ val: '3' })).toBe(3);
    expect(numero('')).toBeNull();
    expect(numero('abc')).toBeNull();
  });

  it('tabla: una línea por fila con cantidad', () => {
    const p = leerPerfil({
      cuando: { modo: 'guardar' },
      tipo: { modo: 'fijo', valor: 'SALIDA' },
      lineas: { origen: 'tabla', tabla: 'PRODS', cantidad: 'CANT' },
      negativo: 'bloquear',
    });
    const r = calcularLineas(
      p,
      [
        {
          id: 'PRODS',
          val: [
            { ListDetGUID: 'A', JSONValues: [{ id: 'CANT', val: '2' }] },
            { ListDetGUID: '', MasterListDetGUID: 'B', JSONValues: [{ id: 'CANT', val: 3 }] },
            { ListDetGUID: 'C', JSONValues: [{ id: 'CANT', val: '0' }] },
            { ListDetGUID: 'D', JSONValues: [{ id: 'CANT', val: '-1' }] },
          ],
        },
      ],
      null,
    );
    expect(r.tipo).toBe('SALIDA');
    expect(r.lineas.map((l) => `${l.producto}:${l.cantidad}`)).toEqual(['A:2', 'B:3']);
    expect(efecto('SALIDA', 2)).toBe(-2);
  });

  it('tipo por campo: por id o por texto de la opción', () => {
    const p = leerPerfil({
      cuando: { modo: 'guardar' },
      tipo: { modo: 'campo', campo: 'MOV', mapa: { opt1: 'ENTRADA', salida: 'SALIDA' } },
      lineas: { origen: 'campos', producto: 'PROD', cantidad: 'CANT' },
    });

    const entrada = calcularLineas(
      p,
      [
        { id: 'MOV', val: { id: 'opt1', txt: 'Entrada' } },
        { id: 'PROD', val: { id: 'G1', txt: 'Tornillo' } },
        { id: 'CANT', val: '5' },
      ],
      null,
    );
    expect(entrada.tipo).toBe('ENTRADA');
    expect(entrada.lineas).toEqual([{ producto: 'G1', cantidad: 5 }]);

    const salida = calcularLineas(
      p,
      JSON.stringify([
        { id: 'MOV', val: { id: 'x', txt: 'Salida' } },
        { id: 'PROD', val: 'G1' },
        { id: 'CANT', val: '5' },
      ]),
      null,
    );
    expect(salida.tipo).toBe('SALIDA');

    expect(calcularLineas(p, [{ id: 'MOV', val: { id: 'otra', txt: 'Otra' } }], null).tipo).toBeNull();
  });

  it('momento de mover', () => {
    const completar = leerPerfil({ cuando: { modo: 'completar' } });
    expect(tocaMover(completar, false, null)).toBe(false);
    expect(tocaMover(completar, true, null)).toBe(true);

    const estados = leerPerfil({ cuando: { modo: 'estados', estados: [12] } });
    expect(tocaMover(estados, true, 11)).toBe(false);
    expect(tocaMover(estados, false, 12)).toBe(true);
  });

  it('valores raros quedan con su valor seguro', () => {
    const p = leerPerfil({ negativo: 'x', tipo: { modo: 'y' } });
    expect(p.negativo).toBe('avisar');
    expect(p.tipo.modo).toBe('fijo');
    expect(p.cuando.modo).toBe('completar');
    expect(leerPerfil('no es json').negativo).toBe('avisar');
  });
});
