/**
 * Corrida PUENTE de septiembre 2026 — emite la mensualidad que la corrida del día 1
 * se saltó en silencio.
 *
 * Qué pasó: la corrida del 2026-09-01 salió `ok=true` (4.875 generadas, 90 omitidas)
 * pero dentro de esas 90 iban TODAS las instalaciones de agosto. El plan facturable
 * de un cliente nacido en el legacy no llega a `SubscriberService` (el sync no
 * escribía esa tabla) y el respaldo por facturas no podía deducirlo: el mes de
 * instalación se emite en $0, así que no hay un solo renglón con precio del que
 * sacarlo. Caían en `NO_SERVICES` y nadie lo veía. Ver `plan-facturable.ts` y
 * `syncServiciosDeAlta` en `sync-legacy-vivo.js`, que cierran el agujero.
 *
 * Este script solo repara lo ya perdido. Usa el MISMO motor de la corrida del mes
 * (`FacturasService.generate`), con tres candados:
 *   · `invoiceDate = 2026-09-01` → la factura nace con el mes y el vencimiento que le
 *     tocaba (20 de septiembre), igual que la de los otros 4.875 abonados;
 *   · `alreadyBilled` de la propia corrida → quien YA tenga factura de septiembre se
 *     salta, incluidas las tres que la ventanilla emitió a mano el 7-sep. No hay
 *     forma de duplicar;
 *   · `subscriberIds` acotado a QUIEN FACTURÓ EN AGOSTO (`OBJETIVO`). Ésta es la que
 *     de verdad importa y NO se puede omitir: una corrida con fecha vieja lanzada
 *     hoy alcanza a gente a la que septiembre no se le debe.
 *
 * Dos casos reales que la simulación sin acotar iba a cobrar mal:
 *   · 57438/57439/57440 — instalados a fin de agosto pero ACTIVOS el 3 de SEPTIEMBRE
 *     (INSTALAR → ACTIVO). Septiembre es su mes de instalación, que va en $0: su
 *     primera mensualidad entera es la de octubre. Se les habría cobrado $76.900 de
 *     más a cada uno. El motor no los frena solo: su guarda de reactivación mira
 *     `previousStatus === 'RETIRADO'`, no `INSTALAR`.
 *   · 3653 y 7609 — figuran ACTIVO pero su última factura es de 2025 y 2024. Basura
 *     del legacy: emitirles una mensualidad es inventarles una deuda.
 * Haber facturado en agosto es la prueba de que el mes corría, y deja fuera a los dos.
 *
 * CUARTO candado — el legacy, preguntado directo. `alreadyBilled` solo ve lo que está
 * IMPORTADO, y hay facturas del legacy que aquí no están: al 54066 el legacy le emitió
 * septiembre (tid 503288, $85.000) y alguien borró la copia de nexus el 3-sep; con el
 * freno de borrados cerrado, la lápida nunca viajó y el sync no la repone. Emitirla de
 * nuevo sería cobrarle dos veces. Es la misma mina de la doble facturación de
 * Villanueva en agosto: el anti-duplicado solo protege de lo que ya bajó.
 *
 *   node scripts/corrida-puente-septiembre.js            → simulación (no escribe)
 *   node scripts/corrida-puente-septiembre.js --commit   → emite
 */
require('reflect-metadata');
const mysql = require('mysql2/promise');
const { facturasService, prismaService: prisma } = require('../dist/src/core/contenedor');

const COMMIT = process.argv.includes('--commit');
const FECHA = '2026-09-01';
const money = (n) => '$' + Math.round(Number(n || 0)).toLocaleString('es-CO');

async function main() {
  // A quién se le debe septiembre: al que ya tenía mensualidad corriendo en agosto.
  const objetivo = await prisma.$queryRaw`
    SELECT DISTINCT i."subscriberId" AS id
      FROM "SubInvoice" i
     WHERE i.kind = 'RECURRENTE' AND i.status <> 'CANCELED'
       AND i."invoiceDate" >= DATE '2026-08-01' AND i."invoiceDate" < DATE '2026-09-01'`;
  let OBJETIVO = objetivo.map((r) => r.id);

  // Y se le pregunta al legacy, que es donde puede haber una factura de septiembre
  // que aquí no está. Solo se cruza a los que en NEXUS salen sin facturar: para el
  // resto la respuesta del legacy es su propia copia (el writeback ya empujó allá
  // las 4.875 de la corrida) y listarlos ahogaría el informe en ruido.
  // El cruce va por `legacyId`, no por `abonado`: ese número se repite en el legacy
  // (21.886 clientes, 14.694 números) y por ahí saca de la lista a quien no toca.
  const yaAqui = new Set((await prisma.subInvoice.findMany({
    where: { invoiceDate: { gte: new Date('2026-09-01'), lt: new Date('2026-10-01') }, status: { not: 'CANCELED' } },
    select: { subscriberId: true },
  })).map((r) => r.subscriberId));
  const dudosos = await prisma.subscriber.findMany({
    where: { id: { in: OBJETIVO.filter((id) => !yaAqui.has(id)) }, legacyId: { not: null } },
    select: { id: true, abonado: true, legacyId: true },
  });

  const my = await mysql.createConnection({
    host: process.env.LEGACY_DB_HOST, port: Number(process.env.LEGACY_DB_PORT || 3306),
    user: process.env.LEGACY_DB_USER, password: process.env.LEGACY_DB_PASSWORD,
    database: process.env.LEGACY_DB_NAME,
  });
  const [yaAlla] = dudosos.length ? await my.query(
    `SELECT DISTINCT csd FROM invoices
      WHERE invoicedate >= '2026-09-01' AND invoicedate < '2026-10-01' AND status <> 'canceled'
        AND csd IN (?)`, [dudosos.map((s) => s.legacyId)]) : [[]];
  await my.end();

  const csdAlla = new Set(yaAlla.map((r) => r.csd));
  const fuera = dudosos.filter((s) => csdAlla.has(s.legacyId));
  if (fuera.length) {
    const ids = new Set(fuera.map((s) => s.id));
    OBJETIVO = OBJETIVO.filter((id) => !ids.has(id));
    console.log(`\n  ⚠️  ${fuera.length} apartado(s): el LEGACY ya les facturó septiembre y aquí no está esa factura.`);
    for (const s of fuera) console.log(`      abonado ${s.abonado} (legacyId ${s.legacyId}) — revisar a mano, NO se le emite`);
  }

  const r = await facturasService.generate(
    { invoiceDate: FECHA, dryRun: !COMMIT, subscriberIds: OBJETIVO },
    { id: 'system', email: 'cron@vestel', name: 'Corrida puente septiembre', roles: [], permissions: ['system.admin'] },
  );

  const aFacturar = (r.plan || []).filter((p) => p.action === 'BILL');
  const motivos = {};
  for (const p of (r.plan || [])) if (p.action === 'SKIP') motivos[p.reason] = (motivos[p.reason] || 0) + 1;

  const subs = aFacturar.length ? await prisma.subscriber.findMany({
    where: { id: { in: aFacturar.map((p) => p.subscriberId) } },
    select: { id: true, abonado: true, fullName: true, status: true },
  }) : [];
  const byId = new Map(subs.map((s) => [s.id, s]));

  console.log(`\nCorrida puente ${FECHA}${COMMIT ? '  (COMMIT)' : '  (simulación)'}`);
  console.log(`  facturaron en agosto ${OBJETIVO.length} · a facturar ${aFacturar.length} · omitidas ${r.skipped ?? '—'}\n`);
  console.log('  abonado | estado     | cliente                          | plan                                       |      total');
  for (const p of aFacturar.sort((a, b) => (byId.get(a.subscriberId)?.abonado ?? 0) - (byId.get(b.subscriberId)?.abonado ?? 0))) {
    const s = byId.get(p.subscriberId);
    const plan = (p.items || []).map((i) => i.productName).join(' + ');
    console.log(`  ${String(s?.abonado ?? '?').padEnd(7)} | ${String(s?.status ?? '').padEnd(10)} | ${(s?.fullName || '(sin nombre)').slice(0, 32).padEnd(32)} | ${plan.slice(0, 42).padEnd(42)} | ${money(p.total).padStart(10)}`);
  }
  const total = aFacturar.reduce((n, p) => n + Number(p.total || 0), 0);
  console.log(`\n  TOTAL: ${money(total)} en ${aFacturar.length} facturas`);
  console.log(`  Motivos de omisión: ${Object.entries(motivos).map(([k, v]) => `${k}=${v}`).join(' · ') || '—'}`);
  if (!COMMIT) console.log('\n(simulación) nada escrito. Corre con --commit para emitir.');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
