import { estaAlDia, ivaDe, num, pesos, round2, saldoPendiente } from './money';

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

describe('estaAlDia / saldoPendiente: el residuo de céntimos no es deuda', () => {
  it('los once céntimos del IVA no son un saldo', () => {
    // Factura 85.000,11 (TV 22.269 + 19 %) contra 85.000 cobrados en ventanilla.
    expect(estaAlDia(0.11)).toBe(true);
    expect(saldoPendiente({ total: 85000.11, paidAmount: 85000 })).toBe(0);
  });

  it('un peso EXACTO sí es un cobro corto', () => {
    expect(estaAlDia(1)).toBe(false);
    expect(saldoPendiente({ total: 70000, paidAmount: 69999 })).toBe(1);
  });

  it('una deuda de verdad se conserva entera', () => {
    expect(estaAlDia(85000)).toBe(false);
    expect(saldoPendiente({ total: 85000, paidAmount: 0 })).toBe(85000);
  });

  it('el sobrepago sigue valiendo cero, no negativo', () => {
    expect(saldoPendiente({ total: 30000, paidAmount: 120000 })).toBe(0);
  });
});

describe('ivaDe / pesos: el IVA no parte el peso', () => {
  it('el 19 % de la TV que partía el peso', () => {
    // 22.269 × 19 % = 4.231,11 — el `,11` que se le pegaba al saldo del cliente.
    expect(ivaDe(22269, 19)).toBe(4231);
    expect(round2((22269 * 19) / 100)).toBe(4231.11); // lo que se hacía antes
  });

  it('la factura entera queda en pesos redondos', () => {
    const base = 58500 + 22269;          // internet + TV
    expect(base + ivaDe(22269, 19)).toBe(85000); // lo que cobra la ventanilla
  });

  it('redondea, no trunca', () => {
    expect(ivaDe(30000, 19)).toBe(5700);
    expect(ivaDe(25210, 19)).toBe(4790); // 4.789,90
    expect(pesos(0.5)).toBe(1);
    expect(pesos(0.49)).toBe(0);
  });

  it('sin IVA es cero, y es defensivo', () => {
    expect(ivaDe(58500, 0)).toBe(0);
    expect(ivaDe(58500, null)).toBe(0);
    expect(pesos(NaN)).toBe(0);
  });
});
