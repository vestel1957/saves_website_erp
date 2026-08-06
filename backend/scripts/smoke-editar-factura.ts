/**
 * Prueba de la edición de facturas contra la BD real, con reversa al final:
 * edita una factura de prueba, comprueba totales/estado/auditoría y la deja como estaba.
 *
 * Los ítems que manda son de ejemplo (un plan y una instalación): sirve para ver el
 * recálculo, no para validar el catálogo.
 *
 * Uso: INV_ID=<id de la factura> npx ts-node --transpile-only scripts/smoke-editar-factura.ts
 */
import { PrismaClient } from '@prisma/client';
import { FacturasService } from '../src/billing/facturas.service';

const prisma = new PrismaClient();
const ID = process.env.INV_ID!;

const posting: any = { postSalesInvoice: async () => null, postSalesInvoiceAdjustment: async (a: any) => { console.log('  ajuste contable:', a.deltaSubtotal, a.deltaTax); return null; } };
const cobranzas: any = {};
const user: any = { id: 'smoke', name: 'Prueba Contabilidad', email: 'prueba@vestel.com.co', permissions: ['system.admin'] };

async function main() {
  const svc = new FacturasService(prisma as any, posting, cobranzas);
  const antes = await prisma.subInvoice.findUnique({ where: { id: ID }, include: { items: true } });
  console.log('ANTES  total', String(antes!.total), 'items', antes!.items.length, 'status', antes!.status, 'editedAt', antes!.editedAt);

  const res = await svc.updateInvoice(ID, {
    reason: 'prueba automatizada',
    items: [
      { productName: '100MegasStS', description: '100MegasStS', qty: 1, price: 401681, taxRate: 0 },
      { productName: 'Instalación', description: 'Instalación', qty: 1, price: 50000, taxRate: 19 },
    ],
  } as any, user);
  console.log('RESULTADO', res);

  const desp = await prisma.subInvoice.findUnique({ where: { id: ID }, include: { items: true } });
  console.log('DESPUÉS total', String(desp!.total), 'subtotal', String(desp!.subtotal), 'iva', String(desp!.tax),
    'items', desp!.items.length, 'status', desp!.status, 'editCount', desp!.editCount, 'editedBy', desp!.editedBy);
  const audit = await prisma.auditLog.findFirst({ where: { entity: 'SubInvoice', entityId: ID }, orderBy: { createdAt: 'desc' } });
  console.log('AUDITORÍA', audit?.action, JSON.stringify(audit?.after).slice(0, 160));

  // Segunda edición: comprobar el contador y que baje el total
  const res2 = await svc.updateInvoice(ID, {
    reason: 'prueba 2', items: [{ productName: '100MegasStS', description: '100MegasStS', qty: 1, price: 100000, taxRate: 0 }],
  } as any, user);
  console.log('2ª EDICIÓN', res2);

  // Reversa: dejar la factura como estaba
  await prisma.subInvoiceItem.deleteMany({ where: { invoiceId: ID } });
  for (const it of antes!.items) {
    const { id, ...data } = it as any;
    await prisma.subInvoiceItem.create({ data });
  }
  const { id, ...orig } = antes as any;
  delete orig.items;
  await prisma.subInvoice.update({ where: { id: ID }, data: { ...orig, editedAt: null, editedBy: null, editCount: 0 } });
  await prisma.auditLog.deleteMany({ where: { entity: 'SubInvoice', entityId: ID, action: 'UPDATE' } });
  const fin = await prisma.subInvoice.findUnique({ where: { id: ID }, include: { items: true } });
  console.log('REVERTIDA total', String(fin!.total), 'items', fin!.items.length, 'editedAt', fin!.editedAt);
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error('FALLO:', e.message); await prisma.$disconnect(); process.exit(1); });
