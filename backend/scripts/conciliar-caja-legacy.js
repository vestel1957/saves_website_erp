/**
 * Conciliación de caja  saves_vestel (PostgreSQL)  ↔  admin_vestel (MySQL VIVO).
 *
 * POR QUÉ EXISTE (2026-08-25, caso real):
 * El cierre de la caja Villanueva del 24-ago decía 15,7 M aquí y 13,3 M allá. La
 * diferencia eran **36 pagos que el legacy ya no tenía**: sus filas de `transactions`
 * habían sido BORRADAS, pero la factura seguía en `paid` y el recibo seguía impreso
 * en `recibos_de_pago`. O sea, plata cobrada de verdad que desapareció del libro de
 * allá. Mirando hacia atrás había lo mismo el 19 y el 22: 74 pagos, 5.281.000 en total.
 *
 * El legacy borra pagos sin dejar rastro —su "anular factura" (`Transactions::
 * cancelinvoice`) corre un `DELETE FROM transactions` a pelo— y no queda fila en
 * `anulaciones`. Nadie se entera hasta que alguien nota que un cierre no cuadra.
 *
 * QUÉ HACE: por cada movimiento de efectivo que este sistema tiene enlazado al legacy
 * (`legacyId`), comprueba que la fila siga viva allá. Lo que falta se reporta con
 * nombre, factura, monto y recibo. NO borra ni resucita nada: la ida tampoco propaga
 * borrados de `transactions` a propósito —hacerlo aquí nos habría hecho perder los
 * 5,2 M sin que nadie los viera pasar—. Esto es un detector, no un corrector.
 *
 * También mira el otro lado (filas de efectivo del legacy que aquí no están), que es
 * ruido normal si acaban de registrarse: se informa aparte y no cuenta como hallazgo.
 *
 * Uso:  node scripts/conciliar-caja-legacy.js [--dias=7]
 * Imprime un JSON de resumen en la última línea (lo consume CronService).
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

const arg = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : def;
};
const DIAS = Math.max(1, Number(arg('dias', 7)) || 7);
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const cop = (n) => new Intl.NumberFormat('es-CO').format(Math.round(n));

/**
 * Mismo criterio de "efectivo del cajón" que el cierre (`cierre-legacy.ts`):
 * `method='Cash'` MÁS `type=TRANSFER`, sin anuladas y sin `no_mostrar`. Si se
 * conciliara TODO el libro saldrían diferencias de banco que no son un borrado.
 */
const CASH = ['Cash', 'cash'];

async function main() {
  if (!MYSQL.user || !MYSQL.password) throw new Error('Faltan LEGACY_DB_USER / LEGACY_DB_PASSWORD en el entorno');
  const t0 = Date.now();
  const desde = new Date(Date.now() - DIAS * 86_400_000);
  desde.setUTCHours(0, 0, 0, 0);
  const my = await mysql.createConnection(MYSQL);

  const nuestras = await prisma.transaction.findMany({
    where: {
      legacyId: { not: null }, status: 'VIGENTE', noShow: false,
      date: { gte: desde },
      OR: [{ method: { in: CASH } }, { type: 'TRANSFER' }],
    },
    select: {
      id: true, legacyId: true, date: true, credit: true, debit: true, cashAccountId: true,
      payerName: true, note: true,
      invoice: { select: { tid: true } },
      receiptLinks: { select: { receipt: { select: { legacyId: true } } } },
    },
  });

  // `Transaction.cashAccountId` guarda el id LEGACY de la caja (no hay relación en el
  // esquema), así que el nombre se resuelve aparte y de una vez para todas.
  const cajas = new Map(
    (await prisma.cashAccount.findMany({ select: { legacyId: true, holder: true } }))
      .map((c) => [c.legacyId, c.holder]),
  );

  const [filas] = await my.query(
    'SELECT id FROM transactions WHERE date >= ?', [desde.toISOString().slice(0, 10)],
  );
  const vivas = new Set(filas.map((r) => r.id));

  const borradas = nuestras
    .filter((t) => !vivas.has(t.legacyId))
    .map((t) => ({
      legacyId: t.legacyId,
      fecha: t.date.toISOString().slice(0, 10),
      caja: cajas.get(t.cashAccountId) ?? String(t.cashAccountId ?? '—'),
      cliente: t.payerName ?? '—',
      factura: t.invoice?.tid ?? null,
      monto: Math.trunc(Number(t.credit) - Number(t.debit)),
      recibo: t.receiptLinks.map((l) => l.receipt?.legacyId).find(Boolean) ?? null,
    }))
    .sort((a, b) => (a.fecha === b.fecha ? a.legacyId - b.legacyId : a.fecha.localeCompare(b.fecha)));

  /**
   * El desempate que convierte "falta una fila" en "se perdió plata": si la factura
   * sigue PAGA en el legacy y el recibo sigue emitido, el cobro ocurrió de verdad y
   * lo que se borró fue el asiento. Sin este chequeo no se puede distinguir un
   * borrado real de una anulación legítima que el legacy hizo bien.
   */
  const conFactura = borradas.filter((b) => b.factura);
  let pagadasAllá = new Set();
  if (conFactura.length) {
    const [inv] = await my.query(
      `SELECT tid FROM invoices WHERE status='paid' AND tid IN (${conFactura.map(() => '?').join(',')})`,
      conFactura.map((b) => b.factura),
    );
    pagadasAllá = new Set(inv.map((r) => r.tid));
  }
  for (const b of borradas) b.facturaSiguePaga = !!(b.factura && pagadasAllá.has(b.factura));

  // El otro sentido: efectivo que está allá y aquí todavía no. Casi siempre es un
  // cobro recién hecho que la próxima pasada de la ida traerá; se informa, no alarma.
  const nuestrosIds = new Set(nuestras.map((t) => t.legacyId));
  const [suyas] = await my.query(
    `SELECT id, date, truncate(credit-debit,0) AS monto FROM transactions
      WHERE date >= ? AND no_mostrar = 0 AND (method = 'Cash' OR type = 'Transfer')`,
    [desde.toISOString().slice(0, 10)],
  );
  const pendientesDeIda = suyas.filter((r) => !nuestrosIds.has(r.id));

  const porCaja = {};
  for (const b of borradas) {
    const k = `${b.caja} · ${b.fecha}`;
    porCaja[k] = porCaja[k] ?? { n: 0, monto: 0 };
    porCaja[k].n++; porCaja[k].monto += b.monto;
  }

  const total = borradas.reduce((a, b) => a + b.monto, 0);
  const conRespaldo = borradas.filter((b) => b.facturaSiguePaga).length;

  if (borradas.length) {
    log(`⚠️ ${borradas.length} movimientos de efectivo BORRADOS en el legacy · ${cop(total)} COP`);
    for (const [k, v] of Object.entries(porCaja)) log(`   ${k}: ${v.n} pagos · ${cop(v.monto)}`);
    if (conRespaldo) log(`   ${conRespaldo} con la factura todavía PAGA allá → el cobro fue real, se borró el asiento`);
  } else {
    log(`sin borrados en los últimos ${DIAS} días`);
  }
  if (pendientesDeIda.length) log(`${pendientesDeIda.length} movimientos del legacy aún no sincronizados aquí (normal si son de ahora)`);

  console.log(JSON.stringify({
    ok: true, mode: 'conciliacion-caja', dias: DIAS, desde: desde.toISOString().slice(0, 10),
    revisadas: nuestras.length,
    borradasEnLegacy: borradas.length,
    montoBorrado: total,
    conFacturaPagaAlla: conRespaldo,
    porCaja,
    detalle: borradas.slice(0, 200),
    pendientesDeIda: pendientesDeIda.length,
    ms: Date.now() - t0,
  }));
  await my.end(); await prisma.$disconnect();
}

main().catch(async (e) => {
  console.log(JSON.stringify({ ok: false, mode: 'conciliacion-caja', error: e.message }));
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
