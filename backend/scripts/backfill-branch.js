const mysql = require('mysql2/promise');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const my = await mysql.createConnection({ host:'127.0.0.1', user:'admin_vestel', password:'Vestel_2025!', database:'vestel_dev' });
  const branchByLegacy = new Map();
  for (const b of await prisma.branch.findMany({ select:{ id:true, legacyId:true } })) branchByLegacy.set(b.legacyId, b.id);
  const [rows] = await my.query('SELECT id, gid FROM customers');
  // agrupa customers por gid -> actualiza en bloque por branch
  const byGid = new Map();
  for (const r of rows) { if (!byGid.has(r.gid)) byGid.set(r.gid, []); byGid.get(r.gid).push(r.id); }
  let updated = 0;
  for (const [gid, ids] of byGid) {
    const bid = branchByLegacy.get(gid);
    if (!bid) continue;
    // updateMany por lotes de legacyId
    for (let i=0;i<ids.length;i+=5000) {
      const chunk = ids.slice(i, i+5000);
      const r = await prisma.subscriber.updateMany({ where:{ legacyId:{ in: chunk } }, data:{ branchId: bid } });
      updated += r.count;
    }
  }
  console.log('subscribers con sede asignada:', updated);
  await my.end(); await prisma.$disconnect();
})().catch(e=>{console.error(e);process.exit(1);});
