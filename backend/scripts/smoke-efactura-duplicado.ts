/** Comprueba el freno al doble timbre: un abonado que el legacy ya facturó este mes. */
import { PrismaService } from '../src/prisma/prisma.service';
import { EinvoiceEmitService } from '../src/einvoice/einvoice-emit.service';

// Seguro: este smoke NUNCA timbra. El gate se lee al CONSTRUIR el servicio (más abajo),
// así que apagarlo aquí basta, pase lo que pase en el entorno.
process.env.EINVOICE_LIVE = 'false';

async function main() {
  const prisma = new PrismaService();
  const emit = new EinvoiceEmitService(prisma);
  const ya = await prisma.electronicInvoice.findFirst({
    where: { type: 'FACTURADA', date: { gte: new Date('2026-09-01T00:00:00Z') }, subscriberId: { not: null } },
    select: { subscriberId: true, date: true },
  });
  const f = await prisma.subInvoice.findFirst({
    where: { subscriberId: ya!.subscriberId!, invoiceDate: { gte: new Date('2026-09-01T00:00:00Z'), lt: new Date('2026-10-01T00:00:00Z') } },
    select: { id: true, tid: true },
  });
  console.log(`abonado ya timbrado el ${ya!.date.toISOString().slice(0, 10)} · factura del mes: ${f ? `tid ${f.tid}` : 'no tiene'}`);
  if (f) {
    try { const r: any = await emit.emit(f.id); console.log('NO FRENÓ →', r.message); }
    catch (e: any) { console.log('frenado ✓ →', e.message); }
    try { const r: any = await emit.emit(f.id, undefined, true); console.log('con forzar → payload de', r.payload?.items?.length, 'ítem(s)'); }
    catch (e: any) { console.log('con forzar falló:', e.message); }
  }
  await prisma.$disconnect();
}
main();
