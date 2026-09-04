/**
 * Deshace la edición del 2026-08-31 15:52 sobre la factura 472167 (abonado 50201)
 * y la deja como estaba: 73.000, con sus dos renglones de siempre.
 *
 * La edición no se quedó de este lado: el writeback de ediciones está EN VIVO
 * (LEGACY_WRITEBACK_EDICIONES_LIVE=true), así que borró los renglones del legacy y
 * los reinsertó con el nuevo importe. Por eso hay que reponer LOS DOS lados; si se
 * repusiera sólo nexus y se limpiara `editedAt`, la ida de los 15 minutos volvería
 * a traer los 77.000 del legacy.
 *
 * El "como estaba" no se reconstruye a ojo: sale del respaldo de las 03:31 de hoy
 * (nexus_20260831_033131.dump) y coincide con el `before` del AuditLog de la edición.
 *
 * Uso:  node scripts/restaurar-factura-472167.js [--aplicar]
 * Sin --aplicar sólo dice lo que haría.
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// .env del backend (igual que sync-legacy-vivo.js: esto cubre la corrida por consola)
try {
  const envFile = path.join(__dirname, '..', '.env');
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
} catch {}

const { PrismaClient } = require('@prisma/client');

const APLICAR = process.argv.includes('--aplicar');
const prisma = new PrismaClient();

const PG_ID = 'cmsdba7s60078dzjwdoz5tcgu';
const LEGACY_ID = 467831;
const TID = 472167;

// Encabezado tal como estaba (respaldo 2026-08-31 03:31 + AuditLog.before).
const CAB = { subtotal: 69008, tax: 3992, total: 73000, itemsCount: 1, notes: '.', status: 'PAID' };

// Los dos renglones originales, con su id de este lado y su id del legacy: los
// 2616144/2616145 quedaron libres al borrarlos la edición, así que se reponen tal
// cual y la correspondencia entre los dos sistemas vuelve a ser la de antes.
const ITEMS = [
  { id: 'cmsdbabe802xidzjwzyjg729x', legacyId: 2616144, productId: 5491, productName: 'Television24',
    qty: 1, price: 21008, taxRate: 19, subtotal: 25000, taxTotal: 3992, createdAt: '2026-08-29T03:15:24.264Z' },
  { id: 'cmsdbabe802xfdzjw1a3vhmc8', legacyId: 2616145, productId: 2649, productName: '10MegasF',
    qty: 1, price: 48000, taxRate: 0, subtotal: 48000, taxTotal: 0, createdAt: '2026-08-29T03:15:24.265Z' },
];

const MYSQL = {
  host: process.env.LEGACY_DB_HOST || '127.0.0.1',
  port: Number(process.env.LEGACY_DB_PORT || 3306),
  user: process.env.LEGACY_DB_USER,
  password: process.env.LEGACY_DB_PASSWORD,
  database: process.env.LEGACY_DB_NAME || 'admin_vestel',
};

(async () => {
  const my = await mysql.createConnection(MYSQL);

  // ── 1. Respaldo de lo que hay AHORA en los dos lados ─────────────────────────
  const antesPg = await prisma.subInvoice.findUnique({ where: { id: PG_ID }, include: { items: true } });
  const [antesMyInv] = await my.query('SELECT * FROM invoices WHERE id = ?', [LEGACY_ID]);
  const [antesMyItems] = await my.query('SELECT * FROM invoice_items WHERE tid = ?', [TID]);
  if (!antesPg) throw new Error('La factura no existe en nexus');

  const destino = path.join(__dirname, '..', 'backups',
    `factura-472167-antes-de-restaurar-${new Date().toISOString().slice(0, 19).replace(/[-:]/g, '')}.json`);
  fs.writeFileSync(destino, JSON.stringify({ nexus: antesPg, legacy: { invoice: antesMyInv[0], items: antesMyItems } }, null, 2));
  console.log(`respaldo → ${destino}`);
  console.log(`ahora    → nexus total=${antesPg.total} status=${antesPg.status} items=${antesPg.items.length}`
    + ` · legacy total=${antesMyInv[0]?.total} items=${antesMyItems.length}`);
  console.log(`queda    → total=${CAB.total} (subtotal ${CAB.subtotal} + IVA ${CAB.tax}) status=${CAB.status}, `
    + ITEMS.map((i) => `${i.productName} ${i.price}`).join(' + '));

  if (!APLICAR) { console.log('\n(seco: no se escribió nada; repetir con --aplicar)'); await my.end(); await prisma.$disconnect(); return; }

  // ── 2. Legacy (MySQL) ────────────────────────────────────────────────────────
  await my.beginTransaction();
  try {
    await my.execute(
      'UPDATE invoices SET subtotal=?, tax=?, total=?, items=?, notes=? WHERE id=?',
      [CAB.subtotal, CAB.tax, CAB.total, CAB.itemsCount, CAB.notes, LEGACY_ID],
    );
    await my.execute('DELETE FROM invoice_items WHERE tid=?', [TID]);
    for (const it of ITEMS) {
      await my.execute(
        'INSERT INTO invoice_items (id,tid,pid,product,qty,price,tax,discount,subtotal,totaltax,totaldiscount,'
        + 'product_des,tax_removed,id_usuario_crea,fecha_creacion,tipo_retencion) '
        + 'VALUES (?,?,?,?,?,?,?,0,?,?,0,NULL,NULL,NULL,NULL,NULL)',
        [it.legacyId, TID, it.productId, it.productName, it.qty, it.price, it.taxRate, it.subtotal, it.taxTotal],
      );
    }
    await my.commit();
    console.log('legacy: encabezado y renglones repuestos');
  } catch (e) { await my.rollback(); throw e; }

  // ── 3. Nexus (Postgres) ──────────────────────────────────────────────────────
  await prisma.$transaction(async (tx) => {
    await tx.subInvoiceItem.deleteMany({ where: { invoiceId: PG_ID } });
    await tx.subInvoiceItem.createMany({
      data: ITEMS.map((it) => ({
        id: it.id, legacyId: it.legacyId, invoiceId: PG_ID, productId: it.productId,
        productName: it.productName, description: null, qty: it.qty,
        price: it.price, taxRate: it.taxRate, discount: 0,
        subtotal: it.subtotal, taxTotal: it.taxTotal, discountTotal: 0,
        createdAt: new Date(it.createdAt),
      })),
    });
    await tx.subInvoice.update({
      where: { id: PG_ID },
      data: {
        subtotal: CAB.subtotal, tax: CAB.tax, total: CAB.total, status: CAB.status,
        itemsCount: CAB.itemsCount, notes: CAB.notes,
        // Se limpia el blindaje: ya no hay edición que proteger, y dejarlo puesto
        // congelaría la factura frente al legacy y haría que el writeback la
        // reescribiera allá en cada pasada.
        editedAt: null, editedBy: null, editCount: 0,
      },
    });
    // La reversión queda registrada; el AuditLog de la edición original se conserva.
    await tx.auditLog.create({
      data: {
        action: 'UPDATE', entity: 'SubInvoice', entityId: PG_ID,
        before: {
          subtotal: Number(antesPg.subtotal), tax: Number(antesPg.tax), total: Number(antesPg.total),
          status: antesPg.status, notes: antesPg.notes,
          items: antesPg.items.map((i) => ({ product: i.productName, qty: i.qty, price: Number(i.price), taxRate: Number(i.taxRate), subtotal: Number(i.subtotal) })),
        },
        after: {
          subtotal: CAB.subtotal, tax: CAB.tax, total: CAB.total, status: CAB.status, notes: CAB.notes,
          items: ITEMS.map((i) => ({ product: i.productName, qty: i.qty, price: i.price, taxRate: i.taxRate, subtotal: i.subtotal })),
          reason: 'Reversión de la edición del 2026-08-31 15:52: la factura vuelve a los 73.000 de siempre (respaldo 03:31 + AuditLog.before). Repuesto también en el legacy.',
          by: 'Restauración manual',
        },
      },
    });
  });
  console.log('nexus: encabezado, renglones y blindaje de edición repuestos');

  // ── 4. Comprobación ──────────────────────────────────────────────────────────
  const fin = await prisma.subInvoice.findUnique({ where: { id: PG_ID }, include: { items: true } });
  const [finMy] = await my.query('SELECT subtotal,tax,total,pamnt,status,items FROM invoices WHERE id=?', [LEGACY_ID]);
  const [finMyIt] = await my.query('SELECT id,product,price,tax,subtotal FROM invoice_items WHERE tid=? ORDER BY id', [TID]);
  console.log('\nnexus  →', JSON.stringify({ subtotal: fin.subtotal, tax: fin.tax, total: fin.total, paid: fin.paidAmount, status: fin.status, editedAt: fin.editedAt, items: fin.items.map((i) => `${i.productName}/${i.price}`) }));
  console.log('legacy →', JSON.stringify(finMy[0]), finMyIt.map((i) => `${i.id}:${i.product}/${i.price}`).join(' + '));

  await my.end();
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect().catch(() => {}); process.exit(1); });
