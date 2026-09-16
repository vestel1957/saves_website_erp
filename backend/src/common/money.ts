import type { Prisma } from '@prisma/client';

/**
 * Convierte un Decimal de Prisma (o número/nulo) a `number`, tratando null/undefined
 * como 0. Helper canónico: reemplaza las ~22 copias locales de `num` dispersas por
 * los servicios.
 */
export const num = (d: Prisma.Decimal | number | null | undefined): number =>
  d == null ? 0 : Number(d);

/**
 * Redondea a 2 decimales (centavos). Defensivo ante valores no numéricos (NaN → 0).
 * Helper canónico: reemplaza las ~12 copias locales de `round2`.
 */
export const round2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Lo que falta por pagar de UNA factura, nunca negativo.
 *
 * El sobrepago de una factura NO rebaja la deuda de otra. Caso real (abonado 15,
 * ago-2024): la cliente pagó 120.000 de un tirón y el legacy los cargó enteros a
 * una factura de 30.000 sin emitir los meses siguientes. Sumar el neto
 * —`suma(total) − suma(pagado)`— dejaba la ficha en CERO mientras la ventanilla,
 * el portal y el estado de cuenta le cobraban las tres facturas de 2026 que sí
 * debe. Ver `deudaPendiente`.
 */
export const saldoPendiente = (
  i: { total: Prisma.Decimal | number | null; paidAmount: Prisma.Decimal | number | null },
): number => Math.max(0, num(i.total) - num(i.paidAmount));

/** La deuda de un cliente: la suma de los saldos de sus facturas pendientes. */
export const deudaPendiente = (
  facturas: { total: Prisma.Decimal | number | null; paidAmount: Prisma.Decimal | number | null }[],
): number => round2(facturas.reduce((a, i) => a + saldoPendiente(i), 0));
