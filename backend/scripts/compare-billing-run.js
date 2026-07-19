/**
 * Comparador de la facturación recurrente: Nexus (simulada) vs el legacy (real).
 *
 * Corre `FacturasService.generate` en dryRun+asIfUnbilled —el MISMO motor que va a
 * producción, sin escribir nada— para un mes que el legacy YA facturó, y cruza el
 * resultado factura por factura contra el lote real que quedó en el MySQL del legacy.
 * Es lo único que revela las diferencias que ninguna prueba sintética muestra.
 *
 * Por qué julio 2026: el legacy corrió el lote el 1-jul (5.061 facturas emisión
 * 2026-07-01 / vencimiento 2026-07-20) y la migración a Nexus es una foto del 2-jul,
 * así que el estado de los abonados en Nexus es casi el mismo que tenía el legacy al
 * facturar. Es la ventana con menos deriva disponible sin re-migrar.
 *
 *   node scripts/compare-billing-run.js
 *   node scripts/compare-billing-run.js --date=2026-07-01 --due=2026-07-20
 *   node scripts/compare-billing-run.js --out=/tmp/informe.json
 *
 * Solo lee. El dryRun no escribe en Postgres y del MySQL del legacy solo hace SELECT.
 *
 * CAVEAT 1 — deriva de estado: el MySQL del legacy está VIVO (hoy), así que
 * `customers.usu_estado` es el de hoy, no el del 1-jul. La tabla `invoices` sí es un
 * hecho histórico. Por eso la clasificación usa el estado que tiene Nexus (foto del
 * 2-jul), el proxy más cercano al momento de la corrida. Un abonado que cambió de
 * estado entre el 1 y el 2 de julio puede salir clasificado sin que haya bug.
 *
 * CAVEAT 2 — la factura del legacy NO se compara como está hoy, sino como NACIÓ.
 * Se compara contra `subtotal + tax`, no contra `total`: la factura del legacy lleva
 * 15 días viva y `total` ya recoge mutaciones posteriores que NO son de la corrida:
 *   · `discount`: el lote inserta discount=0 (Invoices_model.php:1393). El descuento
 *     lo escribe DESPUÉS el portal de autoservicio del cliente
 *     (Customers_model.php:4459, `total = total - X`, destructivo). No es pronto pago:
 *     el % sale de `promos.porcentaje` y no se compara contra `invoiceduedate`. Nexus
 *     ya cubre eso en `src/promotions` (y mejor: emite nota crédito en vez de pisar
 *     el total) → no es brecha de la corrida y compararlo daría diferencias falsas.
 *   · notas crédito/débito posteriores: las facturas que las tienen se apartan.
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/src/app.module');
const { FacturasService } = require('../dist/src/billing/facturas.service');
const { PrismaService } = require('../dist/src/prisma/prisma.service');

const arg = (k, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : def;
};
const DATE = arg('date', '2026-07-01');
const DUE = arg('due', '2026-07-20');
const OUT = arg('out', path.join(__dirname, `compare-billing-${DATE}.json`));

const money = (n) => '$' + Math.round(Number(n || 0)).toLocaleString('en-US');
const norm = (s) => (s || '').trim().toLowerCase();
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };

/** Credenciales del legacy: se leen de su config, no se duplican aquí. */
function legacyDbConfig() {
  const file = '/var/www/vhosts/saves.com.co/httpdocs/saves-vestel/application/config/database.php';
  const src = fs.readFileSync(file, 'utf8');
  const pick = (k) => (src.match(new RegExp(`'${k}'\\s*=>\\s*'([^']*)'`)) || [])[1];
  return { host: pick('hostname'), user: pick('username'), password: pick('password'), database: pick('database') };
}

/**
 * Por qué el legacy facturó a alguien que Nexus no facturaría. El motivo del plan
 * (que da el propio motor) se traduce a una causa de negocio.
 */
function classifyMissing(planRow, sub) {
  if (!sub) return 'CLIENTE_NO_MIGRADO';
  if (!planRow) {
    // No entró siquiera en la población objetivo: su estado en Nexus no es facturable.
    return `ESTADO_NO_FACTURABLE:${sub.status ?? 'null'}`;
  }
  switch (planRow.reason) {
    case 'NO_SERVICES':
      return sub.status === 'COMPROMISO' ? 'COMPROMISO_SIN_PLAN' : 'SIN_PLAN_EMPAREJABLE';
    case 'PROMO':
    case 'PROMO2': return 'PROMO_MES_GRATIS';
    case 'REACTIVATED': return 'REACTIVADO_EN_EL_MES';
    case 'ALREADY_BILLED': return 'YA_FACTURADO';
    case 'ERROR': return 'ERROR_AL_GENERAR';
    default: return `OTRO:${planRow.reason ?? planRow.action}`;
  }
}

const NOTE_PRODUCTS = ['nota credito', 'nota debito'];
const isNote = (it) => NOTE_PRODUCTS.includes(norm(it.product));

/** Por qué difieren los montos de una factura que ambos sistemas emiten. */
function classifyDiff(nx, lg, lgItems) {
  const causes = [];
  const puntos = lgItems.filter((i) => /punto/i.test(i.product || ''));
  if (puntos.length) causes.push('PUNTOS_NO_MODELADOS');

  // Ítems del legacy que no son ni internet, ni TV, ni puntos → servicios adicionales
  // recurrentes, que Nexus no modela como SubscriberService.
  const extra = lgItems.filter((i) => {
    const p = norm(i.product);
    if (/punto/.test(p)) return false;
    return !nx.items.some((n) => norm(n.productName) === p) && !/television|internet/.test(p);
  });
  if (extra.length) causes.push(`SERVICIO_ADICIONAL_NO_MODELADO:${extra.map((e) => e.product).join('|')}`);

  // Mismo conjunto de ítems pero precio distinto → el plan del abonado en Nexus no
  // coincide con lo que el legacy clonó de la factura anterior.
  for (const n of nx.items) {
    const m = lgItems.find((i) => norm(i.product) === norm(n.productName));
    if (m && Math.abs(Number(m.price) - n.price) > 1) causes.push(`PRECIO_DISTINTO:${n.productName}`);
    if (m && Math.abs(Number(m.tax) - n.taxRate) > 0.01) causes.push(`TASA_DISTINTA:${n.productName}`);
  }

  if (!causes.length) {
    const dBase = Math.abs(nx.subtotal - Number(lg.subtotal));
    const dTax = Math.abs(nx.tax - Number(lg.tax));
    if (dBase <= 2 && dTax > 2) causes.push('SOLO_IVA');
    else if (Math.abs(nx.total - (Number(lg.subtotal) + Number(lg.tax))) <= 2) causes.push('REDONDEO');
    else causes.push('SIN_CLASIFICAR');
  }
  return causes;
}

async function main() {
  console.log(`${C.b}Comparador facturación recurrente — Nexus vs legacy${C.x}`);
  console.log(`${C.d}  lote: emisión ${DATE} · vencimiento ${DUE}${C.x}\n`);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const facturas = app.get(FacturasService);
  const prisma = app.get(PrismaService);
  const conn = await mysql.createConnection(legacyDbConfig());

  // --- 1. El lote REAL del legacy (hecho histórico) ---
  const [lgRows] = await conn.execute(
    `SELECT id, tid, csd, subtotal, tax, discount, total, status, television, combo, puntos, estado_tv, estado_combo
       FROM invoices
      WHERE tipo_factura = 'Recurrente' AND invoicedate = ? AND invoiceduedate = ?`,
    [DATE, DUE],
  );
  const [lgItemRows] = await conn.execute(
    `SELECT it.tid, it.product, it.pid, it.qty, it.price, it.tax, it.totaltax
       FROM invoice_items it
       JOIN invoices i ON i.tid = it.tid
      WHERE i.tipo_factura = 'Recurrente' AND i.invoicedate = ? AND i.invoiceduedate = ?`,
    [DATE, DUE],
  );
  const lgItemsByTid = new Map();
  for (const r of lgItemRows) {
    if (!lgItemsByTid.has(r.tid)) lgItemsByTid.set(r.tid, []);
    lgItemsByTid.get(r.tid).push(r);
  }
  console.log(`${C.d}  legacy: ${lgRows.length} facturas · ${lgItemRows.length} ítems${C.x}`);

  // --- 2. La corrida SIMULADA de Nexus, con el motor real ---
  const t0 = Date.now();
  const res = await facturas.generate(
    { invoiceDate: DATE, dryRun: true, asIfUnbilled: true },
    { name: 'comparador', permissions: ['system.admin'] },
  );
  console.log(`${C.d}  nexus:  objetivo ${res.targeted} · facturaría ${res.generated} · omitiría ${res.skipped}`
    + ` (${((Date.now() - t0) / 1000).toFixed(1)}s)${C.x}\n`);

  if (res.dueDate && res.dueDate.toISOString().slice(0, 10) !== DUE) {
    console.log(`${C.y}  ⚠ Nexus vencería el ${res.dueDate.toISOString().slice(0, 10)}, el legacy el ${DUE}${C.x}\n`);
  }

  // --- 3. Mapas de cruce (Subscriber.legacyId = customers.id = invoices.csd) ---
  const subs = await prisma.subscriber.findMany({ select: { id: true, legacyId: true, abonado: true, status: true } });
  const byLegacy = new Map(subs.map((s) => [s.legacyId, s]));
  const byId = new Map(subs.map((s) => [s.id, s]));
  const planBySub = new Map(res.plan.map((p) => [p.subscriberId, p]));

  // --- 4. Cruce ---
  const buckets = { iguales: [], montoDistinto: [], faltaEnNexus: [], sobraEnNexus: [], mutadas: [] };
  const seenSub = new Set();

  for (const lg of lgRows) {
    const sub = byLegacy.get(lg.csd);
    seenSub.add(sub?.id);
    const plan = sub ? planBySub.get(sub.id) : null;
    const items = lgItemsByTid.get(lg.tid) || [];

    if (!plan || plan.action !== 'BILL') {
      buckets.faltaEnNexus.push({
        abonado: sub?.abonado ?? null, legacyCsd: lg.csd, tid: lg.tid,
        statusNexus: sub?.status ?? null, total: Number(lg.subtotal) + Number(lg.tax),
        causa: classifyMissing(plan, sub),
      });
      continue;
    }

    // La factura del legacy COMO NACIÓ: el lote la insertó con discount=0, así que su
    // total al crearse era subtotal+tax. Comparar contra `lg.total` mediría además
    // 15 días de vida (descuentos del portal, pagos) que no son de la corrida.
    const lgCreated = { subtotal: Number(lg.subtotal), tax: Number(lg.tax) };
    lgCreated.total = lgCreated.subtotal + lgCreated.tax;

    const notes = items.filter(isNote);
    const row = {
      abonado: sub.abonado, legacyCsd: lg.csd, tid: lg.tid,
      nexus: { subtotal: plan.subtotal, tax: plan.tax, total: plan.total },
      legacy: lgCreated,
      legacyHoy: { discount: Number(lg.discount), total: Number(lg.total), status: lg.status },
      dTotal: plan.total - lgCreated.total,
    };

    // Con notas posteriores el subtotal/tax del legacy ya no son los del nacimiento:
    // no hay baseline limpio → se aparta en vez de contarse como diferencia.
    if (notes.length) { buckets.mutadas.push({ ...row, notas: notes.length }); continue; }

    if (Math.abs(row.dTotal) < 0.5) buckets.iguales.push(row);
    else buckets.montoDistinto.push({ ...row, causas: classifyDiff(plan, lg, items.filter((i) => !isNote(i))) });
  }

  // Nexus facturaría a alguien que el legacy no facturó en el lote.
  for (const p of res.plan) {
    if (p.action !== 'BILL' || seenSub.has(p.subscriberId)) continue;
    const sub = byId.get(p.subscriberId);
    buckets.sobraEnNexus.push({ abonado: sub?.abonado ?? null, statusNexus: sub?.status ?? null, total: p.total });
  }

  // --- 5. Informe ---
  const sum = (a) => a.reduce((t, r) => t + (r.total ?? r.legacy?.total ?? 0), 0);
  // Facturado por el legacy AL NACER (subtotal+tax), no como está hoy: es lo único
  // comparable contra una corrida recién generada.
  const lgTotal = lgRows.reduce((t, r) => t + Number(r.subtotal) + Number(r.tax), 0);
  const line = (label, n, extra = '') => console.log(`  ${label.padEnd(30)} ${String(n).padStart(6)}  ${extra}`);

  console.log(`${C.b}=== RESULTADO ===${C.x}`);
  line('Facturas iguales', buckets.iguales.length, `${C.g}✓${C.x}`);
  line('Monto distinto', buckets.montoDistinto.length, buckets.montoDistinto.length ? `${C.y}⚠${C.x}` : '');
  line('Falta en Nexus', buckets.faltaEnNexus.length,
    buckets.faltaEnNexus.length ? `${C.r}✗ ${money(sum(buckets.faltaEnNexus))} sin cobrar${C.x}` : '');
  line('Sobra en Nexus', buckets.sobraEnNexus.length,
    buckets.sobraEnNexus.length ? `${C.y}⚠ ${money(sum(buckets.sobraEnNexus))} de más${C.x}` : '');
  line('Apartadas (nota posterior)', buckets.mutadas.length, `${C.d}sin baseline limpio${C.x}`);

  const nxTotal = buckets.iguales.reduce((t, r) => t + r.nexus.total, 0)
    + buckets.montoDistinto.reduce((t, r) => t + r.nexus.total, 0)
    + buckets.sobraEnNexus.reduce((t, r) => t + r.total, 0)
    + buckets.mutadas.reduce((t, r) => t + r.nexus.total, 0);
  console.log(`\n  ${'Facturó el legacy (al nacer)'.padEnd(30)} ${money(lgTotal).padStart(16)}`);
  console.log(`  ${'Facturaría Nexus'.padEnd(30)} ${money(nxTotal).padStart(16)}`);
  const gap = nxTotal - lgTotal;
  const col = Math.abs(gap) < 1000 ? C.g : C.r;
  console.log(`  ${col}${'DIFERENCIA'.padEnd(30)} ${money(gap).padStart(16)}  (${(gap / lgTotal * 100).toFixed(2)}%)${C.x}`);
  const desc = lgRows.reduce((t, r) => t + Number(r.discount), 0);
  console.log(`${C.d}\n  (informativo, NO es brecha de la corrida: el legacy le aplicó después`
    + ` ${money(desc)} en descuentos del portal a ${lgRows.filter((r) => Number(r.discount)).length} facturas)${C.x}`);

  const tally = (rows, key) => {
    const m = new Map();
    for (const r of rows) for (const c of [].concat(key(r))) {
      const k = String(c).split(':')[0];
      const prev = m.get(k) || { n: 0, monto: 0 };
      m.set(k, { n: prev.n + 1, monto: prev.monto + (r.total ?? Math.abs(r.dTotal) ?? 0) });
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  };

  if (buckets.faltaEnNexus.length) {
    console.log(`\n${C.b}=== POR QUÉ FALTAN (${buckets.faltaEnNexus.length}) ===${C.x}`);
    for (const [c, v] of tally(buckets.faltaEnNexus, (r) => r.causa)) {
      console.log(`  ${C.r}${c.padEnd(32)}${C.x} ${String(v.n).padStart(5)}   ${money(v.monto).padStart(14)}`);
    }
  }
  if (buckets.montoDistinto.length) {
    console.log(`\n${C.b}=== POR QUÉ DIFIEREN LOS MONTOS (${buckets.montoDistinto.length}) ===${C.x}`);
    for (const [c, v] of tally(buckets.montoDistinto, (r) => r.causas)) {
      console.log(`  ${C.y}${c.padEnd(32)}${C.x} ${String(v.n).padStart(5)}   ${money(v.monto).padStart(14)} en diferencias`);
    }
    console.log(`\n${C.d}  muestra:${C.x}`);
    for (const r of buckets.montoDistinto.slice(0, 5)) {
      console.log(`${C.d}    abonado ${r.abonado} tid ${r.tid}: nexus ${money(r.nexus.total)} vs legacy ${money(r.legacy.total)}`
        + `  [${r.causas.join(', ')}]${C.x}`);
    }
  }

  fs.writeFileSync(OUT, JSON.stringify({
    lote: { date: DATE, due: DUE }, generadoEn: new Date().toISOString(),
    resumen: {
      legacyFacturas: lgRows.length, legacyTotal: lgTotal, nexusTotal: nxTotal, diferencia: gap,
      iguales: buckets.iguales.length, montoDistinto: buckets.montoDistinto.length,
      faltaEnNexus: buckets.faltaEnNexus.length, sobraEnNexus: buckets.sobraEnNexus.length,
    },
    buckets,
  }, null, 2));
  console.log(`\n${C.d}  detalle completo → ${OUT}${C.x}`);

  await conn.end();
  await app.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
