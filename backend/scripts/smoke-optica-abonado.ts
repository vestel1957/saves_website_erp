/**
 * Señal óptica del abonado (el bloque de la ficha), contra la BD y las OLT REALES.
 *
 * Sólo lee: `display ont info` + `display ont optical-info` de la ONU de un puñado
 * de abonados. Comprueba los tres caminos con que se localiza el equipo —la ONU
 * vinculada, el serial del inventario y la búsqueda por SN en la OLT de la sede— y
 * que un abonado sin ONU salga con el motivo `SIN_ONU` en vez de un error.
 *
 * Uso: npx tsx scripts/smoke-optica-abonado.ts
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { OltService } from '../src/network/olt.service';

async function main() {
  const prisma = new PrismaClient();
  const olt = new OltService(prisma as any);

  const filas = await prisma.oltOnu.findMany({
    where: { subscriberId: { not: null }, syncState: 'presente', ontId: { not: null } },
    select: { subscriberId: true, sn: true, rxPower: true, olt: { select: { name: true } } },
    take: 3,
  });
  for (const f of filas) {
    const t = Date.now();
    const r: any = await olt.opticaDeAbonado(f.subscriberId!);
    console.log(`\n== ${f.olt.name} · SN ${f.sn} · rx del último sync ${f.rxPower ?? '—'} · ${Date.now() - t} ms`);
    console.dir(r, { depth: 4 });
  }

  const sinOnu = await prisma.subscriber.findFirst({
    where: { oltOnus: { none: {} }, status: { not: 'RETIRADO' } },
    select: { id: true, abonado: true },
  });
  if (sinOnu) {
    const t = Date.now();
    const r = await olt.opticaDeAbonado(sinOnu.id);
    console.log(`\n== sin ONU vinculada: abonado ${sinOnu.abonado} · ${Date.now() - t} ms`);
    console.dir(r, { depth: 4 });
  }

  await prisma.$disconnect();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
