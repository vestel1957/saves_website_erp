/**
 * Smoke de INTERBLOQUEO y de saldo de caja en tesorería.
 *
 * Lanza a la vez transferencias A→B y B→A más ingresos sobre las mismas cajas, que es
 * el escenario que puede cruzar dos bloqueos. Comprueba dos cosas:
 *   1. que ninguna operación muere por deadlock;
 *   2. que el `balance` materializado de cada caja coincide con sus movimientos.
 *
 * Por qué existe: al empezar a bloquear `CashAccount` para que el recálculo del saldo
 * no se pisara entre transacciones concurrentes, aparecieron DOS recursos en juego
 * (Subscriber y CashAccount). Varios métodos los tomaban en orden distinto —
 * `createIncome` y `editTransaction` iban CashAccount→Subscriber, y `createTransfer`
 * bloqueaba las cajas en orden origen→destino— así que dos operaciones cruzadas se
 * habrían quedado esperándose. El orden quedó fijado en ORDEN DE BLOQUEO
 * (`cobranzas.service.ts`): Subscriber primero, cajas por id ascendente.
 *
 * Uso — NUNCA contra producción, crea datos:
 *   createdb saves_deadlock_test
 *   DATABASE_URL="postgresql://usuario:clave@localhost:5432/saves_deadlock_test" \
 *     npx prisma migrate deploy
 *   DATABASE_URL="postgresql://usuario:clave@localhost:5432/saves_deadlock_test" \
 *     npx ts-node scripts/smoke-treasury-deadlock.ts
 */
import { PrismaClient } from '@prisma/client';
import { CobranzasService } from '../src/treasury/cobranzas.service';

const RONDAS = Number(process.env.RONDAS || 12);
const IMPORTE = 5_000;
const CAJA_A = 901;
const CAJA_B = 902;

const url = process.env.DATABASE_URL ?? '';
if (!url) throw new Error('Define DATABASE_URL apuntando a una base de PRUEBAS desechable.');
const dbName = new URL(url).pathname.replace(/^\//, '');
if (dbName === 'saves_vestel') {
  throw new Error('DATABASE_URL apunta a la base de PRODUCCIÓN. Este script crea datos: abortado.');
}

// Cada transacción interactiva retiene una conexión. Sin acotar el pool, lanzar
// decenas a la vez agota el `max_connections` del servidor (que además comparte con
// la app en marcha) y los fallos serían del banco de pruebas, no del código.
// Prisma encola las que no caben, así que la concurrencia real se mantiene.
const urlAcotada = url.includes('connection_limit')
  ? url
  : `${url}${url.includes('?') ? '&' : '?'}connection_limit=10`;

const prisma = new PrismaClient({ datasources: { db: { url: urlAcotada } } });
const posting = {
  postCustomerPayment: async () => null,
  postTreasuryIncome: async () => null,
  postTreasuryExpense: async () => null,
};
const mikrotik = { reconnect: async () => null };

async function saldoReal(legacyId: number) {
  const agg = await prisma.transaction.aggregate({
    _sum: { credit: true, debit: true },
    where: { cashAccountId: legacyId, status: 'VIGENTE' },
  });
  return Number(agg._sum.credit ?? 0) - Number(agg._sum.debit ?? 0);
}

async function main() {
  const svc = new CobranzasService(prisma as never, posting as never, mikrotik as never);
  const user = { id: 'u-test', name: 'Smoke', email: 'smoke@test', permissions: ['system.admin'], roles: [] };

  await prisma.transaction.deleteMany({});
  await prisma.cashAccount.deleteMany({});
  await prisma.subscriber.deleteMany({});
  await prisma.subscriber.create({
    data: { id: 'sub-dl', abonado: 1, firstName: 'Cliente', lastName1: 'Prueba', updatedAt: new Date() },
  });
  for (const [id, legacyId] of [['ca-a', CAJA_A], ['ca-b', CAJA_B]] as const) {
    await prisma.cashAccount.create({
      data: { id, legacyId, holder: `Caja ${legacyId}`, branchLegacy: 1, balance: 0 },
    });
  }

  // Mezcla deliberada: A→B, B→A e ingresos, todo a la vez sobre las mismas cajas.
  const ops: (() => Promise<unknown>)[] = [];
  for (let i = 0; i < RONDAS; i++) {
    ops.push(() => svc.createTransfer(
      { fromCashAccountId: CAJA_A, toCashAccountId: CAJA_B, amount: IMPORTE } as never, user as never));
    ops.push(() => svc.createTransfer(
      { fromCashAccountId: CAJA_B, toCashAccountId: CAJA_A, amount: IMPORTE } as never, user as never));
    ops.push(() => svc.createIncome(
      { cashAccountId: CAJA_A, amount: IMPORTE, category: 'Otros', method: 'Efectivo', subscriberId: 'sub-dl' } as never,
      user as never));
  }

  const res = await Promise.allSettled(ops.map((f) => f()));
  const fallidos = res.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  const deadlocks = fallidos.filter((f) => /deadlock/i.test(String(f.reason?.message ?? f.reason)));

  const cuentas = await prisma.cashAccount.findMany({ orderBy: { legacyId: 'asc' } });

  console.log(`  operaciones       : ${ops.length} (transferencias cruzadas + ingresos)`);
  console.log(`  ok / fallidas     : ${res.length - fallidos.length} / ${fallidos.length}`);
  if (fallidos.length) console.log(`  primer fallo      : ${fallidos[0].reason?.message ?? fallidos[0].reason}`);
  console.log(`  deadlocks         : ${deadlocks.length}`);

  let cuadra = true;
  for (const c of cuentas) {
    const real = await saldoReal(c.legacyId!);
    const guardado = Number(c.balance);
    const ok = real === guardado;
    if (!ok) cuadra = false;
    console.log(`  caja ${c.legacyId}: balance=${guardado} movimientos=${real} ${ok ? 'OK' : '<-- DESCUADRE'}`);
  }

  if (deadlocks.length || fallidos.length || !cuadra) {
    console.error('  ❌ FALLO: hubo deadlocks, errores o saldos que no cuadran');
    process.exitCode = 1;
    return;
  }
  console.log('  ✅ SIN DEADLOCKS y los saldos de caja cuadran con sus movimientos');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
