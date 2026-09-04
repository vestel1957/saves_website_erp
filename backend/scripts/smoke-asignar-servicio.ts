import 'reflect-metadata';
/**
 * Smoke de "asignar servicio" desde la factura (el ASIGNAR SERVICIO del legacy).
 *
 * Comprueba, sobre la BD real y dentro de una transacción que se DESHACE al final:
 *   1) el plan queda en `SubscriberService` (lo que factura este sistema);
 *   2) el snapshot television/combo/puntos se escribe en la última factura RECURRENTE
 *      —no en la fija desde la que se asignó—, que es la que lee el legacy;
 *   3) la factura queda marcada con `serviceAssignedAt` (el candado contra el sync);
 *   4) la corrida mensual en seco cobra el plan nuevo.
 *
 * Uso: npx ts-node scripts/smoke-asignar-servicio.ts <abonado>
 */
import { PrismaClient } from '@prisma/client';
import { FacturasService } from '../src/billing/facturas.service';
import { SubscribersService } from '../src/subscribers/subscribers.service';

const prisma = new PrismaClient();
const abonado = Number(process.argv[2] || 54519);
const ok = (b: unknown, m: string) => console.log(`${b ? '✅' : '❌'} ${m}`);

async function main() {
  const sub = await prisma.subscriber.findFirst({
    where: { abonado }, select: { id: true, abonado: true, fullName: true, status: true },
  });
  if (!sub) throw new Error(`No existe el abonado ${abonado}`);

  const factura = await prisma.subInvoice.findFirst({
    where: { subscriberId: sub.id }, orderBy: [{ invoiceDate: 'desc' }, { tid: 'desc' }],
    select: { id: true, tid: true, kind: true },
  });
  if (!factura) throw new Error('El abonado no tiene facturas');

  const recurrente = await prisma.subInvoice.findFirst({
    where: { subscriberId: sub.id, kind: 'RECURRENTE', status: { not: 'CANCELED' } },
    orderBy: [{ invoiceDate: 'desc' }, { tid: 'desc' }],
    select: { id: true, tid: true, serviceCombo: true, serviceTv: true, puntos: true },
  });

  const plan = await prisma.plan.findFirst({ where: { kind: 'INTERNET', active: true }, orderBy: { price: 'desc' } });
  if (!plan) throw new Error('No hay planes de internet en el catálogo');

  console.log(`abonado ${sub.abonado} · ${sub.fullName} · ${sub.status}`);
  console.log(`factura de partida #${factura.tid} (${factura.kind})`);
  console.log(`la que dicta el plan: ${recurrente ? `#${recurrente.tid} (combo=${recurrente.serviceCombo}, tv=${recurrente.serviceTv})` : '— ninguna —'}`);
  console.log(`plan a asignar: ${plan.name} (${plan.price})\n`);

  // Todo dentro de una transacción que se revierte: es la BD de verdad.
  await prisma.$transaction(async (tx) => {
    const subs = new SubscribersService(tx as never, { applyProfile: async () => null } as never, {} as never, {} as never);
    const svc = new FacturasService(tx as never, { postSalesInvoice: async () => null } as never, {} as never, subs as never);
    const user = { id: 'smoke', email: 'smoke@vestel', name: 'Smoke', roles: [], permissions: [], sedes: [] } as never;

    const antes = await svc.servicioAsignado(factura.id, user);
    ok(antes.dicta?.tid === recurrente?.tid, `servicioAsignado apunta a la recurrente #${antes.dicta?.tid ?? '—'}`);
    ok(antes.dicta?.esEsta === (factura.id === recurrente?.id), 'sabe si la factura mirada es la que dicta');

    const r = await svc.asignarServicio(factura.id, { internet: plan.id, pushRouter: false }, user);
    ok(r.ok, 'asignarServicio devolvió ok');

    const filas = await tx.subscriberService.findMany({ where: { subscriberId: sub.id } });
    ok(filas.some((f) => f.kind === 'INTERNET' && f.planName === plan.name),
      `SubscriberService quedó con ${plan.name}`);

    if (recurrente) {
      const post = await tx.subInvoice.findUnique({
        where: { id: recurrente.id },
        select: { serviceCombo: true, serviceTv: true, puntos: true, serviceAssignedAt: true, serviceAssignedBy: true },
      });
      ok(post?.serviceCombo === plan.name, `la recurrente #${recurrente.tid} lleva combo="${post?.serviceCombo}"`);
      ok(post?.serviceAssignedAt != null, 'la recurrente queda marcada (serviceAssignedAt)');
      ok(post?.serviceAssignedBy === 'Smoke', 'queda quién la asignó');

      if (factura.id !== recurrente.id) {
        const fija = await tx.subInvoice.findUnique({
          where: { id: factura.id }, select: { serviceCombo: true, serviceAssignedAt: true },
        });
        ok(fija?.serviceAssignedAt == null, `la fija #${factura.tid} NO se tocó (el legacy no la mira)`);
      }
    }

    // La corrida en seco: ¿cobraría el plan nuevo? Solo tiene sentido en un abonado
    // facturable: la corrida (como la del legacy) solo mira ACTIVO y COMPROMISO.
    if (sub.status === 'ACTIVO' || sub.status === 'COMPROMISO') {
      // `asIfUnbilled`: el abonado ya tiene factura de este mes (la ida trae la del
      // legacy) y sin esto la corrida lo omitiría por ALREADY_BILLED sin llegar a
      // mirar el plan, que es justo lo que se quiere comprobar.
      const corrida = await svc.generate(
        { subscriberIds: [sub.id], dryRun: true, asIfUnbilled: true } as never, user,
      ) as { plan: { subscriberId: string; action: string; reason?: string; serviceCombo?: string | null; total?: number }[] };
      const fila = corrida.plan.find((p) => p.subscriberId === sub.id);
      ok(fila?.action === 'BILL' && fila?.serviceCombo === plan.name,
        `la corrida cobraría ${fila?.serviceCombo ?? `${fila?.action} (${fila?.reason})`} por ${fila?.total ?? 0}`);
    } else {
      console.log(`ℹ️  ${sub.status}: la corrida mensual no lo mira (solo ACTIVO/COMPROMISO), no se comprueba`);
    }

    throw new Error('__ROLLBACK__');
  }).catch((e) => { if ((e as Error).message !== '__ROLLBACK__') throw e; });

  console.log('\n(todo revertido: la BD quedó como estaba)');
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
