import { inicioDelDiaColombia, rangoDeDiasColombia } from './fecha-colombia';

/**
 * El filtro "Desde / Hasta" de la agenda.
 *
 * Lo que se fija aquí es lo que estaba mal: el extremo derecho es EXCLUSIVO y cae
 * en la medianoche del día siguiente. Con el `lte` a la medianoche del propio día
 * —y encima en UTC— un rango de un solo día devolvía cero filas siempre, porque
 * pedía los eventos que empezaran exactamente a las 00:00:00.000.
 */
describe('inicioDelDiaColombia', () => {
  it('las 00:00 de Colombia son las 05:00 UTC', () => {
    expect(inicioDelDiaColombia('2026-08-04')?.toISOString()).toBe('2026-08-04T05:00:00.000Z');
  });

  it('no hay horario de verano: enero y agosto van al mismo desfase', () => {
    expect(inicioDelDiaColombia('2026-01-15')?.toISOString()).toBe('2026-01-15T05:00:00.000Z');
  });

  it('rechaza lo que no es YYYY-MM-DD', () => {
    for (const malo of ['', '4/8/2026', '2026-8-4', 'ayer', '2026-08-04T10:00:00Z']) {
      expect(inicioDelDiaColombia(malo)).toBeNull();
    }
  });

  it('rechaza un día que no existe en vez de rodar al mes siguiente', () => {
    // `new Date('2026-02-31')` no falla: da el 3 de marzo, y el filtro habría
    // devuelto resultados de una fecha que nadie pidió.
    expect(inicioDelDiaColombia('2026-02-31')).toBeNull();
    expect(inicioDelDiaColombia('2026-13-01')).toBeNull();
    expect(inicioDelDiaColombia('2024-02-29')?.toISOString()).toBe('2024-02-29T05:00:00.000Z'); // bisiesto sí
  });
});

describe('rangoDeDiasColombia', () => {
  it('un solo día abarca el día ENTERO', () => {
    const r = rangoDeDiasColombia('2026-08-04', '2026-08-04')!;
    expect(r.gte!.toISOString()).toBe('2026-08-04T05:00:00.000Z');
    expect(r.lt!.toISOString()).toBe('2026-08-05T05:00:00.000Z');
  });

  it('el "hasta" incluye su día completo', () => {
    const r = rangoDeDiasColombia('2026-08-01', '2026-08-04')!;
    expect(r.lt!.toISOString()).toBe('2026-08-05T05:00:00.000Z');
  });

  it('sin fechas no acota nada', () => {
    expect(rangoDeDiasColombia(undefined, undefined)).toEqual({});
    expect(rangoDeDiasColombia('', '   ')).toEqual({});
  });

  it('cada extremo funciona solo', () => {
    expect(Object.keys(rangoDeDiasColombia('2026-08-04', undefined)!)).toEqual(['gte']);
    expect(Object.keys(rangoDeDiasColombia(undefined, '2026-08-04')!)).toEqual(['lt']);
  });

  it('avisa del rango invertido en vez de devolver una tabla vacía', () => {
    expect(rangoDeDiasColombia('2026-08-10', '2026-08-04')).toBeNull();
  });

  it('avisa de una fecha inválida en cualquiera de los dos extremos', () => {
    expect(rangoDeDiasColombia('no-es-fecha', '2026-08-04')).toBeNull();
    expect(rangoDeDiasColombia('2026-08-04', 'no-es-fecha')).toBeNull();
  });
});
