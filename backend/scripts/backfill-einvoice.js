const mysql = require('mysql2/promise');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const my = await mysql.createConnection({ host:'127.0.0.1', user:'admin_vestel', password:'Vestel_2025!', database:'vestel_dev' });
  // pares (fe.id -> invoices.id) donde invoice_id es un id de factura real
  const [rows] = await my.query(`SELECT f.id AS feId, CAST(f.invoice_id AS UNSIGNED) AS invId
    FROM facturacion_electronica_siigo f JOIN invoices i ON i.id = f.invoice_id
    WHERE f.invoice_id REGEXP '^[0-9]+$'`);
  // mapa invoices.id (legacyId) -> SubInvoice.id
  const inv = new Map();
  for (const r of await prisma.subInvoice.findMany({ select:{ id:true, legacyId:true } })) inv.set(r.legacyId, r.id);
  let ok=0, miss=0;
  for (const r of rows) {
    const sid = inv.get(r.invId);
    if (!sid) { miss++; continue; }
    await prisma.electronicInvoice.updateMany({ where:{ legacyId:r.feId }, data:{ invoiceId: sid } });
    ok++;
  }
  console.log('backfill e-factura->factura:', ok, 'enlazadas,', miss, 'sin match');
  await my.end(); await prisma.$disconnect();
})().catch(e=>{console.error(e);process.exit(1);});
