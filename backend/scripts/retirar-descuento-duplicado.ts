/**
 * Retira el 5 % de pronto pago que se concedió DOS VECES a la misma factura.
 *
 *   npx ts-node -T scripts/retirar-descuento-duplicado.ts [--si] [--promo=<id>]
 *
 * POR QUÉ EXISTE (2026-09-03, caso real, factura 503819 del abonado 20166): el portal
 * de pagos del legacy le puso su 5 % en la CABECERA (`discount` 8.663, nota "Descuento
 * 5 %") y el cliente vino luego a pagar en ventanilla, donde el descuento automático al
 * cobrar (`promotions/descuento-al-cobrar.ts`) no vio huella alguna —la cabecera del
 * legacy no deja `PromotionApplication`— y concedió OTRO 5 % como nota crédito, sobre
 * el total ya rebajado (8.229,40). Pagó 156.358,60 por una mensualidad de 173.250: un
 * 9,75 %. Tres facturas así (503685, 503819, 502485) antes del candado
 * `yaRebajadaEnOrigen`.
 *
 * QUÉ HACE: por cada factura con descuento de cabecera > 0 Y una aplicación viva de la
 * promoción, escribe la NOTA DÉBITO del mismo monto que la nota crédito duplicada y
 * marca la aplicación como revertida (mismo gesto que `revertirDescuentosVencidos`:
 * no se borra nada, la factura conserva las dos huellas). La factura vuelve al total
 * que el portal ya había rebajado y, como ya está pagada, queda PARTIAL debiendo justo
 * lo que se regaló de más. El legacy se entera solo: la nota sella `editedAt` y
 * `pushEditedInvoices` (writeback, `LEGACY_WRITEBACK_EDICIONES_LIVE`) la lleva.
 *
 * Sin `--si` sólo enseña lo que haría.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { aplicarNotaEnTx } from '../src/billing/nota-en-tx';

for (const linea of readFileSync('.env', 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(linea.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}

const num = (x: Prisma.Decimal | number | null | undefined) => Number(x ?? 0);
const round2 = (x: number) => Math.round(x * 100) / 100;
const pesos = (n: number) => n.toLocaleString('es-CO');
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];

const prisma = new PrismaClient();
const AUTOR = 'Sistema (descuento duplicado retirado)';

async function main() {
  const enSerio = process.argv.includes('--si');
  const promoId = arg('promo');

  // `PromotionApplication` no tiene relación con la factura (guarda sólo el id), así
  // que se cruzan a mano: aplicaciones vivas → facturas con descuento de cabecera.
  const vivas = await prisma.promotionApplication.findMany({
    where: { revertedAt: null, ...(promoId ? { promotionId: promoId } : {}) },
    include: { promotion: { select: { name: true, percentage: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const facturas = new Map(
    (await prisma.subInvoice.findMany({
      where: { id: { in: vivas.map((a) => a.invoiceId) }, discount: { gt: 0 } },
      select: {
        id: true, tid: true, subtotal: true, discount: true, total: true, paidAmount: true,
        status: true, notes: true,
        subscriber: { select: { legacyId: true, fullName: true } },
      },
    })).map((f) => [f.id, f]),
  );
  const duplicadas = vivas
    .filter((a) => facturas.has(a.invoiceId))
    .map((a) => ({ ...a, invoice: facturas.get(a.invoiceId)! }));

  if (!duplicadas.length) { console.log('No hay descuentos duplicados.'); return; }

  console.log(`${enSerio ? 'RETIRANDO' : 'Plan (sin --si no escribe)'}: ${duplicadas.length} factura(s)\n`);
  let total = 0;
  for (const d of duplicadas) {
    const inv = d.invoice;
    const monto = round2(num(d.amount));
    total = round2(total + monto);
    console.log(
      `#${inv.tid} · ${inv.subscriber?.fullName?.trim() ?? '?'} (abonado ${inv.subscriber?.legacyId ?? '?'})`
      + ` · cabecera ${pesos(num(inv.discount))} "${(inv.notes ?? '').trim()}"`
      + ` · nota "${d.promotion.name}" ${pesos(monto)} por ${d.appliedByName ?? '?'}`
      + ` · total ${pesos(num(inv.total))} pagado ${pesos(num(inv.paidAmount))} (${inv.status})`
      + ` → quedará debiendo ${pesos(round2(num(inv.total) + monto - num(inv.paidAmount)))}`,
    );
    if (!enSerio) continue;

    await prisma.$transaction(async (tx) => {
      await aplicarNotaEnTx(tx, inv.id, {
        type: 'DEBITO',
        amount: monto,
        description: `Descuento duplicado retirado: el portal de pagos ya había aplicado el ${d.promotion.percentage} % en esta factura (${pesos(num(inv.discount))})`,
        editedBy: AUTOR,
      });
      await tx.promotionApplication.update({ where: { id: d.id }, data: { revertedAt: new Date() } });
    });
    console.log('   ✔ retirado');
  }
  console.log(`\nTotal regalado de más: ${pesos(total)} COP`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
