import { csvSedesLegacy, sedesDeCsvLegacy } from './sedes-staff';

/**
 * Formato en el que la ficha del empleado guarda la sede (`Staff.sedeAccede`).
 * Lo tienen que poder releer los dos parsers que ya existen contra esa columna:
 * `support/agenda-sede.ts` y `inventory.service.ts`.
 */
describe('csvSedesLegacy', () => {
  it('escribe una sede con la envoltura del legacy', () => {
    expect(csvSedesLegacy([3])).toBe('-3-');
  });

  it('junta varias por coma, ordenadas y sin repetir', () => {
    expect(csvSedesLegacy([4, 2, 4])).toBe('-2-,-4-');
  });

  it('sin sedes guarda NULL, que es "todas" y no "ninguna"', () => {
    expect(csvSedesLegacy([])).toBeNull();
    expect(csvSedesLegacy(undefined)).toBeNull();
  });

  it('descarta el 0 del legacy y la basura, que no son sedes', () => {
    expect(csvSedesLegacy([0, -1, 3])).toBe('-3-');
  });
});

/** El camino inverso, que usa `createAccount` para heredar la sede de la ficha. */
describe('sedesDeCsvLegacy', () => {
  it('lee una sede con la envoltura del legacy', () => {
    expect(sedesDeCsvLegacy('-3-')).toEqual([3]);
  });

  it('lee varias, ordenadas y sin repetir', () => {
    expect(sedesDeCsvLegacy('-4-,-2-,-4-')).toEqual([2, 4]);
  });

  it('NULL, vacío o basura → [], que es "todas"', () => {
    expect(sedesDeCsvLegacy(null)).toEqual([]);
    expect(sedesDeCsvLegacy(undefined)).toEqual([]);
    expect(sedesDeCsvLegacy('0')).toEqual([]);
    expect(sedesDeCsvLegacy('-0-')).toEqual([]);
  });

  it('es el inverso de csvSedesLegacy para una lista válida', () => {
    expect(sedesDeCsvLegacy(csvSedesLegacy([7, 2]))).toEqual([2, 7]);
  });
});
