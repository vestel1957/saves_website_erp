import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Min, MinLength, ValidateNested } from 'class-validator';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { PostingService } from '../accounting/posting.service';
import { num, round2 } from '../common/money';

const dOnly = (s?: string) => { const d = s ? new Date(s) : new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); };

export class QuoteItemDto {
  @IsString() @MinLength(1) product!: string;
  @IsInt() @Min(1) qty!: number;
  @IsNumber() @Min(0) price!: number;
  @IsOptional() @IsNumber() @Min(0) taxRate?: number;
}
export class CreateQuoteDto {
  @IsOptional() @IsString() subscriberId?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsString() proposal?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => QuoteItemDto) items!: QuoteItemDto[];
}

/** Crear/editar un evento de agenda. */
export class EventDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() color?: string;
  @IsString() start!: string;
  @IsOptional() @IsString() end?: string;
  @IsOptional() allDay?: boolean;
  @IsOptional() @IsInt() orderNo?: number;
}
export class UpdateEventDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsString() start?: string;
  @IsOptional() @IsString() end?: string;
  @IsOptional() allDay?: boolean;
}
export class QuoteStatusDto {
  @IsString() @IsIn(['draft', 'pending', 'sent', 'accepted', 'rejected', 'converted']) status!: string;
}

@Injectable()
export class OmniService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingService,
  ) {}

  // --- Eventos / agenda ---
  async events(params: { from?: string; to?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(params.pageSize) || 50));
    const where: Prisma.CalendarEventWhereInput = {};
    if (params.from || params.to) {
      where.start = {};
      if (params.from) (where.start as any).gte = new Date(params.from);
      if (params.to) (where.start as any).lte = new Date(params.to);
    }
    const [rows, total] = await Promise.all([
      this.prisma.calendarEvent.findMany({ where, orderBy: { start: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.calendarEvent.count({ where }),
    ]);
    return {
      items: rows.map((e) => ({ id: e.id, orderNo: e.orderNo, title: e.title, description: e.description, color: e.color, start: e.start, end: e.end, allDay: e.allDay, assignedBy: e.assignedBy })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }
  async eventsStats() {
    const [total, latest] = await Promise.all([
      this.prisma.calendarEvent.count(),
      this.prisma.calendarEvent.findFirst({ orderBy: { start: 'desc' }, select: { start: true } }),
    ]);
    return { total, ultimo: latest?.start ?? null };
  }

  async createEvent(dto: EventDto, user: AuthUser) {
    const e = await this.prisma.calendarEvent.create({
      data: {
        title: dto.title ?? null, description: dto.description ?? null, color: dto.color ?? null,
        start: new Date(dto.start), end: dto.end ? new Date(dto.end) : null,
        allDay: dto.allDay ?? false, orderNo: dto.orderNo ?? null, assignedBy: user?.name ?? user?.email ?? null,
      },
    });
    return { id: e.id };
  }

  async updateEvent(id: string, dto: UpdateEventDto) {
    const e = await this.prisma.calendarEvent.findUnique({ where: { id } });
    if (!e) throw new NotFoundException('Evento no encontrado');
    const data: Prisma.CalendarEventUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.color !== undefined) data.color = dto.color;
    if (dto.start !== undefined) data.start = new Date(dto.start);
    if (dto.end !== undefined) data.end = dto.end ? new Date(dto.end) : null;
    if (dto.allDay !== undefined) data.allDay = dto.allDay;
    await this.prisma.calendarEvent.update({ where: { id }, data });
    return { id, ok: true };
  }

  async deleteEvent(id: string) {
    await this.prisma.calendarEvent.delete({ where: { id } });
    return { id, deleted: true };
  }

  async quoteDetail(id: string) {
    const q = await this.prisma.quote.findUnique({ where: { id }, include: { items: { orderBy: { id: 'asc' } } } });
    if (!q) throw new NotFoundException('Cotización no encontrada');
    let client: string | null = null;
    if (q.subscriberId) {
      const s = await this.prisma.subscriber.findUnique({ where: { id: q.subscriberId }, select: { firstName: true, lastName1: true, companyName: true, fullName: true } });
      client = s ? ((s.fullName?.trim()) || [s.firstName, s.lastName1].filter(Boolean).join(' ').trim() || s.companyName || null) : null;
    }
    return {
      id: q.id, tid: q.tid, subscriberId: q.subscriberId, client, date: q.invoiceDate, status: q.status,
      subtotal: num(q.subtotal), tax: num(q.tax), total: num(q.total), notes: q.notes, proposal: q.proposal,
      items: q.items.map((it) => ({ id: it.id, product: it.product, qty: it.qty, price: num(it.price), taxRate: num(it.taxRate), subtotal: num(it.subtotal), taxTotal: num(it.taxTotal) })),
    };
  }

  async updateQuoteStatus(id: string, status: string) {
    const q = await this.prisma.quote.findUnique({ where: { id } });
    if (!q) throw new NotFoundException('Cotización no encontrada');
    await this.prisma.quote.update({ where: { id }, data: { status } });
    return { id, status };
  }

  /** Convierte una cotización aceptada en factura de venta (SubInvoice). */
  async convertQuoteToInvoice(id: string, user: AuthUser) {
    const q = await this.prisma.quote.findUnique({ where: { id }, include: { items: true } });
    if (!q) throw new NotFoundException('Cotización no encontrada');
    if (!q.subscriberId) throw new BadRequestException('La cotización no tiene cliente; asígnalo antes de convertir.');
    if (q.status === 'converted') throw new BadRequestException('La cotización ya fue convertida en factura.');
    const today = dOnly();
    const sub = await this.prisma.subscriber.findUnique({ where: { id: q.subscriberId }, select: { eInvoice: true } });
    const result = await this.prisma.$transaction(async (tx) => {
      const max = await tx.subInvoice.aggregate({ _max: { tid: true } });
      const tid = (max._max.tid ?? 1000) + 1;
      const due = new Date(today.getTime() + 30 * 24 * 3600 * 1000);
      const inv = await tx.subInvoice.create({
        data: {
          tid, subscriberId: q.subscriberId!, invoiceDate: today, dueDate: due,
          subtotal: num(q.subtotal), tax: num(q.tax), total: num(q.total), status: 'DUE',
          eInvoiceFlag: sub?.eInvoice ? 'Crear Factura Electronica' : null,
          items: { create: q.items.map((it) => ({ productName: it.product ?? null, qty: it.qty, price: num(it.price), taxRate: num(it.taxRate), subtotal: num(it.subtotal), taxTotal: num(it.taxTotal) })) },
        },
      });
      await tx.quote.update({ where: { id }, data: { status: 'converted' } });
      return { ok: true, invoiceId: inv.id, tid: inv.tid };
    });
    // Contabilización automática de la factura resultante (idempotente; no rompe el flujo).
    await this.posting.postSalesInvoice({
      sourceId: result.invoiceId, date: today, number: result.tid,
      subtotal: num(q.subtotal), tax: num(q.tax), createdBy: user?.name ?? user?.email ?? null,
    });
    return result;
  }

  // --- Cotizaciones ---
  async quotes(params: { search?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
    const where: Prisma.QuoteWhereInput = {};
    const search = (params.search || '').trim();
    if (search) { const n = Number(search); if (Number.isFinite(n)) where.tid = n; }
    const [rows, total] = await Promise.all([
      this.prisma.quote.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.quote.count({ where }),
    ]);
    // Resolver nombres de cliente
    const subIds = rows.map((r) => r.subscriberId).filter((x): x is string => !!x);
    const subs = subIds.length ? await this.prisma.subscriber.findMany({ where: { id: { in: subIds } }, select: { id: true, firstName: true, lastName1: true, companyName: true, fullName: true } }) : [];
    const nameById = new Map(subs.map((s) => [s.id, (s.fullName?.trim()) || [s.firstName, s.lastName1].filter(Boolean).join(' ').trim() || s.companyName || '—']));
    return {
      items: rows.map((q) => ({ id: q.id, tid: q.tid, client: q.subscriberId ? nameById.get(q.subscriberId) ?? '—' : '—', subscriberId: q.subscriberId, date: q.invoiceDate, total: num(q.total), status: q.status, itemsCount: q.itemsCount })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  async createQuote(dto: CreateQuoteDto, user: AuthUser) {
    if (!dto.items?.length) throw new BadRequestException('La cotización no tiene ítems');
    const rows = dto.items.map((it) => {
      const qty = Math.max(0, Math.round(it.qty)); const price = round2(it.price); const taxRate = round2(it.taxRate ?? 0);
      const subtotal = round2(qty * price); const taxTotal = round2((subtotal * taxRate) / 100);
      return { ...it, qty, price, taxRate, subtotal, taxTotal };
    });
    const subtotal = round2(rows.reduce((s, r) => s + r.subtotal, 0));
    const tax = round2(rows.reduce((s, r) => s + r.taxTotal, 0));
    const total = round2(subtotal + tax);
    return this.prisma.$transaction(async (tx) => {
      const max = await tx.quote.aggregate({ _max: { tid: true } });
      const tid = (max._max.tid ?? 1000) + 1;
      const q = await tx.quote.create({
        data: {
          tid, subscriberId: dto.subscriberId ?? null, invoiceDate: dOnly(), subtotal, tax, total, status: 'pending',
          notes: dto.notes ?? null, proposal: dto.proposal ?? null, itemsCount: rows.length,
          items: { create: rows.map((r) => ({ product: r.product, qty: r.qty, price: r.price, taxRate: r.taxRate, subtotal: r.subtotal, taxTotal: r.taxTotal })) },
        },
      });
      return { id: q.id, tid: q.tid, total };
    });
  }
}
