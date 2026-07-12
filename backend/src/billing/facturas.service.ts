import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { CreateInvoiceDto, CreateNoteDto, GenerateInvoicesDto, InvoiceItemDto } from './dto/facturas.dto';

const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? 0 : Number(d));
const round2 = (n: number) => Math.round(n * 100) / 100;

function dateOnly(s?: string): Date {
  const d = s ? new Date(s) : new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86400000);

type Tx = Prisma.TransactionClient;

/** Escritura de facturación (Cobranza): crear factura, generar en lote y notas C/D. */
@Injectable()
export class FacturasService {
  constructor(private readonly prisma: PrismaService) {}

  private async nextTid(tx: Tx): Promise<number> {
    const max = await tx.subInvoice.aggregate({ _max: { tid: true } });
    return (max._max.tid ?? 0) + 1;
  }

  /** Calcula totales de una lista de ítems. */
  private computeTotals(items: InvoiceItemDto[]) {
    const rows = items.map((it) => {
      const qty = Math.max(0, Math.round(it.qty));
      const price = round2(it.price);
      const taxRate = round2(it.taxRate ?? 0);
      const subtotal = round2(qty * price);
      const taxTotal = round2((subtotal * taxRate) / 100);
      return { ...it, qty, price, taxRate, subtotal, taxTotal };
    });
    const subtotal = round2(rows.reduce((s, r) => s + r.subtotal, 0));
    const tax = round2(rows.reduce((s, r) => s + r.taxTotal, 0));
    const total = round2(subtotal + tax);
    return { rows, subtotal, tax, total };
  }

  /** Última factura del cliente (para clonar en "Nueva factura"). */
  async lastInvoice(subscriberId: string) {
    const inv = await this.prisma.subInvoice.findFirst({
      where: { subscriberId },
      orderBy: [{ invoiceDate: 'desc' }, { tid: 'desc' }],
      include: { items: { orderBy: { id: 'asc' } } },
    });
    if (!inv) return { found: false, items: [] as any[] };
    return {
      found: true,
      tid: inv.tid, invoiceDate: inv.invoiceDate, dueDate: inv.dueDate,
      serviceCombo: inv.serviceCombo, serviceTv: inv.serviceTv,
      items: inv.items.map((it) => ({
        productName: it.productName, description: it.description ?? it.productName ?? 'Servicio',
        qty: it.qty || 1, price: num(it.price), taxRate: num(it.taxRate),
      })),
    };
  }

  /** Crear una factura para un cliente. */
  async createInvoice(dto: CreateInvoiceDto, user: AuthUser) {
    if (!dto.items?.length) throw new BadRequestException('La factura no tiene ítems');
    const subscriber = await this.prisma.subscriber.findUnique({ where: { id: dto.subscriberId }, select: { id: true, branchId: true } });
    if (!subscriber) throw new NotFoundException('Cliente no encontrado');

    const { rows, subtotal, tax, total } = this.computeTotals(dto.items);
    const invoiceDate = dateOnly(dto.invoiceDate);
    const dueDate = dto.dueDate ? dateOnly(dto.dueDate) : addDays(invoiceDate, 30);

    return this.prisma.$transaction(async (tx) => {
      const tid = await this.nextTid(tx);
      const inv = await tx.subInvoice.create({
        data: {
          tid, subscriberId: subscriber.id, issuerUserId: null,
          invoiceDate, dueDate,
          subtotal, tax, total, paidAmount: 0,
          status: 'DUE', kind: 'FIJA',
          itemsCount: rows.length, notes: dto.notes ?? null,
          items: {
            create: rows.map((r) => ({
              productId: 0, productName: r.productName ?? null, description: r.description,
              qty: r.qty, price: r.price, taxRate: r.taxRate,
              subtotal: r.subtotal, taxTotal: r.taxTotal, discountTotal: 0,
              createdByUserId: null,
            })),
          },
        },
      });
      return { id: inv.id, tid: inv.tid, total, subtotal, tax };
    });
  }

  /** Generar facturas recurrentes en lote (clona la última factura de cada cliente). */
  async generate(dto: GenerateInvoicesDto, user: AuthUser) {
    const invoiceDate = dateOnly(dto.invoiceDate);
    const dueDate = addDays(invoiceDate, dto.dueDays ?? 30);
    const monthStart = new Date(Date.UTC(invoiceDate.getUTCFullYear(), invoiceDate.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(invoiceDate.getUTCFullYear(), invoiceDate.getUTCMonth() + 1, 1));
    const limit = Math.min(dto.limit ?? 500, 2000);

    // Población objetivo.
    const subWhere: Prisma.SubscriberWhereInput = {};
    if (dto.subscriberIds?.length) subWhere.id = { in: dto.subscriberIds };
    else if (dto.branchId) subWhere.branchId = dto.branchId;

    // Factura la mensualidad LIMPIA desde el plan del abonado (SubscriberService
    // activos), no clonando la última factura. Así los cargos puntuales (instalación,
    // reconexión, descuentos de un mes) nunca se arrastran al mes siguiente.
    const subs = await this.prisma.subscriber.findMany({
      where: subWhere, take: limit,
      select: {
        id: true,
        services: {
          where: { status: 'ACTIVO', price: { gt: 0 } },
          select: { kind: true, planName: true, price: true, taxRate: true },
        },
      },
    });

    // ¿Quiénes ya tienen factura este mes? Una sola consulta (usa el índice de
    // invoiceDate) en vez de un count por abonado — evita N roundtrips a la BD.
    const alreadyBilled = new Set(
      (await this.prisma.subInvoice.findMany({
        where: { invoiceDate: { gte: monthStart, lt: monthEnd } },
        select: { subscriberId: true },
      })).map((r) => r.subscriberId),
    );

    let generated = 0, skipped = 0;
    const created: { subscriberId: string; tid: number }[] = [];
    for (const s of subs) {
      // ¿ya tiene factura este mes? → skip (evita duplicar).
      if (alreadyBilled.has(s.id)) { skipped++; continue; }
      // Sin servicios activos con precio → nada que cobrar este mes.
      if (!s.services.length) { skipped++; continue; }

      // Snapshot de servicios (como el legacy) + ítems desde el plan. El IVA sale
      // del servicio (internet 0, TV 19); precio = base sin IVA (computeTotals lo suma).
      let serviceCombo: string | null = null;
      let serviceTv: string | null = null;
      const items: InvoiceItemDto[] = s.services.map((svc) => {
        const name = svc.planName || svc.kind;
        if (svc.kind === 'INTERNET') serviceCombo = svc.planName ?? serviceCombo;
        if (svc.kind === 'TV') serviceTv = svc.planName ?? serviceTv;
        return { productName: name, description: name, qty: 1, price: num(svc.price), taxRate: num(svc.taxRate) };
      });
      const { rows, subtotal, tax, total } = this.computeTotals(items);
      try {
        const inv = await this.prisma.$transaction(async (tx) => {
          const tid = await this.nextTid(tx);
          return tx.subInvoice.create({
            data: {
              tid, subscriberId: s.id, invoiceDate, dueDate,
              subtotal, tax, total, paidAmount: 0, status: 'DUE', kind: 'RECURRENTE',
              itemsCount: rows.length,
              serviceCombo, serviceTv,
              items: { create: rows.map((r) => ({
                productId: 0, productName: r.productName ?? null, description: r.description,
                qty: r.qty, price: r.price, taxRate: r.taxRate,
                subtotal: r.subtotal, taxTotal: r.taxTotal, discountTotal: 0,
              })) },
            },
          });
        });
        generated++;
        created.push({ subscriberId: s.id, tid: inv.tid });
      } catch { skipped++; }
    }
    return { targeted: subs.length, generated, skipped };
  }

  /** Nota crédito/débito: ajusta la factura vía un ítem (pid=0) y recalcula totales/estado. */
  async createNote(invoiceId: string, dto: CreateNoteDto, user: AuthUser) {
    const amount = round2(dto.amount);
    if (!(amount > 0)) throw new BadRequestException('El monto debe ser mayor a cero');

    // Mapear el usuario logueado a un empleado (Staff) por email para registrar
    // el autor de la nota (createdByUserId = id_usuario_crea legacy).
    const staff = user?.email
      ? await this.prisma.staff.findFirst({ where: { email: user.email }, select: { legacyId: true } })
      : null;
    const authorLegacyId = staff?.legacyId ?? null;

    return this.prisma.$transaction(async (tx) => {
      const inv = await tx.subInvoice.findUnique({ where: { id: invoiceId } });
      if (!inv) throw new NotFoundException('Factura no encontrada');

      const isCredit = dto.type === 'CREDITO';
      const product = isCredit ? 'Nota Credito' : 'Nota Debito';
      const price = isCredit ? -amount : amount;

      let subtotal = num(inv.subtotal);
      let total = num(inv.total);
      const paid = num(inv.paidAmount);
      let status = inv.status;

      if (isCredit) {
        subtotal = round2(subtotal - amount);
        total = round2(total - amount);
        if (subtotal < 0) subtotal = 0;
        if (total < 0) total = 0;
        if (round2(total - paid) <= 0) status = 'PAID';
        else if (paid > 0) status = 'PARTIAL';
      } else {
        subtotal = round2(subtotal + amount);
        total = round2(total + amount);
        if (paid > 0 && paid < total) status = 'PARTIAL';
        else if (paid === 0) status = 'DUE';
      }

      await tx.subInvoiceItem.create({
        data: {
          invoiceId, productId: 0, productName: product,
          description: dto.description ?? product,
          qty: 1, price, taxRate: 0, subtotal: price, taxTotal: 0, discountTotal: 0,
          createdByUserId: authorLegacyId,
        },
      });
      await tx.subInvoice.update({
        where: { id: invoiceId },
        data: { subtotal, total, status, itemsCount: { increment: 1 } },
      });

      // Recalcular cache de dinero del cliente.
      if (inv.subscriberId) {
        const agg = await tx.transaction.aggregate({
          _sum: { debit: true, credit: true },
          where: { subscriberId: inv.subscriberId, status: 'VIGENTE', ext: false },
        });
        await tx.subscriber.update({
          where: { id: inv.subscriberId },
          data: { debitCache: agg._sum.debit ?? 0, creditCache: agg._sum.credit ?? 0 },
        });
      }

      return { invoiceId, type: dto.type, amount, newTotal: total, newBalance: round2(total - paid), status };
    });
  }

  /** Listado de notas crédito/débito (ítems pid=0 con producto Nota …). */
  async listNotes(params: { page?: number; pageSize?: number; search?: string; type?: string }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));

    // Tipo: CREDITO / DEBITO acota el productName; cualquier otro valor no filtra.
    const t = (params.type || '').toUpperCase();
    const productName =
      t === 'CREDITO' ? { in: ['Nota Credito'] }
      : t === 'DEBITO' ? { in: ['Nota Debito'] }
      : { in: ['Nota Credito', 'Nota Debito'] };

    const where: Prisma.SubInvoiceItemWhereInput = { productName };

    // Búsqueda: por N° de factura (tid), descripción o nombre del cliente.
    const q = (params.search || '').trim();
    if (q) {
      const or: Prisma.SubInvoiceItemWhereInput[] = [
        { description: { contains: q, mode: 'insensitive' } },
        { invoice: { subscriber: { fullName: { contains: q, mode: 'insensitive' } } } },
        { invoice: { subscriber: { firstName: { contains: q, mode: 'insensitive' } } } },
        { invoice: { subscriber: { lastName1: { contains: q, mode: 'insensitive' } } } },
        { invoice: { subscriber: { companyName: { contains: q, mode: 'insensitive' } } } },
      ];
      const tid = Number(q);
      if (Number.isFinite(tid) && tid > 0) or.push({ invoice: { tid } });
      where.OR = or;
    }

    const [rows, total] = await Promise.all([
      this.prisma.subInvoiceItem.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
        include: { invoice: { select: { id: true, tid: true, subscriber: { select: { firstName: true, lastName1: true, companyName: true, fullName: true } } } } },
      }),
      this.prisma.subInvoiceItem.count({ where }),
    ]);

    // Resolver el autor (createdByUserId = id_usuario_crea legacy) → nombre del
    // empleado, en una sola consulta para toda la página.
    const authorIds = [...new Set(rows.map((it) => it.createdByUserId).filter((v): v is number => v != null))];
    const staff = authorIds.length
      ? await this.prisma.staff.findMany({ where: { legacyId: { in: authorIds } }, select: { legacyId: true, name: true } })
      : [];
    const authorById = new Map(staff.map((s) => [s.legacyId, s.name]));

    return {
      items: rows.map((it) => ({
        id: it.id, type: it.productName === 'Nota Credito' ? 'CREDITO' : 'DEBITO',
        amount: Math.abs(num(it.price)), description: it.description,
        invoiceId: it.invoice?.id ?? null, tid: it.invoice?.tid ?? null,
        subscriber: it.invoice?.subscriber
          ? (it.invoice.subscriber.fullName || [it.invoice.subscriber.firstName, it.invoice.subscriber.lastName1].filter(Boolean).join(' ') || it.invoice.subscriber.companyName || '—')
          : '—',
        author: it.createdByUserId != null ? (authorById.get(it.createdByUserId) ?? null) : null,
        authorId: it.createdByUserId ?? null,
        date: it.createdAt,
      })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }
}
