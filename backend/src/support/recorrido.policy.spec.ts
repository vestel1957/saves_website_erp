import { largo, metros, proponerRecorrido, type Parada, type Punto } from './recorrido.policy';

/**
 * Puntos reales de Yopal, que es donde está el grueso del parque. Están puestos
 * en cruz alrededor de la sede a propósito: es la trampa clásica del vecino más
 * cercano —ir, volver, ir— y lo que el 2-opt tiene que deshacer.
 */
const SEDE: Punto = { lat: 5.3378, lng: -72.3959 };
const NORTE: Punto = { lat: 5.3600, lng: -72.3959 };
const SUR: Punto = { lat: 5.3150, lng: -72.3959 };
const ESTE: Punto = { lat: 5.3378, lng: -72.3700 };
const OESTE: Punto = { lat: 5.3378, lng: -72.4200 };

const parada = (id: string, punto: Punto | null, extra: Partial<Parada> = {}): Parada => ({
  id, punto, exacto: true, ...extra,
});

describe('proponerRecorrido', () => {
  it('agrupa lo cercano en vez de cruzar la ciudad', () => {
    // Orden actual: norte, sur, norte otra vez. Cualquier orden sensato ahorra.
    const r = proponerRecorrido(SEDE, [
      parada('a', NORTE),
      parada('b', SUR),
      parada('c', { lat: 5.3610, lng: -72.3950 }),
    ]);
    expect(r.metrosDespues).toBeLessThan(r.metrosAntes);
    // Las dos del norte quedan seguidas.
    const i = r.orden.indexOf('a');
    const j = r.orden.indexOf('c');
    expect(Math.abs(i - j)).toBe(1);
  });

  it('no propone un recorrido más largo que el actual', () => {
    const paradas = [parada('a', ESTE), parada('b', OESTE), parada('c', NORTE), parada('d', SUR)];
    const r = proponerRecorrido(SEDE, paradas);
    expect(r.metrosDespues).toBeLessThanOrEqual(r.metrosAntes);
  });

  it('deja quietas las que ya están en marcha y sale desde la última', () => {
    const r = proponerRecorrido(SEDE, [
      parada('enCurso', NORTE, { fija: true }),
      parada('lejos', SUR),
      parada('alLado', { lat: 5.3610, lng: -72.3950 }),
    ]);
    expect(r.orden[0]).toBe('enCurso');
    // Se sale de NORTE, así que la de al lado va antes que la del sur.
    expect(r.orden[1]).toBe('alLado');
  });

  it('manda al final las que no se pudieron ubicar, sin perderlas', () => {
    const r = proponerRecorrido(SEDE, [
      parada('sinGps', null),
      parada('norte', NORTE),
      parada('sur', SUR),
    ]);
    expect(r.orden).toHaveLength(3);
    expect(r.orden[2]).toBe('sinGps');
    expect(r.sinUbicar).toEqual(['sinGps']);
  });

  it('avisa de que el orden salió de centroides de barrio', () => {
    const exacto = proponerRecorrido(SEDE, [parada('a', NORTE), parada('b', SUR)]);
    const aprox = proponerRecorrido(SEDE, [
      parada('a', NORTE, { exacto: false }),
      parada('b', SUR),
    ]);
    expect(exacto.aproximado).toBe(false);
    expect(aprox.aproximado).toBe(true);
  });

  it('aguanta el día vacío y el de una sola visita', () => {
    expect(proponerRecorrido(SEDE, []).orden).toEqual([]);
    const una = proponerRecorrido(SEDE, [parada('a', NORTE)]);
    expect(una.orden).toEqual(['a']);
    expect(una.metrosDespues).toBe(una.metrosAntes);
  });

  it('respeta la distancia que se le inyecte (matriz real, no línea recta)', () => {
    // Distancia falsa donde el norte está carísimo: la propuesta tiene que
    // cambiar respecto de la línea recta, o la inyección no sirve de nada.
    const rio = (a: Punto, b: Punto) =>
      metros(a, b) * (a.lat > 5.35 || b.lat > 5.35 ? 20 : 1);
    const paradas = [parada('norte', NORTE), parada('este', ESTE), parada('oeste', OESTE)];
    const conRio = proponerRecorrido(SEDE, paradas, rio);
    expect(conRio.orden[2]).toBe('norte');
  });

  it('largo() cuenta el tramo desde el punto de partida', () => {
    expect(largo(null, [NORTE, SUR])).toBe(metros(NORTE, SUR));
    expect(largo(SEDE, [NORTE, SUR])).toBe(metros(SEDE, NORTE) + metros(NORTE, SUR));
  });
});

describe('proponerRecorrido sin punto de partida', () => {
  it('no se conforma con el orden en que venía la lista', () => {
    // Zigzag deliberado: norte, sur, norte, sur. Sin saber de dónde sale el
    // técnico había que empezar por alguna, y empezar por la primera de la lista
    // era conservar justo el recorrido que se quiere corregir.
    const r = proponerRecorrido(null, [
      parada('n1', { lat: 5.3600, lng: -72.3959 }),
      parada('s1', { lat: 5.3150, lng: -72.3959 }),
      parada('n2', { lat: 5.3610, lng: -72.3950 }),
      parada('s2', { lat: 5.3160, lng: -72.3950 }),
    ]);
    expect(r.metrosDespues).toBeLessThan(r.metrosAntes);
    expect(Math.abs(r.orden.indexOf('n1') - r.orden.indexOf('n2'))).toBe(1);
    expect(Math.abs(r.orden.indexOf('s1') - r.orden.indexOf('s2'))).toBe(1);
  });
});
