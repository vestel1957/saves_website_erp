import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsNumber, IsOptional, IsString, Min, MinLength, ValidateNested } from 'class-validator';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';

const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? 0 : Number(d));
const round2 = (n: number) => Math.round(n * 100) / 100;
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

@Injectable()
export class OmniService {
  constructor(private readonly prisma: PrismaService) {}

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
