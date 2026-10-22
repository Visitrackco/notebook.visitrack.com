import { describe, expect, it } from 'vitest';

import {
  FilaDeEvento,
  FilaGuardada,
  enElRango,
  filaDesdeLocal,
  paginaDesdeServidor,
  paginaLocal,
  rangoPorDefecto,
  sumarPendientes,
} from './eventos-de-geocerca';

/**
 * El historial de eventos de geocerca: cómo se vuelve fila lo guardado en el
 * navegador y lo que dice el servidor, y el filtro y la página sin servidor.
 */

const POLIGONO = [
  [4.0, -74.0],
  [4.0, -74.01],
  [4.01, -74.01],
  [4.01, -74.0],
];

const FLUJO = {
  id: 7,
  nombre: 'Llegadas a sede',
  geocercas: [{ id: 83, nombre: 'Casa', forma: 'POLYGON', poligono: POLIGONO, puntos: [] }],
  reglas: [
    { id: 'r1', nombre: 'Aviso al llegar', cuando: 'entrar' },
    { id: 'r2', nombre: 'Guardar fuera', cuando: 'actividad-guardar', donde: 'fuera' },
  ],
};

const guardada = (parcial: Partial<FilaGuardada['Payload']> = {}, enviado: 0 | 1 = 1): FilaGuardada => ({
  Clave: parcial.clave ?? 'abc',
  Enviado: enviado,
  Payload: {
    clave: 'abc',
    flujoId: 7,
    reglaId: 'r1',
    geocercaId: 83,
    punto: null,
    tipo: 'ENTRAR',
    lat: 4.005,
    lng: -74.005,
    en: '2026-10-22T15:00:00.000Z',
    ...parcial,
  },
});

const fila = (clave: string, en: string, geocerca = 83, pendiente = false): FilaDeEvento => ({
  clave,
  en,
  tipo: 'ENTRAR',
  momento: null,
  evento: `Entró a ${geocerca}`,
  dentro: true,
  distanciaMetros: 10,
  geocerca: { id: geocerca, nombre: `G${geocerca}` },
  flujo: '',
  regla: '',
  formulario: '',
  pendiente,
});

describe('filaDesdeLocal', () => {
  it('arma el texto, dentro/fuera, el flujo y la regla con el flujo descargado', () => {
    const f = filaDesdeLocal(guardada(), [JSON.stringify(FLUJO)])!;
    expect(f.evento).toBe('Entró a Casa');
    expect(f.dentro).toBe(true);
    expect(f.distanciaMetros).toBeGreaterThan(0);
    expect(f.geocerca).toEqual({ id: 83, nombre: 'Casa' });
    expect(f.flujo).toBe('Llegadas a sede');
    expect(f.regla).toBe('Aviso al llegar');
    expect(f.pendiente).toBe(false);
  });

  it('lo no enviado queda «pendiente de enviar»', () => {
    expect(filaDesdeLocal(guardada({}, 0), [FLUJO])!.pendiente).toBe(true);
  });

  it('un momento usa el `donde` de la regla', () => {
    const f = filaDesdeLocal(
      guardada({ tipo: 'MOMENTO', reglaId: 'r2', momento: 'actividad-guardar', lat: 5, lng: -75 }),
      [FLUJO],
    )!;
    expect(f.evento).toBe('Guardó una actividad estando fuera de Casa');
    expect(f.dentro).toBe(false);
  });

  it('sin el flujo descargado no inventa dentro/fuera, pero conserva la geocerca para filtrar', () => {
    const f = filaDesdeLocal(guardada(), [])!;
    expect(f.dentro).toBeNull();
    expect(f.distanciaMetros).toBeNull();
    expect(f.geocerca?.id).toBe(83);
  });

  it('sin clave no hay fila', () => {
    expect(filaDesdeLocal({ Enviado: 1, Payload: { ...guardada().Payload, clave: '' } }, [])).toBeNull();
  });
});

describe('paginaDesdeServidor', () => {
  it('lee la respuesta de mis-eventos', () => {
    const p = paginaDesdeServidor({
      total: 120,
      pagina: 2,
      tam: 25,
      eventos: [
        {
          clave: 'u1',
          en: '2026-10-22T15:00:00Z',
          tipo: 'MOMENTO',
          momento: 'actividad-guardar',
          evento: 'Guardó una actividad estando dentro de Casa',
          dentro: true,
          distanciaMetros: 12.3,
          geocerca: { id: 5, nombre: 'Casa' },
          flujo: { id: 3, nombre: 'Visitas' },
          regla: { id: 'r1', nombre: 'Al guardar' },
          formulario: '',
          answerGuid: null,
        },
        { sinClave: true },
      ],
      geocercas: [{ id: 5, nombre: 'Casa' }],
    })!;
    expect(p.origen).toBe('servidor');
    expect(p.total).toBe(120);
    expect(p.pagina).toBe(2);
    expect(p.filas).toHaveLength(1);
    expect(p.filas[0]).toMatchObject({ clave: 'u1', flujo: 'Visitas', regla: 'Al guardar', pendiente: false });
    expect(p.geocercas).toEqual([{ id: 5, nombre: 'Casa' }]);
  });

  it('una respuesta sin `eventos` cuenta como caído', () => {
    expect(paginaDesdeServidor({ mensaje: 'Not Found' })).toBeNull();
    expect(paginaDesdeServidor(null)).toBeNull();
  });
});

describe('paginaLocal', () => {
  const filas = [
    fila('a', '2026-10-20T12:00:00Z', 83),
    fila('b', '2026-10-22T12:00:00Z', 84),
    fila('c', '2026-10-21T12:00:00Z', 83),
    fila('viejo', '2026-09-01T12:00:00Z', 83),
  ];
  const filtro = { desde: '2026-10-16', hasta: '2026-10-22', geocerca: null };

  it('filtra por rango y ordena del más reciente al más viejo', () => {
    const p = paginaLocal(filas, filtro);
    expect(p.origen).toBe('local');
    expect(p.filas.map((f) => f.clave)).toEqual(['b', 'c', 'a']);
    expect(p.total).toBe(3);
  });

  it('filtra por geocerca, y el selector sigue ofreciendo las del rango', () => {
    const p = paginaLocal(filas, { ...filtro, geocerca: 83 });
    expect(p.filas.map((f) => f.clave)).toEqual(['c', 'a']);
    expect(p.geocercas.map((g) => g.id)).toEqual([83, 84]);
  });

  it('corta de a `tam` y no se pasa de la última página', () => {
    expect(paginaLocal(filas, filtro, 2, 2).filas.map((f) => f.clave)).toEqual(['a']);
    expect(paginaLocal(filas, filtro, 9, 2).pagina).toBe(2);
  });
});

describe('sumarPendientes', () => {
  const filtro = { desde: '2026-10-16', hasta: '2026-10-22', geocerca: null };
  const servidor = {
    origen: 'servidor' as const,
    total: 1,
    pagina: 1,
    tam: 25,
    filas: [fila('subido', '2026-10-21T12:00:00Z')],
    geocercas: [{ id: 83, nombre: 'G83' }],
  };

  it('pone arriba lo que este navegador aún no subió, sin repetir', () => {
    const p = sumarPendientes(
      servidor,
      [fila('nuevo', '2026-10-22T12:00:00Z', 83, true), fila('subido', '2026-10-21T12:00:00Z', 83, false)],
      filtro,
    );
    expect(p.filas.map((f) => f.clave)).toEqual(['nuevo', 'subido']);
    expect(p.filas[0].pendiente).toBe(true);
  });

  it('solo en la primera página', () => {
    const p = sumarPendientes({ ...servidor, pagina: 2 }, [fila('nuevo', '2026-10-22T12:00:00Z', 83, true)], filtro);
    expect(p.filas.map((f) => f.clave)).toEqual(['subido']);
  });
});

describe('fechas', () => {
  it('por defecto, los últimos siete días con hoy', () => {
    expect(rangoPorDefecto(new Date(2026, 9, 22, 10))).toEqual({ desde: '2026-10-16', hasta: '2026-10-22' });
  });

  it('el rango incluye los dos extremos, por día local', () => {
    const iso = new Date(2026, 9, 22, 23, 30).toISOString();
    expect(enElRango(iso, '2026-10-22', '2026-10-22')).toBe(true);
    expect(enElRango(iso, '2026-10-23', '2026-10-30')).toBe(false);
  });
});
