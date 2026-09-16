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
  /**
   * Nº de FACTURA. Misma historia que `ticketCode`: nació en un bloque aparte (500.000)
   * para no pisar al legacy, y el bloque dejó de estar aparte al empezar a empujarle
   * facturas — él numera con `MAX(tid)+1` y adoptó nuestro máximo, hasta emitir su
   * factura 470663 con un tid que ya era nuestro (2026-08-28).
   *
   * Mientras el legacy facture, el número de lo que VIAJA lo reparte él: el writeback
   * pide su `MAX(tid)+1` y renumera la nuestra. Esta secuencia (subida a 900.000 en
   * `20260828220000_tid_seq_900k`) solo da un número de partida fuera de su alcance.
   */
  subInvoice: '"SubInvoice_tid_seq"',
  stockReturn: '"StockReturn_tid_seq"',
  supplyOrder: '"SupplyOrder_tid_seq"',
  /** Número de abonado. Ojo: la columna NO es única (ver la migración), pero al
   *  menos deja de fabricar duplicados nuevos por concurrencia. */
  subscriberAbonado: '"Subscriber_abonado_seq"',
  quote: '"Quote_tid_seq"',
  /** Consecutivo de asiento contable (`JournalEntry.number`, columna @unique). */
  journalEntry: '"JournalEntry_number_seq"',
  /**
   * Nº de ORDEN de servicio. Nació en un rango APARTE (desde 500.000) para no pisar el
   * contador del legacy, y ese rango dejó de estar aparte el día que empezamos a
   * empujarle órdenes: el legacy numera con `MAX(codigo)+1`, así que adoptó nuestro
   * máximo y siguió contando desde ahí (llegó a 504.170 con esta secuencia en 500.130).
   *
   * Mientras los técnicos trabajen en el legacy, el número LO REPARTE EL LEGACY: esta
   * secuencia da un número de partida y el writeback lo cambia si allá ya está cogido
   * (`pushTickets` renumera). Sirve para que la orden nazca con un número aunque el
   * legacy no responda, no como fuente de verdad de la numeración.
   * Ver 20260811150000_ticket_code_seq y [[ordenes-viajan-al-legacy]].
   */
  ticketCode: '"Ticket_code_seq"',
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
