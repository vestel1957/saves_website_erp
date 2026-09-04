/**
 * Alinea una caja de nexus con la MISMA caja del legacy, fila por fila.
 *
 * POR QUÉ: la ida (`sync-legacy-vivo`) trae las transacciones de forma **incremental por
 * id** (`WHERE id > watermark`) y NUNCA relee lo ya importado. Consecuencia: todo lo que
 * el legacy le haga a una fila DESPUÉS de que la trajimos es invisible aquí —editar el
 * importe, moverla de caja, cambiarle la fecha o borrarla—. Con los meses eso separa las
 * dos cajas sin que nadie lo note hasta que un cierre no cuadra.
 *
 * Medido en la caja Villanueva (2026-08-25): 74 pagos borrados allá que aquí seguían
 * contados, 42 importes editados, 1 barrido archivado en otra caja y 1 pata de arrastre
 * duplicada.
 *
 * QUÉ HACE (el legacy manda, es el sistema vivo):
 *   · importe/fecha distintos  → los pone como están allá
 *   · anulada allá y aquí no   → la marca ANULADA (con su rastro en `Voiding` si lo hay)
 *   · borrada allá             → la BORRA aquí (con copia previa en --respaldo)
 *   · está allá y no aquí      → sólo lo REPORTA: crearla es trabajo de la ida, no de esto
 *   · nacida aquí (sin legacyId) → sólo lo REPORTA: no es desajuste, es trabajo pendiente
 *     de viajar (o una prueba). Ver `LEGACY_WRITEBACK_CAJA_LIVE`.
 *
 * Recalcula `CashAccount.balance` al terminar (es SUM(credit-debit) de las VIGENTES y si
 * no se toca sólo se corrige con el siguiente movimiento de esa caja).
 *
 * Uso:  node scripts/alinear-caja-con-legacy.js --caja=1 [--desde=2026-07-01] [--aplicar]
 * Sin `--aplicar` va en SECO: enseña el plan y no escribe nada.
 * Imprime un JSON de resumen en la última línea.
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
const dbUrl = (u => u ? u + (u.includes('?') ? '&' : '?') + 'connection_limit=5' : u)(process.env.DATABASE_URL);
const prisma = new PrismaClient(dbUrl ? { datasources: { db: { url: dbUrl } } } : undefined);

const MYSQL = {
  host: process.env.LEGACY_DB_HOST || '127.0.0.1',
  port: Number(process.env.LEGACY_DB_PORT || 3306),
  user: process.env.LEGACY_DB_USER,
  password: process.env.LEGACY_DB_PASSWORD,
  database: process.env.LEGACY_DB_NAME || 'admin_vestel',
  dateStrings: true, supportBigNumbers: true, bigNumberStrings: false,
};

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split('=')[1] : d;
};
const CAJA = Number(arg('caja', 0));
const DESDE = arg('desde', '2026-01-01');
const APLICAR = process.argv.includes('--aplicar');
const RESPALDO = arg('respaldo', `/home/dev/backups/alinear-caja-${CAJA}-${DESDE}`);
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const cop = (n) => new Intl.NumberFormat('es-CO').format(Math.round(n));
const iso = (d) => d.toISOString().slice(0, 10);

async function main() {
  if (!CAJA) throw new Error('Falta --caja=<legacyId de la caja>');
  if (!MYSQL.user || !MYSQL.password) throw new Error('Faltan LEGACY_DB_USER / LEGACY_DB_PASSWORD');
  const t0 = Date.now();
  const my = await mysql.createConnection(MYSQL);

  const cuenta = await prisma.cashAccount.findUnique({ where: { legacyId: CAJA }, select: { holder: true } });
  log(`caja ${CAJA} (${cuenta?.holder ?? '?'}) desde ${DESDE} · ${APLICAR ? 'APLICANDO' : 'SECO (plan)'}`);

  // Lado legacy. Se trae también si tiene anulación, que es como el legacy marca que una
  // fila ya no cuenta (su `estado` está a NULL en todas las filas: no lo usa).
  const [filas] = await my.query(
    `SELECT t.id, t.acid, t.date, t.credit, t.debit, t.no_mostrar,
            (a.id_anulacion IS NOT NULL) AS anulada
       FROM transactions t
       LEFT JOIN anulaciones a ON a.transactions_id = t.id
      WHERE t.date >= ?`, [DESDE],
  );
  const legacy = new Map(filas.map((r) => [r.id, r]));

  const nuestras = await prisma.transaction.findMany({
    where: { cashAccountId: CAJA, date: { gte: new Date(`${DESDE}T00:00:00.000Z`) } },
    select: { id: true, legacyId: true, date: true, credit: true, debit: true, status: true, noShow: true, note: true },
  });

  const plan = { importes: [], fechas: [], anular: [], borrar: [], nacidasAqui: [], otraCaja: [] };
  for (const t of nuestras) {
    if (t.legacyId == null) { plan.nacidasAqui.push({ id: t.id, monto: Number(t.credit) - Number(t.debit), note: t.note }); continue; }
    const r = legacy.get(t.legacyId);
    if (!r) { plan.borrar.push({ id: t.id, legacyId: t.legacyId, monto: Number(t.credit) - Number(t.debit), fecha: iso(t.date) }); continue; }
    // Movida de caja en el legacy: aquí se queda en la vieja para siempre.
    if (r.acid !== CAJA) plan.otraCaja.push({ id: t.id, legacyId: t.legacyId, aqui: CAJA, alla: r.acid });
    if (Number(r.credit) !== Number(t.credit) || Number(r.debit) !== Number(t.debit)) {
      plan.importes.push({ id: t.id, legacyId: t.legacyId, credit: Number(r.credit), debit: Number(r.debit),
        antes: Number(t.credit) - Number(t.debit), ahora: Number(r.credit) - Number(r.debit) });
    }
    if (r.date !== iso(t.date)) plan.fechas.push({ id: t.id, legacyId: t.legacyId, de: iso(t.date), a: r.date });
    const anuladaAlla = !!Number(r.anulada);
    if (anuladaAlla && t.status !== 'ANULADA') plan.anular.push({ id: t.id, legacyId: t.legacyId });
  }

  // Lo que está allá y aquí no: la ida debería traerlo. Se reporta, no se inventa.
  const nuestrosIds = new Set(nuestras.map((t) => t.legacyId).filter((x) => x != null));
  const faltanAqui = [...legacy.values()].filter((r) => r.acid === CAJA && !nuestrosIds.has(r.id));

  const resumen = {
    ok: true, mode: 'alinear-caja', caja: CAJA, holder: cuenta?.holder ?? null, desde: DESDE, aplicado: APLICAR,
    revisadas: nuestras.length,
    importes: plan.importes.length, fechas: plan.fechas.length, anular: plan.anular.length,
    borrar: plan.borrar.length, montoBorrado: plan.borrar.reduce((a, b) => a + b.monto, 0),
    otraCaja: plan.otraCaja.length, nacidasAqui: plan.nacidasAqui.length, faltanAqui: faltanAqui.length,
  };
  log(`importes ${resumen.importes} · fechas ${resumen.fechas} · a anular ${resumen.anular}`
    + ` · a borrar ${resumen.borrar} (${cop(resumen.montoBorrado)}) · en otra caja allá ${resumen.otraCaja}`
    + ` · nacidas aquí ${resumen.nacidasAqui} · faltan aquí ${resumen.faltanAqui}`);

  if (!APLICAR) {
    console.log(JSON.stringify({ ...resumen, plan, ms: Date.now() - t0 }));
    await my.end(); await prisma.$disconnect();
    return;
  }

  // Copia de lo que se va a borrar o cambiar, ANTES de tocarlo.
  fs.mkdirSync(RESPALDO, { recursive: true });
  const tocadas = [...plan.borrar, ...plan.importes, ...plan.fechas, ...plan.anular].map((x) => x.id);
  if (tocadas.length) {
    const copia = await prisma.transaction.findMany({ where: { id: { in: tocadas } } });
    fs.writeFileSync(path.join(RESPALDO, 'antes.json'), JSON.stringify(copia, null, 1));
    log(`respaldo de ${copia.length} filas en ${RESPALDO}/antes.json`);
  }

  for (const x of plan.importes) {
    await prisma.transaction.update({ where: { id: x.id }, data: { credit: x.credit, debit: x.debit } });
  }
  for (const x of plan.fechas) {
    await prisma.transaction.update({ where: { id: x.id }, data: { date: new Date(`${x.a}T00:00:00.000Z`) } });
  }
  if (plan.anular.length) {
    await prisma.transaction.updateMany({ where: { id: { in: plan.anular.map((x) => x.id) } }, data: { status: 'ANULADA' } });
  }
  if (plan.borrar.length) {
    const ids = plan.borrar.map((x) => x.id);
    await prisma.receiptTransaction.deleteMany({ where: { transactionId: { in: ids } } });
    await prisma.transaction.deleteMany({ where: { id: { in: ids } } });
  }
  for (const x of plan.otraCaja) {
    await prisma.transaction.update({ where: { id: x.id }, data: { cashAccountId: x.alla } });
  }

  // `CashAccount.balance` es SUM(credit-debit) de las VIGENTES: se recalcula aquí porque
  // si no, sólo se corregiría con el siguiente movimiento de esa caja.
  const cajasTocadas = [...new Set([CAJA, ...plan.otraCaja.map((x) => x.alla)])];
  for (const c of cajasTocadas) {
    const agg = await prisma.transaction.aggregate({
      _sum: { credit: true, debit: true }, where: { cashAccountId: c, status: 'VIGENTE' },
    });
    const balance = Number(agg._sum.credit ?? 0) - Number(agg._sum.debit ?? 0);
    await prisma.cashAccount.updateMany({ where: { legacyId: c }, data: { balance } });
  }
  log(`saldo recalculado en ${cajasTocadas.length} caja(s)`);

  console.log(JSON.stringify({ ...resumen, respaldo: RESPALDO, ms: Date.now() - t0 }));
  await my.end(); await prisma.$disconnect();
}

main().catch(async (e) => {
  console.log(JSON.stringify({ ok: false, mode: 'alinear-caja', error: e.message }));
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
