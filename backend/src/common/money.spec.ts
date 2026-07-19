import { num, round2 } from './money';

describe('num', () => {
  it('trata null/undefined como 0', () => {
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
  });

  it('convierte números tal cual', () => {
    expect(num(1234.56)).toBe(1234.56);
    expect(num(0)).toBe(0);
  });

  it('convierte objetos tipo Decimal (con toString/valueOf) a number', () => {
    // Prisma.Decimal se comporta como number vía Number(); emulamos con un objeto.
    const decimalLike = { valueOf: () => 42.5 } as unknown as number;
    expect(num(decimalLike)).toBe(42.5);
  });
});

describe('round2', () => {
  it('redondea a 2 decimales (centavos)', () => {
    expect(round2(1.005 * 100)).toBe(100.5);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(19999.999)).toBe(20000);
  });

  it('es defensivo ante valores no numéricos', () => {
    expect(round2(NaN)).toBe(0);
    expect(round2(Number('no-es-numero'))).toBe(0);
  });

  it('preserva enteros', () => {
    expect(round2(50000)).toBe(50000);
  });
});
