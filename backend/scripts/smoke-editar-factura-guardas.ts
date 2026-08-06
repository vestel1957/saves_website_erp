/**
 * Guardas de la edición de facturas, contra la BD real. Todo lo que escribe lo revierte.
 *
 * Uso: npx ts-node --transpile-only scripts/smoke-editar-factura-guardas.ts
 */
import { PrismaClient } from '@prisma/client';
import { FacturasService } from '../src/billing/facturas.service';

const prisma = new PrismaClient();
let ok = 0, fail = 0;
const assert = (cond: boolean, msg: string, extra = '') => {
  if (cond) { ok++; console.log(`  OK    ${msg}`); }
  else { fail++; console.log(`  FALLO ${msg} ${extra}`); }
};

const posting: any = { postSalesInvoiceAdjustment: async () => null };
const user: any = { id: 'smoke', name: 'Prueba Contabilidad', email: 'prueba@vestel.com.co', permissions: ['system.admin'] };
const svc = () => new FacturasService(prisma as any, posting, {} as any);

/** Corre la edición y devuelve el mensaje de error, o null si pasó. */
async function intento(id: string, items: any[], reason = 'prueba de guarda') {
  try { await svc().updateInvoice(id, { reason, items } as any, user); return null; }
  catch (e) { return (e as Error).message; }
}

async function main() {
  // 1) No puede quedar por debajo de lo ya pagado
  const pagada = await prisma.subInvoice.findFirst({
    where: { paidAmount: { gt: 0 }, status: { in: ['PAID', 'PARTIAL'] }, electronicInvoices: { none: {} } },
    select: { id: true, tid: true, paidAmount: true },
  });
  if (pagada) {
    const msg = await intento(pagada.id, [{ productName: 'X', description: 'X', qty: 1, price: 1, taxRate: 0 }]);
    assert(!!msg && msg.includes('pagados'), `factura pagada #${pagada.tid}: no deja bajar el total`, String(msg));
    const sigue = await prisma.subInvoice.findUnique({ where: { id: pagada.id }, select: { editedAt: true } });
    assert(sigue?.editedAt == null, 'la factura rechazada no quedó marcada como editada');
  }

  // 2) Sin conceptos, no
  if (pagada) {
    const msg = await intento(pagada.id, []);
    assert(!!msg && msg.includes('sin conceptos'), 'una factura no se puede dejar sin conceptos', String(msg));
  }

  // 3) Anulada, no
  const anulada = await prisma.subInvoice.findFirst({ where: { status: 'CANCELED' }, select: { id: true, tid: true } });
  if (anulada) {
    const msg = await intento(anulada.id, [{ productName: 'X', description: 'X', qty: 1, price: 1000, taxRate: 0 }]);
    assert(!!msg && msg.includes('anulada'), `factura anulada #${anulada.tid}: no se edita`, String(msg));
  } else console.log('  (sin facturas anuladas para probar)');

  // 4) Timbrada ante la DIAN, no
  const timbrada = await prisma.subInvoice.findFirst({
    where: { electronicInvoices: { some: { type: 'FACTURADA', dianNumber: { not: null } } } },
    select: { id: true, tid: true },
  });
  if (timbrada) {
    const msg = await intento(timbrada.id, [{ productName: 'X', description: 'X', qty: 1, price: 1000, taxRate: 0 }]);
    assert(!!msg && msg.includes('DIAN'), `factura timbrada #${timbrada.tid}: no se edita`, String(msg));
  } else console.log('  (sin facturas timbradas ante la DIAN todavía)');

  // 5) Las notas crédito/débito se conservan y siguen contando en el total
  const conNota = await prisma.subInvoiceItem.findFirst({
    where: { productName: { in: ['Nota Credito', 'Nota Debito'] }, invoice: { status: { notIn: ['CANCELED'] } } },
    select: { invoiceId: true, subtotal: true },
  });
  if (conNota) {
    const antes = await prisma.subInvoice.findUnique({ where: { id: conNota.invoiceId }, include: { items: true } });
    // Se pone un pago de 0 temporal para que la guarda del pagado no estorbe la prueba.
    await prisma.subInvoice.update({ where: { id: conNota.invoiceId }, data: { paidAmount: 0 } });
    const res: any = await svc().updateInvoice(conNota.invoiceId, {
      reason: 'prueba nota', items: [{ productName: 'Servicio', description: 'Servicio', qty: 1, price: 100000, taxRate: 0 }],
    } as any, user);
    const notaVal = Number(conNota.subtotal);
    assert(res.notesKept >= 1, 'la nota sobrevive a la edición', JSON.stringify(res));
    assert(res.subtotal === 100000 + notaVal, `el total incluye la nota (${notaVal})`, JSON.stringify(res));
    const items = await prisma.subInvoiceItem.count({ where: { invoiceId: conNota.invoiceId, productName: { in: ['Nota Credito', 'Nota Debito'] } } });
    assert(items >= 1, 'la nota sigue en la factura');

    // reversa
    await prisma.subInvoiceItem.deleteMany({ where: { invoiceId: conNota.invoiceId } });
    for (const it of antes!.items) { const { id, ...data } = it as any; await prisma.subInvoiceItem.create({ data }); }
    const { id, items: _i, ...orig } = antes as any;
    await prisma.subInvoice.update({ where: { id: conNota.invoiceId }, data: { ...orig, editedAt: null, editedBy: null, editCount: 0 } });
    await prisma.auditLog.deleteMany({ where: { entity: 'SubInvoice', entityId: conNota.invoiceId, action: 'UPDATE' } });
    const fin = await prisma.subInvoice.findUnique({ where: { id: conNota.invoiceId }, include: { items: true } });
    assert(Number(fin!.total) === Number(antes!.total) && fin!.items.length === antes!.items.length && fin!.editedAt === null,
      'la factura de prueba quedó como estaba', `${fin!.total} vs ${antes!.total}`);
  }

  console.log(`\n${ok} OK · ${fail} fallos`);
  await prisma.$disconnect();
  if (fail) process.exit(1);
}
main().catch(async (e) => { console.error('FALLO:', e); await prisma.$disconnect(); process.exit(1); });
