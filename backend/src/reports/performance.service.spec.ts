import { mediana } from './performance.service';

describe('mediana', () => {
  it('toma el del medio con lista impar', () => {
    expect(mediana([10, 2, 6])).toBe(6);
  });

  it('promedia los dos del medio con lista par', () => {
    expect(mediana([4, 10, 2, 6])).toBe(5);
  });

  it('ignora a quien no tiene el dato en vez de contarlo como cero', () => {
    // Un técnico sin órdenes cerradas llega con null. Tratarlo como 0% lo
    // convertiría en el mejor del equipo sin haber hecho nada.
    expect(mediana([null, 10, null, 20, 30])).toBe(20);
  });

  it('sin datos devuelve null, no 0', () => {
    expect(mediana([])).toBeNull();
    expect(mediana([null, null])).toBeNull();
  });

  it('no se deja ordenar como texto', () => {
    // Con orden lexicográfico la mediana de esto daría 100.
    expect(mediana([9, 100, 20])).toBe(20);
  });
});
