// ETL de los módulos nicho: PlayHub, mensajería interna, gestor documental.
// Idempotente por legacyId. Uso: node scripts/etl-extras.js
const mysql = require('mysql2/promise');
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const parseDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
};

async function main() {
  const my = await mysql.createConnection({ host: 'localhost', user: 'admin_vestel', password: 'Vestel_2025!', database: 'vestel_dev' });

  // Mapa customer legacyId → Subscriber.id
  const subs = await p.subscriber.findMany({ where: { legacyId: { not: null } }, select: { id: true, legacyId: true } });
  const subById = new Map(subs.map((s) => [s.legacyId, s.id]));

  // --- PlayHub ---
  const [ph] = await my.query('SELECT * FROM playhub_suscripciones');
  let phN = 0;
  for (const r of ph) {
    await p.playhubSubscription.upsert({
      where: { legacyId: r.id },
      update: {},
      create: {
        legacyId: r.id,
        subscriberId: subById.get(r.customer_id) ?? null,
        nameS: r.name_s ?? null,
        externalName: r.nombre_externo ?? null,
        productId: r.product_id ?? null,
        productName: r.product_name ?? null,
        voucher: r.voucher ?? null,
        syncedAt: parseDate(r.fecha_sync),
      },
    });
    phN++;
  }
  console.log(`✓ PlayHub: ${phN}`);

  // --- Mensajería ---
  const [ms] = await my.query('SELECT * FROM mensajes');
  let msN = 0;
  for (const r of ms) {
    await p.internalMessage.upsert({
      where: { legacyId: r.idm },
      update: {},
      create: {
        legacyId: r.idm,
        campaignName: r.nombre_cam ?? null,
        refId: r.ide ?? null,
        recipientUserId: r.iduser ?? null,
        body: (r.sms ?? '').toString(),
      },
    });
    msN++;
  }
  console.log(`✓ Mensajes: ${msN}`);

  // --- Documental: folders ---
  const [fs] = await my.query('SELECT * FROM folders');
  const folderById = new Map();
  for (const r of fs) {
    const f = await p.docFolder.upsert({
      where: { legacyId: r.idc },
      update: { name: r.nombre ?? '(sin nombre)' },
      create: { legacyId: r.idc, name: r.nombre ?? '(sin nombre)', createdAt: parseDate(r.created_at) ?? new Date() },
    });
    folderById.set(r.idc, f.id);
  }
  // documents
  const [docs] = await my.query('SELECT * FROM documents');
  let docN = 0;
  for (const r of docs) {
    const folderLegacy = r.folder_id ?? r.carpeta ?? null;
    await p.document.upsert({
      where: { legacyId: r.id },
      update: {},
      create: {
        legacyId: r.id,
        folderId: folderLegacy ? (folderById.get(folderLegacy) ?? null) : null,
        title: r.title ?? '(sin título)',
        fileName: r.filename ?? null,
        docDate: parseDate(r.cdate),
        permission: r.permission ?? 0,
      },
    });
    docN++;
  }
  console.log(`✓ Carpetas: ${fs.length} · Documentos: ${docN}`);

  await my.end();
  await p.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
