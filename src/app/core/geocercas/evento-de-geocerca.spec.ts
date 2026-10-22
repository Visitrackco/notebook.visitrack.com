import { describe, expect, it } from 'vitest';

import {
  EventoLocal,
  dibujarGeocerca,
  elegirVista,
  leerGeometria,
  medirPosicion,
  textoDelEvento,
  vistaDesdeLocal,
} from './evento-de-geocerca';

/**
 * La pantalla de un evento de geocerca: qué texto se arma sin servidor y de
 * dónde salen los datos (servidor o navegador).
 */

// Un cuadrado de ~1,1 km alrededor de (4.005, -74.005). Vértices [lat, lng].
const POLIGONO = [
  [4.0, -74.0],
  [4.0, -74.01],
  [4.01, -74.01],
  [4.01, -74.0],
];

const FLUJO = {
  id: 7,
  nombre: 'Llegadas a sede',
  activo: true,
  geocercas: [
    { id: 83, nombre: 'Casa', forma: 'POLYGON', poligono: POLIGONO, puntos: [] },
    {
      id: 84,
      nombre: 'Sedes',
      forma: 'CIRCLE',
      puntos: [{ clave: 'L:12', nombre: 'Sede Norte', lat: 4.6, lng: -74.08, radio: 100 }],
    },
  ],
  reglas: [
    { id: 'r1', nombre: 'Aviso al llegar', cuando: 'entrar' },
    { id: 'r2', nombre: 'Guardar fuera', cuando: 'actividad-guardar', donde: 'fuera' },
  ],
};

const evento = (parcial: Partial<EventoLocal> = {}): EventoLocal => ({
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
});

describe('textoDelEvento', () => {
  it('dice el movimiento con el nombre de la geocerca', () => {
    expect(textoDelEvento({ tipo: 'ENTRAR', geocerca: 'Casa' })).toBe('Entró a Casa');
    expect(textoDelEvento({ tipo: 'SALIR', geocerca: 'Casa' })).toBe('Salió de Casa');
    expect(textoDelEvento({ tipo: 'PERMANECER', geocerca: 'Casa' })).toBe('Se quedó en Casa');
  });

  it('en «cerca» nombra el punto', () => {
    expect(textoDelEvento({ tipo: 'CERCA', geocerca: 'Sedes', punto: 'Sede Norte' })).toBe(
      'Pasó cerca de Sede Norte',
    );
  });

  it('en una geocerca por puntos añade el punto', () => {
    expect(textoDelEvento({ tipo: 'ENTRAR', geocerca: 'Sedes', punto: 'Sede Norte' })).toBe(
      'Entró a Sedes (Sede Norte)',
    );
  });

  it('dice el momento de la app y dónde estaba', () => {
    expect(
      textoDelEvento({ tipo: 'MOMENTO', momento: 'actividad-guardar', geocerca: 'Bodega', donde: 'dentro' }),
    ).toBe('Guardó una actividad estando dentro de Bodega');
    expect(
      textoDelEvento({ tipo: 'MOMENTO', momento: 'sesion-iniciar', geocerca: 'Bodega', donde: 'fuera' }),
    ).toBe('Inició sesión estando fuera de Bodega');
    expect(
      textoDelEvento({
        tipo: 'MOMENTO',
        momento: 'actividad-crear',
        geocerca: 'Sedes',
        punto: 'Sede Norte',
        donde: 'cerca',
      }),
    ).toBe('Creó una actividad cerca de Sede Norte');
  });

  it('sin nombre no deja el hueco', () => {
    expect(textoDelEvento({ tipo: 'SALIR', geocerca: '' })).toBe('Salió de la geocerca');
  });
});

describe('medirPosicion', () => {
  const casa = leerGeometria(FLUJO.geocercas[0])!;
  const sedes = leerGeometria(FLUJO.geocercas[1])!;

  it('en un polígono da dentro y la distancia al lado más cercano', () => {
    const m = medirPosicion(casa, 4.005, -74.005)!;
    expect(m.dentro).toBe(true);
    // Al centro de un cuadrado de ~1,1 km le quedan ~550 m a cada lado.
    expect(m.distanciaMetros).toBeGreaterThan(500);
    expect(m.distanciaMetros).toBeLessThan(600);

    const fuera = medirPosicion(casa, 4.011, -74.005)!;
    expect(fuera.dentro).toBe(false);
    expect(fuera.distanciaMetros).toBeGreaterThan(90);
    expect(fuera.distanciaMetros).toBeLessThan(130);
  });

  it('por puntos mide contra el borde del radio', () => {
    const m = medirPosicion(sedes, 4.6, -74.08)!;
    expect(m.dentro).toBe(true);
    expect(m.distanciaMetros).toBe(100);

    // ~222 m al norte: fuera, a ~122 m del borde.
    const fuera = medirPosicion(sedes, 4.602, -74.08)!;
    expect(fuera.dentro).toBe(false);
    expect(fuera.distanciaMetros).toBeGreaterThan(110);
    expect(fuera.distanciaMetros).toBeLessThan(135);
  });
});

describe('vistaDesdeLocal', () => {
  it('arma el texto, el flujo, la regla y dentro/fuera', () => {
    const v = vistaDesdeLocal(evento(), FLUJO, 'Ana Pérez');
    expect(v.origen).toBe('local');
    expect(v.evento).toBe('Entró a Casa');
    expect(v.flujo).toBe('Llegadas a sede');
    expect(v.regla).toBe('Aviso al llegar');
    expect(v.usuario).toBe('Ana Pérez');
    expect(v.dentro).toBe(true);
    expect(v.mapaUrl).toBeNull();
  });

  it('en un momento usa el `donde` de la regla y guarda la actividad', () => {
    const v = vistaDesdeLocal(
      evento({
        tipo: 'MOMENTO',
        reglaId: 'r2',
        momento: 'actividad-guardar',
        lat: 4.02,
        contexto: { answerGuid: 'g-1', surveyId: 55 },
      }),
      JSON.stringify(FLUJO),
      'Ana',
      'Inspección',
    );
    expect(v.evento).toBe('Guardó una actividad estando fuera de Casa');
    expect(v.dentro).toBe(false);
    expect(v.contexto).toEqual({ answerGuid: 'g-1', surveyId: 55, formulario: 'Inspección' });
  });

  it('sin el flujo descargado, no inventa dentro/fuera', () => {
    const v = vistaDesdeLocal(evento({ punto: 'C:Portería' }), null, 'Ana');
    expect(v.dentro).toBeNull();
    expect(v.distanciaMetros).toBeNull();
    expect(v.geocerca).toBeNull();
    expect(v.punto?.nombre).toBe('Portería');
  });
});

describe('elegirVista', () => {
  const local = vistaDesdeLocal(evento(), FLUJO, 'Ana');
  const delServidor = {
    clave: 'abc',
    tipo: 'ENTRAR',
    momento: null,
    evento: 'Entró a Casa',
    en: '2026-10-22T15:00:00.000Z',
    lat: 4.005,
    lng: -74.005,
    usuario: { id: 'u1', nombre: 'Ana María Pérez' },
    flujo: { id: 7, nombre: 'Llegadas' },
    regla: { id: 'r1', nombre: 'Al llegar' },
    geocerca: null,
    punto: null,
    dentro: true,
    distanciaMetros: 551,
    mapaUrl: 'https://mapas/x.png',
    contexto: null,
  };

  it('el servidor manda cuando responde', () => {
    const e = elegirVista({ estado: 'ok', cuerpo: delServidor }, local);
    expect(e.estado).toBe('listo');
    if (e.estado !== 'listo') return;
    expect(e.vista.origen).toBe('servidor');
    expect(e.vista.usuario).toBe('Ana María Pérez');
    expect(e.vista.mapaUrl).toBe('https://mapas/x.png');
    expect(e.vista.distanciaMetros).toBe(551);
  });

  it('lo local rellena lo que le falta al servidor (la geometría del dibujo)', () => {
    const e = elegirVista({ estado: 'ok', cuerpo: delServidor }, local);
    if (e.estado !== 'listo') throw new Error('debía estar listo');
    expect(e.vista.geocerca?.nombre).toBe('Casa');
  });

  it('sin respuesta del servidor, lo local', () => {
    const e = elegirVista({ estado: 'sin-respuesta' }, local);
    expect(e.estado === 'listo' && e.vista.origen).toBe('local');
  });

  it('una respuesta ilegible cuenta como sin respuesta', () => {
    const e = elegirVista({ estado: 'ok', cuerpo: { nada: 1 } }, local);
    expect(e.estado === 'listo' && e.vista.origen).toBe('local');
    expect(elegirVista({ estado: 'ok', cuerpo: 'x' }, null)).toEqual({ estado: 'sin-datos' });
  });

  it('un 404 con algo local enseña lo local (pudo no haber subido)', () => {
    const e = elegirVista({ estado: 'no-existe' }, local);
    expect(e.estado === 'listo' && e.vista.origen).toBe('local');
  });

  it('sin nada: «no existe» con 404, «sin datos» sin red', () => {
    expect(elegirVista({ estado: 'no-existe' }, null)).toEqual({ estado: 'no-existe' });
    expect(elegirVista({ estado: 'sin-respuesta' }, null)).toEqual({ estado: 'sin-datos' });
  });
});

describe('dibujarGeocerca', () => {
  it('cabe en el recuadro y pone a la persona dentro del polígono', () => {
    const d = dibujarGeocerca(leerGeometria(FLUJO.geocercas[0]), 4.005, -74.005, 320, 200)!;
    const xs = d.poligono.split(' ').map((p) => Number(p.split(',')[0]));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(320);
    expect(d.persona.cx).toBeGreaterThan(Math.min(...xs));
    expect(d.persona.cx).toBeLessThan(Math.max(...xs));
  });

  it('dibuja círculos para las geocercas por puntos', () => {
    const d = dibujarGeocerca(leerGeometria(FLUJO.geocercas[1]), 4.602, -74.08)!;
    expect(d.poligono).toBe('');
    expect(d.circulos).toHaveLength(1);
    expect(d.circulos[0].r).toBeGreaterThan(0);
  });

  it('sin geometría no hay dibujo', () => {
    expect(dibujarGeocerca(null, 4, -74)).toBeNull();
  });
});
