/**
 * Prueba de que una factura editada aquí SOBREVIVE al sync de ida (legacy → nuevo).
 *
 * Edita una factura de verdad, corre `sync-legacy-vivo.js` completo (lo mismo que el
 * cron cada 15 min) y comprueba que el total y los renglones nuevos siguen ahí y que
 * el legacy no los pisó. Deja la factura como estaba (respaldo en JSON por si acaso).
 *
 * Uso: INV_ID=<id> npx ts-node --transpile-only scripts/smoke-editar-factura-sync.ts
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { FacturasService } from '../src/billing/facturas.service';

const prisma = new PrismaClient();
const ID = process.env.INV_ID!;
let ok = 0, fail = 0;
const assert = (c: boolean, m: string, extra = '') => {
  if (c) { ok++; console.log(`  OK    ${m}`); } else { fail++; console.log(`  FALLO ${m} ${extra}`); }
};

const posting: any = { postSalesInvoiceAdjustment: async () => null };
const user: any = { id: 'smoke', name: 'Prueba Contabilidad', email: 'prueba@vestel.com.co', permissions: ['system.admin'] };

async function main() {
  const antes = await prisma.subInvoice.findUnique({ where: { id: ID }, include: { items: true } });
  if (!antes) throw new Error('factura no encontrada');
  // Si la prueba anterior se cortó a la mitad, el "antes" que se guardaría sería el
  // estado EDITADO y la reversa dejaría la factura falseada para siempre. Mejor no
  // arrancar: se limpia la marca y se deja que el sync reponga la factura del legacy.
  if (antes.editedAt) {
    throw new Error(`la factura #${antes.tid} ya está marcada como editada: repónla desde el legacy antes de correr esta prueba`);
  }
  const respaldo = join(__dirname, `_respaldo-factura-${antes.tid}.json`);
  writeFileSync(respaldo, JSON.stringify(antes, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 1));
  console.log(`factura #${antes.tid} · total ${antes.total} · ${antes.items.length} renglones · respaldo en ${respaldo}`);

  const svc = new FacturasService(prisma as any, posting, {} as any, {} as any);
  const res: any = await svc.updateInvoice(ID, {
    reason: 'prueba de blindaje contra el sync',
    items: [{ productName: 'Concepto de prueba', description: 'Concepto de prueba', qty: 1, price: 12345, taxRate: 0 }],
  } as any, user);
  console.log(`editada → total ${res.total}`);

  console.log('corriendo sync-legacy-vivo (completo)…');
  const out = execFileSync(process.execPath, ['--max-old-space-size=2048', join(__dirname, 'sync-legacy-vivo.js')],
    { maxBuffer: 32 * 1024 * 1024, env: process.env }).toString().trim().split('\n').pop()!;
  const sum = JSON.parse(out);
  console.log('sync:', JSON.stringify(sum.invoices));
  assert(sum.ok === true, 'el sync corrió sin error');
  assert((sum.invoices?.editadasAqui ?? 0) >= 0, 'el sync reporta las editadas aparte');

  const desp = await prisma.subInvoice.findUnique({ where: { id: ID }, include: { items: true } });
  assert(Number(desp!.total) === 12345, 'el total editado sobrevivió al sync', `quedó ${desp!.total}`);
  assert(desp!.items.length === 1 && desp!.items[0].productName === 'Concepto de prueba',
    'los renglones editados sobrevivieron (no volvieron los del legacy)', `${desp!.items.length} renglones`);
  assert(desp!.editedAt != null, 'la marca de edición sigue puesta');

  // reversa
  await prisma.subInvoiceItem.deleteMany({ where: { invoiceId: ID } });
  for (const it of antes.items) { const { id, ...data } = it as any; await prisma.subInvoiceItem.create({ data }); }
  const { id, items: _i, ...orig } = antes as any;
  await prisma.subInvoice.update({ where: { id: ID }, data: { ...orig, editedAt: null, editedBy: null, editCount: 0 } });
  await prisma.auditLog.deleteMany({ where: { entity: 'SubInvoice', entityId: ID, action: 'UPDATE' } });
  const fin = await prisma.subInvoice.findUnique({ where: { id: ID }, include: { items: true } });
  assert(Number(fin!.total) === Number(antes.total) && fin!.items.length === antes.items.length && fin!.editedAt === null,
    'la factura quedó como estaba', `${fin!.total} vs ${antes.total}`);

  console.log(`\n${ok} OK · ${fail} fallos`);
  await prisma.$disconnect();
  if (fail) process.exit(1);
}
main().catch(async (e) => { console.error('FALLO:', e); await prisma.$disconnect(); process.exit(1); });
