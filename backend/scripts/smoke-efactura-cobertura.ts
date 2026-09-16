/**
 * ¿Todos los conceptos que se van a timbrar tienen código de producto en Siigo?
 * Recorre las facturas pendientes de los clientes marcados y lista los nombres de ítem
 * que NO resuelven contra el catálogo (esos los rechazaría la DIAN).
 *   npx tsx scripts/smoke-efactura-cobertura.ts
 */
import { PrismaService } from '../src/prisma/prisma.service';

async function main() {
  const prisma = new PrismaService();
  const items = await prisma.subInvoiceItem.groupBy({
    by: ['productName'],
    where: { invoice: { is: {
      eInvoiceFlag: 'Crear Factura Electronica',
      subscriber: { is: { eInvoice: true } },
      invoiceDate: { gte: new Date(`${process.argv[2] || '2026-09'}-01T00:00:00Z`), lt: new Date(`${process.argv[3] || '2026-11'}-01T00:00:00Z`) },
    } } },
    _count: { _all: true },
  });
  const nombres = items.map((i) => (i.productName ?? '').trim()).filter(Boolean);
  const mats = await prisma.material.findMany({ where: { name: { in: nombres }, code: { not: null } }, select: { name: true } });
  const conCodigo = new Set(mats.map((m) => m.name));
  const tv = (n: string) => /televi|punto/i.test(n);

  const faltan = items.filter((i) => i.productName && !conCodigo.has(i.productName.trim()) && !tv(i.productName));
  console.log(`conceptos distintos por timbrar: ${items.length}`);
  console.log(`sin código de catálogo (y no son de TV): ${faltan.length}`);
  for (const f of faltan.sort((a, b) => b._count._all - a._count._all).slice(0, 25)) {
    console.log(`  ${String(f._count._all).padStart(7)}  ${f.productName}`);
  }
  await prisma.$disconnect();
}
main();
