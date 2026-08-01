/**
 * Borra de Postgres los renglones de factura que ya NO existen en el legacy.
 *
 * El legacy, cuando alguien edita una factura, BORRA sus renglones y los vuelve a
 * insertar con ids nuevos. `sync-legacy-vivo` solo inserta y actualiza por legacyId:
 * nunca borra. Resultado: en el sistema nuevo la factura queda con los renglones
 * viejos MÁS los nuevos, el detalle sale duplicado y no da el total. El cliente ve
 * una factura que no se explica.
 *
 * Este script compara renglón a renglón contra el legacy y borra los que allá ya no
 * están. Nunca toca renglones creados aquí (`legacyId` nulo).
 *
 * Uso:  node scripts/limpiar-renglones-huerfanos.js [--aplicar]
 */
const fs = require('fs'), path = require('path');
for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}
const mysql = require('mysql2/promise');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const APLICAR = process.argv.includes('--aplicar');
const cop = (n) => new Intl.NumberFormat('es-CO').format(Math.round(n));

(async () => {
  const my = await mysql.createConnection({
    host: process.env.LEGACY_DB_HOST, port: Number(process.env.LEGACY_DB_PORT || 3306),
    user: process.env.LEGACY_DB_USER, password: process.env.LEGACY_DB_PASSWORD,
    database: process.env.LEGACY_DB_NAME, dateStrings: true,
  });

  // Sospechosas: el detalle suma MÁS que el total (síntoma del renglón repetido).
  const sospechosas = await prisma.$queryRawUnsafe(`
    WITH s AS (SELECT "invoiceId", sum(subtotal) suma FROM "SubInvoiceItem" GROUP BY "invoiceId")
    SELECT i.id, i.tid, i.status::text, i.total::float8 AS total, s.suma::float8 AS suma
    FROM "SubInvoice" i JOIN s ON s."invoiceId" = i.id
    WHERE i."legacyId" IS NOT NULL AND s.suma > i.total
      AND i.total <> s.suma - i.discount + i.shipping
    ORDER BY i.tid`);
  console.log(`facturas sospechosas: ${sospechosas.length}`);

  const porTid = new Map(sospechosas.map((r) => [Number(r.tid), r]));
  const tids = [...porTid.keys()];

  // Renglones que el legacy tiene HOY para esas facturas.
  const vivos = new Map(); // tid -> Set(idLegacy)
  for (let i = 0; i < tids.length; i += 500) {
    const chunk = tids.slice(i, i + 500);
    const [rows] = await my.query(
      `SELECT id, tid FROM invoice_items WHERE tid IN (${chunk.map(() => '?').join(',')})`, chunk);
    for (const r of rows) {
      if (!vivos.has(r.tid)) vivos.set(r.tid, new Set());
      vivos.get(r.tid).add(r.id);
    }
  }

  // Renglones que Postgres tiene para esas facturas.
  const pgItems = await prisma.subInvoiceItem.findMany({
    where: { invoiceId: { in: sospechosas.map((s) => s.id) }, legacyId: { not: null } },
    select: { id: true, legacyId: true, invoiceId: true, subtotal: true },
  });

  const huerfanos = [];
  for (const it of pgItems) {
    const inv = sospechosas.find((s) => s.id === it.invoiceId);
    const set = vivos.get(Number(inv.tid));
    // Si el legacy no devolvió NADA para esa factura, no se asume que se borró todo:
    // podría ser una factura que allá ya no existe y eso es otro problema, no este.
    if (!set || set.size === 0) continue;
    if (!set.has(it.legacyId)) huerfanos.push(it);
  }

  const facturasTocadas = new Set(huerfanos.map((h) => h.invoiceId));
  const plata = huerfanos.reduce((a, h) => a + Number(h.subtotal), 0);
  console.log(`renglones huérfanos: ${huerfanos.length} en ${facturasTocadas.size} facturas · ${cop(plata)} de detalle fantasma`);

  if (!APLICAR) { console.log('(seco: no se borró nada — use --aplicar)'); await my.end(); await prisma.$disconnect(); return; }

  // Respaldo completo de lo que se va a borrar, por si hay que devolverlo.
  const respaldo = await prisma.subInvoiceItem.findMany({ where: { id: { in: huerfanos.map((h) => h.id) } } });
  const destino = process.env.RESPALDO_HUERFANOS || path.join(__dirname, '..', 'renglones-huerfanos-respaldo.json');
  fs.writeFileSync(destino, JSON.stringify(respaldo, (k, v) => (typeof v === 'bigint' ? String(v) : v), 1));
  console.log(`respaldo de ${respaldo.length} renglones en ${destino}`);

  let borrados = 0;
  for (let i = 0; i < huerfanos.length; i += 500) {
    const r = await prisma.subInvoiceItem.deleteMany({ where: { id: { in: huerfanos.slice(i, i + 500).map((h) => h.id) } } });
    borrados += r.count;
  }
  // `itemsCount` queda contando renglones que ya no están.
  for (const invId of facturasTocadas) {
    const n = await prisma.subInvoiceItem.count({ where: { invoiceId: invId } });
    await prisma.subInvoice.update({ where: { id: invId }, data: { itemsCount: n } });
  }
  console.log(`borrados: ${borrados} · itemsCount recalculado en ${facturasTocadas.size} facturas`);
  await my.end(); await prisma.$disconnect();
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
