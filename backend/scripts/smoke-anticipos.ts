/**
 * Smoke de ANTICIPOS (saldo a favor) contra la base de VERDAD, sin dejar rastro:
 * todo corre dentro de una transacción que al final se REVIENTA a propósito, así que
 * no se crea ni se toca nada de forma permanente.
 *
 *   npx ts-node --transpile-only scripts/smoke-anticipos.ts
 *
 * Comprueba el camino completo con Prisma de por medio (que es donde se rompen las
 * cosas que el test unitario de `repartirAnticipos` no puede ver):
 *   1. un anticipo abierto se imputa a la mensualidad pendiente y la deja PAGADA,
 *   2. deja la pareja de movimientos sin caja (crédito a la factura + débito que
 *      consume el anticipo) → neto cero para la caja y para el acumulado del cliente,
 *   3. revertir la aplicación devuelve el saldo y la factura vuelve a deber.
 */
import { PrismaClient } from '@prisma/client';
import { aplicarAnticipos, revertirAplicaciones, saldoAFavor } from '../src/billing/anticipos';

const prisma = new PrismaClient();
const cop = (n: number) => `$${n.toLocaleString('es-CO')}`;
const ROLLBACK = 'SMOKE_ROLLBACK';

let fallos = 0;
function check(ok: boolean, texto: string) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${texto}`);
  if (!ok) fallos++;
}

async function main() {
  // Una mensualidad pendiente de verdad: es el escenario del día 1 del mes.
  const factura = await prisma.subInvoice.findFirst({
    where: { status: 'DUE', kind: 'RECURRENTE', paidAmount: 0, total: { gt: 0 } },
    orderBy: { invoiceDate: 'desc' },
    select: { id: true, tid: true, total: true, subscriberId: true },
  });
  if (!factura?.subscriberId) {
    console.log('No hay ninguna mensualidad pendiente con la que probar. Nada que hacer.');
    return;
  }
  const total = Number(factura.total);
  console.log(`Factura #${factura.tid} · ${cop(total)} · cliente ${factura.subscriberId}\n`);

  try {
    await prisma.$transaction(async (tx) => {
      const antes = await saldoAFavor(tx, factura.subscriberId!);

      // El cliente pagó un mes de más en ventanilla.
      const adv = await tx.customerAdvance.create({
        data: {
          subscriberId: factura.subscriberId!, amount: total, applied: 0, status: 'ABIERTO',
          date: new Date(), method: 'Cash', note: 'smoke',
        },
      });
      check(await saldoAFavor(tx, factura.subscriberId!) === antes + total, `saldo a favor = ${cop(total)}`);

      // --- 1. se imputa a la factura pendiente ---
      const res = await aplicarAnticipos(tx, factura.subscriberId!);
      check(res.total === total, `se imputaron ${cop(res.total)} (esperado ${cop(total)})`);
      check(res.aplicados.length === 1 && res.aplicados[0].tid === factura.tid,
        `fue a la factura #${factura.tid}`);
      check(res.aplicados[0]?.status === 'PAID', 'la factura queda PAGADA');

      const inv = await tx.subInvoice.findUniqueOrThrow({ where: { id: factura.id } });
      check(Number(inv.paidAmount) === total && inv.status === 'PAID',
        `paidAmount = ${cop(Number(inv.paidAmount))} · status = ${inv.status}`);

      // --- 2. la pareja de movimientos deja el neto en cero ---
      const app = await tx.customerAdvanceApplication.findFirstOrThrow({ where: { advanceId: adv.id } });
      const credito = await tx.transaction.findUniqueOrThrow({ where: { id: app.transactionId! } });
      const debito = await tx.transaction.findUniqueOrThrow({ where: { id: app.debitTransactionId! } });
      check(Number(credito.credit) === total && credito.invoiceId === factura.id,
        'crédito por el valor, contra la factura');
      check(Number(debito.debit) === total && debito.invoiceId === null,
        'débito por el mismo valor, sin factura');
      check(credito.cashAccountId === null && debito.cashAccountId === null,
        'ninguno de los dos toca una caja (el arqueo del día no se mueve)');
      check(Number(credito.credit) - Number(debito.debit) === 0,
        'neto cero en el acumulado del cliente');

      const advDespues = await tx.customerAdvance.findUniqueOrThrow({ where: { id: adv.id } });
      check(advDespues.status === 'APLICADO' && Number(advDespues.applied) === total,
        'el anticipo queda consumido');
      check(await saldoAFavor(tx, factura.subscriberId!) === antes, 'ya no queda saldo a favor');

      // --- 3. reversa ---
      await revertirAplicaciones(tx, { advanceId: adv.id });
      const invRev = await tx.subInvoice.findUniqueOrThrow({ where: { id: factura.id } });
      check(Number(invRev.paidAmount) === 0 && invRev.status === 'DUE',
        'al revertir, la factura vuelve a deber');
      check(await saldoAFavor(tx, factura.subscriberId!) === antes + total,
        'y el saldo a favor vuelve a estar disponible');
      const anuladas = await tx.transaction.findMany({
        where: { id: { in: [credito.id, debito.id] } }, select: { status: true },
      });
      check(anuladas.every((t) => t.status === 'ANULADA'), 'los dos movimientos quedan anulados');

      throw new Error(ROLLBACK);
    }, { timeout: 60_000 });
  } catch (e) {
    if ((e as Error).message !== ROLLBACK) throw e;
    console.log('\n(todo revertido: la base queda como estaba)');
  }

  console.log(fallos ? `\n❌ ${fallos} comprobación(es) fallida(s)` : '\n✅ Todo correcto');
  process.exitCode = fallos ? 1 : 0;
}

main().finally(() => prisma.$disconnect());
