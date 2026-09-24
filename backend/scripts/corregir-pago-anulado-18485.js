/**
 * Corrección puntual (2026-09-17): abonada 53863, LEIDY AVELLA (CC 1118168071,
 * legacy customers.id 18485, sede Villanueva).
 *
 * El 12/05/2026 pagó 25.548 por Wompi (movimiento 487943, ref 50db8528…) — era el
 * prorrateo de abril (#443895) — y el legacy lo cargó a la #438444 (instalación,
 * 30.000), que ya estaba pagada: quedó con pamnt 55.548. El 23/06 volvió a pagar el
 * prorrateo dentro de otro pago de 66.000, y desde ahí cada pago mensual se partió
 * 25.548 + 40.452 hasta dejar julio (#452112) PARTIAL debiendo 25.548.
 * Por libros: facturado abr–ago 319.548 = pagado 319.548. Sólo debe septiembre.
 *
 * El 16/09 22:09 Johana Mancipe ANULÓ el 487943 ("tiene un saldo a favor de facturas
 * pasadas", a pedido de Mireya Aguilera), pero eso borró la plata sin darle el saldo.
 *
 * Qué hace, en los dos sistemas:
 *   · deshace la anulación del 487943 (se borran la fila `anulaciones` 4181 y su
 *     `Voiding`; queda respaldo JSON y AuditLog),
 *   · re-etiqueta ese pago a la #452112 (julio), que es la que realmente cubre,
 *   · #438444 → pamnt 30.000 PAID; #452112 → pamnt 66.000 PAID,
 *   · recalcula acumulados del cliente y saldo de la caja WOMPI.
 *
 * Uso: node scripts/corregir-pago-anulado-18485.js [--live]   (sin --live no escribe nada)
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

const LIVE = process.argv.includes('--live');
const CSD = 18485;
const TX = 487943;
const ANULACION = 4181;
const ORIGEN = 438444;
const DESTINO = 452112;
const MONTO = 25548;
const num = (v) => Number(v ?? 0);
const mismoDinero = (a, b) => Math.abs(Number(a) - Number(b)) < 1;
const ESPERADO = { [ORIGEN]: { pamnt: 55548, total: 30000 }, [DESTINO]: { pamnt: 40452, total: 66000 } };
const NOTA = `Pago de la factura #${DESTINO} LEIDY AVELLA 1118168071 metodo: WOMPI, Sede: Villanueva, referencia: 50db8528a41bb21a37eba3056e8060a9 #reasignado_de=${ORIGEN}`;

async function main() {
  const my = await mysql.createConnection({
    host: process.env.LEGACY_DB_HOST, port: Number(process.env.LEGACY_DB_PORT || 3306),
    user: process.env.LEGACY_DB_USER, password: process.env.LEGACY_DB_PASSWORD,
    database: process.env.LEGACY_DB_NAME, dateStrings: true,
  });

  // ── Frenos ──────────────────────────────────────────────────────────────────
  const [[tl]] = await my.query('SELECT * FROM transactions WHERE id=?', [TX]);
  const tp = await prisma.transaction.findUnique({ where: { legacyId: TX } });
  if (!tl || !tp) throw new Error('movimiento falta');
  if (tl.payerid !== CSD || tl.tid !== ORIGEN || tl.estado !== 'Anulada' || !mismoDinero(tl.credit, MONTO)) throw new Error(`legacy 487943 no está como se diagnosticó: ${JSON.stringify(tl)}`);
  if (tp.status !== 'ANULADA' || !mismoDinero(tp.credit, MONTO)) throw new Error(`nexus 487943 no está como se diagnosticó`);
  const [[al]] = await my.query('SELECT * FROM anulaciones WHERE id_anulacion=?', [ANULACION]);
  const vp = await prisma.voiding.findFirst({ where: { legacyId: ANULACION, transactionId: tp.id } });
  if (!al || al.transactions_id !== TX || !vp) throw new Error('la anulación no está como se diagnosticó');
  const [facts] = await my.query('SELECT * FROM invoices WHERE tid IN (?) AND csd=?', [[ORIGEN, DESTINO], CSD]);
  const fLeg = new Map(facts.map((f) => [f.tid, f]));
  const fPg = new Map((await prisma.subInvoice.findMany({ where: { tid: { in: [ORIGEN, DESTINO] } } })).map((f) => [f.tid, f]));
  for (const tid of [ORIGEN, DESTINO]) {
    const l = fLeg.get(tid), p = fPg.get(tid), e = ESPERADO[tid];
    if (!l || !p || p.subscriberId !== tp.subscriberId) throw new Error(`#${tid} falta o es de otro cliente`);
    if (p.editedAt) throw new Error(`#${tid} editada aquí`);
    if (!mismoDinero(l.pamnt, e.pamnt) || !mismoDinero(p.paidAmount, e.pamnt)) throw new Error(`#${tid}: pamnt legacy ${l.pamnt} / nexus ${p.paidAmount} ≠ ${e.pamnt}`);
    if (!mismoDinero(l.total, e.total) || !mismoDinero(p.total, e.total)) throw new Error(`#${tid}: total cambió`);
  }

  console.log(`${LIVE ? 'APLICANDO' : 'EN SECO (no se escribe nada)'} — cliente ${CSD}`);
  console.log(`  deshace anulación ${ANULACION} del movimiento ${TX} ($25.548) y lo pasa de #${ORIGEN} a #${DESTINO}`);
  if (!LIVE) { await my.end(); await prisma.$disconnect(); return; }

  const respaldo = { fecha: new Date().toISOString(), tl, tp, al, vp, fLeg: [...fLeg.values()], fPg: [...fPg.values()] };
  const dir = '/home/dev/backups';
  fs.mkdirSync(dir, { recursive: true });
  const archivo = path.join(dir, `pago-anulado-18485-${Date.now()}.json`);
  fs.writeFileSync(archivo, JSON.stringify(respaldo, null, 2));
  console.log(`  respaldo: ${archivo}`);

  await my.beginTransaction();
  try {
    await my.execute('DELETE FROM anulaciones WHERE id_anulacion=?', [ANULACION]);
    await my.execute('UPDATE transactions SET estado=NULL, tid=?, note=? WHERE id=?', [DESTINO, NOTA, TX]);
    await my.execute(`UPDATE invoices SET pamnt=?, status='paid' WHERE id=?`, [30000, fLeg.get(ORIGEN).id]);
    await my.execute(`UPDATE invoices SET pamnt=?, status='paid', pmethod='WOMPI' WHERE id=?`, [66000, fLeg.get(DESTINO).id]);
    await my.execute(
      `UPDATE customers SET
         debit  = (SELECT COALESCE(SUM(debit), 0)  FROM transactions WHERE payerid = ? AND estado IS NULL AND ext = '0'),
         credit = (SELECT COALESCE(SUM(credit), 0) FROM transactions WHERE payerid = ? AND estado IS NULL AND ext = '0')
       WHERE id = ?`, [CSD, CSD, CSD]);

    await prisma.$transaction(async (tx) => {
      await tx.voiding.delete({ where: { id: vp.id } });
      await tx.transaction.update({
        where: { id: tp.id },
        data: { status: 'VIGENTE', invoiceId: fPg.get(DESTINO).id, note: NOTA },
      });
      await tx.subInvoice.update({ where: { tid: ORIGEN }, data: { paidAmount: 30000, status: 'PAID' } });
      await tx.subInvoice.update({ where: { tid: DESTINO }, data: { paidAmount: 66000, status: 'PAID' } });
      const agg = await tx.transaction.aggregate({
        _sum: { debit: true, credit: true }, where: { subscriberId: tp.subscriberId, status: 'VIGENTE', ext: false },
      });
      await tx.subscriber.update({
        where: { id: tp.subscriberId },
        data: { debitCache: agg._sum.debit ?? 0, creditCache: agg._sum.credit ?? 0 },
      });
      const acc = await tx.cashAccount.findFirst({ where: { legacyId: tp.cashAccountId }, select: { id: true } });
      if (acc) {
        const c = await tx.transaction.aggregate({ _sum: { credit: true, debit: true }, where: { cashAccountId: tp.cashAccountId, status: 'VIGENTE' } });
        await tx.cashAccount.update({ where: { id: acc.id }, data: { balance: Math.round((num(c._sum.credit) - num(c._sum.debit)) * 100) / 100 } });
      }
      await tx.auditLog.create({
        data: {
          action: 'UNVOID', entity: 'treasury/transactions', entityId: tp.id,
          before: { status: 'ANULADA', invoice: ORIGEN, voiding: ANULACION },
          after: {
            status: 'VIGENTE', invoice: DESTINO, backup: archivo,
            reason: 'Pago Wompi real del 12-may aplicado a factura ya pagada; se reasigna a julio. Pedido de soporte 2026-09-17.',
          },
        },
      });
      // Invariante: cada factura dice lo mismo allá y acá, y cuadra con sus pagos vigentes.
      for (const tid of [ORIGEN, DESTINO]) {
        const [[s]] = await my.query(`SELECT COALESCE(SUM(credit),0) p FROM transactions WHERE tid=? AND (estado IS NULL OR estado='')`, [tid]);
        const p = await tx.transaction.aggregate({ _sum: { credit: true }, where: { invoiceId: fPg.get(tid).id, status: 'VIGENTE' } });
        const esperado = ESPERADO[tid].total;
        if (!mismoDinero(s.p, esperado) || !mismoDinero(p._sum.credit, esperado)) throw new Error(`#${tid}: pagos legacy ${s.p} / nexus ${p._sum.credit} ≠ ${esperado}`);
      }
      await my.commit();
    });
    console.log('  ✔ aplicado');
  } catch (e) {
    await my.rollback().catch(() => {});
    console.error(`  ✘ revertido: ${e.message}`);
    process.exitCode = 1;
  }
  await my.end();
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
