/**
 * Barrido de descuentos del PORTAL DE PAGOS, a mano.
 *
 *   npx ts-node --transpile-only scripts/descuento-portal.ts               # sólo cuenta
 *   npx ts-node --transpile-only scripts/descuento-portal.ts --live        # escribe
 *   npx ts-node --transpile-only scripts/descuento-portal.ts --solo=56571  # un abonado
 *
 * `--solo` acota el barrido a UN cliente (por número de abonado). Es la forma de
 * probar la campaña de punta a punta —ver el valor rebajado en el portal— antes de
 * repartirla sobre la cartera entera.
 *
 * Sin `--live` no toca nada: dice a cuántos clientes alcanzaría, cuántas facturas y
 * cuánta plata. Con `--live` concede las notas crédito (y necesita además el gate
 * `PROMO_PORTAL_PRECONCEDER_LIVE=true`, que es el que gobierna la pasada del cron).
 *
 * Ver `src/promotions/descuento-portal.ts` para el porqué de todo esto.
 */
import { PrismaClient } from '@prisma/client';
import { barrerDescuentosDelPortal, PORTAL_PRECONCEDER_LIVE } from '../src/promotions/descuento-portal';

const cop = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;

(async () => {
  const prisma = new PrismaClient();
  const live = process.argv.includes('--live');
  if (live && !PORTAL_PRECONCEDER_LIVE) {
    console.error('El gate PROMO_PORTAL_PRECONCEDER_LIVE no está abierto: --live no escribirá nada.');
    process.exit(1);
  }
  try {
    const solo = (process.argv.find((a) => a.startsWith('--solo=')) ?? '').split('=')[1];
    let soloSubscriberId: string | undefined;
    if (solo) {
      const s = await prisma.subscriber.findFirst({
        where: { abonado: Number(solo) }, select: { id: true, abonado: true, fullName: true },
      });
      if (!s) { console.error(`No hay ningún abonado ${solo}.`); process.exit(1); }
      soloSubscriberId = s.id;
      console.log(`Acotado al abonado ${s.abonado} — ${s.fullName?.trim() || 'sin nombre'}`);
    }
    const r = await barrerDescuentosDelPortal(prisma as never, { live, soloSubscriberId });
    console.log(`\nPromociones del portal vigentes: ${r.promociones.join(', ') || '(ninguna)'}`);
    console.log(`Clientes que alcanzan y deben:   ${r.candidatos.toLocaleString('es-CO')}`);
    console.log(`${live ? 'Se les concedió a' : 'Se les concedería a'}: ${r.beneficiados.toLocaleString('es-CO')} clientes`
      + ` · ${r.facturas.toLocaleString('es-CO')} facturas · ${cop(r.monto)}`);
    if (r.retirados.clientes) {
      console.log(`Descuentos retirados (promo vencida sin pago): ${r.retirados.clientes} clientes`
        + ` · ${r.retirados.facturas} facturas${r.retirados.monto ? ` · ${cop(r.retirados.monto)}` : ''}`);
    }
    if (r.errores.length) {
      console.log(`\n${r.errores.length} con error:`);
      for (const e of r.errores.slice(0, 10)) console.log(`  ${e.subscriberId}: ${e.error}`);
    }
    if (!live) console.log('\n(seco — nada se escribió; añade --live para conceder)');
  } finally {
    await prisma.$disconnect();
  }
})();
