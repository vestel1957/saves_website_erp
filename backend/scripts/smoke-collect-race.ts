/**
 * Smoke de CONCURRENCIA de `CobranzasService.collect()`.
 *
 * Lanza N recaudos simultáneos del MISMO cliente y comprueba el invariante que
 * de verdad importa: **lo que cobró la caja tiene que ser lo que refleja la cartera**
 * (suma de los INCOME creados == paidAmount de la factura).
 *
 * Por qué existe: el reparto de un pago es un read-modify-write sobre `paidAmount`.
 * Cuando las facturas se leían fuera de la transacción, dos recaudos simultáneos
 * calculaban sobre la misma foto y uno de los abonos se perdía — pero las DOS filas
 * de ingreso quedaban creadas. Con 5 pagos de 20.000 esto imprimía:
 *     ❌ se cobraron 100000 pero la cartera sólo refleja 20000
 * El arreglo (bloquear la fila del suscriptor con FOR UPDATE y repartir dentro de
 * la transacción) lo deja en verde. Este script es la regresión de eso.
 *
 * Uso — NUNCA contra producción, crea y borra datos:
 *   createdb saves_race_test
 *   DATABASE_URL="postgresql://usuario:clave@localhost:5432/saves_race_test" \
 *     npx prisma migrate deploy
 *   DATABASE_URL="postgresql://usuario:clave@localhost:5432/saves_race_test" \
 *     PAGOS=10 npx ts-node scripts/smoke-collect-race.ts
 */
import { PrismaClient } from '@prisma/client';
import { CobranzasService } from '../src/treasury/cobranzas.service';

const PAGOS = Number(process.env.PAGOS || 5);
const IMPORTE = 20_000;
const TOTAL_FACTURA = 200_000;

const url = process.env.DATABASE_URL ?? '';
// Seguro: este script borra suscriptores, facturas y movimientos. Que no pueda
// apuntar por accidente a la base real.
if (!url) {
  throw new Error('Define DATABASE_URL apuntando a una base de PRUEBAS desechable.');
}
// Ojo: hay que mirar el NOMBRE DE LA BASE, no la URL entera — el usuario de
// producción también se llama `saves_vestel` y un match sobre la cadena completa
// bloquearía cualquier base de pruebas servida por ese mismo usuario.
const dbName = new URL(url).pathname.replace(/^\//, '');
if (dbName === 'saves_vestel') {
  throw new Error('DATABASE_URL apunta a la base de PRODUCCIÓN. Este script borra datos: abortado.');
}

const prisma = new PrismaClient({ datasources: { db: { url } } });

// Las integraciones externas quedan fuera: aquí sólo se mide la carrera sobre el dinero.
const posting = { postCustomerPayment: async () => null, postTreasuryIncome: async () => null };
const mikrotik = { reconnect: async () => null };
// El emisor de eventos tampoco entra al humo: aquí sólo se mide la carrera sobre el dinero.
const eventos = { emit: () => true };

async function main() {
  const svc = new CobranzasService(
    prisma as never,
    posting as never,
    mikrotik as never,
    eventos as never,
  );
  const user = {
    id: 'u-test', name: 'Smoke', email: 'smoke@test',
    permissions: ['system.admin'], roles: [],
  };

  await prisma.transaction.deleteMany({});
  await prisma.subInvoice.deleteMany({});
  await prisma.subscriber.deleteMany({});

  const sub = await prisma.subscriber.create({
    data: { id: 'sub-race', abonado: 1, firstName: 'Cliente', lastName1: 'Prueba', updatedAt: new Date() },
  });
  await prisma.subInvoice.create({
    data: {
      id: 'inv-race', tid: 1, subscriberId: sub.id,
      invoiceDate: new Date('2026-07-01'), dueDate: new Date('2026-07-15'),
      total: TOTAL_FACTURA, paidAmount: 0, status: 'DUE', updatedAt: new Date(),
    },
  });

  const res = await Promise.allSettled(
    Array.from({ length: PAGOS }, () =>
      svc.collect(
        { subscriberId: sub.id, amount: IMPORTE, method: 'Efectivo' } as never,
        user as never,
      ),
    ),
  );
  const ok = res.filter((r) => r.status === 'fulfilled').length;
  const fallidos = res.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

  const factura = await prisma.subInvoice.findUnique({ where: { id: 'inv-race' } });
  const agg = await prisma.transaction.aggregate({
    _sum: { credit: true }, _count: { _all: true },
    where: { invoiceId: 'inv-race', status: 'VIGENTE' },
  });

  const cobrado = Number(agg._sum.credit ?? 0);
  const pagado = Number(factura!.paidAmount);

  console.log(`  recaudos lanzados : ${PAGOS} de ${IMPORTE} (factura de ${TOTAL_FACTURA})`);
  console.log(`  ok / fallidos     : ${ok} / ${fallidos.length}`);
  if (fallidos.length) console.log(`  motivo fallo      : ${fallidos[0].reason?.message ?? fallidos[0].reason}`);
  console.log(`  filas INCOME      : ${agg._count._all}  (suma cobrada = ${cobrado})`);
  console.log(`  paidAmount factura: ${pagado}`);

  if (cobrado !== pagado) {
    console.error(`  ❌ DESCUADRE: se cobraron ${cobrado} y la cartera refleja ${pagado} (perdidos ${cobrado - pagado})`);
    process.exitCode = 1;
    return;
  }
  console.log(`  ✅ CUADRA: la caja cobró ${cobrado} y la cartera registra ${pagado}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
