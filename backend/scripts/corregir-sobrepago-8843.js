/**
 * Corrección puntual (2026-09-21): abonado 2683, HERNANDO CELIS CARDENAS
 * (CC 4274338, legacy customers.id 8843, sede Villanueva).
 *
 * Reclamo: la ficha le cobra tres facturas y sólo debe la última (#501630, sep-2026, 132.000).
 * Las dos viejas que salían pendientes:
 *
 *   · #317261 (jul-2024): 40.000, pagado 23.185 → residuo 16.815
 *   · #349865 (ene-2025): 86.650, pagado 0 — nota de la ventanilla: "lo dejo en 0 YA QUE USUARIO
 *     TIENE UN SALDO DE 83 PENDIENTE Y ESTAMOS EN PAGOS" (nunca se dejó en 0)
 *
 * Y la plata que el legacy tenía sin aplicar:
 *
 *   · #106916 (afiliación de ene-2022, total 0): 100.000 cobrados en tres pagos (30+35+35)
 *   · #400595 (oct-2025): pagó 86.700 sobre 86.650 → sobran 50
 *
 * El legacy pinta el saldo como SUM(total) − SUM(pamnt) de toda la historia, así que esos
 * 100.050 tapaban casi toda la deuda vieja y la ficha allá decía 135.415 (132.000 + 3.415).
 * Nexus suma factura por factura y nunca en negativo (`saldoPendiente` en common/money.ts):
 * 235.465. Ver la nota de saldos fantasma y `corregir-sobrepago-6880.js`.
 *
 * Qué hace, en los dos sistemas y en la misma jugada (decisión del 21-sep: aplicar el saldo
 * a favor y condonar el residuo):
 *   1. Re-etiqueta los cobros de la #106916 a las facturas que realmente cubren:
 *        119146 (35.000) y 111255 (35.000) → #349865 enteros
 *        101521 (30.000) → 16.650 a #349865 y un hijo de 13.350 a #317261
 *      y parte el 444622 (86.700) en 86.650 + un hijo de 50 a #317261.
 *      La plata NO cambia de fecha ni de caja: el hijo hereda fecha, cuenta y método del padre.
 *   2. Condona los 3.415 que quedan en la #317261 como descuento de cabecera
 *      (total 40.000 → 36.585), la misma convención del pronto pago.
 * Resultado: las cuatro facturas viejas `paid` con residuo 0; sólo queda la #501630.
 * Si la plata total del cliente cambia o los dos lados no quedan iguales, se revierte todo.
 *
 * Uso: node scripts/corregir-sobrepago-8843.js [--live]   (sin --live no escribe nada)
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
const prisma = new PrismaClient();
const { mapTx } = require('./lib/vestel-map');

const LIVE = process.argv.includes('--live');
const CSD = 8843;
const num = (v) => Number(v ?? 0);
const cop = (n) => '$' + Math.round(n).toLocaleString('es-CO');
const mismoDinero = (a, b) => Math.abs(Number(a) - Number(b)) < 1;

/**
 * Cada cobro: a qué factura queda colgado el padre (con lo que le sobra) y qué hijos se
 * desprenden hacia otras facturas.
 */
const COBROS = {
  119146: { padre: 349865, hijos: [] },
  111255: { padre: 349865, hijos: [] },
  101521: { padre: 349865, hijos: [{ destino: 317261, monto: 13350 }] },
  444622: { padre: 400595, hijos: [{ destino: 317261, monto: 50 }] },
};
/** Lo que se condona como descuento de cabecera. */
const CONDONAR = { tid: 317261, monto: 3415 };
const NOTA_CONDONA = 'Condonado 3.415 de residuo al aplicar el saldo a favor de la #106916 (21-sep-2026)';

/** Cómo tiene que estar todo ANTES; si algo cambió, no se toca nada. */
const ESPERADO_PAMNT = { 106916: 100000, 317261: 23185, 349865: 0, 400595: 86700 };
const ESPERADO_TOTAL = { 106916: 0, 317261: 40000, 349865: 86650, 400595: 86650 };
const ESPERADO_TX = {
  119146: { tid: 106916, credit: 35000 },
  111255: { tid: 106916, credit: 35000 },
  101521: { tid: 106916, credit: 30000 },
  444622: { tid: 400595, credit: 86700 },
};
/** #349865 se editó hoy (a 0 y de vuelta a como estaba); las demás no deben tener ediciones. */
const EDITADA_OK = new Set([349865]);

function notaMovida(nota, tidOrigen, tidDestino, marca) {
  const base = String(nota ?? '').replace(new RegExp(String(tidOrigen), 'g'), String(tidDestino));
  return `${base} ${marca}`.slice(0, 255);
}

async function dineroLegacy(my) {
  const [[t]] = await my.query(
    `SELECT COALESCE(SUM(credit),0) c FROM transactions WHERE payerid=? AND (estado IS NULL OR estado='')`, [CSD]);
  return num(t.c);
}
async function dineroNexus(db, subscriberId) {
  const r = await db.transaction.aggregate({ where: { subscriberId, status: 'VIGENTE' }, _sum: { credit: true } });
  return num(r._sum.credit);
}
async function netoLegacy(my) {
  const [[t]] = await my.query('SELECT SUM(total) - SUM(pamnt) n FROM invoices WHERE csd=?', [CSD]);
  return num(t.n);
}

async function main() {
  const my = await mysql.createConnection({
    host: process.env.LEGACY_DB_HOST, port: Number(process.env.LEGACY_DB_PORT || 3306),
    user: process.env.LEGACY_DB_USER, password: process.env.LEGACY_DB_PASSWORD,
    database: process.env.LEGACY_DB_NAME, dateStrings: true,
  });

  // ── Frenos: el estado tiene que ser exactamente el que se diagnosticó ─────────
  const tids = Object.keys(ESPERADO_PAMNT).map(Number);
  const [facts] = await my.query('SELECT * FROM invoices WHERE tid IN (?) AND csd=?', [tids, CSD]);
  const fLeg = new Map(facts.map((f) => [f.tid, f]));
  const fPg = new Map((await prisma.subInvoice.findMany({ where: { tid: { in: tids } } })).map((f) => [f.tid, f]));
  for (const tid of tids) {
    const l = fLeg.get(tid), p = fPg.get(tid);
    if (!l || !p) throw new Error(`factura #${tid} falta en ${!l ? 'legacy' : 'nexus'}`);
    if (p.legacyId !== l.id) throw new Error(`factura #${tid}: legacyId ${p.legacyId} ≠ ${l.id}`);
    if (p.editedAt && !EDITADA_OK.has(tid)) throw new Error(`factura #${tid} editada aquí`);
    if (!mismoDinero(l.total, ESPERADO_TOTAL[tid])) throw new Error(`#${tid}: total legacy ${l.total} ≠ esperado ${ESPERADO_TOTAL[tid]}`);
    if (!mismoDinero(p.total, ESPERADO_TOTAL[tid])) throw new Error(`#${tid}: total nexus ${p.total} ≠ esperado ${ESPERADO_TOTAL[tid]}`);
    if (!mismoDinero(l.pamnt, ESPERADO_PAMNT[tid])) throw new Error(`#${tid}: pamnt legacy ${l.pamnt} ≠ esperado ${ESPERADO_PAMNT[tid]}`);
    if (!mismoDinero(p.paidAmount, ESPERADO_PAMNT[tid])) throw new Error(`#${tid}: paid nexus ${p.paidAmount} ≠ esperado ${ESPERADO_PAMNT[tid]}`);
    if (l.facturacion_electronica === 'Factura Electronica Creada') throw new Error(`#${tid} ya está timbrada`);
  }
  const txLeg = new Map();
  for (const [id, esp] of Object.entries(ESPERADO_TX)) {
    const [[t]] = await my.query('SELECT * FROM transactions WHERE id=?', [id]);
    const p = await prisma.transaction.findUnique({ where: { legacyId: Number(id) } });
    if (!t || !p) throw new Error(`movimiento ${id} falta en ${!t ? 'legacy' : 'nexus'}`);
    if (t.estado) throw new Error(`movimiento ${id} está ${t.estado}`);
    if (Number(t.tid) !== esp.tid) throw new Error(`movimiento ${id}: tid ${t.tid} ≠ ${esp.tid}`);
    if (p.invoiceId !== fPg.get(esp.tid).id) throw new Error(`movimiento ${id}: en nexus cuelga de otra factura`);
    if (!mismoDinero(t.credit, esp.credit) || !mismoDinero(p.credit, esp.credit)) throw new Error(`movimiento ${id}: legacy ${t.credit} / nexus ${p.credit} ≠ ${esp.credit}`);
    txLeg.set(Number(id), t);
  }
  const subscriberId = fPg.get(349865).subscriberId;

  console.log(`${LIVE ? 'APLICANDO' : 'EN SECO (no se escribe nada)'} — cliente ${CSD} (abonado 2683, HERNANDO CELIS)`);
  for (const [id, c] of Object.entries(COBROS)) {
    const t = txLeg.get(Number(id));
    const hijos = c.hijos.reduce((s, h) => s + h.monto, 0);
    console.log(`  cobro ${id} (${cop(num(t.credit))}, #${t.tid}): ${cop(num(t.credit) - hijos)} → #${c.padre}` +
      c.hijos.map((h) => ` · hijo ${cop(h.monto)} → #${h.destino}`).join(''));
  }
  console.log(`  condona ${cop(CONDONAR.monto)} en #${CONDONAR.tid} (descuento de cabecera)`);
  const antesLeg = await dineroLegacy(my), antesPg = await dineroNexus(prisma, subscriberId);
  console.log(`  plata vigente del cliente: legacy ${cop(antesLeg)} · nexus ${cop(antesPg)} · neto legacy ${cop(await netoLegacy(my))}`);
  for (const tid of tids) console.log(`  antes  #${tid}: total ${cop(num(fLeg.get(tid).total))} · pagado ${cop(num(fLeg.get(tid).pamnt))} · ${fLeg.get(tid).status}`);
  if (!LIVE) { await my.end(); await prisma.$disconnect(); return; }

  // ── Escritura: legacy y nexus en la misma jugada ───────────────────────────────
  await my.beginTransaction();
  try {
    const pamnt = Object.fromEntries(tids.map((t) => [t, num(fLeg.get(t).pamnt)]));
    const total = Object.fromEntries(tids.map((t) => [t, num(fLeg.get(t).total)]));
    const padres = []; // { id, credit, tid, note }
    const nuevas = []; // { legacyId, destino }
    for (const [idStr, c] of Object.entries(COBROS)) {
      const id = Number(idStr), t = txLeg.get(id), origen = Number(t.tid);
      let credit = num(t.credit);
      for (const h of c.hijos) {
        credit -= h.monto;
        pamnt[origen] -= h.monto;
        pamnt[h.destino] += h.monto;
        const [ins] = await my.execute(
          `INSERT INTO transactions (acid, account, type, cat, debit, credit, payer, payerid, method, date,
                                     tid, eid, note, ext, nombre_banco, id_banco, estado, no_mostrar, id_orden_payu)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [t.acid, t.account, t.type, t.cat, t.debit, h.monto, t.payer, t.payerid, t.method, t.date,
            h.destino, t.eid, notaMovida(t.note, origen, h.destino, `#adelantado_de_tr_id=${id}`), t.ext,
            t.nombre_banco, t.id_banco, t.estado, t.no_mostrar, t.id_orden_payu]);
        nuevas.push({ legacyId: ins.insertId, destino: h.destino });
      }
      let note = String(t.note ?? '');
      if (c.hijos.length) note = `${note} #credito_inicial=${num(t.credit)}`.slice(0, 255);
      if (c.padre !== origen) {
        pamnt[origen] -= credit;
        pamnt[c.padre] += credit;
        note = notaMovida(note, origen, c.padre, `#reasignado_de_factura=${origen}`);
      }
      await my.execute('UPDATE transactions SET credit=?, tid=?, note=? WHERE id=?', [credit, c.padre, note, id]);
      padres.push({ id, credit, tid: c.padre, note });
    }
    total[CONDONAR.tid] -= CONDONAR.monto;
    const lc = fLeg.get(CONDONAR.tid);
    const notaCondona = [String(lc.notes ?? '').trim(), NOTA_CONDONA].filter(Boolean).join(' · ').slice(0, 500);
    await my.execute('UPDATE invoices SET discount=discount+?, total=?, notes=? WHERE id=?',
      [CONDONAR.monto, total[CONDONAR.tid], notaCondona, lc.id]);
    for (const tid of tids) {
      const st = pamnt[tid] >= total[tid] ? 'paid' : pamnt[tid] > 0 ? 'partial' : 'due';
      await my.execute('UPDATE invoices SET pamnt=?, status=? WHERE id=?', [pamnt[tid], st, fLeg.get(tid).id]);
    }

    await prisma.$transaction(async (tx) => {
      const pc = fPg.get(CONDONAR.tid);
      await tx.subInvoice.update({
        where: { tid: CONDONAR.tid },
        data: { discount: num(pc.discount) + CONDONAR.monto, total: total[CONDONAR.tid], notes: notaCondona },
      });
      for (const tid of tids) {
        const st = mismoDinero(pamnt[tid], total[tid]) || pamnt[tid] >= total[tid] ? 'PAID' : pamnt[tid] > 0 ? 'PARTIAL' : 'DUE';
        await tx.subInvoice.update({ where: { tid }, data: { paidAmount: pamnt[tid], status: st } });
      }
      for (const p of padres) {
        await tx.transaction.update({
          where: { legacyId: p.id },
          data: { credit: p.credit, note: p.note, invoiceId: fPg.get(p.tid).id },
        });
      }
      for (const n of nuevas) {
        const [[fila]] = await my.query('SELECT * FROM transactions WHERE id=?', [n.legacyId]);
        await tx.transaction.create({ data: mapTx(fila, subscriberId, fPg.get(n.destino).id, null) });
      }
      // Invariantes: la misma plata en los dos lados, y cada factura diciendo lo mismo allá y acá.
      const despuesLeg = await dineroLegacy(my), despuesPg = await dineroNexus(tx, subscriberId);
      if (!mismoDinero(antesLeg, despuesLeg)) throw new Error(`legacy pasó de ${cop(antesLeg)} a ${cop(despuesLeg)}`);
      if (!mismoDinero(antesPg, despuesPg)) throw new Error(`nexus pasó de ${cop(antesPg)} a ${cop(despuesPg)}`);
      for (const tid of tids) {
        const [[f]] = await my.query('SELECT pamnt, total FROM invoices WHERE tid=?', [tid]);
        const p = await tx.subInvoice.findUnique({ where: { tid }, select: { paidAmount: true, total: true } });
        if (!mismoDinero(f.pamnt, p.paidAmount) || !mismoDinero(f.total, p.total)) throw new Error(`#${tid}: legacy ${f.pamnt}/${f.total} ≠ nexus ${p.paidAmount}/${p.total}`);
        if (!mismoDinero(f.pamnt, f.total)) throw new Error(`#${tid} no quedó saldada: pagado ${f.pamnt} de ${f.total}`);
        const sum = await tx.transaction.aggregate({ where: { invoiceId: fPg.get(tid).id, status: 'VIGENTE' }, _sum: { credit: true } });
        if (!mismoDinero(sum._sum.credit, p.paidAmount)) throw new Error(`#${tid}: movimientos ${sum._sum.credit} ≠ pagado ${p.paidAmount}`);
      }
      const neto = await netoLegacy(my);
      if (!mismoDinero(neto, 132000)) throw new Error(`neto legacy quedó en ${cop(neto)}, no 132.000`);
      await my.commit();
    });
    console.log(`  ✔ aplicado · movimientos nuevos en el legacy: ${nuevas.map((n) => n.legacyId).join(', ')}`);
    console.log(`  neto legacy ahora: ${cop(await netoLegacy(my))}`);
  } catch (e) {
    await my.rollback().catch(() => {});
    console.error(`  ✘ revertido: ${e.message}`);
    process.exitCode = 1;
  }
  await my.end();
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
