/**
 * Arma (sin enviar) el payload DIAN de unas facturas reales y lo imprime, para poder
 * cotejarlo contra las facturas que el legacy ya timbró en Siigo.
 *   npx tsx scripts/smoke-efactura-payload.ts [cuantas]
 */
import { PrismaService } from '../src/prisma/prisma.service';
import { EinvoiceEmitService } from '../src/einvoice/einvoice-emit.service';

// Seguro: este smoke NUNCA timbra. El gate se lee al CONSTRUIR el servicio (más abajo),
// así que apagarlo aquí basta, pase lo que pase en el entorno.
process.env.EINVOICE_LIVE = 'false';

async function main() {
  const prisma = new PrismaService();
  const emit = new EinvoiceEmitService(prisma);
  const n = Number(process.argv[2] || 3);

  const facturas = await prisma.subInvoice.findMany({
    where: {
      eInvoiceFlag: 'Crear Factura Electronica',
      subscriber: { is: { eInvoice: true } },
      invoiceDate: { gte: new Date('2026-09-01T00:00:00Z'), lt: new Date('2026-10-01T00:00:00Z') },
      ...(process.argv[3] === 'condescuento' ? { items: { some: { productName: 'Nota Credito' } } } : {}),
    },
    select: { id: true, tid: true, invoiceDate: true, subscriber: { select: { abonado: true, docNumber: true, branch: { select: { name: true } } } } },
    orderBy: { invoiceDate: 'desc' },
    take: n,
  });
  console.log(`facturas pendientes tomadas: ${facturas.length}\n`);
  for (const f of facturas) {
    console.log(`--- tid ${f.tid} · abonado ${f.subscriber?.abonado} · doc ${f.subscriber?.docNumber} · ${f.subscriber?.branch?.name} · ${f.invoiceDate.toISOString().slice(0, 10)}`);
    try {
      const r: any = await emit.emit(f.id);
      console.log(JSON.stringify(r.payload, null, 1));
    } catch (e: any) {
      console.log('ERROR:', e?.message);
    }
  }
  await prisma.$disconnect();
}
main();
