// Completa el combo a medias en `SubscriberService`.
//
// Síntoma: un abonado que en el legacy factura internet + TV tiene UNA sola de las dos
// filas, así que la corrida del mes le factura medio combo. El respaldo
// `planDeUltimaFactura` NO lo tapa: solo entra cuando el abonado no tiene NINGUNA fila
// (`facturas.service.ts` ▸ `const base = conPlan.length ? conPlan : planFactura...`).
//
// Origen: el seed del 2026-07-05 (`seed-plans-from-services.js`) emparejaba el plan
// contra los ÍTEMS de la última factura, y para estos abonados los renglones todavía no
// estaban importados (llegaron el 2026-07-28) — ver [[servicios-contratados-incompletos]].
//
// La pata que falta se deriva de las facturas del LEGACY (tid < 500.000), con la MISMA
// regla que `plan-facturable.ts` para no cobrar un prorrateo como si fuera mensualidad:
//   nombre  = `serviceCombo` / `serviceTv` de la última factura del legacy
//   precio  = el más repetido de ese renglón en los últimos 6 meses (empate → el mayor)
//
//   node scripts/completar-servicios-combo.js            → preview
//   node scripts/completar-servicios-combo.js --commit   → escribe
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const COMMIT = process.argv.includes('--commit');
const money = (n) => '$' + Number(n || 0).toLocaleString('es-CO');
const norm = (s) => (s || '').trim().toLowerCase();
const vivo = (s) => s && norm(s) !== 'no';

async function main() {
  // 1. Última factura del legacy por abonado: es de donde el legacy mismo lee el plan.
  const ult = await p.$queryRaw`
    SELECT DISTINCT ON (i."subscriberId")
           i."subscriberId", i.tid, i."invoiceDate", i."serviceCombo", i."serviceTv"
      FROM "SubInvoice" i
     WHERE i.kind = 'RECURRENTE' AND i.tid < 500000
     ORDER BY i."subscriberId", i."invoiceDate" DESC, i.tid DESC`;

  const svc = await p.subscriberService.findMany({ select: { subscriberId: true, kind: true } });
  const tiene = new Map();
  for (const s of svc) {
    const v = tiene.get(s.subscriberId) || new Set();
    v.add(s.kind); tiene.set(s.subscriberId, v);
  }

  // 2. Quién tiene el combo a medias y qué pata le falta.
  const faltantes = [];
  for (const u of ult) {
    const kinds = tiene.get(u.subscriberId);
    if (!kinds || (kinds.has('INTERNET') && kinds.has('TV'))) continue; // sin filas → ya lo cubre el respaldo
    if (!vivo(u.serviceCombo) || !vivo(u.serviceTv)) continue;          // en el legacy no es combo
    const falta = kinds.has('TV') ? 'INTERNET' : 'TV';
    faltantes.push({ id: u.subscriberId, tid: u.tid, fecha: u.invoiceDate, falta, nombre: (falta === 'INTERNET' ? u.serviceCombo : u.serviceTv).trim() });
  }
  if (!faltantes.length) { console.log('No hay combos a medias.'); return; }

  // 3. Precio del renglón: el más repetido en 6 meses de facturas del legacy, empate al
  //    mayor. Así el prorrateo de un mes parcial ($37.033) no se queda de mensualidad.
  const desde = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 6, 1));
  const precios = await p.$queryRaw`
    SELECT DISTINCT ON (i."subscriberId", lower(btrim(COALESCE(it."productName", it.description))))
           i."subscriberId" AS sub,
           lower(btrim(COALESCE(it."productName", it.description))) AS nombre,
           it.price, it."taxRate", count(*) AS veces
      FROM "SubInvoiceItem" it
      JOIN "SubInvoice" i ON i.id = it."invoiceId"
     WHERE i.kind = 'RECURRENTE' AND i.tid < 500000
       AND i."invoiceDate" >= ${desde} AND it.price > 0
     GROUP BY 1, 2, it.price, it."taxRate"
     ORDER BY 1, 2, count(*) DESC, it.price DESC`;
  const precioDe = new Map(precios.map((r) => [`${r.sub}|${r.nombre}`, r]));

  const planes = await p.plan.findMany({ select: { id: true, kind: true, name: true, price: true, taxRate: true } });
  const buscarPlan = (kind, name, price) =>
    planes.find((x) => x.kind === kind && norm(x.name) === norm(name) && Number(x.price) === Number(price))
    || planes.find((x) => x.kind === kind && norm(x.name) === norm(name))
    || null;

  const subs = new Map((await p.subscriber.findMany({
    where: { id: { in: faltantes.map((f) => f.id) } },
    select: { id: true, abonado: true, status: true },
  })).map((s) => [s.id, s]));

  const detalle = [], pendientes = [];
  for (const f of faltantes) {
    const s = subs.get(f.id);
    const pr = precioDe.get(`${f.id}|${norm(f.nombre)}`);
    if (!pr) { pendientes.push({ ...f, abonado: s?.abonado, estado: s?.status }); continue; }
    const plan = buscarPlan(f.falta, f.nombre, pr.price);
    if (COMMIT) {
      await p.subscriberService.create({
        data: {
          subscriberId: f.id, kind: f.falta, planName: f.nombre,
          price: pr.price, taxRate: pr.taxRate ?? 0, status: 'ACTIVO', planId: plan?.id ?? null,
        },
      });
    }
    detalle.push({ abonado: s?.abonado, estado: s?.status, ultima: f.fecha, falta: f.falta, nombre: f.nombre, precio: Number(pr.price), iva: Number(pr.taxRate ?? 0), plan: plan ? 'sí' : 'NO' });
  }

  console.log(`\nCombos a medias: ${faltantes.length}${COMMIT ? '  (COMMIT)' : '  (preview)'}`);
  console.log(`  Filas ${COMMIT ? 'creadas' : 'a crear'}: ${detalle.length}`);
  console.log(`  Sin precio fiable en 6 meses (a mano): ${pendientes.length}\n`);
  console.log('  abonado | estado     | últ.legacy | falta    | plan                       | precio      | IVA | catálogo');
  for (const d of detalle) {
    console.log(`  ${String(d.abonado).padEnd(7)} | ${String(d.estado).padEnd(10)} | ${String(d.ultima?.toISOString().slice(0,10)).padEnd(10)} | ${d.falta.padEnd(8)} | ${d.nombre.padEnd(26)} | ${money(d.precio).padStart(11)} | ${String(d.iva).padStart(3)} | ${d.plan}`);
  }
  if (pendientes.length) {
    console.log('\n  ⚠️  Sin precio fiable (revisar a mano):');
    for (const d of pendientes) console.log(`  ${String(d.abonado).padEnd(7)} | ${String(d.estado).padEnd(10)} | falta ${d.falta.padEnd(8)} | ${d.nombre} | factura ${d.tid}`);
  }
  const vivos = detalle.filter((d) => d.estado !== 'RETIRADO');
  const total = vivos.reduce((n, d) => n + d.precio * (1 + d.iva / 100), 0);
  console.log(`\n  Mensualidad que vuelve a la corrida (sin retirados): ${money(Math.round(total))}  ·  ${vivos.length} abonados`);
  if (!COMMIT) console.log('\n(preview) nada escrito. Corre con --commit para aplicar.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
