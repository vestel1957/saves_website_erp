/**
 * Trae las `transactions` que el legacy TIENE y aquí FALTAN, y vuelve a colgarles su recibo.
 *
 * POR QUÉ: la ida (`sync-legacy-vivo`) importa movimientos por MARCA DE AGUA
 * (`WHERE id > st.tx`) y `createMany` los mete con `skipDuplicates`. Si una fila no entra
 * en su pasada —porque en ese instante el `legacyId` ya estaba ocupado por la vuelta, o
 * porque alguien la borró aquí después— la marca ya pasó por encima y **no se vuelve a
 * mirar jamás**: el hueco es permanente. `refrescarTransacciones` tampoco lo tapa, porque
 * sólo ACTUALIZA las que ya están (ver [[editar-monto-movimiento-legacy]]).
 *
 * Es el complemento de `alinear-caja-con-legacy.js`, que hace lo contrario (sobra aquí →
 * se borra) y de lo que falta sólo deja el conteo: crear filas no es cosa suya.
 *
 * QUÉ HACE (el legacy manda):
 *   · fila del legacy sin pareja aquí → la CREA con el mismo mapeo de la ida (`mapTx`)
 *   · su anulación, si la tiene       → `Voiding` + estado ANULADA
 *   · su recibo (`transactions_ids_recibos_de_pago`) → vuelve a enlazar `ReceiptTransaction`
 *   · recalcula `CashAccount.balance` de las cajas tocadas
 *
 * NO toca facturas: `pamnt`/`status` los copia del legacy la propia ida en su refresco.
 *
 * Uso:  node scripts/traer-tx-faltantes-legacy.js --desde=2026-09-19 [--hasta=] [--caja=1] [--aplicar]
 * Sin `--aplicar` va en SECO. Imprime un JSON de resumen en la última línea.
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

try {
  const envFile = path.join(__dirname, '..', '.env');
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
} catch {}

const { PrismaClient } = require('@prisma/client');
const { mapTx, esPagoDeCompra } = require('./lib/vestel-map');

const dbUrl = (u => u ? u + (u.includes('?') ? '&' : '?') + 'connection_limit=5' : u)(process.env.DATABASE_URL);
const prisma = new PrismaClient(dbUrl ? { datasources: { db: { url: dbUrl } } } : undefined);

const MYSQL = {
  host: process.env.LEGACY_DB_HOST || '127.0.0.1',
  port: Number(process.env.LEGACY_DB_PORT || 3306),
  user: process.env.LEGACY_DB_USER,
  password: process.env.LEGACY_DB_PASSWORD,
  database: process.env.LEGACY_DB_NAME || 'admin_vestel',
  dateStrings: true, supportBigNumbers: true, bigNumberStrings: false,
};

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split('=')[1] : d;
};
const DESDE = arg('desde');
const HASTA = arg('hasta', DESDE);
const CAJA = Number(arg('caja', 0)) || null;
const APLICAR = process.argv.includes('--aplicar');
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const cop = (n) => new Intl.NumberFormat('es-CO').format(Math.round(n));

async function main() {
  if (!DESDE) throw new Error('Falta --desde=YYYY-MM-DD');
  if (!MYSQL.user || !MYSQL.password) throw new Error('Faltan LEGACY_DB_USER / LEGACY_DB_PASSWORD');
  const t0 = Date.now();
  const my = await mysql.createConnection(MYSQL);
  log(`${DESDE}..${HASTA}${CAJA ? ` · caja ${CAJA}` : ' · todas las cajas'} · ${APLICAR ? 'APLICANDO' : 'SECO (plan)'}`);

  const [filas] = await my.query(
    `SELECT * FROM transactions WHERE date BETWEEN ? AND ?${CAJA ? ' AND acid = ?' : ''} ORDER BY id`,
    CAJA ? [DESDE, HASTA, CAJA] : [DESDE, HASTA],
  );
  const aqui = await prisma.transaction.findMany({
    where: { legacyId: { in: filas.map((r) => r.id) } }, select: { legacyId: true },
  });
  const ya = new Set(aqui.map((t) => t.legacyId));
  const faltan = filas.filter((r) => !ya.has(r.id));
  log(`legacy ${filas.length} · aquí ${ya.size} · faltan ${faltan.length}`);

  // Enlaces que necesita `mapTx`, resueltos igual que en `syncTransactions`.
  const payerIds = [...new Set(faltan.map((r) => r.payerid).filter(Boolean))];
  const subs = payerIds.length
    ? await prisma.subscriber.findMany({ where: { legacyId: { in: payerIds } }, select: { id: true, legacyId: true } }) : [];
  const subMap = new Map(subs.map((r) => [r.legacyId, r.id]));
  const tidsFactura = [...new Set(faltan.filter((r) => !esPagoDeCompra(r)).map((r) => r.tid).filter(Boolean))];
  const tidsOrden = [...new Set(faltan.filter(esPagoDeCompra).map((r) => r.tid).filter(Boolean))];
  const invRows = tidsFactura.length
    ? await prisma.subInvoice.findMany({ where: { tid: { in: tidsFactura } }, select: { id: true, tid: true } }) : [];
  const invByTid = new Map(invRows.map((r) => [r.tid, r.id]));
  const ordRows = tidsOrden.length
    ? await prisma.supplyOrder.findMany({ where: { tid: { in: tidsOrden } }, select: { id: true, tid: true } }) : [];
  const ordByTid = new Map(ordRows.map((r) => [r.tid, r.id]));

  const data = faltan.map((r) => {
    const compra = esPagoDeCompra(r);
    return mapTx(r, subMap.get(r.payerid), compra ? null : invByTid.get(r.tid), compra ? ordByTid.get(r.tid) : null);
  });
  const monto = data.reduce((a, d) => a + Number(d.credit) - Number(d.debit), 0);
  const sinAbonado = data.filter((d) => !d.subscriberId).length;
  const sinFactura = faltan.filter((r) => !esPagoDeCompra(r) && r.tid && !invByTid.has(r.tid)).length;

  // Anulaciones y recibos de las que faltan.
  const ids = faltan.map((r) => r.id);
  const [anul] = ids.length
    ? await my.query('SELECT * FROM anulaciones WHERE transactions_id IN (?)', [ids]) : [[]];
  const [links] = ids.length
    ? await my.query('SELECT * FROM transactions_ids_recibos_de_pago WHERE id_transaccion IN (?)', [ids]) : [[]];

  const resumen = {
    ok: true, mode: 'traer-tx-faltantes', desde: DESDE, hasta: HASTA, caja: CAJA, aplicado: APLICAR,
    enLegacy: filas.length, yaAqui: ya.size, faltan: faltan.length, monto,
    sinAbonadoAqui: sinAbonado, sinFacturaAqui: sinFactura,
    anulaciones: anul.length, enlacesRecibo: links.length,
  };
  log(`a crear ${faltan.length} (${cop(monto)}) · sin abonado ${sinAbonado} · sin factura ${sinFactura}`
    + ` · anulaciones ${anul.length} · enlaces de recibo ${links.length}`);

  if (!APLICAR) {
    console.log(JSON.stringify({ ...resumen, plan: faltan.map((r) => ({
      legacyId: r.id, acid: r.acid, date: r.date, tid: r.tid, credit: r.credit, debit: r.debit, note: r.note,
    })), ms: Date.now() - t0 }));
    await my.end(); await prisma.$disconnect();
    return;
  }

  let creadas = 0;
  for (const d of data) {
    // Una a una y tolerando la ya existente: si otra pasada la creó mientras esto corría,
    // no puede tumbar el resto del lote.
    try { await prisma.transaction.create({ data: d }); creadas++; }
    catch (e) { log(`⚠️ #${d.legacyId} no entró: ${e.code ?? e.message}`); }
  }

  // Anulación: el estado y su rastro (el legacy admite varias por movimiento y aquí
  // `Voiding.transactionId` es único, así que sólo cabe la primera).
  const txRows = await prisma.transaction.findMany({
    where: { legacyId: { in: ids } }, select: { id: true, legacyId: true },
  });
  const txMap = new Map(txRows.map((r) => [r.legacyId, r.id]));
  let anuladas = 0;
  for (const a of anul) {
    const tid = txMap.get(a.transactions_id);
    if (!tid) continue;
    await prisma.transaction.update({ where: { id: tid }, data: { status: 'ANULADA' } });
    await prisma.voiding.create({ data: {
      legacyId: a.id_anulacion, dateTime: new Date(a.fecha_hora), detail: a.detalle ?? null,
      reason: a.razon_anulacion ?? null, voidedBy: a.usuario_anula ?? null, transactionId: tid,
    } }).catch(() => {});
    anuladas++;
  }

  // Recibo ↔ movimiento. El recibo casi siempre está aquí (nació aquí o lo trajo la ida);
  // el que no esté se reporta, porque crearlo es trabajo de `syncRecibos`.
  const rcRows = await prisma.paymentReceipt.findMany({
    where: { legacyId: { in: [...new Set(links.map((l) => l.id_recibo_de_pago))] } },
    select: { id: true, legacyId: true },
  });
  const rcMap = new Map(rcRows.map((r) => [r.legacyId, r.id]));
  const bridge = links
    .map((l) => ({ receiptId: rcMap.get(l.id_recibo_de_pago), transactionId: txMap.get(l.id_transaccion) }))
    .filter((b) => b.receiptId && b.transactionId);
  const enlazados = bridge.length
    ? (await prisma.receiptTransaction.createMany({ data: bridge, skipDuplicates: true })).count : 0;

  // `CashAccount.balance` es SUM(credit-debit) de las VIGENTES: si no se recalcula aquí,
  // sólo se corrige con el siguiente movimiento de esa caja.
  const cajas = [...new Set(faltan.map((r) => r.acid).filter((x) => x != null))];
  for (const c of cajas) {
    const agg = await prisma.transaction.aggregate({
      _sum: { credit: true, debit: true }, where: { cashAccountId: c, status: 'VIGENTE' },
    });
    await prisma.cashAccount.updateMany({ where: { legacyId: c },
      data: { balance: Number(agg._sum.credit ?? 0) - Number(agg._sum.debit ?? 0) } });
  }
  log(`creadas ${creadas} · anuladas ${anuladas} · enlaces ${enlazados} · saldo recalculado en ${cajas.length} caja(s)`);

  console.log(JSON.stringify({ ...resumen, creadas, anuladas, enlazados,
    recibosQueFaltanAqui: links.length - bridge.length, cajasRecalculadas: cajas, ms: Date.now() - t0 }));
  await my.end(); await prisma.$disconnect();
}

main().catch(async (e) => {
  console.log(JSON.stringify({ ok: false, mode: 'traer-tx-faltantes', error: e.message }));
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
