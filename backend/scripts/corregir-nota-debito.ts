/**
 * Convierte una NOTA DÉBITO mal digitada en una NOTA CRÉDITO — nexus y legacy a la vez.
 *
 *   npx ts-node -T scripts/corregir-nota-debito.ts <tid|idFactura> [--si]
 *
 * POR QUÉ EXISTE (2026-09-02, caso real, factura 503806 del abonado 55508):
 * a un cliente se le concedió el 40 % de descuento por tres meses. En agosto se
 * aplicó bien (nota CRÉDITO de −26.400 → total 39.600) y en septiembre se escogió
 * por error el tipo contrario: la nota DÉBITO **sumó** los 26.400 y la factura pasó
 * de 66.000 a 92.400 en vez de bajar a 39.600.
 *
 * Notas: la aplicación sólo sabe AÑADIRLAS (`POST /invoices/:id/notes`); no hay
 * pantalla ni endpoint para quitar una, así que el error se queda en el detalle y en
 * el total mientras nadie entre por debajo. Esto entra por debajo: quita el renglón
 * equivocado y pone en su lugar la nota crédito del mismo monto, con la misma
 * descripción y el mismo autor. El renglón borrado queda en `AuditLog`.
 *
 * Sólo se permite cuando la factura NO tiene pagos aplicados y NO se emitió ante la
 * DIAN: si ya hay plata o número DIAN, lo correcto es una nota crédito ENCIMA (que sí
 * hace la pantalla), no reescribir el documento.
 *
 * El legacy va en el mismo viaje, con el mismo gesto que hace `pushEditedInvoices`
 * del writeback (borrar los renglones de la factura y reinsertarlos) más los totales
 * del encabezado. Si sólo se tocara este lado, el detalle de allá seguiría diciendo
 * 92.400 hasta la siguiente pasada del writeback —y el cliente paga por el legacy—.
 *
 * Sin `--si` sólo enseña lo que haría.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import mysql from 'mysql2/promise';
import { readFileSync } from 'node:fs';

// El .env a mano: este script se corre suelto, sin el arranque de la API.
for (const linea of readFileSync('.env', 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(linea.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { invItem, invInvoice } = require('./lib/vestel-map.js');

const num = (x: Prisma.Decimal | number | null | undefined) => Number(x ?? 0);
const round2 = (x: number) => Math.round(x * 100) / 100;
const pesos = (n: number) => n.toLocaleString('es-CO');

const prisma = new PrismaClient();

async function main() {
  const [clave, ...flags] = process.argv.slice(2);
  const enSerio = flags.includes('--si');
  if (!clave) throw new Error('Falta el tid o el id de la factura.');

  const inv = await prisma.subInvoice.findFirst({
    where: /^\d+$/.test(clave) ? { tid: Number(clave) } : { id: clave },
    include: {
      items: { orderBy: { createdAt: 'asc' } },
      electronicInvoices: { select: { type: true, dianNumber: true } },
      subscriber: { select: { id: true, legacyId: true, abonado: true, fullName: true } },
    },
  });
  if (!inv) throw new Error('No se encontró la factura.');

  if (inv.status === 'CANCELED') throw new Error('La factura está anulada.');
  if (num(inv.paidAmount) > 0) {
    throw new Error(`La factura ya tiene ${pesos(num(inv.paidAmount))} pagados: no se reescribe. Emita una nota crédito encima desde la pantalla.`);
  }
  if (inv.electronicInvoices.some((e) => e.type === 'FACTURADA' && e.dianNumber)) {
    throw new Error('La factura ya fue emitida ante la DIAN: ajústela con una nota crédito encima, no reescribiendo el documento.');
  }

  // La nota débito a corregir: la última, si hubiera más de una.
  const debito = [...inv.items].reverse().find((it) => it.productName === 'Nota Debito');
  if (!debito) throw new Error('Esta factura no tiene ninguna nota débito.');

  const monto = round2(Math.abs(num(debito.price)));
  const otros = inv.items.filter((it) => it.id !== debito.id);
  const subtotal = Math.max(0, round2(otros.reduce((s, it) => s + num(it.subtotal), 0) - monto));
  const total = Math.max(0, round2(subtotal + num(inv.tax)));

  // La retención del encabezado la puso esa misma nota (el legacy guarda ahí la
  // última): si la nota se va, se va con ella.
  const limpiaRetencion = !!debito.retentionType && inv.retentionType === debito.retentionType;

  console.log('Factura:', {
    tid: inv.tid, legacyId: inv.legacyId, fecha: inv.invoiceDate.toISOString().slice(0, 10),
    cliente: inv.subscriber ? `${inv.subscriber.abonado} · ${inv.subscriber.fullName ?? ''}`.trim() : null,
    total: num(inv.total), pagado: num(inv.paidAmount), estado: inv.status,
  });
  console.log('Nota débito a reemplazar:', { monto, retencion: debito.retentionType, autor: debito.createdByUserId, texto: debito.description });
  console.log(`\n  total  ${pesos(num(inv.total))}  →  ${pesos(total)}   (nota débito +${pesos(monto)} fuera, nota crédito −${pesos(monto)} dentro)`);
  if (limpiaRetencion) console.log(`  retención del encabezado: ${inv.retentionType} → (ninguna)`);
  if (!enSerio) { console.log('\n(simulación: añade --si para aplicarlo de verdad)'); return; }

  // ---------- nexus ----------
  await prisma.$transaction(async (db) => {
    await db.subInvoiceItem.delete({ where: { id: debito.id } });
    await db.subInvoiceItem.create({
      data: {
        invoiceId: inv.id, productId: 0, productName: 'Nota Credito',
        description: debito.description, qty: 1,
        price: -monto, taxRate: 0, subtotal: -monto, taxTotal: 0, discountTotal: 0,
        retentionType: null, createdByUserId: debito.createdByUserId,
      },
    });
    await db.subInvoice.update({
      where: { id: inv.id },
      data: {
        subtotal, total, status: 'DUE', itemsCount: otros.length + 1,
        ...(limpiaRetencion ? { retentionType: null } : {}),
        // Igual que `aplicarNotaEnTx`: la factura queda MODIFICADA y blindada de la
        // ida. `editCount` SÍ sube aquí (a diferencia de una nota corriente) porque
        // es lo que mira `pushEditedInvoices` para reescribirla allá.
        editedAt: new Date(), editedBy: 'Soporte (corrección de nota)',
        editCount: { increment: 1 },
      },
    });
    await db.auditLog.create({
      data: {
        action: 'UPDATE', entity: 'SubInvoice', entityId: inv.id,
        before: { total: num(inv.total), subtotal: num(inv.subtotal), retentionType: inv.retentionType,
          nota: { tipo: 'Nota Debito', monto, retencion: debito.retentionType, legacyId: debito.legacyId, descripcion: debito.description } },
        after: { total, subtotal, retentionType: limpiaRetencion ? null : inv.retentionType,
          nota: { tipo: 'Nota Credito', monto: -monto },
          motivo: 'Nota débito digitada por error: era el descuento pactado (nota crédito). Corregida por script.' },
      },
    });
    if (inv.subscriberId) {
      const agg = await db.transaction.aggregate({
        _sum: { debit: true, credit: true },
        where: { subscriberId: inv.subscriberId, status: 'VIGENTE', ext: false },
      });
      await db.subscriber.update({
        where: { id: inv.subscriberId },
        data: { debitCache: agg._sum.debit ?? 0, creditCache: agg._sum.credit ?? 0 },
      });
    }
  });
  console.log('nexus: nota débito fuera, nota crédito dentro, total recalculado.');

  // ---------- legacy ----------
  if (inv.legacyId == null) { console.log('legacy: la factura no existe allá (legacyId nulo), nada que reescribir.'); return; }
  const my = await mysql.createConnection({
    host: process.env.LEGACY_DB_HOST, port: Number(process.env.LEGACY_DB_PORT ?? 3306),
    user: process.env.LEGACY_DB_USER, password: process.env.LEGACY_DB_PASSWORD,
    database: process.env.LEGACY_DB_NAME, dateStrings: true,
  });
  await my.beginTransaction();
  try {
    const frescos = await prisma.subInvoiceItem.findMany({ where: { invoiceId: inv.id } });
    await my.execute('DELETE FROM invoice_items WHERE tid = ?', [inv.tid]);
    for (const it of frescos) {
      const fila = invItem(it, inv.tid) as Record<string, unknown>;
      const cols = Object.keys(fila);
      const [res]: any = await my.execute(
        `INSERT INTO \`invoice_items\` (${cols.map((c) => `\`${c}\``).join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
        cols.map((c) => fila[c] ?? null),
      );
      await prisma.subInvoiceItem.update({ where: { id: it.id }, data: { legacyId: res.insertId } });
    }
    const full = invInvoice({ ...inv, subtotal, total, status: 'DUE', itemsCount: frescos.length },
      inv.subscriber?.legacyId ?? null) as Record<string, unknown>;
    const cols = ['subtotal', 'tax', 'total', 'items'];
    await my.execute(
      `UPDATE \`invoices\` SET ${cols.map((c) => `\`${c}\`=?`).join(',')} WHERE \`id\`=?`,
      [...cols.map((c) => full[c] ?? null), inv.legacyId],
    );
    await my.commit();
    console.log(`legacy: factura ${inv.legacyId} reescrita (${frescos.length} renglones, total ${pesos(total)}).`);
  } catch (e) {
    await my.rollback();
    throw e;
  } finally {
    await my.end();
  }
}

main().catch((e) => { console.error('✖', e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
