// Backfill de SubscriberService + catálogo Plan desde las FACTURAS.
// El precio/plan de cada abonado vive en su última factura (serviceCombo/serviceTv
// + ítems con price/taxRate). Este script lo materializa para que la facturación
// "desde el plan" y el "cambiar plan" tengan datos. Idempotente por abonado.
//
//   node scripts/seed-plans-from-services.js            → preview (solo lectura)
//   node scripts/seed-plans-from-services.js --commit   → escribe servicios + catálogo
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const COMMIT = process.argv.includes('--commit');
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US');
const norm = (s) => (s || '').trim().toLowerCase();
const isNone = (s) => !s || norm(s) === 'no';

// Empareja el ítem de la factura cuyo nombre coincide con el plan (combo/tv).
function matchItem(items, planName) {
  const target = norm(planName);
  return items.find((it) => norm(it.description) === target || norm(it.productName) === target) || null;
}

async function main() {
  const activos = await p.subscriber.findMany({ where: { status: 'ACTIVO' }, select: { id: true } });
  console.log(`Abonados ACTIVO: ${activos.length}${COMMIT ? '  (COMMIT)' : '  (preview)'}\n`);

  const planCache = new Map(); // key kind|name|price|tax -> planId (o placeholder en preview)
  const catalogPreview = new Map(); // key -> {kind,name,price,tax,count}
  let svcCreated = 0, subsDone = 0, subsSkipExist = 0, sinFactura = 0;
  const unmatched = { INTERNET: 0, TV: 0 };

  async function ensurePlan(kind, name, price, tax) {
    const key = `${kind}|${name}|${price}|${tax}`;
    const prev = catalogPreview.get(key);
    catalogPreview.set(key, { kind, name, price, tax, count: (prev?.count || 0) + 1 });
    if (!COMMIT) return key;
    if (planCache.has(key)) return planCache.get(key);
    let plan = await p.plan.findFirst({ where: { kind, name, price, taxRate: tax } });
    if (!plan) plan = await p.plan.create({ data: { kind, name, price, taxRate: tax, active: true } });
    planCache.set(key, plan.id);
    return plan.id;
  }

  for (const s of activos) {
    // Idempotencia: si ya tiene servicios, no reproceso.
    if (COMMIT) {
      const has = await p.subscriberService.count({ where: { subscriberId: s.id } });
      if (has > 0) { subsSkipExist++; continue; }
    }
    const inv = await p.subInvoice.findFirst({
      where: { subscriberId: s.id },
      orderBy: [{ invoiceDate: 'desc' }, { tid: 'desc' }],
      select: { serviceCombo: true, serviceTv: true, items: { select: { description: true, productName: true, price: true, taxRate: true } } },
    });
    if (!inv) { sinFactura++; continue; }

    const lines = [];
    if (!isNone(inv.serviceCombo)) {
      const it = matchItem(inv.items, inv.serviceCombo);
      if (it && Number(it.price) > 0) lines.push({ kind: 'INTERNET', name: inv.serviceCombo.trim(), price: Number(it.price), tax: Number(it.taxRate) });
      else unmatched.INTERNET++;
    }
    if (!isNone(inv.serviceTv)) {
      const it = matchItem(inv.items, inv.serviceTv);
      if (it && Number(it.price) > 0) lines.push({ kind: 'TV', name: inv.serviceTv.trim(), price: Number(it.price), tax: Number(it.taxRate) });
      else unmatched.TV++;
    }
    if (!lines.length) continue;

    for (const l of lines) {
      const planId = await ensurePlan(l.kind, l.name, l.price, l.tax);
      if (COMMIT) {
        await p.subscriberService.create({
          data: { subscriberId: s.id, kind: l.kind, planName: l.name, price: l.price, taxRate: l.tax, status: 'ACTIVO', planId },
        });
      }
      svcCreated++;
    }
    subsDone++;
  }

  console.log('=== RESULTADO ===');
  console.log(`  Abonados con servicios ${COMMIT ? 'creados' : 'a crear'}: ${subsDone}`);
  console.log(`  Servicios (líneas) ${COMMIT ? 'creados' : 'a crear'}:      ${svcCreated}`);
  console.log(`  Planes distintos en catálogo:            ${catalogPreview.size}`);
  if (COMMIT) console.log(`  Abonados ya con servicios (omitidos):    ${subsSkipExist}`);
  console.log(`  ⚠️  Sin ninguna factura (a resolver a mano): ${sinFactura}`);
  console.log(`  ⚠️  Plan sin ítem emparejable (internet/tv): ${unmatched.INTERNET}/${unmatched.TV}`);

  // Muestra del catálogo (top por # de abonados)
  const top = [...catalogPreview.values()].sort((a, b) => b.count - a.count).slice(0, 12);
  console.log('\n  Catálogo (top 12 por abonados):');
  for (const c of top) console.log(`    ${c.kind.padEnd(9)} ${c.name.padEnd(26)} ${money(c.price).padStart(11)}  IVA ${String(c.tax).padStart(2)}%  ×${c.count}`);

  if (!COMMIT) console.log('\n(preview) nada escrito. Corre con --commit para aplicar.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
