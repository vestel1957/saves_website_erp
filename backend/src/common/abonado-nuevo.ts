import { Prisma } from '@prisma/client';
import { rangoDeDiasColombia } from './fecha-colombia';

/**
 * Qué es un "abonado nuevo" y en qué día cuenta. Una sola definición para el
 * panel ejecutivo y la capa `analitica` de Metabase (backend/analitica/vistas.sql).
 *
 * - Es un número de abonado NUEVO: tiene `legacyId`. Los clientes de prueba que se
 *   crearon en producción ("PRUEBA · DEMO INSTALACIÓN", 22-ago-2026) no lo tienen,
 *   y antes se contaban como altas.
 * - Desde que el sync está vivo, el día del alta es el día en que el registro nació
 *   (`createdAt`, en hora de Colombia). No se usa `entryDate`: desde agosto de 2026 casi
 *   nadie la llena (septiembre: 2 de 48), y la fecha de contrato a veces trae errores
 *   de digitación (un alta del 4-sep con contrato del 4-jun).
 * - Lo que llegó ANTES del sync vivo no tiene fecha de creación real: la importación
 *   inicial (`createdAt` = 2026-07-02, 21.772 registros) y el lote atrasado con el que
 *   arrancó el sync el 27-jul (54 altas de contratos del 2 al 27 de julio). Para esos
 *   vale la de ingreso y, si falta, la de contrato (cuando están las dos son iguales en
 *   el 100% de los casos). Desde el 28-jul `createdAt` cae el mismo día del contrato.
 * - Una orden de instalación NO es un alta: en septiembre hubo 3 sobre clientes de 2005 y 2022.
 */
export const FIN_IMPORTACION = new Date('2026-07-28T05:00:00.000Z'); // 2026-07-28 00:00 Colombia

export function whereAbonadoNuevo(desde: string, hasta: string): Prisma.SubscriberWhereInput {
  const creado = rangoDeDiasColombia(desde, hasta) ?? {};
  const dia = { gte: new Date(`${desde}T00:00:00.000Z`), lte: new Date(`${hasta}T00:00:00.000Z`) };
  return {
    legacyId: { not: null },
    OR: [
      { createdAt: { ...creado, gte: maximo(creado.gte, FIN_IMPORTACION) } },
      { createdAt: { lt: FIN_IMPORTACION }, entryDate: dia },
      { createdAt: { lt: FIN_IMPORTACION }, entryDate: null, contractDate: dia },
    ],
  };
}

function maximo(a: Date | undefined, b: Date): Date {
  return a && a > b ? a : b;
}
