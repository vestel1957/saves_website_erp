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
