import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { scopeDate } from '../common/date-scope';

const num = (d: Prisma.Decimal | null | undefined) => (d == null ? 0 : Number(d));

function subName(s: {
  firstName: string | null; secondName: string | null; lastName1: string | null;
  lastName2: string | null; companyName: string | null; fullName: string | null;
} | null): string | null {
  if (!s) return null;
  if (s.fullName && s.fullName.trim()) return s.fullName.trim();
  const person = [s.firstName, s.secondName, s.lastName1, s.lastName2].map((p) => (p || '').trim()).filter(Boolean).join(' ');
  return person || (s.companyName || '').trim() || null;
}
const SUB_SELECT = { firstName: true, secondName: true, lastName1: true, lastName2: true, companyName: true, fullName: true, id: true, abonado: true } as const;

@Injectable()
export class TreasuryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Resumen: ingresos vs egresos vigentes + top categorías de egreso. Por defecto AÑO ACTUAL. */
  async stats(params: { from?: string; to?: string; all?: string }) {
    const dateWhere: Prisma.TransactionWhereInput = { status: 'VIGENTE' };
    const period = scopeDate(params.from, params.to, params.all);
    if (period) dateWhere.date = period;
    const [income, expense, anuladas, byCat] = await Promise.all([
      this.prisma.transaction.aggregate({ _sum: { credit: true }, _count: { _all: true }, where: { ...dateWhere, type: 'INCOME' } }),
      this.prisma.transaction.aggregate({ _sum: { debit: true }, _count: { _all: true }, where: { ...dateWhere, type: 'EXPENSE' } }),
      this.prisma.transaction.count({ where: { status: 'ANULADA', ...(period ? { date: period } : {}) } }),
      this.prisma.transaction.groupBy({ by: ['category'], _sum: { debit: true }, where: { ...dateWhere, type: 'EXPENSE' }, orderBy: { _sum: { debit: 'desc' } }, take: 8 }),
    ]);
    const ingresos = num(income._sum.credit);
    const egresos = num(expense._sum.debit);
    return {
      ingresos, egresos, balance: ingresos - egresos,
      nIngresos: income._count._all, nEgresos: expense._count._all, anuladas,
      topEgresos: byCat.map((c) => ({ category: c.category, total: num(c._sum.debit) })),
    };
  }

  /** Listado paginado de movimientos. Por defecto AÑO ACTUAL (override con from/to o all=1). */
  async list(params: { search?: string; type?: string; category?: string; status?: string; from?: string; to?: string; all?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
    const search = (params.search || '').trim();

    const where: Prisma.TransactionWhereInput = {};
    if (params.type) where.type = params.type as any;
    if (params.category) where.category = params.category;
    if (params.status) where.status = params.status as any;
    // Por defecto AÑO ACTUAL (aplica también al buscar; usar all=1 para histórico).
    const period = scopeDate(params.from, params.to, params.all);
    if (period) where.date = period;
    if (search) {
      where.OR = [
        { payerName: { contains: search, mode: 'insensitive' } },
        { note: { contains: search, mode: 'insensitive' } },
        { accountName: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where, orderBy: { date: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
        include: { subscriber: { select: SUB_SELECT }, invoice: { select: { tid: true } } },
      }),
      this.prisma.transaction.count({ where }),
    ]);

    return {
      items: rows.map((t) => ({
        id: t.id, date: t.date, type: t.type, category: t.category,
        debit: num(t.debit), credit: num(t.credit),
        amount: t.type === 'EXPENSE' ? num(t.debit) : num(t.credit),
        payer: subName(t.subscriber) ?? t.payerName ?? '—',
        subscriberId: t.subscriber?.id ?? null,
        method: t.method, account: t.accountName, bank: t.bankName,
        invoiceTid: t.invoice?.tid ?? null, status: t.status, note: t.note,
        attach: t.attach, attachName: t.attachName,
      })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  /** Adjunta (o reemplaza) el comprobante/evidencia de un movimiento. */
  async attachTransaction(id: string, file: { filename: string; originalname: string }) {
    const t = await this.prisma.transaction.findUnique({ where: { id }, select: { id: true } });
    if (!t) throw new NotFoundException('Movimiento no encontrado');
    await this.prisma.transaction.update({ where: { id }, data: { attach: file.filename, attachName: file.originalname } });
    return { ok: true, attachName: file.originalname };
  }

  /** Datos del comprobante adjunto de un movimiento (para descargar/previsualizar). */
  async getTransactionAttachment(id: string) {
    const t = await this.prisma.transaction.findUnique({ where: { id }, select: { attach: true, attachName: true } });
    if (!t?.attach) throw new NotFoundException('Comprobante no encontrado');
    return { storedName: t.attach, originalName: t.attachName ?? t.attach };
  }

  /** Detalle de un movimiento (con anulación y recibos ligados). */
  async detail(id: string) {
    const t = await this.prisma.transaction.findUnique({
      where: { id },
      include: {
        subscriber: { select: SUB_SELECT }, invoice: { select: { id: true, tid: true } },
        voiding: true, receiptLinks: { include: { receipt: { select: { id: true, fileName: true, date: true } } } },
      },
    });
    if (!t) throw new NotFoundException('Movimiento no encontrado');
    return {
      id: t.id, date: t.date, type: t.type, category: t.category,
      debit: num(t.debit), credit: num(t.credit),
      payer: subName(t.subscriber) ?? t.payerName, subscriberId: t.subscriber?.id ?? null,
      method: t.method, account: t.accountName, bank: t.bankName, note: t.note, status: t.status,
      invoice: t.invoice ? { id: t.invoice.id, tid: t.invoice.tid } : null,
      voiding: t.voiding ? { date: t.voiding.dateTime, reason: t.voiding.reason, by: t.voiding.voidedBy } : null,
      receipts: t.receiptLinks.map((l) => ({ id: l.receipt.id, fileName: l.receipt.fileName, date: l.receipt.date })),
    };
  }

  /** Cierres de caja diarios. */
  /** Datos para el PDF de recibo de caja (recibo + transacciones abonadas). */
  async receiptPdfData(id: string) {
    const r = await this.prisma.paymentReceipt.findUnique({
      where: { id },
      include: {
        invoice: { include: { subscriber: { select: { firstName: true, lastName1: true, companyName: true, fullName: true, abonado: true, docNumber: true } } } },
        transactions: { include: { transaction: { include: { invoice: { select: { tid: true } } } } } },
      },
    });
    if (!r) throw new NotFoundException('Recibo no encontrado');
    const s = r.invoice?.subscriber;
    const name = s ? (s.fullName || [s.firstName, s.lastName1].filter(Boolean).join(' ') || s.companyName || '—').trim() : '—';
    const items = r.transactions.map((rt) => ({
      tid: rt.transaction.invoice?.tid ?? null,
      concept: rt.transaction.invoice?.tid ? `Abono a factura #${rt.transaction.invoice.tid}` : (rt.transaction.category || 'Abono'),
      amount: num(rt.transaction.credit),
      method: rt.transaction.method,
    }));
    return {
      number: String(r.legacyId ?? r.fileName ?? r.id.slice(-6)),
      date: r.date,
      cashier: null as string | null,
      method: items[0]?.method ?? null,
      subscriber: s ? { name, abonado: s.abonado, docNumber: s.docNumber } : null,
      items: items.map(({ tid, concept, amount }) => ({ tid, concept, amount })),
      total: items.reduce((sum, i) => sum + i.amount, 0),
    };
  }

  /** Datos para el PDF de cierre de caja (resuelve el nombre de la caja). */
  async cashClosePdfData(id: string) {
    const c = await this.prisma.cashClose.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Cierre de caja no encontrado');
    const acc = await this.prisma.cashAccount.findFirst({ where: { legacyId: c.cashAccountId } });
    return {
      cashAccountName: acc?.holder ?? `Caja #${c.cashAccountId}`,
      date: c.date,
      userName: '—',
      base: num(c.base), sales: num(c.sales), expenses: num(c.expenses),
      deposited: num(c.deposited), surplus: num(c.surplus),
    };
  }

  /** Construye el filtro común de cierres (rango de fecha + caja). */
  private cashCloseWhere(params: { from?: string; to?: string; all?: string; cashAccountId?: number }): Prisma.CashCloseWhereInput {
    const where: Prisma.CashCloseWhereInput = {};
    const period = scopeDate(params.from, params.to, params.all);
    if (period) where.date = period;
    if (params.cashAccountId) where.cashAccountId = Number(params.cashAccountId);
    return where;
  }

  /** Listado paginado de cierres + totales del conjunto filtrado. Por defecto AÑO ACTUAL. */
  async cashCloses(params: { from?: string; to?: string; all?: string; cashAccountId?: number; page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
    const where = this.cashCloseWhere(params);
    const [rows, total, sums] = await Promise.all([
      this.prisma.cashClose.findMany({ where, orderBy: { date: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.cashClose.count({ where }),
      this.prisma.cashClose.aggregate({ where, _sum: { base: true, sales: true, expenses: true, deposited: true, surplus: true } }),
    ]);
    return {
      items: rows.map((c) => ({
        id: c.id, cashAccountId: c.cashAccountId, date: c.date,
        base: num(c.base), sales: num(c.sales), expenses: num(c.expenses),
        deposited: num(c.deposited), surplus: num(c.surplus),
      })),
      totals: {
        count: total,
        base: num(sums._sum.base), sales: num(sums._sum.sales), expenses: num(sums._sum.expenses),
        deposited: num(sums._sum.deposited), surplus: num(sums._sum.surplus),
      },
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  /** Cierres agregados por período (día/semana/mes) para la vista consolidada. */
  async cashClosesSummary(params: { group?: string; from?: string; to?: string; all?: string; cashAccountId?: number }) {
    const group = params.group === 'week' || params.group === 'month' ? params.group : 'day';
    const period = scopeDate(params.from, params.to, params.all);
    const conds: Prisma.Sql[] = [];
    if (period?.gte) conds.push(Prisma.sql`"date" >= ${period.gte}`);
    if (period?.lte) conds.push(Prisma.sql`"date" <= ${period.lte}`);
    if (params.cashAccountId) conds.push(Prisma.sql`"cashAccountId" = ${Number(params.cashAccountId)}`);
    const whereSql = conds.length ? Prisma.sql`WHERE ${Prisma.join(conds, ' AND ')}` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      { period: Date; count: number; base: string; sales: string; expenses: string; deposited: string; surplus: string }[]
    >(Prisma.sql`
      SELECT date_trunc(${group}::text, "date")::date AS period,
             COUNT(*)::int AS count,
             SUM(base) AS base, SUM(sales) AS sales, SUM(expenses) AS expenses,
             SUM(deposited) AS deposited, SUM(surplus) AS surplus
      FROM "CashClose"
      ${whereSql}
      GROUP BY 1
      ORDER BY 1 DESC
    `);
    return {
      group,
      items: rows.map((r) => ({
        period: r.period, count: Number(r.count),
        base: Number(r.base ?? 0), sales: Number(r.sales ?? 0), expenses: Number(r.expenses ?? 0),
        deposited: Number(r.deposited ?? 0), surplus: Number(r.surplus ?? 0),
      })),
    };
  }

  categories() {
    return this.prisma.transactionCategory.findMany({ orderBy: { name: 'asc' }, select: { name: true } });
  }
}
