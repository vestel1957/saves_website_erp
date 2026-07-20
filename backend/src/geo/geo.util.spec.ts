import { assertPoint, distMeters, parseCoord, parsePoint } from './geo.util';

describe('parseCoord', () => {
  it('acepta una coordenada normal', () => {
    expect(parseCoord('5.3407689')).toBeCloseTo(5.3407689);
    expect(parseCoord('-72.369472')).toBeCloseTo(-72.369472);
  });

  it('tolera la coma decimal y los espacios del legacy', () => {
    expect(parseCoord(' 5,3407689 ')).toBeCloseTo(5.3407689);
  });

  it('rechaza la basura que trae el legacy', () => {
    for (const v of [null, undefined, '', '   ', 'NULL', 'null', '0', 'abc', 'N/A']) {
      expect(parseCoord(v)).toBeNull();
    }
  });
});

describe('parsePoint', () => {
  it('devuelve el par cuando ambas son válidas', () => {
    expect(parsePoint('5.3407689', '-72.369472')).toEqual({
      lat: 5.3407689,
      lng: -72.369472,
    });
  });

  it('descarta el punto si falta una de las dos', () => {
    expect(parsePoint('5.34', null)).toBeNull();
    expect(parsePoint(null, '-72.36')).toBeNull();
  });

  it('descarta el (0,0): es el punto al que va a parar todo dato vacío', () => {
    expect(parsePoint('0', '0')).toBeNull();
  });

  it('descarta coordenadas fuera de Colombia', () => {
    expect(parsePoint('48.8566', '2.3522')).toBeNull(); // París
    expect(parsePoint('-72.369472', '5.3407689')).toBeNull(); // lat/lng invertidas
  });
});

describe('assertPoint', () => {
  it('redondea a 6 decimales (≈10 cm, más que suficiente)', () => {
    expect(assertPoint(5.33781234567, -72.39593412345)).toEqual({
      lat: 5.337812,
      lng: -72.395934,
    });
  });

  it('rechaza lo que está fuera del área de cobertura', () => {
    expect(() => assertPoint(48.8566, 2.3522)).toThrow(/fuera del área/);
  });

  it('rechaza NaN e infinitos', () => {
    expect(() => assertPoint(NaN, -72.39)).toThrow();
    expect(() => assertPoint(5.33, Infinity)).toThrow();
  });
});

describe('distMeters', () => {
  it('da 0 para el mismo punto', () => {
    expect(distMeters(5.3378, -72.3959, 5.3378, -72.3959)).toBe(0);
  });

  it('mide con precisión de metros en distancias cortas', () => {
    // 0,001° de latitud ≈ 111 m en cualquier meridiano.
    expect(distMeters(5.3378, -72.3959, 5.3388, -72.3959)).toBeGreaterThan(105);
    expect(distMeters(5.3378, -72.3959, 5.3388, -72.3959)).toBeLessThan(117);
  });
});
