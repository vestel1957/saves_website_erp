import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { FacturasService } from './facturas.service';
import { CreateRecurringDto } from './dto/recurring.dto';
import { num, round2 } from '../common/money';


function subName(s: {
  firstName: string | null; secondName: string | null; lastName1: string | null;
  lastName2: string | null; companyName: string | null; fullName: string | null;
} | null): string {
  if (!s) return '—';
  if (s.fullName && s.fullName.trim()) return s.fullName.trim();
  const person = [s.firstName, s.secondName, s.lastName1, s.lastName2].map((p) => (p || '').trim()).filter(Boolean).join(' ');
  return person || (s.companyName || '').trim() || 'Sin nombre';
}
const SUB_SELECT = {
  firstName: true, secondName: true, lastName1: true, lastName2: true,
  companyName: true, fullName: true, abonado: true, id: true,
} as const;

/** "Reciclaje de ventas": plantillas de factura recurrente (legacy rec_invoices). */
@Injectable()
export class RecurringService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly facturas: FacturasService,
  ) {}

  /** Dashboard: métricas de las plantillas recurrentes. */
  async stats() {
    const [count, agg, byStatus] = await Promise.all([
      this.prisma.recurringInvoice.count(),
      this.prisma.recurringInvoice.aggregate({ _sum: { total: true }, where: { active: true } }),
      this.prisma.recurringInvoice.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    const active = await this.prisma.recurringInvoice.count({ where: { active: true } });
    const status: Record<string, number> = {};
    for (const r of byStatus) status[r.status ?? '—'] = r._count._all;
    return { total: count, active, inactive: count - active, valorRecurrente: num(agg._sum.total), status };
  }

  /** Listado paginado de plantillas. */
  async list(params: { search?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
    const search = (params.search || '').trim();
    const where: Prisma.RecurringInvoiceWhereInput = {};
    if (search) {
      const asNum = Number(search);
      where.OR = [
        ...(Number.isFinite(asNum) ? [{ tid: asNum }] : []),
        { subscriber: { is: { OR: [
          { firstName: { contains: search, mode: 'insensitive' as const } },
          { lastName1: { contains: search, mode: 'insensitive' as const } },
          { companyName: { contains: search, mode: 'insensitive' as const } },
          ...(Number.isFinite(asNum) ? [{ abonado: asNum }] : []),
        ] } } },
      ];
    }
    const [rows, total] = await Promise.all([
      this.prisma.recurringInvoice.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
        include: { subscriber: { select: SUB_SELECT } },
      }),
      this.prisma.recurringInvoice.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id, tid: r.tid, subscriberId: r.subscriber?.id ?? null,
        subscriber: subName(r.subscriber), abonado: r.subscriber?.abonado ?? null,
        total: num(r.total), rec: r.rec, ron: r.ron, status: r.status,
        active: r.active, dueDate: r.dueDate, itemsCount: r.itemsCount,
      })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  /** Detalle de una plantilla. */
  async detail(id: string) {
    const r = await this.prisma.recurringInvoice.findUnique({
      where: { id },
      include: { subscriber: { select: SUB_SELECT }, items: { orderBy: { id: 'asc' } } },
    });
    if (!r) throw new NotFoundException('Plantilla no encontrada');
    return {
      id: r.id, tid: r.tid, subscriber: r.subscriber ? { id: r.subscriber.id, name: subName(r.subscriber), abonado: r.subscriber.abonado } : null,
      subtotal: num(r.subtotal), tax: num(r.tax), total: num(r.total),
      rec: r.rec, ron: r.ron, status: r.status, active: r.active, dueDate: r.dueDate, notes: r.notes,
      items: r.items.map((it) => ({ id: it.id, description: it.description ?? it.productName, qty: it.qty, price: num(it.price), taxRate: num(it.taxRate), subtotal: num(it.subtotal), taxTotal: num(it.taxTotal) })),
    };
  }

  private computeTotals<T extends { qty: number; price: number; taxRate?: number }>(items: T[]) {
    const rows = items.map((it) => {
      const qty = Math.max(0, Math.round(it.qty));
      const price = round2(it.price);
      const taxRate = round2(it.taxRate ?? 0);
      const subtotal = round2(qty * price);
      const taxTotal = round2((subtotal * taxRate) / 100);
      return { ...it, qty, price, taxRate, subtotal, taxTotal };
    });
    return {
      rows,
      subtotal: round2(rows.reduce((s, r) => s + r.subtotal, 0)),
      tax: round2(rows.reduce((s, r) => s + r.taxTotal, 0)),
      total: round2(rows.reduce((s, r) => s + r.subtotal + r.taxTotal, 0)),
    };
  }

  private async nextTid(): Promise<number> {
    const max = await this.prisma.recurringInvoice.aggregate({ _max: { tid: true } });
    return (max._max.tid ?? 1000) + 1;
  }

  /** Crear una plantilla recurrente. */
  async create(dto: CreateRecurringDto, user: AuthUser) {
    if (!dto.items?.length) throw new BadRequestException('La plantilla no tiene ítems');
    const subscriber = await this.prisma.subscriber.findUnique({ where: { id: dto.subscriberId }, select: { id: true } });
    if (!subscriber) throw new NotFoundException('Cliente no encontrado');

    const { rows, subtotal, tax, total } = this.computeTotals(dto.items);
    const tid = await this.nextTid();
    const r = await this.prisma.recurringInvoice.create({
      data: {
        tid, subscriberId: subscriber.id, invoiceDate: new Date(),
        subtotal, tax, total, status: 'due', ron: 'Recurring',
        rec: dto.rec ?? '1 month', notes: dto.notes ?? null, itemsCount: rows.length, active: true,
        items: { create: rows.map((r2) => ({
          productId: 0, productName: r2.productName ?? null, description: r2.description,
          qty: r2.qty, price: r2.price, taxRate: r2.taxRate, subtotal: r2.subtotal, taxTotal: r2.taxTotal, discountTotal: 0,
        })) },
      },
    });
    return { id: r.id, tid: r.tid, total };
  }

  /** Activar/desactivar una plantilla. */
  async toggle(id: string, active: boolean) {
    const r = await this.prisma.recurringInvoice.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Plantilla no encontrada');
    await this.prisma.recurringInvoice.update({ where: { id }, data: { active } });
    return { id, active };
  }

  /** Eliminar una plantilla. */
  async remove(id: string) {
    const r = await this.prisma.recurringInvoice.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Plantilla no encontrada');
    await this.prisma.recurringInvoice.delete({ where: { id } });
    return { id, deleted: true };
  }

  /** Generar una factura real a partir de la plantilla. */
  async run(id: string, user: AuthUser) {
    const r = await this.prisma.recurringInvoice.findUnique({ where: { id }, include: { items: true } });
    if (!r) throw new NotFoundException('Plantilla no encontrada');
    if (!r.items.length) throw new BadRequestException('La plantilla no tiene ítems');
    const invoice = await this.facturas.createInvoice({
      subscriberId: r.subscriberId,
      items: r.items.map((it) => ({
        productName: it.productName ?? undefined, description: it.description ?? it.productName ?? 'Servicio',
        qty: it.qty || 1, price: num(it.price), taxRate: num(it.taxRate),
      })),
      notes: `Generada de plantilla recurrente #${r.tid}`,
    } as any, user);
    return invoice;
  }
}
