/**
 * Smoke de CONCURRENCIA de los consecutivos (`tid`).
 *
 * Lanza N creaciones de factura simultáneas y comprueba que salen N documentos con
 * N consecutivos DISTINTOS y cero fallos.
 *
 * Por qué existe: el consecutivo se sacaba con `MAX(tid)+1`. Dos procesos que leen a
 * la vez obtienen el mismo número; como `tid` tiene índice único, la segunda inserción
 * falla. En el cron de facturación recurrente ese fallo se contabilizaba como
 * `failed++` y el abonado se quedaba sin factura del mes, sin reintento ni alerta.
 * Con `MAX(tid)+1` este script imprime fallos por colisión; con la secuencia de
 * Postgres (`common/tid.ts`) pasa en verde.
 *
 * Uso — NUNCA contra producción, crea datos:
 *   createdb saves_tid_test
 *   DATABASE_URL="postgresql://usuario:clave@localhost:5432/saves_tid_test" \
 *     npx prisma migrate deploy
 *   DATABASE_URL="postgresql://usuario:clave@localhost:5432/saves_tid_test" \
 *     FACTURAS=20 npx ts-node scripts/smoke-tid-race.ts
 */
import { PrismaClient } from '@prisma/client';
import { FacturasService } from '../src/billing/facturas.service';

const N = Number(process.env.FACTURAS || 20);

const url = process.env.DATABASE_URL ?? '';
if (!url) throw new Error('Define DATABASE_URL apuntando a una base de PRUEBAS desechable.');
// Mirar el NOMBRE de la base, no la URL entera: el usuario de producción se llama igual.
const dbName = new URL(url).pathname.replace(/^\//, '');
if (dbName === 'saves_vestel') {
  throw new Error('DATABASE_URL apunta a la base de PRODUCCIÓN. Este script crea datos: abortado.');
}

const prisma = new PrismaClient({ datasources: { db: { url } } });

// Contabilidad y cobranzas fuera de juego: aquí sólo se mide el consecutivo.
const posting = { postSalesInvoice: async () => null };
const cobranzas = {};

async function main() {
  const svc = new FacturasService(prisma as never, posting as never, cobranzas as never, {} as never);
  const user = { id: 'u-test', name: 'Smoke', email: 'smoke@test', permissions: ['system.admin'], roles: [] };

  await prisma.subInvoiceItem.deleteMany({});
  await prisma.subInvoice.deleteMany({});
  await prisma.subscriber.deleteMany({});
  await prisma.subscriber.create({
    data: { id: 'sub-tid', abonado: 1, firstName: 'Cliente', lastName1: 'Prueba', updatedAt: new Date() },
  });

  const dto = {
    subscriberId: 'sub-tid',
    invoiceDate: '2026-07-01',
    items: [{ productName: 'Internet', description: 'Plan', qty: 1, price: 50_000, taxRate: 0 }],
  };

  const res = await Promise.allSettled(
    Array.from({ length: N }, () => svc.createInvoice(dto as never, user as never)),
  );
  const ok = res.filter((r) => r.status === 'fulfilled').length;
  const fallidos = res.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

  const facturas = await prisma.subInvoice.findMany({ select: { tid: true } });
  const tids = facturas.map((f) => f.tid);
  const distintos = new Set(tids).size;

  console.log(`  facturas lanzadas : ${N}`);
  console.log(`  ok / fallidas     : ${ok} / ${fallidos.length}`);
  if (fallidos.length) console.log(`  motivo fallo      : ${fallidos[0].reason?.message ?? fallidos[0].reason}`);
  console.log(`  creadas en BD     : ${tids.length}  (consecutivos distintos = ${distintos})`);

  if (fallidos.length || tids.length !== N || distintos !== N) {
    console.error(`  ❌ COLISIÓN: se pidieron ${N} facturas y hay ${tids.length} con ${distintos} consecutivos únicos`);
    process.exitCode = 1;
    return;
  }
  console.log(`  ✅ SIN COLISIONES: ${N} facturas con ${distintos} consecutivos únicos`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
