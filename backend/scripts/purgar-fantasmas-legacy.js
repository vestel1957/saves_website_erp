/**
 * Purga de FANTASMAS: filas que vinieron del legacy y que el legacy ya no tiene.
 *
 * POR QUÉ EXISTE (2026-08-26, a pedido expreso):
 * La ida (`sync-legacy-vivo.js`) nunca borra. Cuando el legacy elimina una fila, aquí
 * se queda viva para siempre —salvo las facturas, que `syncBorradas` marca CANCELED
 * sin borrarlas—. Eso deja dos libros que no cuadran en los CONTEOS aunque cuadren en
 * la plata, y en la caja de Villanueva se vio al revés: nexus mostraba 2,3 M más que
 * el legacy porque allá habían borrado 33 pagos que aquí seguían contados.
 *
 * Este script deja las dos bases IGUALES: lo que no está allá, no queda aquí.
 *
 * OJO CON LO QUE **NO** TOCA:
 *   · Filas propias de nexus (`legacyId = null`). El legacy nunca las tuvo porque
 *     nacieron aquí; borrarlas sería tirar trabajo, no sincronizar.
 *   · La tabla `anulaciones`: allá caben varias por transacción y aquí sólo una
 *     (`Voiding.transactionId @unique`). No hay nada que borrar, falta sitio.
 *
 * ORDEN DE BORRADO (importa: hay FKs sin cascada):
 *   1. Soltar los vínculos de filas VIVAS que apuntan a una factura fantasma.
 *   2. Voiding  → no tiene cascada desde Transaction.
 *   3. Transaction (ReceiptTransaction cae por cascada).
 *   4. PaymentReceipt (idem).
 *   5. SubInvoice (SubInvoiceItem cae por cascada).
 *   6. Ticket (TicketMaterial cae por cascada) y TicketThread.
 *
 * Uso:  node scripts/purgar-fantasmas-legacy.js [--dry]
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
const dbUrl = (u => u ? u + (u.includes('?') ? '&' : '?') + 'connection_limit=5' : u)(process.env.DATABASE_URL);
const prisma = new PrismaClient(dbUrl ? { datasources: { db: { url: dbUrl } } } : undefined);
const DRY = process.argv.includes('--dry');
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const N = (n) => Number(n).toLocaleString('es-CO');

/** Los legacyId que SIGUEN vivos allá, preguntando por lotes (IN gigante = paquete roto). */
async function vivos(my, tabla, col, ids) {
  const s = new Set();
  for (let i = 0; i < ids.length; i += 10000) {
    const [r] = await my.query(`SELECT ${col} AS k FROM ${tabla} WHERE ${col} IN (?)`, [ids.slice(i, i + 10000)]);
    r.forEach((x) => s.add(Number(x.k)));
  }
  return s;
}

/** deleteMany por lotes: 2.878 ids en un solo `IN` es una consulta de 100 KB. */
async function borrarPorId(modelo, ids, campo = 'id') {
  let n = 0;
  for (let i = 0; i < ids.length; i += 1000) {
    const { count } = await prisma[modelo].deleteMany({ where: { [campo]: { in: ids.slice(i, i + 1000) } } });
    n += count;
  }
  return n;
}

(async () => {
  const my = await mysql.createConnection({
    host: process.env.LEGACY_DB_HOST || '127.0.0.1', port: Number(process.env.LEGACY_DB_PORT || 3306),
    user: process.env.LEGACY_DB_USER, password: process.env.LEGACY_DB_PASSWORD,
    database: process.env.LEGACY_DB_NAME || 'admin_vestel', dateStrings: true,
  });
  const sum = { dry: DRY };

  // ---- 1. Quiénes son los fantasmas ----
  const inv = await prisma.subInvoice.findMany({ where: { legacyId: { not: null } }, select: { id: true, legacyId: true, status: true, total: true } });
  const invVivas = await vivos(my, 'invoices', 'id', inv.map((r) => r.legacyId));
  const invF = inv.filter((r) => !invVivas.has(r.legacyId));
  const invIds = invF.map((r) => r.id);

  const tx = await prisma.transaction.findMany({ where: { legacyId: { not: null } }, select: { id: true, legacyId: true, credit: true, debit: true, method: true, type: true, status: true, noShow: true } });
  const txVivas = await vivos(my, 'transactions', 'id', tx.map((r) => r.legacyId));
  const txF = tx.filter((r) => !txVivas.has(r.legacyId));
  const txIds = txF.map((r) => r.id);
  const esEfectivo = (r) => ['Cash', 'cash'].includes(r.method || '') || String(r.type).toLowerCase() === 'transfer';
  const plata = txF.filter((r) => r.status !== 'ANULADA' && !r.noShow && esEfectivo(r))
    .reduce((a, r) => a + Math.trunc(Number(r.credit) - Number(r.debit)), 0);

  const rc = await prisma.paymentReceipt.findMany({ where: { legacyId: { not: null } }, select: { id: true, legacyId: true } });
  const rcVivos = await vivos(my, 'recibos_de_pago', 'id', rc.map((r) => r.legacyId));
  const rcIds = rc.filter((r) => !rcVivos.has(r.legacyId)).map((r) => r.id);

  const tk = await prisma.ticket.findMany({ where: { legacyId: { not: null } }, select: { id: true, legacyId: true } });
  const tkVivos = await vivos(my, 'tickets', 'idt', tk.map((r) => r.legacyId));
  const tkIds = tk.filter((r) => !tkVivos.has(r.legacyId)).map((r) => r.id);

  const th = await prisma.ticketThread.findMany({ where: { legacyId: { not: null } }, select: { id: true, legacyId: true } });
  const thVivos = await vivos(my, 'tickets_th', 'id', th.map((r) => r.legacyId));
  const thIds = th.filter((r) => !thVivos.has(r.legacyId)).map((r) => r.id);

  sum.fantasmas = {
    facturas: invF.length, montoFacturas: invF.reduce((a, r) => a + Number(r.total), 0),
    facturasVivasEnPg: invF.filter((r) => r.status !== 'CANCELED').length,
    pagos: txF.length, plataDePagos: plata, recibos: rcIds.length, ordenes: tkIds.length, hilosDeOrden: thIds.length,
  };
  log(`facturas ${invF.length} (${N(sum.fantasmas.montoFacturas)} COP) · pagos ${txF.length} (${N(plata)} COP) · recibos ${rcIds.length} · órdenes ${tkIds.length} · hilos ${thIds.length}`);

  // Guarda: una factura fantasma que aquí siguiera VIGENTE sería un caso nuevo (hoy son 0,
  // todas pasaron por `syncBorradas`). Antes de borrar plata viva, que lo mire una persona.
  if (sum.fantasmas.facturasVivasEnPg > 0) {
    sum.abortado = `${sum.fantasmas.facturasVivasEnPg} facturas fantasma siguen VIGENTES aquí: revisar a mano antes de borrar`;
    log('⛔', sum.abortado);
    console.log(JSON.stringify(sum));
    await my.end(); await prisma.$disconnect(); return;
  }

  // ---- 2. Soltar vínculos de filas VIVAS que apuntan a una factura fantasma ----
  // No se pueden borrar (el legacy las tiene), pero no pueden quedar apuntando al vacío.
  const sueltas = {};
  if (!DRY && invIds.length) {
    for (const [modelo, campo] of [['transaction', 'invoiceId'], ['paymentReceipt', 'invoiceId'], ['additionalService', 'invoiceId'], ['electronicInvoice', 'invoiceId']]) {
      let n = 0;
      for (let i = 0; i < invIds.length; i += 1000) {
        // Las que además son fantasma se borran luego; soltarles el vínculo antes es inocuo.
        const { count } = await prisma[modelo].updateMany({
          where: { [campo]: { in: invIds.slice(i, i + 1000) } },
          data: { [campo]: null },
        });
        n += count;
      }
      if (n) sueltas[modelo] = n;
    }
    // PromotionApplication.invoiceId es texto suelto (sin FK): se borra la aplicación.
    let promos = 0;
    for (let i = 0; i < invIds.length; i += 1000) {
      const { count } = await prisma.promotionApplication.deleteMany({ where: { invoiceId: { in: invIds.slice(i, i + 1000) } } });
      promos += count;
    }
    if (promos) sueltas.promotionApplication = promos;
    // Referencias blandas a los pagos que se van (columnas String sin FK).
    for (const modelo of ['paymentImportRow', 'paymentOrder', 'scheduledPaymentRun']) {
      let n = 0;
      for (let i = 0; i < txIds.length; i += 1000) {
        const { count } = await prisma[modelo].updateMany({ where: { transactionId: { in: txIds.slice(i, i + 1000) } }, data: { transactionId: null } });
        n += count;
      }
      if (n) sueltas[modelo] = n;
    }
  }
  sum.vinculosSueltos = sueltas;

  if (DRY) {
    log('DRY: no se borró nada');
    console.log(JSON.stringify(sum));
    await my.end(); await prisma.$disconnect(); return;
  }

  // ---- 3..6. Borrado, en orden de dependencias ----
  sum.borrado = {};
  sum.borrado.anulaciones = await borrarPorId('voiding', txIds, 'transactionId');
  sum.borrado.pagos = await borrarPorId('transaction', txIds);
  sum.borrado.recibos = await borrarPorId('paymentReceipt', rcIds);
  sum.borrado.renglones = await borrarPorId('subInvoiceItem', invIds, 'invoiceId');
  sum.borrado.facturas = await borrarPorId('subInvoice', invIds);
  sum.borrado.ordenes = await borrarPorId('ticket', tkIds);
  sum.borrado.hilosDeOrden = await borrarPorId('ticketThread', thIds);
  log('borrado:', JSON.stringify(sum.borrado));

  console.log(JSON.stringify(sum));
  await my.end();
  await prisma.$disconnect();
})();
