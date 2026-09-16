/**
 * DESHACER un cierre de caja — el de un día que nunca debió cerrarse.
 *
 * POR QUÉ EXISTE
 * ──────────────
 * El cierre no es una fila de una tabla "cierres": son DOS transacciones con la nota
 * `Saldo <fecha>` —un EXPENSE el día que se cierra y un INCOME el próximo día hábil—
 * y no hay ninguna pantalla que las quite. Un día cerrado se queda cerrado.
 *
 * Eso normalmente está bien (cerrar dos veces duplicaría el arrastre), pero deja sin
 * salida un caso concreto: cerrar HOY por error. El panel pasa a "Caja cerrada", el
 * botón de abrir deja de pintarse y la cajera no puede trabajar. Le pasó a Yopal el
 * 2026-09-04: la pantalla de cierre viene puesta en hoy, a primera hora el cajón
 * enseñaba el arrastre de ayer, y se cerró el día de hoy a las 7:48 de la mañana.
 *
 * (El agujero ya está tapado en `createCashClose`: un día sin movimientos propios se
 * rechaza con `motivo: 'sin-actividad'`. Esto es para limpiar lo que quedó escrito.)
 *
 * LAS DOS BASES
 * ─────────────
 * Las dos patas viajan al legacy por el writeback, así que existen también en su tabla
 * `transactions`. Borrarlas SÓLO aquí no sirve de nada: la pasada de caja las vuelve a
 * traer a los cinco minutos. Por eso se borra primero en MySQL y después en Postgres.
 *
 * Uso:
 *   npx ts-node --transpile-only scripts/deshacer-cierre-caja.ts --caja=3 --fecha=2026-09-04
 *   ... --live     para escribir de verdad (sin esto sólo enseña lo que haría)
 */
import { PrismaClient, Prisma } from '@prisma/client';
import mysql from 'mysql2/promise';
import { readFileSync } from 'node:fs';

// El .env a mano: este script se corre suelto, sin el arranque de la API.
for (const linea of readFileSync('.env', 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(linea.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const LIVE = process.argv.includes('--live');
const CAJA = Number(arg('caja'));
const FECHA = arg('fecha');

const cop = (n: number) => n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });

async function main() {
  if (!CAJA || !FECHA || !/^\d{4}-\d{2}-\d{2}$/.test(FECHA)) {
    throw new Error('Uso: --caja=<legacyId de la caja> --fecha=YYYY-MM-DD [--live]');
  }
  const prisma = new PrismaClient();
  const nota = `Saldo ${FECHA}`;

  const cuenta = await prisma.cashAccount.findUnique({
    where: { legacyId: CAJA }, select: { holder: true },
  });
  if (!cuenta) throw new Error(`No hay caja con legacyId=${CAJA}`);

  // Las dos patas se emparejan por la NOTA, no por la fecha: ambas llevan la del cierre
  // (el INCOME cae en el próximo día hábil, que puede ser el lunes).
  const patas = await prisma.transaction.findMany({
    where: { cashAccountId: CAJA, note: nota, status: 'VIGENTE' },
    select: { id: true, type: true, date: true, debit: true, credit: true, legacyId: true, payerName: true, createdAt: true },
    orderBy: { date: 'asc' },
  });

  console.log(`\nCaja ${CAJA} (${cuenta.holder}) · cierre "${nota}"`);
  if (!patas.length) { console.log('  No hay ningún cierre con esa nota. Nada que deshacer.'); await prisma.$disconnect(); return; }
  for (const p of patas) {
    const monto = Number(p.type === 'EXPENSE' ? p.debit : p.credit);
    console.log(`  ${p.type.padEnd(7)} ${p.date.toISOString().slice(0, 10)}  ${cop(monto).padStart(14)}  legacyId=${p.legacyId ?? '—'}  ${p.payerName ?? ''}`);
  }

  // Guarda: sólo se deshace un cierre que no debió existir, o sea el de un día SIN
  // movimientos propios. Si ese día tuvo recaudo de verdad, el cierre es legítimo y
  // quitarlo descuadraría el arrastre de toda la cadena de días siguientes.
  const [{ propios }] = await prisma.$queryRaw<{ propios: number }[]>(Prisma.sql`
    SELECT COUNT(*)::int AS propios FROM "Transaction"
    WHERE "cashAccountId" = ${CAJA} AND status = 'VIGENTE' AND "date" = ${FECHA}::date
      AND (note IS NULL OR NOT (note ~ '^Saldo [0-9]{4}-[0-9]{2}-[0-9]{2}$'))`);
  console.log(`  Movimientos propios del ${FECHA}: ${propios}`);
  if (propios > 0) {
    throw new Error(
      `Ese día tiene ${propios} movimiento(s) propios: el cierre es legítimo y NO se deshace desde aquí. ` +
      'Quitarlo movería el arrastre de todos los días siguientes.',
    );
  }

  const ids = patas.map((p) => p.legacyId).filter((x): x is number => x != null);
  if (!LIVE) {
    console.log(`\n[DRY-RUN] Borraría ${patas.length} fila(s) en Postgres y ${ids.length} en el legacy (ids ${ids.join(', ') || '—'}).`);
    console.log('          Añade --live para escribir.\n');
    await prisma.$disconnect();
    return;
  }

  // Primero el legacy: si se borrara antes en Postgres, la pasada de caja de los 5
  // minutos podría colarse entremedias y volver a traerlas.
  if (ids.length) {
    const my = await mysql.createConnection({
      host: process.env.LEGACY_DB_HOST || '127.0.0.1',
      port: Number(process.env.LEGACY_DB_PORT || 3306),
      user: process.env.LEGACY_DB_USER,
      password: process.env.LEGACY_DB_PASSWORD,
      database: process.env.LEGACY_DB_NAME || 'admin_vestel',
    });
    const [res] = await my.execute(
      `DELETE FROM transactions WHERE id IN (${ids.map(() => '?').join(',')}) AND note = ?`,
      [...ids, nota],
    );
    console.log(`  legacy: ${(res as { affectedRows: number }).affectedRows} fila(s) borradas`);
    await my.end();
  }

  const del = await prisma.transaction.deleteMany({ where: { id: { in: patas.map((p) => p.id) } } });
  console.log(`  nexus:  ${del.count} fila(s) borradas`);
  console.log(`\nHecho. La caja ${cuenta.holder} vuelve a estar abierta el ${FECHA}.\n`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(`\n✗ ${e.message}\n`); process.exit(1); });
