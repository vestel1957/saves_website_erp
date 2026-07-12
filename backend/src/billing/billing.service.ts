import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { scopeDate, currentYear } from '../common/date-scope';
import { WhatsappService } from '../common/whatsapp/whatsapp.service';
import { invoicePdfBuffer } from './billing-pdf';

const num = (d: Prisma.Decimal | null | undefined) => (d == null ? 0 : Number(d));

function subName(s: {
  firstName: string | null; secondName: string | null;
  lastName1: string | null; lastName2: string | null; companyName: string | null; fullName: string | null;
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

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
  ) {}

  /**
   * Envía la factura (PDF) al WhatsApp del cliente vía Kapso. Tolerante: si
   * WhatsApp no está configurado, `sendDocument` degrada a log y devolvemos
   * `sent:false` para que la UI lo informe sin romper.
   */
  async sendWhatsapp(id: string) {
    const inv = await this.detail(id);
    const phone = inv.subscriber?.phone?.replace(/\D/g, '');
    if (!phone) throw new BadRequestException('El cliente no tiene teléfono registrado.');
    const pdf = await invoicePdfBuffer(inv as any);
    const caption = `Factura N° ${inv.tid} · Total ${new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(inv.total)}`
      + (inv.balance > 0 ? ` · Saldo pendiente ${new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(inv.balance)}` : ' · Pagada. ¡Gracias!');
    const sent = await this.whatsapp.sendDocument(phone, pdf, `factura-${inv.tid}.pdf`, caption);
    return { sent, phone };
  }

  /** Resumen de facturación (actividad del periodo) y cartera (histórico completo). */
  async stats(params: { from?: string; to?: string; all?: string } = {}) {
    // Actividad (facturas emitidas) → por defecto AÑO ACTUAL para velocidad.
    const period = scopeDate(params.from, params.to, params.all);
    const activityWhere = period ? { invoiceDate: period } : {};
    const [byStatus, agg, cartera] = await Promise.all([
      this.prisma.subInvoice.groupBy({ by: ['status'], _count: { _all: true }, where: activityWhere }),
      this.prisma.subInvoice.aggregate({ _sum: { total: true }, where: activityWhere }),
      // Cartera = saldo pendiente TODO el histórico (no depende de la fecha).
      this.prisma.subInvoice.aggregate({
        _sum: { total: true, paidAmount: true },
        _count: { _all: true },
        where: { status: { in: ['DUE', 'PARTIAL'] } },
      }),
    ]);
    const status: Record<string, number> = {};
    for (const r of byStatus) status[r.status] = r._count._all;
    return {
      total: Object.values(status).reduce((a, b) => a + b, 0),
      facturadoTotal: num(agg._sum.total),
      pagadas: status['PAID'] ?? 0,
      pendientes: status['DUE'] ?? 0,
      parciales: status['PARTIAL'] ?? 0,
      carteraTotal: num(cartera._sum.total) - num(cartera._sum.paidAmount),
      carteraFacturas: cartera._count._all,
      status,
      periodo: params.all ? 'Histórico' : params.from || params.to ? 'Rango' : `Año ${currentYear()}`,
    };
  }

  /** Listado paginado de facturas con filtros. */
  async list(params: {
    search?: string; status?: string; ron?: string; branchId?: string;
    from?: string; to?: string; all?: string; overdue?: string;
    page?: number; pageSize?: number;
  }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
    const search = (params.search || '').trim();

    const where: Prisma.SubInvoiceWhereInput = {};
    if (params.status) where.status = params.status as any;
    if (params.ron) where.ron = params.ron as any;
    if (params.branchId) where.subscriber = { branchId: params.branchId };
    // Vencidas / con saldo: facturas sin pagar del todo (DUE o PARTIAL) cuya
    // fecha de vencimiento ya pasó. Herramienta directa para cobranza.
    if (params.overdue === '1' || params.overdue === 'true') {
      where.status = { in: ['DUE', 'PARTIAL'] as any };
      where.dueDate = { lt: new Date() };
    }
    // Por defecto AÑO ACTUAL (aplica también al buscar; usar all=1 para histórico completo).
    const period = scopeDate(params.from, params.to, params.all);
    if (period) where.invoiceDate = period;
    if (search) {
      const asNum = Number(search);
      where.OR = [
        ...(Number.isFinite(asNum) ? [{ tid: asNum }] : []),
        { subscriber: { is: {
          OR: [
            { firstName: { contains: search, mode: 'insensitive' as const } },
            { lastName1: { contains: search, mode: 'insensitive' as const } },
            { companyName: { contains: search, mode: 'insensitive' as const } },
            { docNumber: { contains: search } },
            ...(Number.isFinite(asNum) ? [{ abonado: asNum }] : []),
          ],
        } } },
      ];
    }

    const [rows, total, agg] = await Promise.all([
      this.prisma.subInvoice.findMany({
        where, orderBy: { invoiceDate: 'desc' },
        skip: (page - 1) * pageSize, take: pageSize,
        include: { subscriber: { select: SUB_SELECT } },
      }),
      this.prisma.subInvoice.count({ where }),
      // Totales del set filtrado COMPLETO (no solo la página): facturado y saldo.
      this.prisma.subInvoice.aggregate({ _sum: { total: true, paidAmount: true }, where }),
    ]);

    const sumTotal = num(agg._sum.total);
    const sumPaid = num(agg._sum.paidAmount);

    return {
      items: rows.map((i) => ({
        id: i.id, tid: i.tid,
        subscriberId: i.subscriber?.id ?? null,
        subscriber: subName(i.subscriber), abonado: i.subscriber?.abonado ?? null,
        date: i.invoiceDate, dueDate: i.dueDate,
        total: num(i.total), paid: num(i.paidAmount), balance: num(i.total) - num(i.paidAmount),
        status: i.status, ron: i.ron, kind: i.kind,
        service: [i.serviceCombo, i.serviceTv].filter((x) => x && x !== 'no').join(' · ') || null,
        eInvoiceFlag: i.eInvoiceFlag, // 'Crear Factura Electronica' | 'Factura Electronica Creada' | null
      })),
      sum: { total: sumTotal, balance: sumTotal - sumPaid },
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  /** Detalle de una factura: ítems, cliente y pagos aplicados. */
  async detail(id: string) {
    const i = await this.prisma.subInvoice.findUnique({
      where: { id },
      include: {
        subscriber: { select: { ...SUB_SELECT, docType: true, docNumber: true, email: true, phone1: true, branch: { select: { name: true } } } },
        items: { orderBy: { id: 'asc' } },
        transactions: { orderBy: { date: 'desc' } },
        electronicInvoices: { orderBy: { date: 'desc' }, take: 5 },
      },
    });
    if (!i) throw new NotFoundException('Factura no encontrada');

    return {
      id: i.id, tid: i.tid, kind: i.kind, status: i.status, ron: i.ron,
      date: i.invoiceDate, dueDate: i.dueDate,
      subtotal: num(i.subtotal), tax: num(i.tax), discount: num(i.discount),
      total: num(i.total), paid: num(i.paidAmount), balance: num(i.total) - num(i.paidAmount),
      paymentMethod: i.paymentMethod, branchRef: i.branchRef,
      service: { combo: i.serviceCombo, tv: i.serviceTv, puntos: i.puntos, estadoCombo: i.estadoCombo, estadoTv: i.estadoTv },
      eInvoiceFlag: i.eInvoiceFlag,
      subscriber: i.subscriber ? {
        id: i.subscriber.id, name: subName(i.subscriber), abonado: i.subscriber.abonado,
        docType: i.subscriber.docType, docNumber: i.subscriber.docNumber,
        email: i.subscriber.email, phone: i.subscriber.phone1, branch: i.subscriber.branch?.name ?? null,
      } : null,
      items: i.items.map((it) => ({
        id: it.id, product: it.productName, description: it.description, qty: it.qty,
        price: num(it.price), taxRate: num(it.taxRate), subtotal: num(it.subtotal), taxTotal: num(it.taxTotal),
      })),
      payments: i.transactions.map((t) => ({
        id: t.id, date: t.date, amount: num(t.credit), method: t.method,
        category: t.category, status: t.status, note: t.note,
      })),
      electronic: i.electronicInvoices.map((e) => ({
        id: e.id, date: e.date, type: e.type, dianNumber: e.dianNumber, cufe: e.cufe, pdfUrl: e.pdfUrl,
      })),
    };
  }

  /** Cartera agrupada por edad (aging) — cálculo en SQL (una sola query, todo el histórico). */
  async aging() {
    const rows = await this.prisma.$queryRaw<
      { corriente: number; d1_30: number; d31_60: number; d61_90: number; d90: number }[]
    >`
      SELECT
        COALESCE(SUM(bal) FILTER (WHERE d <= 0), 0)::float          AS corriente,
        COALESCE(SUM(bal) FILTER (WHERE d BETWEEN 1 AND 30), 0)::float  AS d1_30,
        COALESCE(SUM(bal) FILTER (WHERE d BETWEEN 31 AND 60), 0)::float AS d31_60,
        COALESCE(SUM(bal) FILTER (WHERE d BETWEEN 61 AND 90), 0)::float AS d61_90,
        COALESCE(SUM(bal) FILTER (WHERE d > 90), 0)::float          AS d90
      FROM (
        SELECT (total - "paidAmount") AS bal, (CURRENT_DATE - "dueDate") AS d
        FROM "SubInvoice"
        WHERE status IN ('DUE', 'PARTIAL')
      ) t`;
    const r = rows[0] ?? { corriente: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90: 0 };
    return { corriente: Number(r.corriente), d1_30: Number(r.d1_30), d31_60: Number(r.d31_60), d61_90: Number(r.d61_90), d90: Number(r.d90) };
  }
}
