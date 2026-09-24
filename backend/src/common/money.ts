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
 * Redondea al PESO, que es la unidad real de este negocio.
 *
 * `round2` redondea a CÉNTIMOS, y un céntimo aquí no existe: no se puede cobrar en
 * ventanilla, no cabe en el legacy (`invoices.total` es `int(16)`) y no se imprime en
 * el recibo. Lo único que hace es quedarse pegado al saldo del cliente.
 */
export const pesos = (n: number): number => Math.round(Number(n) || 0);

/**
 * El IVA de una base, AL PESO.
 *
 * El 19 % parte el peso constantemente: una TV de 22.269 da 4.231,11. Guardar ese
 * `,11` en el renglón lo arrastra al total de la factura, y de ahí al saldo del
 * cliente — que queda debiendo once céntimos que nadie puede pagar. Así se le negó el
 * paz y salvo a la abonada 57485 (factura #505028) estando al día.
 *
 * Esta regla ya vivía suelta en `prorrateo-reconexion.service.ts` ("el renglón entero
 * tiene que ser entero o el writeback y el sync verían totales distintos cada 15
 * minutos"); aquí es la única copia, para que valga en TODA factura que nazca.
 */
export const ivaDe = (base: number, pct: number | null | undefined): number =>
  pesos((Number(base) || 0) * (Number(pct) || 0) / 100);

/**
 * Menos de UN PESO no es plata.
 *
 * El legacy guarda `invoices.total`/`pamnt` como `int(16)` y el IVA del 19 % parte el
 * peso: una TV de 22.269 + IVA da 26.500,11 y la factura queda en 85.000,11 mientras
 * la ventanilla cobra 85.000 redondos. Son 291 facturas con ese residuo, y nadie
 * puede pagar once céntimos: la cliente queda "debiendo" para siempre y se le niega
 * el paz y salvo estando al día (abonada 57485, factura #505028).
 *
 * Es la misma tolerancia que ya usa `mismoDinero` en `sync-legacy-vivo.js`.
 *
 * Estricto a propósito (`< 1`, no `<= 1`): un peso EXACTO sí es un cobro corto de
 * verdad — abonada 57454, 69.999 sobre 70.000, y por eso no le abrieron la
 * instalación. Ese hay que corregirlo, no perdonarlo.
 */
export const TOLERANCIA_PESO = 1;

/** `true` si el saldo está en cero en pesos (el residuo de céntimos no cuenta). */
export const estaAlDia = (saldo: number): boolean => saldo < TOLERANCIA_PESO;

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
): number => {
  const falta = num(i.total) - num(i.paidAmount);
  // El residuo de céntimos (y el sobrepago) valen cero: ver `TOLERANCIA_PESO`.
  return estaAlDia(falta) ? 0 : round2(falta);
};

/** La deuda de un cliente: la suma de los saldos de sus facturas pendientes. */
export const deudaPendiente = (
  facturas: { total: Prisma.Decimal | number | null; paidAmount: Prisma.Decimal | number | null }[],
): number => round2(facturas.reduce((a, i) => a + saldoPendiente(i), 0));
