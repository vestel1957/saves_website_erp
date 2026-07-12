import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { CashCloseDto, CashOpenDto, CollectDto, ExpenseDto, TransferDto, VoidTxDto } from './dto/cobranzas.dto';

const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? 0 : Number(d));
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Fondo fijo de caja (base inicial estándar). En el legacy saves-vestel la base
 * es un valor fijo que NUNCA sale del cajón (200.000 en la mayoría de cajas).
 * La base real con que se abre = FONDO_FIJO + arrastre del día anterior.
 */
const FONDO_FIJO = 200000;

const SUB_NAME_SELECT = {
  firstName: true, secondName: true, lastName1: true, lastName2: true,
  companyName: true, fullName: true,
} as const;

function subName(s: {
  firstName: string | null; secondName: string | null; lastName1: string | null;
  lastName2: string | null; companyName: string | null; fullName: string | null;
} | null): string | null {
  if (!s) return null;
  if (s.fullName && s.fullName.trim()) return s.fullName.trim();
  const person = [s.firstName, s.secondName, s.lastName1, s.lastName2]
    .map((p) => (p || '').trim()).filter(Boolean).join(' ');
  return person || (s.companyName || '').trim() || null;
}

/** Fecha "date-only" en UTC a partir de 'YYYY-MM-DD' (o ISO). */
function dateOnly(s: string): Date {
  const d = new Date(s);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

type Tx = Prisma.TransactionClient;

/**
 * Operaciones de escritura del módulo Cobranzas (migrado de saves-vestel):
 * recaudo con multipago en cascada, anulación con reversa, egresos y cierre de caja.
 */
@Injectable()
export class CobranzasService {
  constructor(private readonly prisma: PrismaService) {}

  /** Recalcula el cache de dinero del suscriptor (SUM debit/credit de tx vigentes internas). */
  private async recomputeSubscriber(tx: Tx, subscriberId: string) {
    const agg = await tx.transaction.aggregate({
      _sum: { debit: true, credit: true },
      where: { subscriberId, status: 'VIGENTE', ext: false },
    });
    await tx.subscriber.update({
      where: { id: subscriberId },
      data: { debitCache: agg._sum.debit ?? 0, creditCache: agg._sum.credit ?? 0 },
    });
  }

  /** Facturas pendientes del suscriptor (para el modal de recaudo). */
  async subscriberDebt(subscriberId: string) {
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: { id: true, abonado: true, balance: true, ...SUB_NAME_SELECT },
    });
    if (!sub) throw new NotFoundException('Cliente no encontrado');

    const invoices = await this.prisma.subInvoice.findMany({
      where: { subscriberId, status: { in: ['DUE', 'PARTIAL'] } },
      orderBy: [{ invoiceDate: 'asc' }, { tid: 'asc' }],
      select: { id: true, tid: true, invoiceDate: true, dueDate: true, total: true, paidAmount: true, status: true },
    });

    const items = invoices.map((i) => ({
      id: i.id, tid: i.tid, invoiceDate: i.invoiceDate, dueDate: i.dueDate,
      total: num(i.total), paid: num(i.paidAmount),
      balance: round2(num(i.total) - num(i.paidAmount)), status: i.status,
    }));
    return {
      subscriberId: sub.id, name: subName(sub), abonado: sub.abonado,
      balance: num(sub.balance),
      totalDebt: round2(items.reduce((s, i) => s + i.balance, 0)),
      invoices: items,
    };
  }

  /** Registrar recaudo: aplica el monto en cascada, crea transacciones + recibo. */
  async collect(dto: CollectDto, user: AuthUser) {
    const amount = round2(Number(dto.amount));
    if (!(amount > 0)) throw new BadRequestException('El monto debe ser mayor a cero');

    const sub = await this.prisma.subscriber.findUnique({
      where: { id: dto.subscriberId },
      select: { id: true, balance: true, ...SUB_NAME_SELECT },
    });
    if (!sub) throw new NotFoundException('Cliente no encontrado');

    // Facturas a pagar: orden explícito o más antiguas primero.
    let invoices;
    if (dto.invoiceIds?.length) {
      const found = await this.prisma.subInvoice.findMany({
        where: { id: { in: dto.invoiceIds }, subscriberId: dto.subscriberId, status: { in: ['DUE', 'PARTIAL'] } },
      });
      const byId = new Map(found.map((i) => [i.id, i]));
      invoices = dto.invoiceIds.map((id) => byId.get(id)).filter((i): i is NonNullable<typeof i> => !!i);
    } else {
      invoices = await this.prisma.subInvoice.findMany({
        where: { subscriberId: dto.subscriberId, status: { in: ['DUE', 'PARTIAL'] } },
        orderBy: [{ invoiceDate: 'asc' }, { tid: 'asc' }],
      });
    }
    if (!invoices.length) throw new BadRequestException('El cliente no tiene facturas pendientes');

    // --- Fase 1: reparto en cascada (saldo = total - paidAmount) ---
    let monto = amount;
    const montos = new Map<string, number>();
    let lastId: string | null = null;
    for (const inv of invoices) {
      if (monto <= 0) break;
      const saldo = round2(num(inv.total) - num(inv.paidAmount));
      if (saldo <= 0) continue;
      if (monto >= saldo) {
        montos.set(inv.id, saldo);
        monto = round2(monto - saldo);
        lastId = inv.id;
      } else {
        // El dinero se agota aquí → pago parcial de esta factura.
        montos.set(inv.id, monto);
        lastId = inv.id;
        monto = 0;
        break;
      }
    }
    // Excedente (sobrepago): se carga a la última factura procesada (queda como saldo a favor/adelanto).
    if (monto > 0 && lastId) {
      montos.set(lastId, round2((montos.get(lastId) ?? 0) + monto));
      monto = 0;
    }
    if (!montos.size) throw new BadRequestException('No hay saldo pendiente que cubrir');

    const payDate = dto.date ? dateOnly(dto.date) : dateOnly(new Date().toISOString());
    const payer = subName(sub);

    return this.prisma.$transaction(async (tx) => {
      const applied: { invoiceId: string; tid: number; amount: number; status: string }[] = [];
      const txIds: string[] = [];
      let primary: { id: string; tid: number } | null = null;

      for (const inv of invoices) {
        const amt = montos.get(inv.id);
        if (!amt) continue;
        const saldoAntes = round2(num(inv.total) - num(inv.paidAmount));
        const status: 'PAID' | 'PARTIAL' = saldoAntes > amt ? 'PARTIAL' : 'PAID';
        const newPamnt = round2(num(inv.paidAmount) + amt);

        const t = await tx.transaction.create({
          data: {
            type: 'INCOME', category: 'Sales', credit: amt, debit: 0,
            payerName: payer, subscriberId: sub.id,
            method: dto.method, date: payDate, invoiceId: inv.id,
            cashAccountId: dto.cashAccountId ?? null, accountName: dto.accountName ?? null,
            bankName: dto.method === 'Bank' ? (dto.bankName ?? null) : null,
            ext: false, status: 'VIGENTE',
            note: dto.note ?? `Pago de la factura #${inv.tid}`,
          },
        });
        txIds.push(t.id);
        await tx.subInvoice.update({
          where: { id: inv.id },
          data: { paidAmount: newPamnt, status, paymentMethod: dto.method },
        });
        applied.push({ invoiceId: inv.id, tid: inv.tid, amount: amt, status });
        if (!primary) primary = { id: inv.id, tid: inv.tid };
      }

      // Método "Balance": descontar del saldo a favor del cliente.
      if (dto.method === 'Balance') {
        const nuevo = Math.max(0, round2(num(sub.balance) - amount));
        await tx.subscriber.update({ where: { id: sub.id }, data: { balance: nuevo } });
      }

      await this.recomputeSubscriber(tx, sub.id);

      // Recibo de caja (materializado al pagar, no al imprimir como el legacy).
      const receipt = await tx.paymentReceipt.create({
        data: {
          date: payDate,
          fileName: `${primary!.tid}_${Date.now()}`,
          invoiceId: primary!.id,
          transactions: { create: txIds.map((id) => ({ transactionId: id })) },
        },
      });

      return {
        receiptId: receipt.id,
        fileName: receipt.fileName,
        totalApplied: round2(applied.reduce((s, a) => s + a.amount, 0)),
        applied,
      };
    });
  }

  /** Anular una transacción: soft-delete + Voiding + reversa del saldo de la factura. */
  async voidTransaction(id: string, dto: VoidTxDto, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const t = await tx.transaction.findUnique({
        where: { id },
        include: { receiptLinks: true },
      });
      if (!t) throw new NotFoundException('Transacción no encontrada');
      if (t.status === 'ANULADA') throw new BadRequestException('La transacción ya está anulada');

      await tx.transaction.update({ where: { id }, data: { status: 'ANULADA' } });
      await tx.voiding.create({
        data: {
          dateTime: new Date(),
          detail: dto.detail ?? null,
          reason: dto.reason,
          voidedBy: user.name || user.email,
          transactionId: id,
        },
      });

      // Reversa sobre la factura (solo pagos de venta).
      if (t.invoiceId && t.category === 'Sales' && t.type === 'INCOME') {
        const inv = await tx.subInvoice.findUnique({ where: { id: t.invoiceId } });
        if (inv) {
          let pamnt = round2(num(inv.paidAmount) - num(t.credit));
          let status: 'DUE' | 'PARTIAL' = 'PARTIAL';
          if (pamnt <= 0) { pamnt = 0; status = 'DUE'; }
          await tx.subInvoice.update({ where: { id: inv.id }, data: { paidAmount: pamnt, status } });
        }
      }

      // El recibo se elimina (como el legacy): borra enlaces y recibos que queden huérfanos.
      const receiptIds = [...new Set(t.receiptLinks.map((l) => l.receiptId))];
      await tx.receiptTransaction.deleteMany({ where: { transactionId: id } });
      for (const rid of receiptIds) {
        const remaining = await tx.receiptTransaction.count({ where: { receiptId: rid } });
        if (remaining === 0) await tx.paymentReceipt.delete({ where: { id: rid } });
      }

      if (t.subscriberId) await this.recomputeSubscriber(tx, t.subscriberId);
      return { id, status: 'ANULADA' };
    });
  }

  /** Registrar un egreso/gasto de caja. */
  async createExpense(dto: ExpenseDto, user: AuthUser) {
    const amount = round2(Number(dto.amount));
    const t = await this.prisma.transaction.create({
      data: {
        type: 'EXPENSE', category: dto.category, debit: amount, credit: 0,
        payerName: dto.payerName ?? null,
        method: dto.method,
        date: dto.date ? dateOnly(dto.date) : dateOnly(new Date().toISOString()),
        cashAccountId: dto.cashAccountId ?? null, accountName: dto.accountName ?? null,
        bankName: dto.method === 'Bank' ? (dto.bankName ?? null) : null,
        ext: true, status: 'VIGENTE', note: dto.note ?? null,
        issuerUserId: null,
      },
    });
    return { id: t.id, amount };
  }

  /**
   * Transferir dinero entre dos cajas: crea un EXPENSE en la caja origen y un
   * INCOME en la caja destino, ambos categoría "Transferencia" y enlazados por
   * nota. Así el cierre/arqueo de cada caja refleja el movimiento.
   */
  async createTransfer(dto: TransferDto, user: AuthUser) {
    if (dto.fromCashAccountId === dto.toCashAccountId) {
      throw new BadRequestException('La caja origen y destino no pueden ser la misma.');
    }
    const amount = round2(Number(dto.amount));
    if (amount <= 0) throw new BadRequestException('El monto debe ser mayor a cero.');

    const date = dto.date ? dateOnly(dto.date) : dateOnly(new Date().toISOString());
    const fromName = dto.fromAccountName ?? `Caja ${dto.fromCashAccountId}`;
    const toName = dto.toAccountName ?? `Caja ${dto.toCashAccountId}`;
    const baseNote = (dto.note ?? '').trim();

    return this.prisma.$transaction(async (tx) => {
      const out = await tx.transaction.create({
        data: {
          type: 'EXPENSE', category: 'Transferencia', debit: amount, credit: 0,
          method: 'Cash', date, status: 'VIGENTE', ext: true, issuerUserId: null,
          cashAccountId: dto.fromCashAccountId, accountName: dto.fromAccountName ?? null,
          payerName: user?.name ?? null,
          note: `Transferencia a ${toName}${baseNote ? ` — ${baseNote}` : ''}`,
        },
      });
      const inc = await tx.transaction.create({
        data: {
          type: 'INCOME', category: 'Transferencia', credit: amount, debit: 0,
          method: 'Cash', date, status: 'VIGENTE', ext: true, issuerUserId: null,
          cashAccountId: dto.toCashAccountId, accountName: dto.toAccountName ?? null,
          payerName: user?.name ?? null,
          note: `Transferencia desde ${fromName}${baseNote ? ` — ${baseNote}` : ''}`,
        },
      });
      return {
        amount, date,
        from: { cashAccountId: dto.fromCashAccountId, name: fromName, transactionId: out.id },
        to: { cashAccountId: dto.toCashAccountId, name: toName, transactionId: inc.id },
      };
    });
  }

  /** Cajas disponibles (derivadas de las transacciones existentes). */
  async cashAccounts() {
    const rows = await this.prisma.transaction.groupBy({
      by: ['cashAccountId', 'accountName'],
      where: { cashAccountId: { not: null } },
      _count: { _all: true },
    });
    const byId = new Map<number, { id: number; name: string; count: number }>();
    for (const r of rows) {
      if (r.cashAccountId == null) continue;
      const prev = byId.get(r.cashAccountId);
      const count = r._count._all;
      if (!prev || count > prev.count) {
        byId.set(r.cashAccountId, { id: r.cashAccountId, name: r.accountName ?? `Caja ${r.cashAccountId}`, count });
      }
    }
    return [...byId.values()]
      .map(({ id, name }) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Apertura de caja: registra la base inicial de una caja en una fecha. */
  async openCash(dto: CashOpenDto, user: AuthUser) {
    const d = dateOnly(dto.date);
    const o = await this.prisma.cashOpen.upsert({
      where: { cashAccountId_date: { cashAccountId: dto.cashAccountId, date: d } },
      create: {
        cashAccountId: dto.cashAccountId, accountName: dto.accountName ?? null, date: d,
        base: round2(dto.base), note: dto.note ?? null, openedBy: user.name || user.email,
      },
      update: { base: round2(dto.base), note: dto.note ?? null, accountName: dto.accountName ?? null },
    });
    return { id: o.id, cashAccountId: o.cashAccountId, date: o.date, base: num(o.base), openedBy: o.openedBy };
  }

  /** Apertura vigente de una caja en una fecha (o null). */
  async getCashOpen(cashAccountId: number, date: string) {
    const d = dateOnly(date);
    const o = await this.prisma.cashOpen.findUnique({
      where: { cashAccountId_date: { cashAccountId, date: d } },
    });
    return o ? { base: num(o.base), openedBy: o.openedBy, openedAt: o.openedAt, note: o.note } : null;
  }

  /**
   * Arrastre: excedente del ÚLTIMO cierre anterior a la fecha para esa caja.
   * Es lo que quedó en el cajón (más allá del fondo fijo) el día anterior y que
   * "rueda" hacia hoy. Devuelve 0 si la caja nunca se ha cerrado.
   */
  async getCarryover(cashAccountId: number, date: string): Promise<{ carryover: number; from: Date | null }> {
    const d = dateOnly(date);
    const prev = await this.prisma.cashClose.findFirst({
      where: { cashAccountId, date: { lt: d } },
      orderBy: { date: 'desc' },
    });
    return { carryover: prev ? round2(num(prev.surplus)) : 0, from: prev?.date ?? null };
  }

  /**
   * Sugerencia de apertura para una caja/fecha: fondo fijo + arrastre del día
   * anterior. La base propuesta ya trae el arrastre sumado (modelo elegido).
   * Si ya existe apertura para ese día, la devuelve como `existing`.
   */
  async cashOpenSuggest(cashAccountId: number, date: string) {
    const { carryover, from } = await this.getCarryover(cashAccountId, date);
    const existing = await this.getCashOpen(cashAccountId, date);
    return {
      fondoFijo: FONDO_FIJO,
      carryover,
      carryoverFrom: from,
      base: round2(FONDO_FIJO + carryover),
      existing,
    };
  }

  /** Aperturas recientes (listado). */
  async cashOpens(params: { page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
    const [rows, total] = await Promise.all([
      this.prisma.cashOpen.findMany({ orderBy: { openedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.cashOpen.count(),
    ]);
    return {
      items: rows.map((o) => ({
        id: o.id, cashAccountId: o.cashAccountId, accountName: o.accountName,
        date: o.date, base: num(o.base), openedBy: o.openedBy, openedAt: o.openedAt, note: o.note,
      })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  /** Cierre de caja (arqueo): agrega ingresos/egresos vigentes de la caja en la fecha. */
  async createCashClose(dto: CashCloseDto, user: AuthUser) {
    const d = dateOnly(dto.date);
    const next = new Date(d.getTime() + 24 * 60 * 60 * 1000);
    const dateWhere: Prisma.TransactionWhereInput = {
      cashAccountId: dto.cashAccountId, status: 'VIGENTE',
      date: { gte: d, lt: next },
    };
    const [inc, exp] = await Promise.all([
      this.prisma.transaction.aggregate({ _sum: { credit: true }, where: { ...dateWhere, type: 'INCOME' } }),
      this.prisma.transaction.aggregate({ _sum: { debit: true }, where: { ...dateWhere, type: 'EXPENSE' } }),
    ]);
    const sales = round2(num(inc._sum.credit));
    const expenses = round2(num(exp._sum.debit));
    // Base: la que pase el usuario, o la de la apertura del día si existe.
    let base = round2(Number(dto.base ?? 0));
    if (dto.base == null) {
      const apertura = await this.prisma.cashOpen.findUnique({
        where: { cashAccountId_date: { cashAccountId: dto.cashAccountId, date: d } },
      });
      if (apertura) base = round2(num(apertura.base));
    }
    const deposited = round2(Number(dto.deposited ?? 0));
    // Excedente (legacy saves-vestel): lo que queda en el cajón MÁS ALLÁ del
    // fondo fijo, y que se arrastra al día siguiente. El fondo fijo (200k) nunca
    // sale, por eso NO entra en el excedente:
    //   excedente = arrastre_del_día_anterior + ventas − egresos − consignado
    const { carryover } = await this.getCarryover(dto.cashAccountId, dto.date);
    const surplus = round2(carryover + sales - expenses - deposited);

    const close = await this.prisma.cashClose.upsert({
      where: { cashAccountId_date: { cashAccountId: dto.cashAccountId, date: d } },
      create: { cashAccountId: dto.cashAccountId, date: d, base, sales, expenses, deposited, surplus, userId: 0 },
      update: { base, sales, expenses, deposited, surplus },
    });
    return {
      id: close.id, cashAccountId: close.cashAccountId, date: close.date,
      base, fondoFijo: FONDO_FIJO, carryover, sales, expenses, deposited, surplus,
    };
  }
}
