import { Prisma } from '@prisma/client';

/**
 * Consecutivos de documento (`tid`) servidos por secuencias de Postgres.
 *
 * Sustituye al patrón `MAX(tid)+1`, que estaba replicado en cuatro servicios y tenía
 * una carrera real: dos procesos concurrentes (el cron de facturación y un cajero,
 * típicamente) leían el mismo máximo y pedían el mismo número. Como `tid` tiene índice
 * único no se duplicaba: fallaba — y en el lote de facturación ese fallo se contaba
 * como `failed++`, dejando al abonado sin factura del mes sin reintento ni alerta.
 *
 * `nextval` es atómico y no bloquea, así que no serializa nada. A cambio no es
 * transaccional: si la transacción se deshace, el número se pierde y quedan huecos en
 * la numeración. Es el intercambio correcto — un hueco es inocuo, un duplicado no.
 */

/** Cliente Prisma o transacción abierta: sólo se necesita `$queryRaw`. */
type Db = Pick<Prisma.TransactionClient, '$queryRaw'>;

/**
 * Secuencias creadas en `20260720000000_tid_sequences`. El identificador va entrecomillado
 * porque los nombres llevan mayúsculas y Postgres las plegaría a minúsculas sin comillas.
 */
export const TID_SEQ = {
  subInvoice: '"SubInvoice_tid_seq"',
  recurringInvoice: '"RecurringInvoice_tid_seq"',
  stockReturn: '"StockReturn_tid_seq"',
  supplyOrder: '"SupplyOrder_tid_seq"',
  /** Número de abonado. Ojo: la columna NO es única (ver la migración), pero al
   *  menos deja de fabricar duplicados nuevos por concurrencia. */
  subscriberAbonado: '"Subscriber_abonado_seq"',
  quote: '"Quote_tid_seq"',
} as const;

export type TidSequence = (typeof TID_SEQ)[keyof typeof TID_SEQ];

/**
 * Siguiente consecutivo de la secuencia indicada.
 *
 * El nombre viaja como PARÁMETRO con cast a `regclass`, no interpolado en el SQL: así
 * no hay concatenación de identificadores (el proyecto no usa `queryRawUnsafe` en
 * ningún sitio y esto no iba a ser la excepción).
 */
export async function nextTid(db: Db, sequence: TidSequence): Promise<number> {
  const rows = await db.$queryRaw<{ tid: bigint }[]>`SELECT nextval(${sequence}::regclass) AS tid`;
  return Number(rows[0].tid);
}
