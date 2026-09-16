#!/usr/bin/env ts-node
/**
 * Deja en CERO al abonado 52420 (JOSE ALFREDO ESPITIA ARDILA): sin cartera y sin saldo
 * a favor.
 *
 * Qué pasó:
 *   · 10-09 21:23 se cobraron 41.950 (7.199 a #405483 + 34.751 a #408506) y a las 21:29
 *     se anularon los dos pagos («se aplicó mal el descuento»).
 *   · nexus restó el pago de las facturas, pero `pushVoidings` del writeback sólo marca
 *     `estado='Anulada'` en el legacy: no recalcula `invoices.pamnt`. La ida copió de
 *     vuelta el pamnt viejo y las dos facturas quedaron con un pago que no existe.
 *   · 11-09 13:02 se cobraron 41.899 sobre #408506 y #414525. Con el pago fantasma,
 *     #408506 "debía" 3.574: el 50 % se topó ahí y 22.736,50 quedaron de anticipo.
 *
 * Qué hace (una sola transacción):
 *   1. `paidAmount` de #405483 y #408506 = lo que respaldan sus pagos VIGENTES.
 *   2. Nota crédito a #408506 por 15.588,50: completa el 50 % de la campaña (quedaba
 *      rebajada sólo en 3.574) → total 19.162,50, igual que #414525.
 *   3. Nota crédito a #405483 por 3.625 (el 50 % de 7.199 más 25,50 de redondeo para
 *      que el anticipo la cierre exacta) → debe 3.574.
 *   4. `aplicarAnticipos`: los 22.736,50 pagan 3.574 + 19.162,50. Anticipo APLICADO.
 *
 * El writeback del cron (cada 5 min) lleva las notas y los movimientos al legacy, y
 * `reflejarEnLegacy` recalcula allá el pamnt desde los pagos vigentes, así que el pago
 * fantasma también desaparece del legacy.
 *
 *   npx ts-node --transpile-only scripts/corregir-anulacion-52420.ts            # simulacro
 *   npx ts-node --transpile-only scripts/corregir-anulacion-52420.ts --aplicar
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { aplicarNotaEnTx } from '../src/billing/nota-en-tx';
import { aplicarAnticipos, saldoAFavor } from '../src/billing/anticipos';
import { num, round2 } from '../src/common/money';

const prisma = new PrismaClient();
const APLICA = process.argv.includes('--aplicar');
const SUB = 'cmr3j3gj30czbdz33l5rzwbs6';
const EDITOR = 'Soporte (corrección anulación 10-09)';
const SIMULACRO = 'simulacro: se deshace';

async function main() {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Subscriber" WHERE id = ${SUB} FOR UPDATE`;
    const inv = async (tid: number) => tx.subInvoice.findUniqueOrThrow({ where: { tid } });

    // Candados: si alguien ya tocó algo, no se corrige a ciegas.
    const a = await inv(405483), b = await inv(408506);
    const adv = await tx.customerAdvance.findMany({ where: { subscriberId: SUB, status: 'ABIERTO' } });
    if (num(a.total) !== 54767 || num(a.paidAmount) !== 54767) throw new Error(`#405483 cambió: ${a.total}/${a.paidAmount}`);
    if (num(b.total) !== 34751 || num(b.paidAmount) !== 34751) throw new Error(`#408506 cambió: ${b.total}/${b.paidAmount}`);
    if (adv.length !== 1 || num(adv[0].amount) !== 22736.5 || num(adv[0].applied) !== 0) throw new Error('el anticipo cambió');

    // 1) Lo pagado = lo que respaldan los pagos vigentes.
    for (const f of [a, b]) {
      const r = await tx.transaction.aggregate({
        where: { invoiceId: f.id, status: 'VIGENTE' }, _sum: { credit: true, debit: true },
      });
      const pagado = round2(num(r._sum.credit) - num(r._sum.debit));
      await tx.subInvoice.update({
        where: { id: f.id },
        data: { paidAmount: pagado, status: pagado <= 0 ? 'DUE' : pagado >= num(f.total) ? 'PAID' : 'PARTIAL' },
      });
      console.log(`#${f.tid}: pagado ${f.paidAmount} → ${pagado}`);
    }

    // 2) y 3) El 50 % de la campaña, completo.
    await aplicarNotaEnTx(tx, b.id, {
      type: 'CREDITO', amount: 15588.5, editedBy: EDITOR,
      description: 'Promoción: cartera 50% y activa usuario (completa el 50%)',
    });
    await aplicarNotaEnTx(tx, a.id, {
      type: 'CREDITO', amount: 3625, editedBy: EDITOR,
      description: 'Promoción: cartera 50% y activa usuario (50% + ajuste)',
    });

    // 4) El saldo a favor paga lo que queda.
    const res = await aplicarAnticipos(tx, SUB, { editedBy: EDITOR });
    console.log('anticipo aplicado:', res.aplicados.map((x) => `#${x.tid} ${x.amount} ${x.status}`).join(' · '));

    // Verificación: todo en cero o nada.
    const abiertas = await tx.subInvoice.findMany({
      where: { subscriberId: SUB, status: { in: ['DUE', 'PARTIAL'] } }, select: { tid: true, total: true, paidAmount: true },
    });
    const favor = await saldoAFavor(tx, SUB);
    for (const t of [405483, 408506, 414525]) {
      const f = await inv(t);
      console.log(`#${t}: total ${f.total} · pagado ${f.paidAmount} · ${f.status}`);
    }
    console.log(`facturas abiertas: ${abiertas.length} · saldo a favor: ${favor}`);
    if (abiertas.length || favor !== 0) throw new Error('no quedó en cero — se deshace todo');

    if (APLICA) {
      await tx.auditLog.create({
        data: {
          action: 'SCRIPT corregir-anulacion-52420', entity: `subscribers/${SUB}`, entityId: SUB,
          after: { motivo: 'pago anulado 10-09 no revertido en el legacy; cliente en cero', anticipo: res.total },
        },
      });
    } else {
      throw new Error(SIMULACRO);
    }
  }, { timeout: 30_000 });
  console.log('APLICADO');
}

main()
  .catch((e) => { console.log(e.message === SIMULACRO ? `\n(${SIMULACRO}; con --aplicar se guarda)` : e); })
  .finally(() => prisma.$disconnect());
