/**
 * Smoke del WEB SERVICE DEL PORTAL DE PAGOS (`src/portal-pagos/`).
 *
 * Lo que se mide aquí es lo que este módulo añade por encima de `collect()`, que es
 * justo lo que no cubre ninguna otra prueba y lo que, si falla, se cobra dos veces:
 *
 *   1. la deuda que se le enseña al portal es la NETA (ya con la promoción vigente);
 *   2. el pago sólo se aplica si la orden existe en el portal, está aprobada, es de
 *      ese abonado y por ese importe;
 *   3. es IDEMPOTENTE: el webhook de Wompi reintenta y el dinero se reparte una vez;
 *   4. el movimiento queda con la referencia de la pasarela en `payuOrderId` y la
 *      orden sellada con `appliedAt`, que es de lo que se fía el puente de
 *      `online-payments` para no reconectar dos veces.
 *
 * La consulta a `crm_vestel` se sustituye por un doble: aquí se prueba la DECISIÓN,
 * no MySQL.
 *
 * Uso — NUNCA contra producción, crea y borra datos:
 *   createdb saves_portal_test
 *   DATABASE_URL="postgresql://usuario:clave@localhost:5432/saves_portal_test" \
 *     npx prisma migrate deploy
 *   DATABASE_URL="postgresql://usuario:clave@localhost:5432/saves_portal_test" \
 *     npx ts-node --transpile-only scripts/smoke-portal-pagos.ts
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { CobranzasService } from '../src/treasury/cobranzas.service';
import { PortalPagosService } from '../src/portal-pagos/portal-pagos.service';

const url = process.env.DATABASE_URL ?? '';
if (!url) throw new Error('Define DATABASE_URL apuntando a una base de PRUEBAS desechable.');
// Se mira el NOMBRE de la base, no la URL: el usuario de producción se llama igual.
if (new URL(url).pathname.replace(/^\//, '') === 'saves_vestel') {
  throw new Error('DATABASE_URL apunta a PRODUCCIÓN. Este script borra datos: abortado.');
}

const prisma = new PrismaClient({ datasources: { db: { url } } });

// Integraciones externas fuera: aquí se mide la decisión sobre el dinero.
const posting = { postCustomerPayment: async () => null, postTreasuryIncome: async () => null };
const reconexion = { reconnect: async () => null, porPago: async () => null, aQuienLeToca: async () => ({ todos: [], internet: [], tv: [], tvSinEquipo: [] }) };
const eventos = { emit: () => true };

const REF = 'ref-smoke-portal-0001';
const CID = 90001;
const TOTAL = 100_000;

let fallos = 0;
function comprobar(desc: string, ok: boolean, detalle = '') {
  console.log(`  ${ok ? '✅' : '❌'} ${desc}${detalle ? ` — ${detalle}` : ''}`);
  if (!ok) fallos++;
}

async function main() {
  process.env.PORTAL_WS_ENABLED = 'true';
  process.env.PORTAL_WS_USER_MD5 = 'a'.repeat(32);
  process.env.PORTAL_WS_PASS_MD5 = 'b'.repeat(32);
  process.env.PORTAL_WS_IPS = '';

  const cobranzas = new CobranzasService(prisma as never, posting as never, reconexion as never, eventos as never);
  const portal = new PortalPagosService(prisma as never, cobranzas);

  // El doble de `crm_vestel`: una orden aprobada, de este abonado, por este importe.
  let ordenFalsa: any = {
    id: 1, reference: REF, debe: TOTAL, estado: 'Finalizada con Exito',
    cid_user: CID, metodo_pago: 'PSE', id_wompi: '123-456',
  };
  (portal as any).ordenDelPortal = async (r: string) => (r === REF ? ordenFalsa : null);
  (portal as any).llavesWompi = async () => ({ valor: '{}' });

  // ── Datos ────────────────────────────────────────────────────────────────
  await prisma.receiptTransaction.deleteMany({});
  await prisma.paymentReceipt.deleteMany({});
  await prisma.transaction.deleteMany({});
  await prisma.paymentOrder.deleteMany({});
  await prisma.subInvoice.deleteMany({});
  await prisma.subscriber.deleteMany({});

  const sub = await prisma.subscriber.create({
    data: { id: 'sub-portal', legacyId: CID, abonado: 90001, firstName: 'Cliente', lastName1: 'Portal', status: 'ACTIVO', updatedAt: new Date() },
  });
  await prisma.subInvoice.create({
    data: {
      id: 'inv-portal', tid: 900001, subscriberId: sub.id,
      invoiceDate: new Date('2026-09-01'), dueDate: new Date('2026-09-20'),
      subtotal: TOTAL, total: TOTAL, paidAmount: 0, status: 'DUE', updatedAt: new Date(),
    },
  });
  await prisma.paymentOrder.create({
    data: { reference: REF, subscriberId: sub.id, gateway: 'wompi', amount: TOTAL, status: 'APPROVED', updatedAt: new Date() },
  });

  console.log('\n1) La deuda que ve el portal');
  const due1 = await portal.getDueCustomer(CID);
  comprobar('total - pamnt = la deuda', Number(due1.due.total) - Number(due1.due.pamnt) === TOTAL,
    `${due1.due.total} - ${due1.due.pamnt}`);
  comprobar('el botón de descuento queda oculto', due1.data_promos != null && (due1.data_estados_promos as unknown[]).length === 0);

  console.log('\n2) Guardas del pago');
  await esperaError('referencia que no existe', () => portal.payDueCustomer(CID, TOTAL, 'no-existe'));
  ordenFalsa = { ...ordenFalsa, estado: 'Inicial' };
  await esperaError('orden no aprobada', () => portal.payDueCustomer(CID, TOTAL, REF));
  ordenFalsa = { ...ordenFalsa, estado: 'Finalizada con Exito' };
  await esperaError('monto distinto al del portal', () => portal.payDueCustomer(CID, TOTAL - 1, REF));
  ordenFalsa = { ...ordenFalsa, cid_user: CID + 1 };
  await esperaError('orden de otro abonado', () => portal.payDueCustomer(CID, TOTAL, REF));
  ordenFalsa = { ...ordenFalsa, cid_user: CID };

  console.log('\n3) El pago');
  await portal.payDueCustomer(CID, TOTAL, REF);
  const inv = await prisma.subInvoice.findUnique({ where: { id: 'inv-portal' } });
  comprobar('la factura queda PAGADA', inv?.status === 'PAID', `status=${inv?.status} pagado=${inv?.paidAmount}`);
  comprobar('el método es WOMPI', inv?.paymentMethod === 'WOMPI', String(inv?.paymentMethod));

  const movs = await prisma.transaction.findMany({ where: { subscriberId: sub.id, status: 'VIGENTE' } });
  comprobar('un solo movimiento por el importe', movs.length === 1 && Number(movs[0].credit) === TOTAL,
    `${movs.length} movimiento(s)`);
  comprobar('lleva la referencia de la pasarela', movs[0]?.payuOrderId === REF, String(movs[0]?.payuOrderId));
  comprobar('entra en la cuenta WOMPI', movs[0]?.accountName === 'WOMPI', String(movs[0]?.accountName));
  comprobar('la nota dice el método y la referencia',
    !!movs[0]?.note?.includes('metodo: WOMPI') && !!movs[0]?.note?.includes(REF), movs[0]?.note ?? '');

  const orden = await prisma.paymentOrder.findUnique({ where: { reference: REF } });
  comprobar('la orden queda sellada (appliedAt)', orden?.appliedAt != null);
  comprobar('la orden apunta a su recaudo', orden?.transactionId === movs[0]?.id);

  console.log('\n4) El webhook reintenta (idempotencia)');
  const otra = await portal.payDueCustomer(CID, TOTAL, REF);
  comprobar('la segunda llamada no hace nada', (otra as any).yaAplicado === true);
  const movs2 = await prisma.transaction.count({ where: { subscriberId: sub.id, status: 'VIGENTE' } });
  comprobar('sigue habiendo UN movimiento', movs2 === 1, `${movs2}`);
  const inv2 = await prisma.subInvoice.findUnique({ where: { id: 'inv-portal' } });
  comprobar('la factura no se paga dos veces', Number(inv2?.paidAmount) === TOTAL, String(inv2?.paidAmount));

  console.log('\n5) Dos llamadas a la vez (webhook + red de seguridad)');
  // Otra factura y otra orden, esta vez atacada por dos caminos al mismo tiempo.
  const REF2 = 'ref-smoke-portal-0002';
  ordenFalsa = { id: 2, reference: REF2, debe: TOTAL, estado: 'Finalizada con Exito', cid_user: CID, metodo_pago: 'PSE', id_wompi: '9-9' };
  (portal as any).ordenDelPortal = async (r: string) => (r === REF2 ? ordenFalsa : null);
  await prisma.subInvoice.create({
    data: {
      id: 'inv-portal-2', tid: 900002, subscriberId: sub.id,
      invoiceDate: new Date('2026-10-01'), dueDate: new Date('2026-10-20'),
      subtotal: TOTAL, total: TOTAL, paidAmount: 0, status: 'DUE', updatedAt: new Date(),
    },
  });
  await prisma.paymentOrder.create({
    data: { reference: REF2, subscriberId: sub.id, gateway: 'wompi', amount: TOTAL, status: 'APPROVED', updatedAt: new Date() },
  });
  const carrera = await Promise.allSettled([
    portal.payDueCustomer(CID, TOTAL, REF2),
    portal.payDueCustomer(CID, TOTAL, REF2),
  ]);
  const aplicados = carrera.filter((r) => r.status === 'fulfilled' && !(r.value as any).yaAplicado).length;
  comprobar('sólo UNA de las dos aplica el pago', aplicados === 1, `${aplicados} aplicaron`);
  const movs3 = await prisma.transaction.count({ where: { invoiceId: 'inv-portal-2', status: 'VIGENTE' } });
  comprobar('un solo movimiento contra la factura', movs3 === 1, `${movs3}`);
  const inv3 = await prisma.subInvoice.findUnique({ where: { id: 'inv-portal-2' } });
  comprobar('no se cobra dos veces', Number(inv3?.paidAmount) === TOTAL, String(inv3?.paidAmount));

  console.log('\n6) El aviso de Wompi llega ANTES de que el puente registre la orden');
  const REF3 = 'ref-smoke-portal-0003';
  ordenFalsa = { id: 3, reference: REF3, debe: 50_000, estado: 'Finalizada con Exito', cid_user: CID, metodo_pago: 'PSE', id_wompi: '3-3' };
  (portal as any).ordenDelPortal = async (r: string) => (r === REF3 ? ordenFalsa : null);
  await prisma.subInvoice.create({
    data: {
      id: 'inv-portal-3', tid: 900003, subscriberId: sub.id,
      invoiceDate: new Date('2026-11-01'), dueDate: new Date('2026-11-20'),
      subtotal: 50_000, total: 50_000, paidAmount: 0, status: 'DUE', updatedAt: new Date(),
    },
  });
  // A propósito SIN crear el PaymentOrder: es el caso real (el puente ingesta cada 5 min).
  await portal.payDueCustomer(CID, 50_000, REF3);
  const inv4 = await prisma.subInvoice.findUnique({ where: { id: 'inv-portal-3' } });
  comprobar('el pago entra igual', inv4?.status === 'PAID', `status=${inv4?.status}`);
  const orden3 = await prisma.paymentOrder.findUnique({ where: { reference: REF3 } });
  comprobar('y la orden se crea ya sellada', orden3?.appliedAt != null);

  console.log('\n7) Ya pagada, el portal no vuelve a cobrar');
  (portal as any).ordenDelPortal = async (r: string) => (r === REF ? { id: 1, reference: REF, debe: TOTAL, estado: 'Finalizada con Exito', cid_user: CID, metodo_pago: 'PSE', id_wompi: '123-456' } : null);
  const due2 = await portal.getDueCustomer(CID);
  comprobar('la deuda queda en cero', Number(due2.due.total) - Number(due2.due.pamnt) === 0,
    `${due2.due.total} - ${due2.due.pamnt}`);

  console.log(fallos ? `\n❌ ${fallos} comprobación(es) en rojo\n` : '\n✅ todo en verde\n');
  if (fallos) process.exitCode = 1;
}

async function esperaError(desc: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    comprobar(`rechaza: ${desc}`, false, 'NO falló');
  } catch (e: any) {
    comprobar(`rechaza: ${desc}`, true, e?.message ?? '');
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
