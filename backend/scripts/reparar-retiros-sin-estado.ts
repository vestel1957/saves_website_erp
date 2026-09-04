/**
 * Repara los RETIROS que se cerraron aquí y dejaron al cliente ACTIVO.
 *
 * Hasta el 31-08-2026 la cascada de cierre (`applyCloseCascade`) ponía el estado del
 * abonado en RETIRADO pero NO escribía la fila de historial, y el estado del abonado es
 * de los campos que manda el legacy en la ida (`CAMPOS_DE_ALLA`): quince minutos después
 * `syncCustomers` devolvía el 'Activo' de allá y el retiro se deshacía solo. Los que se
 * salvaron fueron los que además se retiraron en el legacy a mano.
 *
 * Esto NO toca la red: el corte ya se hizo el día que se cerró la orden (el servicio
 * está caído). Lo que se repone es el rastro que faltaba —estado, estado anterior,
 * historial y la baja en la factura vigente—, que es justo lo que `pushBajas` necesita
 * para llevárselo al legacy y que no se vuelva a revertir.
 *
 * Uso:  npx ts-node --transpile-only scripts/reparar-retiros-sin-estado.ts [--dry] [--desde=2026-08-01]
 *       (por defecto SECO: hay que pasar --aplicar para escribir)
 */
import { PrismaClient, type SubscriberStatus } from '@prisma/client';

const prisma = new PrismaClient();

const arg = (n: string) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split('=').slice(1).join('=') : null;
};
const APLICAR = process.argv.includes('--aplicar');
const DESDE = new Date(arg('desde') || '2026-08-01');

/** Estados que ya son una baja: a esos no hay nada que reparar. */
const YA_DE_BAJA: SubscriberStatus[] = ['RETIRADO', 'DEPURADO'];

async function main() {
  const ordenes = await prisma.ticket.findMany({
    where: {
      status: 'RESUELTO',
      resolvedAt: { not: null, gte: DESDE }, // `resolvedAt` sólo lo escribe este sistema: es "se cerró AQUÍ"
      type: { contains: 'Retiro', mode: 'insensitive' },
    },
    select: {
      id: true, code: true, type: true, resolvedAt: true, subscriberId: true,
      subscriber: { select: { id: true, abonado: true, legacyId: true, status: true } },
    },
    orderBy: { resolvedAt: 'asc' },
  });

  const plan: Array<{ code: number | null; abonado: number; subId: string; antes: SubscriberStatus | null; fecha: Date; estado: boolean }> = [];
  for (const o of ordenes) {
    const s = o.subscriber;
    if (!s) continue;
    if (YA_DE_BAJA.includes(s.status as SubscriberStatus)) {
      // El estado sí quedó, pero la factura vigente puede seguir diciendo que el
      // servicio está al aire (la cascada vieja tampoco la tocaba): esa mitad se repone
      // igual, porque es la que pinta la ficha.
      if (!plan.some((p) => p.subId === s.id)) {
        plan.push({ code: o.code, abonado: s.abonado, subId: s.id, antes: null, fecha: o.resolvedAt!, estado: false });
      }
      continue;
    }
    // ¿Ya hay constancia del retiro? (la escribe la cascada arreglada, o la devolución
    // de equipo). Si la hay, `pushBajas` ya lo va a empujar y aquí no hay nada que hacer.
    const yaHay = await prisma.subscriberStatusHistory.findFirst({
      where: { subscriberId: s.id, status: 'RETIRADO', date: { gte: o.resolvedAt! } },
      select: { id: true },
    });
    if (yaHay) continue;
    if (plan.some((p) => p.subId === s.id)) continue; // dos órdenes del mismo cliente: una sola baja
    plan.push({ code: o.code, abonado: s.abonado, subId: s.id, antes: s.status as SubscriberStatus, fecha: o.resolvedAt!, estado: true });
  }

  console.log(`Órdenes de retiro cerradas aquí desde ${DESDE.toISOString().slice(0, 10)}: ${ordenes.length}`);
  console.log(`Clientes por reponer: ${plan.length} (${plan.filter((p) => p.estado).length} de estado, el resto sólo la factura)`);
  for (const p of plan) {
    console.log(`  · abonado ${p.abonado} — orden #${p.code} cerrada ${p.fecha.toISOString().slice(0, 16)}`
      + (p.estado ? ` — hoy está ${p.antes}` : ' — estado OK, se revisa la factura'));
  }
  if (!plan.length || !APLICAR) {
    console.log(APLICAR ? 'Nada que hacer.' : 'SECO: no se escribió nada (pasa --aplicar).');
    return;
  }

  let tocadas = 0;
  for (const p of plan) {
    await prisma.$transaction(async (tx) => {
      if (p.estado) {
        await tx.subscriber.update({
          where: { id: p.subId },
          data: { previousStatus: p.antes ?? undefined, status: 'RETIRADO', statusChangedAt: p.fecha },
        });
        await tx.subscriberStatusHistory.create({
          data: {
            subscriberId: p.subId,
            status: 'RETIRADO',
            date: p.fecha,
            originTicketId: p.code ?? null,
            note: `Retiro${p.code ? ` (orden #${p.code})` : ''} — repuesto: el cierre no dejó constancia y la ida lo revirtió`,
          },
        });
      }
      // La baja también en la factura vigente, que es donde la ficha lee qué servicio
      // está caído (mismo criterio que `marcarBajaEnFactura`).
      const vigente = await tx.$queryRaw<{ id: string; ron: string | null }[]>`
        SELECT i.id, i.ron::text AS ron FROM "SubInvoice" i
         WHERE i."subscriberId" = ${p.subId} AND i.kind = 'RECURRENTE'
         ORDER BY i."invoiceDate" DESC NULLS LAST, i.tid DESC LIMIT 1`;
      // Si la factura ya cuenta una baja (la escribió el legacy y la trajo la ida), se
      // deja como está: reescribir un 'Cortado' por mora con un 'Suspendido' sería
      // cambiarle el motivo a algo que ya está bien contado.
      const yaDeBaja = ['RETIRADO', 'SUSPENDIDO', 'DEPURADO'].includes(vigente[0]?.ron ?? '');
      if (vigente[0] && !yaDeBaja) {
        await tx.subInvoice.update({
          where: { id: vigente[0].id },
          data: { ron: 'RETIRADO', estadoTv: 'SUSPENDIDO', estadoCombo: 'SUSPENDIDO' },
        });
        tocadas++;
      }
    });
    console.log(`  ✓ abonado ${p.abonado} → ${p.estado ? 'RETIRADO' : 'sólo factura'}`);
  }
  console.log(`Facturas marcadas: ${tocadas}`);
  console.log('Listo. Ahora: node scripts/writeback-legacy.js --solo=bajas   (para que el legacy se entere)');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
