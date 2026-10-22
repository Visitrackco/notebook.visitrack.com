import { describe, expect, it } from 'vitest';

import { EstadoDeVigia, MomentosDeGeocerca, VigiaDeGeocercas, metrosEntre } from './vigia-de-geocercas';

/**
 * El porte de `VigiaDeGeocercas` (GeocercasNativas.kt).
 *
 * Lo que se fija aquí es lo que protege contra el ruido del GPS: que la
 * primera lectura solo aprende, que un cruce necesita dos lecturas, y que
 * «cerca» tiene histéresis. Sin eso, cada recarga de la pestaña sería una
 * llegada y cada salto del GPS un correo.
 */

// Un cuadrado de ~1,1 km alrededor de (4.005, -74.005). Vértices [lat, lng].
const POLIGONO = [
  [4.0, -74.0],
  [4.0, -74.01],
  [4.01, -74.01],
  [4.01, -74.0],
];
const DENTRO = { lat: 4.005, lng: -74.005 };
const FUERA = { lat: 4.05, lng: -74.05 };

const T0 = new Date(2026, 9, 22, 10, 0, 0).getTime();
const SEG = 1000;
const MIN = 60 * SEG;

function flujo(reglas: object[], geocercas?: object[]) {
  return {
    id: 1,
    nombre: 'ZONA DE PRUEBA',
    activo: true,
    geocercas: geocercas ?? [
      { id: 83, nombre: 'Casa', activa: true, forma: 'POLYGON', poligono: POLIGONO, puntos: [] },
    ],
    reglas,
  };
}

function regla(cuando: string, extra: object = {}) {
  return {
    id: `r-${cuando}`,
    nombre: `Regla ${cuando}`,
    cuando,
    geocercas: [83],
    punto: null,
    metros: null,
    minutos: null,
    repetir: 'siempre',
    horario: null,
    acciones: [{ accion: 'crear-actividad', surveyId: 10117, enElPunto: true }],
    avisaServidor: true,
    ...extra,
  };
}

function vigiaCon(f: object, estado: EstadoDeVigia = {}): VigiaDeGeocercas {
  const v = new VigiaDeGeocercas(estado);
  v.cargar([JSON.stringify(f)]);
  return v;
}

describe('VigiaDeGeocercas', () => {
  it('la primera lectura aprende y no dispara, aunque ya esté dentro', () => {
    // Ojo: «permanecer», como en el teléfono, sí cuenta desde que se aprendió
    // (no mira si es la primera lectura); por eso aquí solo va «entrar».
    const v = vigiaCon(flujo([regla('entrar')]));

    expect(v.evaluar(DENTRO, T0)).toEqual([]);
    expect(v.estadoActual['g:1:83'].dentro).toBe(true);

    // Y seguir dentro tampoco es «entrar»: ya estaba cuando se le conoció.
    expect(v.evaluar(DENTRO, T0 + 20 * SEG).filter((d) => d.tipo === 'ENTRAR')).toEqual([]);
  });

  it('entrar necesita dos lecturas seguidas dentro, y dispara una sola vez por estancia', () => {
    const v = vigiaCon(flujo([regla('entrar')]));

    expect(v.evaluar(FUERA, T0)).toEqual([]);
    // Una lectura dentro puede ser un salto del GPS.
    expect(v.evaluar(DENTRO, T0 + 20 * SEG)).toEqual([]);

    const disparos = v.evaluar(DENTRO, T0 + 40 * SEG);
    expect(disparos).toHaveLength(1);
    expect(disparos[0]).toMatchObject({
      tipo: 'ENTRAR',
      flujoId: 1,
      reglaId: 'r-entrar',
      geocercaId: 83,
      geocercaNombre: 'Casa',
    });
    expect(disparos[0].acciones[0]).toMatchObject({ accion: 'crear-actividad', surveyId: 10117 });

    expect(v.evaluar(DENTRO, T0 + 60 * SEG)).toEqual([]);
  });

  it('un salto suelto fuera no cuenta como cruce', () => {
    const v = vigiaCon(flujo([regla('entrar'), regla('salir')]));

    v.evaluar(FUERA, T0);
    v.evaluar(DENTRO, T0 + 20 * SEG);
    // Fuera, dentro: el contador vuelve a cero y no se confirma nada.
    expect(v.evaluar(FUERA, T0 + 40 * SEG)).toEqual([]);
    expect(v.evaluar(DENTRO, T0 + 60 * SEG)).toEqual([]);
    expect(v.estadoActual['g:1:83'].dentro).toBe(false);
  });

  it('salir dispara al confirmar con dos lecturas que salió', () => {
    const v = vigiaCon(flujo([regla('salir')]));

    expect(v.evaluar(DENTRO, T0)).toEqual([]);
    expect(v.evaluar(FUERA, T0 + 20 * SEG)).toEqual([]);

    const disparos = v.evaluar(FUERA, T0 + 40 * SEG);
    expect(disparos.map((d) => d.tipo)).toEqual(['SALIR']);

    expect(v.evaluar(FUERA, T0 + 60 * SEG)).toEqual([]);
  });

  it('cerca de un punto: dispara al acercarse a menos de los metros, con histéresis al alejarse', () => {
    const punto = { clave: 'C:Punto 1', nombre: 'Punto 1', lat: 4.6, lng: -74.08, radio: 100 };
    const geocercas = [{ id: 83, nombre: 'Casa', activa: true, forma: 'CIRCLE', puntos: [punto] }];
    const v = vigiaCon(flujo([regla('cerca', { metros: 50 })], geocercas));

    // ~0,0001° de latitud son ~11 m.
    const a = (m: number) => ({ lat: 4.6 + m / 111_195, lng: -74.08 });
    expect(Math.round(metrosEntre(4.6, -74.08, a(40).lat, a(40).lng))).toBe(40);

    expect(v.evaluar(a(500), T0)).toEqual([]); // aprende: lejos
    const disparos = v.evaluar(a(40), T0 + 20 * SEG);
    expect(disparos).toHaveLength(1);
    expect(disparos[0]).toMatchObject({ tipo: 'CERCA', punto: 'C:Punto 1', puntoNombre: 'Punto 1' });

    // A 70 m no ha salido (sale a más de 50 × 1,25 + 15 = 77,5 m): volver no redispara.
    expect(v.evaluar(a(70), T0 + 40 * SEG)).toEqual([]);
    expect(v.evaluar(a(40), T0 + 60 * SEG)).toEqual([]);

    // A 100 m sí salió: acercarse otra vez vuelve a disparar.
    expect(v.evaluar(a(100), T0 + 80 * SEG)).toEqual([]);
    expect(v.evaluar(a(30), T0 + 100 * SEG).map((d) => d.tipo)).toEqual(['CERCA']);
  });

  it('cerca: la primera lectura ya cerca aprende y no dispara', () => {
    const punto = { clave: 'C:P', nombre: 'P', lat: 4.6, lng: -74.08, radio: 100 };
    const geocercas = [{ id: 83, nombre: 'Casa', activa: true, forma: 'CIRCLE', puntos: [punto] }];
    const v = vigiaCon(flujo([regla('cerca', { metros: 50 })], geocercas));

    expect(v.evaluar({ lat: 4.6, lng: -74.08 }, T0)).toEqual([]);
    expect(v.evaluar({ lat: 4.6, lng: -74.08 }, T0 + 20 * SEG)).toEqual([]);
  });

  it('permanecer: dispara cuando lleva N minutos dentro, contados desde la primera lectura del cruce', () => {
    const v = vigiaCon(flujo([regla('permanecer', { minutos: 10 })]));

    v.evaluar(FUERA, T0);
    v.evaluar(DENTRO, T0 + 20 * SEG); // primera lectura dentro: aquí empieza la cuenta
    expect(v.evaluar(DENTRO, T0 + 40 * SEG)).toEqual([]);
    expect(v.evaluar(DENTRO, T0 + 20 * SEG + 9 * MIN)).toEqual([]);

    const disparos = v.evaluar(DENTRO, T0 + 20 * SEG + 10 * MIN);
    expect(disparos.map((d) => d.tipo)).toEqual(['PERMANECER']);

    // Una vez por estancia.
    expect(v.evaluar(DENTRO, T0 + 30 * MIN)).toEqual([]);
  });

  it('el estado guardado sobrevive a una recarga: no vuelve a disparar', () => {
    const guardado: { estado: EstadoDeVigia } = { estado: {} };
    const f = flujo([regla('entrar')]);

    const v1 = new VigiaDeGeocercas({}, (e) => (guardado.estado = JSON.parse(JSON.stringify(e))));
    v1.cargar([JSON.stringify(f)]);
    v1.evaluar(FUERA, T0);
    v1.evaluar(DENTRO, T0 + 20 * SEG);
    expect(v1.evaluar(DENTRO, T0 + 40 * SEG)).toHaveLength(1);

    const v2 = vigiaCon(f, guardado.estado);
    expect(v2.evaluar(DENTRO, T0 + 5 * MIN)).toEqual([]);
  });

  it('«una vez al día» no repite el mismo día, aunque vuelva a entrar', () => {
    const v = vigiaCon(flujo([regla('entrar', { repetir: 'una-vez-al-dia' })]));

    v.evaluar(FUERA, T0);
    v.evaluar(DENTRO, T0 + 20 * SEG);
    expect(v.evaluar(DENTRO, T0 + 40 * SEG)).toHaveLength(1);

    v.evaluar(FUERA, T0 + 60 * SEG);
    v.evaluar(FUERA, T0 + 80 * SEG);
    v.evaluar(DENTRO, T0 + 100 * SEG);
    expect(v.evaluar(DENTRO, T0 + 120 * SEG)).toEqual([]);
  });

  it('un flujo apagado o una geocerca inactiva no vigilan nada', () => {
    const apagado = vigiaCon({ ...flujo([regla('entrar')]), activo: false });
    apagado.evaluar(FUERA, T0);
    apagado.evaluar(DENTRO, T0 + 20 * SEG);
    expect(apagado.evaluar(DENTRO, T0 + 40 * SEG)).toEqual([]);

    const inactiva = vigiaCon(
      flujo([regla('entrar')], [{ id: 83, nombre: 'Casa', activa: false, forma: 'POLYGON', poligono: POLIGONO }]),
    );
    inactiva.evaluar(FUERA, T0);
    inactiva.evaluar(DENTRO, T0 + 20 * SEG);
    expect(inactiva.evaluar(DENTRO, T0 + 40 * SEG)).toEqual([]);
  });

  it('fuera del horario de la regla no dispara', () => {
    // T0 es a las 10:00; la regla solo vale de 14:00 a 18:00.
    const v = vigiaCon(flujo([regla('entrar', { horario: { desde: '14:00', hasta: '18:00' } })]));
    v.evaluar(FUERA, T0);
    v.evaluar(DENTRO, T0 + 20 * SEG);
    expect(v.evaluar(DENTRO, T0 + 40 * SEG)).toEqual([]);
  });
});

/**
 * Los momentos de la app: una sola lectura, sin aprender ni confirmar.
 */
describe('MomentosDeGeocerca', () => {
  const PUNTO = { clave: 'L:55', nombre: 'Sede 55', lat: 4.6, lng: -74.08, radio: 100, locationTypeId: 7 };
  const OTRO = { clave: 'C:Otro', nombre: 'Otro', lat: 4.7, lng: -74.2, radio: 100, locationTypeId: null };

  function flujoMomento(reglas: object[]) {
    return {
      id: 2,
      nombre: 'Momentos',
      activo: true,
      geocercas: [
        { id: 83, nombre: 'Casa', activa: true, forma: 'POLYGON', poligono: POLIGONO, puntos: [] },
        { id: 90, nombre: 'Sedes', activa: true, forma: 'CIRCLE', puntos: [PUNTO, OTRO] },
      ],
      reglas,
    };
  }

  function reglaMomento(cuando: string, extra: object = {}) {
    return {
      id: `m-${cuando}`,
      nombre: `Momento ${cuando}`,
      cuando,
      geocercas: [83],
      repetir: 'siempre',
      horario: null,
      acciones: [{ accion: 'notificar', titulo: 'Guardó en {GEOCERCA}' }],
      ...extra,
    };
  }

  const CTX = { answerGuid: 'abc', surveyId: 10117 };

  it('dispara con la primera lectura si está dentro, sin aprender ni confirmar', () => {
    const m = new MomentosDeGeocerca();
    const flujos = [flujoMomento([reglaMomento('actividad-guardar')])];

    const disparos = m.evaluar(flujos, 'actividad-guardar', CTX, DENTRO, T0);
    expect(disparos).toHaveLength(1);
    expect(disparos[0]).toMatchObject({
      tipo: 'MOMENTO',
      momento: 'actividad-guardar',
      contexto: CTX,
      geocercaId: 83,
      reglaId: 'm-actividad-guardar',
    });

    // Otro momento no la dispara, y fuera tampoco.
    expect(m.evaluar(flujos, 'actividad-crear', CTX, DENTRO, T0)).toEqual([]);
    expect(m.evaluar(flujos, 'actividad-guardar', CTX, FUERA, T0)).toEqual([]);
  });

  it('«fuera» dispara por cada geocerca de la regla en la que no está', () => {
    const m = new MomentosDeGeocerca();
    const flujos = [flujoMomento([reglaMomento('sesion-cerrar', { donde: 'fuera', geocercas: [] })])];

    // Dentro del polígono 83, fuera de las sedes de la 90.
    const disparos = m.evaluar(flujos, 'sesion-cerrar', null, DENTRO, T0);
    expect(disparos.map((d) => d.geocercaId)).toEqual([90]);
    expect(disparos[0].contexto).toBeNull();
  });

  it('«cerca» dispara por cada punto coincidente a menos de los metros', () => {
    const m = new MomentosDeGeocerca();
    const regla = reglaMomento('actividad-crear', {
      donde: 'cerca',
      metros: 50,
      geocercas: [90],
      punto: { modo: 'tipo', tipoUbicacion: 7 },
    });
    const flujos = [flujoMomento([regla])];
    const a40 = { lat: 4.6 + 40 / 111_195, lng: -74.08 };

    const disparos = m.evaluar(flujos, 'actividad-crear', CTX, a40, T0);
    expect(disparos).toHaveLength(1);
    expect(disparos[0]).toMatchObject({ punto: 'L:55', puntoNombre: 'Sede 55' });

    const a80 = { lat: 4.6 + 80 / 111_195, lng: -74.08 };
    expect(m.evaluar(flujos, 'actividad-crear', CTX, a80, T0)).toEqual([]);
  });

  it('`formularios` limita los momentos de actividad a esos SurveyID', () => {
    const m = new MomentosDeGeocerca();
    const flujos = [flujoMomento([reglaMomento('actividad-eliminar', { formularios: [555] })])];

    expect(m.evaluar(flujos, 'actividad-eliminar', CTX, DENTRO, T0)).toEqual([]);
    expect(
      m.evaluar(flujos, 'actividad-eliminar', { answerGuid: 'x', surveyId: '555' }, DENTRO, T0),
    ).toHaveLength(1);
  });

  it('«una vez al día» usa su propio estado, separado del de la vigía', () => {
    const m = new MomentosDeGeocerca();
    const flujos = [flujoMomento([reglaMomento('sesion-iniciar', { repetir: 'una-vez-al-dia' })])];

    expect(m.evaluar(flujos, 'sesion-iniciar', null, DENTRO, T0)).toHaveLength(1);
    expect(m.evaluar(flujos, 'sesion-iniciar', null, DENTRO, T0 + MIN)).toEqual([]);
    // Al día siguiente, otra vez.
    expect(m.evaluar(flujos, 'sesion-iniciar', null, DENTRO, T0 + 24 * 60 * MIN)).toHaveLength(1);

    // La vigía de movimiento no ve estas llaves ni las toca.
    const v = vigiaCon(flujoMomento([reglaMomento('sesion-iniciar')]));
    v.evaluar(DENTRO, T0);
    expect(Object.keys(v.estadoActual).some((k) => k.startsWith('dia:'))).toBe(false);
  });

  it('respetan el horario de la regla y la vigilancia de movimiento los ignora', () => {
    const m = new MomentosDeGeocerca();
    const flujos = [
      flujoMomento([reglaMomento('actividad-guardar', { horario: { desde: '14:00', hasta: '18:00' } })]),
    ];
    expect(m.evaluar(flujos, 'actividad-guardar', CTX, DENTRO, T0)).toEqual([]);

    const v = vigiaCon(flujoMomento([reglaMomento('actividad-guardar')]));
    v.evaluar(FUERA, T0);
    v.evaluar(DENTRO, T0 + 20 * SEG);
    expect(v.evaluar(DENTRO, T0 + 40 * SEG)).toEqual([]);
  });

  it('hayReglaPara dice si vale la pena pedir el GPS', () => {
    const flujos = [flujoMomento([reglaMomento('sesion-cerrar')])];
    expect(MomentosDeGeocerca.hayReglaPara(flujos, 'sesion-cerrar')).toBe(true);
    expect(MomentosDeGeocerca.hayReglaPara(flujos, 'sesion-iniciar')).toBe(false);
    expect(MomentosDeGeocerca.hayReglaPara([{ ...flujos[0], activo: false }], 'sesion-cerrar')).toBe(false);
  });
});
