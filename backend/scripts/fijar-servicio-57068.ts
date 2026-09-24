/**
 * El abonado 57068 pasó de 300 a 600 megas en agosto, y es el único al que crear los
 * planes que faltaban (`planes-legacy-faltantes.ts`) deja PEOR.
 *
 * Por qué: no tiene fila en `SubscriberService`, así que su plan sale derivado de sus
 * facturas, y `planDeUltimaFactura` mira las DOS últimas mensualidades a propósito (para
 * que un prorrateo corto no le borre un servicio). Sus dos últimas traen internet con
 * NOMBRES distintos —agosto #474757 '300Megas26F-S' $75.000 y septiembre #504602
 * '600Megas26F-S' $100.000—, y la regla sólo colapsa el mismo nombre repetido, no dos
 * nombres del mismo tipo. Mientras '600Megas26F-S' no existía en `Plan` sólo casaba el de
 * agosto; ahora casan los dos y octubre le saldría con DOS internet ($175.000).
 *
 * El arreglo es acotado y no toca la regla de facturación (que es un defecto viejo y
 * afecta a otros 6 abonados con el mismo patrón, ver el informe): se le escribe la fila
 * que dice su cabecera, al precio que su propia factura de septiembre ya le cobra. Con
 * fila propia deja de derivarse.
 *
 * Prisma directo, sin pasar por `changePlan`: esto es un arreglo de FACTURACIÓN y no debe
 * empujar perfil al router ni viajar al legacy.
 *
 *   npx ts-node --transpile-only scripts/fijar-servicio-57068.ts            → simulación
 *   npx ts-node --transpile-only scripts/fijar-servicio-57068.ts --commit
 */
import * as fs from 'fs';
import * as path from 'path';

for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}

import { PrismaService } from '../src/prisma/prisma.service';

const COMMIT = process.argv.includes('--commit');
const ABONADO = 57068;
const PLAN = '600Megas26F-S';
const PRECIO = 100000;

async function main() {
  const prisma = new PrismaService();
  const sub = await prisma.subscriber.findFirst({
    where: { abonado: ABONADO },
    select: { id: true, abonado: true, status: true, services: { select: { kind: true, planName: true } } },
  });
  if (!sub) throw new Error(`no existe el abonado ${ABONADO}`);
  if (sub.services.some((s) => s.kind === 'INTERNET')) {
    console.log(`El abonado ${ABONADO} ya tiene fila de INTERNET (${sub.services.find((s) => s.kind === 'INTERNET')?.planName}); no se toca.`);
    return prisma.$disconnect();
  }

  // La cabecera y el cobro de septiembre tienen que decir lo mismo que se va a escribir:
  // si no, el precio sale de otro lado y hay que mirarlo a mano.
  const sept = await prisma.subInvoice.findFirst({
    where: { subscriberId: sub.id, kind: 'RECURRENTE', status: { not: 'CANCELED' } },
    orderBy: [{ invoiceDate: 'desc' }, { tid: 'desc' }],
    select: { tid: true, serviceCombo: true, items: { select: { productName: true, price: true } } },
  });
  const renglon = sept?.items.find((i) => (i.productName ?? '').trim().toLowerCase() === PLAN.toLowerCase());
  console.log(`abonado ${ABONADO} (${sub.status}) · última recurrente #${sept?.tid} cabecera='${sept?.serviceCombo}' renglón=${renglon ? '$' + Number(renglon.price).toLocaleString('es-CO') : '(ninguno)'}`);
  if ((sept?.serviceCombo ?? '').trim().toLowerCase() !== PLAN.toLowerCase() || Number(renglon?.price ?? 0) !== PRECIO) {
    throw new Error('la última factura ya no dice lo mismo — revisar a mano antes de escribir');
  }

  const plan = await prisma.plan.findFirst({ where: { name: { equals: PLAN, mode: 'insensitive' } }, orderBy: { price: 'desc' } });
  if (!plan) throw new Error(`el plan ${PLAN} no está en el catálogo`);

  console.log(`\n→ SubscriberService INTERNET ${PLAN} $${PRECIO.toLocaleString('es-CO')} IVA ${plan.taxRate}% (planId ${plan.id})`);
  if (!COMMIT) { console.log('\n(simulación: nada escrito — repetir con --commit)\n'); return prisma.$disconnect(); }

  await prisma.subscriberService.create({
    data: { subscriberId: sub.id, kind: 'INTERNET', planName: PLAN, price: PRECIO,
            taxRate: plan.taxRate, megas: plan.megas, planId: plan.id, status: 'ACTIVO' },
  });
  console.log('\nFila creada.\n');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
