/**
 * Una misma nota crédito/débito sobre VARIAS facturas del mismo cliente.
 *
 * Nace de la depuración de cartera: perdonarle a un abonado los meses que arrastra
 * era una pasada por el modal por cada factura, reescribiendo la observación cada
 * vez. El lote lo hace de una, y el servidor tiene que garantizar lo que la pantalla
 * no puede: que las facturas existan, que sean TODAS del mismo cliente, que ninguna
 * venga repetida y que los montos sean positivos.
 *
 * Se prueba el DTO (donde vive la validación de forma) y el servicio contra un
 * Prisma de mentira, sin BD.
 */
import 'reflect-metadata';
import { validar } from '../core/http/validar';
import { CreateNotesBulkDto } from './dto/facturas.dto';
import { FacturasService } from './facturas.service';
import type { AuthUser } from '../auth/current-user.decorator';

const lote = (extra: Record<string, unknown>) => ({
  type: 'CREDITO',
  description: 'Depuración de cartera, autoriza cartera',
  items: [{ invoiceId: 'inv-1', amount: 15000 }],
  ...extra,
});

describe('CreateNotesBulkDto', () => {
  it('exige al menos una factura', () => {
    expect(() => validar(CreateNotesBulkDto, lote({ items: [] }))).toThrow(/al menos una factura/i);
  });

  it('exige la observación, igual que la nota suelta', () => {
    expect(() => validar(CreateNotesBulkDto, lote({ description: 'ok' }))).toThrow(/observación/i);
  });

  it('no deja pasar montos de cero o negativos', () => {
    expect(() => validar(CreateNotesBulkDto, lote({ items: [{ invoiceId: 'inv-1', amount: 0 }] }))).toThrow();
    expect(() => validar(CreateNotesBulkDto, lote({ items: [{ invoiceId: 'inv-1', amount: -5000 }] }))).toThrow();
  });

  it('topa el lote en 50 facturas', () => {
    const items = Array.from({ length: 51 }, (_, i) => ({ invoiceId: `inv-${i}`, amount: 1000 }));
    expect(() => validar(CreateNotesBulkDto, lote({ items }))).toThrow(/50/);
  });

  it('acepta el lote bueno y recorta la observación', () => {
    const dto = validar(CreateNotesBulkDto, lote({
      description: '  Depuración de cartera  ',
      items: [{ invoiceId: 'inv-1', amount: 15000 }, { invoiceId: 'inv-2', amount: 20000 }],
    }));
    expect(dto.description).toBe('Depuración de cartera');
    expect(dto.items).toHaveLength(2);
  });
});

type FacturaFalsa = { id: string; tid: number; subscriberId: string | null; total: number; paid?: number };

/** Prisma de mentira: guarda los ítems creados y las facturas actualizadas. */
function prismaFalso(facturas: FacturaFalsa[]) {
  const filas = new Map(facturas.map((f) => [f.id, {
    id: f.id, tid: f.tid, subscriberId: f.subscriberId,
    subtotal: f.total, total: f.total, paidAmount: f.paid ?? 0, status: 'DUE',
  }]));
  const creados: any[] = [];
  const actualizadas: any[] = [];
  let transacciones = 0;

  const tx = {
    subInvoice: {
      findUnique: async ({ where }: any) => filas.get(where.id) ?? null,
      update: async ({ where, data }: any) => { actualizadas.push({ id: where.id, ...data }); return {}; },
    },
    subInvoiceItem: { create: async ({ data }: any) => { creados.push(data); return data; } },
    transaction: { aggregate: async () => ({ _sum: { debit: 0, credit: 0 } }) },
    subscriber: { update: async () => ({}) },
  };

  const prisma = {
    subInvoice: {
      findMany: async ({ where }: any) => facturas
        .filter((f) => where.id.in.includes(f.id))
        .map((f) => ({ id: f.id, tid: f.tid, subscriberId: f.subscriberId })),
    },
    staff: { findFirst: async () => ({ legacyId: 42 }) },
    $transaction: async (fn: any) => { transacciones += 1; return fn(tx); },
  };

  return { prisma, creados, actualizadas, veces: () => transacciones };
}

/** Sin sedes marcadas = sin acotar (ver common/sede-scope). */
const usuario = { id: 'u1', email: 'cartera@vestel.com.co', name: 'Cartera', permissions: [], sedes: [] } as unknown as AuthUser;

const servicio = (prisma: any) => new FacturasService(prisma, {} as any, {} as any, {} as any);

describe('FacturasService.createNotes', () => {
  it('aplica una nota por factura, todas en la MISMA transacción', async () => {
    const f = prismaFalso([
      { id: 'inv-1', tid: 500001, subscriberId: 'sub-1', total: 60000 },
      { id: 'inv-2', tid: 500002, subscriberId: 'sub-1', total: 60000 },
      { id: 'inv-3', tid: 500003, subscriberId: 'sub-1', total: 40000 },
    ]);
    const res = await servicio(f.prisma).createNotes({
      type: 'CREDITO',
      description: 'Depuración de cartera, autoriza cartera',
      items: [
        { invoiceId: 'inv-1', amount: 60000 },
        { invoiceId: 'inv-2', amount: 60000 },
        { invoiceId: 'inv-3', amount: 40000 },
      ],
    } as any, usuario);

    expect(res.count).toBe(3);
    expect(res.total).toBe(160000);
    expect(res.subscriberId).toBe('sub-1');
    expect(f.veces()).toBe(1);
    expect(f.creados).toHaveLength(3);
    // La nota crédito entra como renglón en negativo y deja la factura en cero.
    expect(f.creados.map((c) => c.price)).toEqual([-60000, -60000, -40000]);
    expect(f.actualizadas.map((a) => a.total)).toEqual([0, 0, 0]);
    // Todas llevan la MISMA observación y quedan blindadas del sync (`editedAt`).
    expect(new Set(f.creados.map((c) => c.description)).size).toBe(1);
    expect(f.actualizadas.every((a) => a.editedAt instanceof Date)).toBe(true);
    // Devuelve el número de factura de cada nota, para poder decir cuáles fueron.
    expect(res.results.map((r: any) => r.tid)).toEqual([500001, 500002, 500003]);
  });

  it('no aplica NADA si el lote cruza dos clientes', async () => {
    const f = prismaFalso([
      { id: 'inv-1', tid: 1, subscriberId: 'sub-1', total: 10000 },
      { id: 'inv-2', tid: 2, subscriberId: 'sub-2', total: 10000 },
    ]);
    await expect(servicio(f.prisma).createNotes({
      type: 'CREDITO', description: 'Depuración de cartera',
      items: [{ invoiceId: 'inv-1', amount: 5000 }, { invoiceId: 'inv-2', amount: 5000 }],
    } as any, usuario)).rejects.toThrow(/clientes distintos/i);
    expect(f.creados).toHaveLength(0);
  });

  it('no aplica NADA si una de las facturas no existe', async () => {
    const f = prismaFalso([{ id: 'inv-1', tid: 1, subscriberId: 'sub-1', total: 10000 }]);
    await expect(servicio(f.prisma).createNotes({
      type: 'CREDITO', description: 'Depuración de cartera',
      items: [{ invoiceId: 'inv-1', amount: 5000 }, { invoiceId: 'inv-fantasma', amount: 5000 }],
    } as any, usuario)).rejects.toThrow(/no existe/i);
    expect(f.creados).toHaveLength(0);
  });

  it('rechaza la misma factura repetida en el lote (se aplicaría dos veces)', async () => {
    const f = prismaFalso([{ id: 'inv-1', tid: 1, subscriberId: 'sub-1', total: 10000 }]);
    await expect(servicio(f.prisma).createNotes({
      type: 'CREDITO', description: 'Depuración de cartera',
      items: [{ invoiceId: 'inv-1', amount: 5000 }, { invoiceId: 'inv-1', amount: 5000 }],
    } as any, usuario)).rejects.toThrow(/repetida/i);
    expect(f.creados).toHaveLength(0);
  });

  it('la nota débito recarga cada factura', async () => {
    const f = prismaFalso([
      { id: 'inv-1', tid: 1, subscriberId: 'sub-1', total: 50000 },
      { id: 'inv-2', tid: 2, subscriberId: 'sub-1', total: 50000 },
    ]);
    const res = await servicio(f.prisma).createNotes({
      type: 'DEBITO', description: 'Reconexión pendiente de cobro',
      items: [{ invoiceId: 'inv-1', amount: 7500 }, { invoiceId: 'inv-2', amount: 7500 }],
    } as any, usuario);
    expect(res.total).toBe(15000);
    expect(f.creados.map((c) => c.price)).toEqual([7500, 7500]);
    expect(f.actualizadas.map((a) => a.total)).toEqual([57500, 57500]);
  });
});
