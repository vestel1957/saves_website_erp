import {
  CARGO_CAJERO,
  CARGO_OTRO,
  CARGO_TECNICO,
  ETIQUETAS_CARGO,
  cargoLegacy,
  cargoSqlCase,
  codigoDeCargo,
} from './cargos-legacy';

/**
 * Estas pruebas existen por un error concreto: los códigos 2 y 3 estuvieron
 * cambiados y el sistema llamó "Cajero" a los técnicos durante meses, en cuatro
 * sitios a la vez. Que fallen si alguien los vuelve a voltear.
 */
describe('cargos legacy', () => {
  it('el 2 es el técnico y el 3 el cajero (lo dice el dato, no el número)', () => {
    expect(CARGO_TECNICO).toBe(2);
    expect(CARGO_CAJERO).toBe(3);
    expect(cargoLegacy(2)).toBe('Técnico');
    expect(cargoLegacy(3)).toBe('Cajero');
  });

  it('un código desconocido o ausente no inventa cargo', () => {
    expect(cargoLegacy(null)).toBeNull();
    expect(cargoLegacy(undefined)).toBeNull();
    expect(cargoLegacy(99)).toBeNull();
  });

  it('resuelve el nombre del cargo como lo escribe una persona', () => {
    expect(codigoDeCargo('Técnico')).toBe(CARGO_TECNICO);
    expect(codigoDeCargo('tecnicos')).toBe(CARGO_TECNICO);
    expect(codigoDeCargo('CAJERAS')).toBe(CARGO_CAJERO);
    expect(codigoDeCargo('cajero')).toBe(CARGO_CAJERO);
    expect(codigoDeCargo('')).toBeNull();
    expect(codigoDeCargo('bombero')).toBeNull();
  });

  it('el CASE de SQL sale del mismo mapa que las etiquetas', () => {
    const sql = cargoSqlCase('e.role').sql;
    expect(sql).toContain("WHEN 2 THEN 'Técnico'");
    expect(sql).toContain("WHEN 3 THEN 'Cajero'");
    expect(sql).toContain(`ELSE '${CARGO_OTRO}'`);
    // Toda etiqueta del catálogo tiene que estar en el CASE: si alguien agrega un
    // cargo y el SQL no lo refleja, la búsqueda IA lo cuenta como "Otro".
    for (const etiqueta of ETIQUETAS_CARGO) expect(sql).toContain(`'${etiqueta}'`);
  });
});
