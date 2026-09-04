/**
 * Borra UN pago de caja como si nunca se hubiera registrado — nexus y legacy a la vez.
 *
 *   npx ts-node -T scripts/borrar-pago.ts <idTransaccion|abonado> [--si]
 *
 * NO es la anulación de la aplicación. `voidTransaction` deja la transacción en
 * ANULADA con su `Voiding`, que es lo correcto cuando un recaudo real hay que
 * reversar: queda el rastro. Esto es otra cosa —la que hace falta cuando se cobra
 * para PROBAR algo y se quiere volver a dejar la factura como estaba para repetir—:
 * borra la fila, el recibo, el enlace y el asiento contable, devuelve la factura a
 * DUE y recalcula los saldos materializados del cliente y de la caja.
 *
 * El legacy va SIEMPRE en el mismo viaje. Si solo se borrara aquí, `legacy-sync-caja`
 * (cada 15 min) volvería a traer el pago desde `transactions` y el recibo reaparecería
 * quince minutos después: ver [[writeback-caja-legacy]].
 *
 * Sin `--si` solo enseña lo que borraría.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import mysql from 'mysql2/promise';
import { readFileSync } from 'node:fs';

// El .env a mano: este script se corre suelto, sin el arranque de la API.
for (const linea of readFileSync('.env', 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(linea.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const num = (x: Prisma.Decimal | number | null | undefined) => Number(x ?? 0);
const round2 = (x: number) => Math.round(x * 100) / 100;

const prisma = new PrismaClient();

async function main() {
  const [clave, ...flags] = process.argv.slice(2);
  const enSerio = flags.includes('--si');
  if (!clave) throw new Error('Falta el id de la transacción (o el número de abonado, para coger su último pago de hoy).');

  // Se admite el número de abonado para el caso corriente: "bórrame el pago que
  // acabo de hacerle a este cliente".
  const tx = /^\d+$/.test(clave)
    ? await prisma.transaction.findFirst({
        where: {
          subscriber: { abonado: Number(clave) }, type: 'INCOME', status: 'VIGENTE',
          category: 'Sales', receiptLinks: { some: {} },
        },
        orderBy: { createdAt: 'desc' },
        include: { invoice: true, receiptLinks: true, subscriber: { select: { id: true, abonado: true, fullName: true } } },
      })
    : await prisma.transaction.findUnique({
        where: { id: clave },
        include: { invoice: true, receiptLinks: true, subscriber: { select: { id: true, abonado: true, fullName: true } } },
      });
  if (!tx) throw new Error('No se encontró ningún pago con esa clave.');

  const recibos = [...new Set(tx.receiptLinks.map((l) => l.receiptId))];
  const recibosLegacy = await prisma.paymentReceipt.findMany({
    where: { id: { in: recibos } }, select: { id: true, legacyId: true, fileName: true },
  });
  const asiento = await prisma.journalEntry.findFirst({
    where: { sourceType: 'CUSTOMER_PAYMENT', sourceId: { in: recibos } },
    select: { id: true, number: true },
  });

  console.log('Pago:', {
    id: tx.id, legacyId: tx.legacyId, fecha: tx.date.toISOString().slice(0, 10),
    monto: num(tx.credit), metodo: tx.method, caja: tx.cashAccountId,
    cliente: tx.subscriber ? `${tx.subscriber.abonado} · ${tx.subscriber.fullName}` : null,
    factura: tx.invoice ? `#${tx.invoice.tid} (${tx.invoice.status}, pagado ${num(tx.invoice.paidAmount)} de ${num(tx.invoice.total)})` : null,
    recibos: recibosLegacy.map((r) => r.legacyId ?? r.fileName),
    asiento: asiento?.number ?? null,
  });
  if (!enSerio) { console.log('\n(simulación: añade --si para borrarlo de verdad)'); return; }

  // ---------- nexus ----------
  await prisma.$transaction(async (db) => {
    if (tx.subscriberId) await db.$queryRaw`SELECT id FROM "Subscriber" WHERE id = ${tx.subscriberId} FOR UPDATE`;

    if (asiento) {
      await db.journalLine.deleteMany({ where: { entryId: asiento.id } });
      await db.journalEntry.delete({ where: { id: asiento.id } });
    }
    await db.receiptTransaction.deleteMany({ where: { transactionId: tx.id } });
    for (const rid of recibos) {
      const quedan = await db.receiptTransaction.count({ where: { receiptId: rid } });
      if (quedan === 0) await db.paymentReceipt.delete({ where: { id: rid } });
    }
    await db.transaction.delete({ where: { id: tx.id } });

    // La factura vuelve a deber lo que este pago cubría.
    if (tx.invoiceId && tx.category === 'Sales' && tx.type === 'INCOME' && tx.invoice) {
      const pagado = Math.max(0, round2(num(tx.invoice.paidAmount) - num(tx.credit)));
      await db.subInvoice.update({
        where: { id: tx.invoiceId },
        data: { paidAmount: pagado, status: pagado <= 0 ? 'DUE' : 'PARTIAL' },
      });
    }

    // Saldos materializados, con la misma fórmula de CobranzasService.
    if (tx.subscriberId) {
      const agg = await db.transaction.aggregate({
        _sum: { debit: true, credit: true },
        where: { subscriberId: tx.subscriberId, status: 'VIGENTE', ext: false },
      });
      await db.subscriber.update({
        where: { id: tx.subscriberId },
        data: { debitCache: agg._sum.debit ?? 0, creditCache: agg._sum.credit ?? 0 },
      });
    }
    if (tx.cashAccountId != null) {
      const acc = await db.cashAccount.findFirst({ where: { legacyId: tx.cashAccountId }, select: { id: true } });
      if (acc) {
        const agg = await db.transaction.aggregate({
          _sum: { credit: true, debit: true },
          where: { cashAccountId: tx.cashAccountId, status: 'VIGENTE' },
        });
        await db.cashAccount.update({
          where: { id: acc.id },
          data: { balance: round2(num(agg._sum.credit) - num(agg._sum.debit)) },
        });
      }
    }
  });
  console.log('nexus: pago, recibo, enlace y asiento borrados; factura y saldos de vuelta.');

  // ---------- legacy ----------
  const my = await mysql.createConnection({
    host: process.env.LEGACY_DB_HOST, port: Number(process.env.LEGACY_DB_PORT ?? 3306),
    user: process.env.LEGACY_DB_USER, password: process.env.LEGACY_DB_PASSWORD, database: process.env.LEGACY_DB_NAME,
  });
  await my.beginTransaction();
  try {
    let borradas = 0, recibosBorrados = 0;
    for (const r of recibosLegacy) {
      if (r.legacyId == null) continue;
      await my.query('DELETE FROM transactions_ids_recibos_de_pago WHERE id_recibo_de_pago=?', [r.legacyId]);
      const [d]: any = await my.query('DELETE FROM recibos_de_pago WHERE id=?', [r.legacyId]);
      recibosBorrados += d.affectedRows;
    }
    if (tx.legacyId != null) {
      const [d]: any = await my.query('DELETE FROM transactions WHERE id=?', [tx.legacyId]);
      borradas = d.affectedRows;
    }
    // La factura del legacy queda como la dejó nexus (misma cuenta, mismo estado).
    let facturas = 0;
    if (tx.invoice) {
      const pagado = Math.max(0, round2(num(tx.invoice.paidAmount) - num(tx.credit)));
      const [d]: any = await my.query('UPDATE invoices SET status=?, pamnt=? WHERE tid=?', [
        pagado <= 0 ? 'due' : 'partial', pagado, tx.invoice.tid,
      ]);
      facturas = d.affectedRows;
    }
    await my.commit();
    console.log(`legacy: transacción ${borradas} · recibo ${recibosBorrados} · factura ${facturas}`);
  } catch (e) {
    await my.rollback();
    throw e;
  } finally {
    await my.end();
  }
}

main()
  .catch((e) => { console.error('FALLÓ:', e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
