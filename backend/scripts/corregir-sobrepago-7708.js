/**
 * Corrección puntual (2026-09-10): abonada 15, MARIA DEL TRANSITO DAZA (CC 41479509,
 * legacy customers.id 7708, sede Villanueva).
 *
 * El 08/08/2024 pagó 120.000 y el legacy los cargó ENTEROS a la factura #318921 (30.000).
 * Al día siguiente la cortaron y no se facturó sep–nov 2024, así que el excedente (90.000)
 * nunca se consumió. Además el legacy dio por pagadas, SIN ningún movimiento detrás, la
 * #349353 (ene-2025, con el excedente del pago del 28/12/2024 sobre la #347871) y la #446947
 * (jun-2026, con parte del de la #318921), pero sin rebajar el `pamnt` de la factura origen:
 * ese excedente ya se había gastado y seguía figurando.
 *
 * Cuentas desde jul-2024: 24 facturas × 30.000 = 720.000; cobrado vigente = 690.000.
 * Por los libros debía 30.000, pero la sede decidió dejarla debiendo 60.000 (ago + sep 2026):
 * con el excedente sólo se cubre julio. Los 30.000 que sobran se quedan en la #318921
 * (pamnt 60.000): la plata no se borra, y la deuda se suma factura por factura sin negativos,
 * así que no le rebaja nada a ago/sep.
 *
 * Qué hace — el mismo mecanismo que `repartir-adelantos-legacy.js`, en los dos sistemas:
 * parte los cobros originales y re-etiqueta la plata a la factura que realmente cubrió.
 *   · RESPALDO: la destino ya está pagada sin movimiento → sólo se le da el movimiento.
 *   · CUBRIR:   la destino está debiendo → se le sube `pamnt` y se salda.
 * La plata total del cliente no cambia (se verifica y si no cuadra se revierte todo).
 *
 * Uso: node scripts/corregir-sobrepago-7708.js [--live]   (sin --live no escribe nada)
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
const CSD = 7708;
const num = (v) => Number(v ?? 0);
const cop = (n) => '$' + Math.round(n).toLocaleString('es-CO');
const mismoDinero = (a, b) => Math.abs(Number(a) - Number(b)) < 1;

/** origen → destino, monto; y el movimiento del cobro que se parte. */
const PARES = [
  { origen: 318921, destino: 446947, monto: 30000, modo: 'RESPALDO', tx: 349468 }, // jun-2026
  { origen: 318921, destino: 450682, monto: 30000, modo: 'CUBRIR', tx: 349468 },   // jul-2026
  { origen: 347871, destino: 349353, monto: 30000, modo: 'RESPALDO', tx: 381150 }, // ene-2025
];
/** Cómo tiene que estar todo ANTES; si algo cambió, no se toca nada. */
const ESPERADO_PAMNT = { 318921: 120000, 347871: 60000, 446947: 30000, 349353: 30000, 450682: 0 };
const ESPERADO_CREDIT = { 349468: 120000, 381150: 60000 };

function notaHija(nota, tidOrigen, tidDestino, idPadre) {
  const base = String(nota ?? '').replace(new RegExp(String(tidOrigen), 'g'), String(tidDestino));
  return `${base} #adelantado_de_tr_id=${idPadre}`.slice(0, 255);
}
function notaPadre(nota, creditOriginal) {
  const s = String(nota ?? '');
  if (s.toLowerCase().includes('credito_inicial')) return s;
  return `${s} #credito_inicial=${creditOriginal}`.slice(0, 255);
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
    if (p.editedAt) throw new Error(`factura #${tid} editada aquí`);
    if (!mismoDinero(l.pamnt, ESPERADO_PAMNT[tid])) throw new Error(`#${tid}: pamnt legacy ${l.pamnt} ≠ esperado ${ESPERADO_PAMNT[tid]}`);
    if (!mismoDinero(p.paidAmount, ESPERADO_PAMNT[tid])) throw new Error(`#${tid}: paid nexus ${p.paidAmount} ≠ esperado ${ESPERADO_PAMNT[tid]}`);
  }
  for (const par of PARES.filter((x) => x.modo === 'RESPALDO')) {
    const [vivos] = await my.query(`SELECT id FROM transactions WHERE tid=? AND (estado IS NULL OR estado='') AND credit>0`, [par.destino]);
    if (vivos.length) throw new Error(`#${par.destino} ya tiene movimientos vigentes (${vivos.map((v) => v.id)}): no es pago fantasma`);
  }
  const txLeg = new Map();
  for (const [id, credit] of Object.entries(ESPERADO_CREDIT)) {
    const [[t]] = await my.query('SELECT * FROM transactions WHERE id=?', [id]);
    const p = await prisma.transaction.findUnique({ where: { legacyId: Number(id) } });
    if (!t || !p) throw new Error(`movimiento ${id} falta en ${!t ? 'legacy' : 'nexus'}`);
    if (t.estado) throw new Error(`movimiento ${id} está ${t.estado}`);
    if (!mismoDinero(t.credit, credit) || !mismoDinero(p.credit, credit)) throw new Error(`movimiento ${id}: legacy ${t.credit} / nexus ${p.credit} ≠ ${credit}`);
    txLeg.set(Number(id), t);
  }
  const subscriberId = fPg.get(318921).subscriberId;

  console.log(`${LIVE ? 'APLICANDO' : 'EN SECO (no se escribe nada)'} — cliente ${CSD}`);
  for (const p of PARES) console.log(`  ${p.modo.padEnd(8)} #${p.origen} → #${p.destino}  ${cop(p.monto)}  (parte el movimiento ${p.tx})`);
  const antesLeg = await dineroLegacy(my), antesPg = await dineroNexus(prisma, subscriberId);
  console.log(`  plata vigente del cliente: legacy ${cop(antesLeg)} · nexus ${cop(antesPg)}`);
  if (!LIVE) { await my.end(); await prisma.$disconnect(); return; }

  // ── Escritura: legacy y nexus en la misma jugada ───────────────────────────────
  await my.beginTransaction();
  try {
    const pamnt = Object.fromEntries(tids.map((t) => [t, num(fLeg.get(t).pamnt)]));
    const credit = Object.fromEntries([...txLeg].map(([id, t]) => [id, num(t.credit)]));
    const nuevas = [];
    for (const p of PARES) {
      pamnt[p.origen] -= p.monto;
      if (p.modo === 'CUBRIR') pamnt[p.destino] += p.monto;
      const t = txLeg.get(p.tx);
      credit[p.tx] -= p.monto;
      const [ins] = await my.execute(
        `INSERT INTO transactions (acid, account, type, cat, debit, credit, payer, payerid, method, date,
                                   tid, eid, note, ext, nombre_banco, id_banco, estado, no_mostrar, id_orden_payu)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [t.acid, t.account, t.type, t.cat, t.debit, p.monto, t.payer, t.payerid, t.method, t.date,
          p.destino, t.eid, notaHija(t.note, p.origen, p.destino, t.id), t.ext,
          t.nombre_banco, t.id_banco, t.estado, t.no_mostrar, t.id_orden_payu]);
      nuevas.push({ legacyId: ins.insertId, destino: p.destino });
    }
    for (const [id, c] of Object.entries(credit)) {
      const t = txLeg.get(Number(id));
      await my.execute('UPDATE transactions SET credit=?, note=? WHERE id=?', [c, notaPadre(t.note, num(t.credit)), id]);
    }
    for (const tid of tids) {
      const total = num(fLeg.get(tid).total);
      const st = pamnt[tid] >= total ? 'paid' : pamnt[tid] > 0 ? 'partial' : 'due';
      await my.execute('UPDATE invoices SET pamnt=?, status=?, pmethod=? WHERE id=?', [pamnt[tid], st, 'Cash', fLeg.get(tid).id]);
    }

    await prisma.$transaction(async (tx) => {
      for (const tid of tids) {
        const total = num(fPg.get(tid).total);
        const st = mismoDinero(pamnt[tid], total) || pamnt[tid] >= total ? 'PAID' : pamnt[tid] > 0 ? 'PARTIAL' : 'DUE';
        await tx.subInvoice.update({ where: { tid }, data: { paidAmount: pamnt[tid], status: st } });
      }
      for (const [id, c] of Object.entries(credit)) {
        const t = txLeg.get(Number(id));
        await tx.transaction.update({ where: { legacyId: Number(id) }, data: { credit: c, note: notaPadre(t.note, num(t.credit)) } });
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
        const [[f]] = await my.query('SELECT pamnt FROM invoices WHERE tid=?', [tid]);
        const p = await tx.subInvoice.findUnique({ where: { tid }, select: { paidAmount: true } });
        if (!mismoDinero(f.pamnt, p.paidAmount)) throw new Error(`#${tid}: legacy ${f.pamnt} ≠ nexus ${p.paidAmount}`);
      }
      await my.commit();
    });
    console.log(`  ✔ aplicado · movimientos nuevos en el legacy: ${nuevas.map((n) => n.legacyId).join(', ')}`);
  } catch (e) {
    await my.rollback().catch(() => {});
    console.error(`  ✘ revertido: ${e.message}`);
    process.exitCode = 1;
  }
  await my.end();
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
