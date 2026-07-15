import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { PostingService } from '../accounting/posting.service';
import { MikrotikService } from '../network/mikrotik.service';
import {
  CashAccountDto, CashCloseDto, CashOpenDto, CollectDto, EditTxDto, ExpenseDto,
  IncomeDto, TransferDto, TxCategoryDto, VoidTxDto,
} from './dto/cobranzas.dto';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingService,
    private readonly mikrotik: MikrotikService,
  ) {}

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

  /**
   * Saldo persistente de una caja (legacy `accounts.lastbal`). Se recalcula desde
   * cero (SUM crédito − débito de movimientos VIGENTES de esa caja) para ser
   * siempre correcto e idempotente. `cashAccountId` es el id legacy que llevan las
   * transacciones; la fila CashAccount se resuelve por `legacyId`.
   */
  private async recomputeCashBalance(tx: Tx, cashAccountId: number | null | undefined) {
    if (cashAccountId == null) return;
    const acc = await tx.cashAccount.findFirst({ where: { legacyId: cashAccountId }, select: { id: true } });
    if (!acc) return; // caja derivada sin fila propia: nada que materializar
    const agg = await tx.transaction.aggregate({
      _sum: { credit: true, debit: true },
      where: { cashAccountId, status: 'VIGENTE' },
    });
    const balance = round2(num(agg._sum.credit) - num(agg._sum.debit));
    await tx.cashAccount.update({ where: { id: acc.id }, data: { balance } });
  }

  /**
   * Ingreso manual libre: INCOME no ligado a factura. Actualiza el saldo de la caja.
   * Equivale a `Transactions_model::save_trans` con pay_type=Income del legacy.
   */
  async createIncome(dto: IncomeDto, user: AuthUser) {
    const amount = round2(Number(dto.amount));
    if (!(amount > 0)) throw new BadRequestException('El monto debe ser mayor a cero');
    if (dto.subscriberId) {
      const sub = await this.prisma.subscriber.findUnique({ where: { id: dto.subscriberId }, select: { id: true } });
      if (!sub) throw new NotFoundException('Cliente no encontrado');
    }
    const when = dto.date ? dateOnly(dto.date) : dateOnly(new Date().toISOString());
    const result = await this.prisma.$transaction(async (tx) => {
      const t = await tx.transaction.create({
        data: {
          type: 'INCOME', category: dto.category, credit: amount, debit: 0,
          payerName: dto.payerName ?? null, subscriberId: dto.subscriberId ?? null,
          method: dto.method,
          date: when,
          cashAccountId: dto.cashAccountId ?? null, accountName: dto.accountName ?? null,
          bankName: dto.method === 'Bank' ? (dto.bankName ?? null) : null,
          ext: false, status: 'VIGENTE', note: dto.note ?? null, issuerUserId: null,
        },
      });
      await this.recomputeCashBalance(tx, dto.cashAccountId);
      if (dto.subscriberId) await this.recomputeSubscriber(tx, dto.subscriberId);
      return { id: t.id, amount };
    });
    // Contabilización automática (idempotente; no rompe el flujo si falla). "Balance" no mueve efectivo.
    if (dto.method !== 'Balance') {
      await this.posting.postTreasuryIncome({
        sourceId: result.id, date: when, amount: result.amount, category: dto.category,
        toBank: dto.method === 'Bank', createdBy: user?.name ?? user?.email ?? null,
      });
    }
    return result;
  }

  /**
   * Editar un movimiento. Campos seguros siempre; el monto solo si NO es un pago
   * de venta ligado a factura (esos se anulan y rehacen para no descuadrar cartera).
   */
  async editTransaction(id: string, dto: EditTxDto, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const t = await tx.transaction.findUnique({ where: { id } });
      if (!t) throw new NotFoundException('Movimiento no encontrado');
      if (t.status === 'ANULADA') throw new BadRequestException('No se puede editar un movimiento anulado');

      const data: Prisma.TransactionUpdateInput = {};
      if (dto.category !== undefined) data.category = dto.category;
      if (dto.note !== undefined) data.note = dto.note;
      if (dto.date !== undefined) data.date = dateOnly(dto.date);
      if (dto.method !== undefined) data.method = dto.method;
      if (dto.payerName !== undefined) data.payerName = dto.payerName;
      if (dto.accountName !== undefined) data.accountName = dto.accountName;
      if (dto.cashAccountId !== undefined) data.cashAccountId = dto.cashAccountId;
      if (dto.bankName !== undefined) data.bankName = dto.bankName;

      if (dto.amount !== undefined) {
        const isSalePayment = !!t.invoiceId && t.category === 'Sales' && t.type === 'INCOME';
        if (isSalePayment) {
          throw new BadRequestException('No se puede editar el monto de un pago de venta. Anula el movimiento y regístralo de nuevo.');
        }
        const amount = round2(Number(dto.amount));
        if (t.type === 'INCOME') { data.credit = amount; data.debit = 0; }
        else { data.debit = amount; data.credit = 0; }
      }

      await tx.transaction.update({ where: { id }, data });
      // Recalcular saldo de la(s) caja(s) afectada(s).
      const affected = new Set<number>();
      if (t.cashAccountId != null) affected.add(t.cashAccountId);
      if (dto.cashAccountId != null) affected.add(dto.cashAccountId);
      for (const acid of affected) await this.recomputeCashBalance(tx, acid);
      if (t.subscriberId) await this.recomputeSubscriber(tx, t.subscriberId);
      return { id, ok: true };
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
    let amount = round2(Number(dto.amount));
    if (!(amount > 0)) throw new BadRequestException('El monto debe ser mayor a cero');

    const sub = await this.prisma.subscriber.findUnique({
      where: { id: dto.subscriberId },
      select: { id: true, balance: true, ...SUB_NAME_SELECT },
    });
    if (!sub) throw new NotFoundException('Cliente no encontrado');

    // Método "Balance": el pago se cubre con el saldo a favor del cliente y NO
    // puede exceder ese saldo (paridad legacy Transactions.php:1334 → si el saldo
    // no alcanza, se capa el monto aplicado al saldo disponible; nunca aplica de más).
    if (dto.method === 'Balance') {
      const bal = round2(num(sub.balance));
      if (bal <= 0) throw new BadRequestException('El cliente no tiene saldo a favor para pagar con Balance.');
      if (amount > bal) amount = bal;
    }

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

    const result = await this.prisma.$transaction(async (tx) => {
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
      await this.recomputeCashBalance(tx, dto.cashAccountId);

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
    // Contabilización automática del recaudo (DR banco/caja, CR cartera). "Balance"
    // se paga con saldo a favor del cliente: no mueve efectivo → no se contabiliza aquí.
    if (dto.method !== 'Balance' && result.totalApplied > 0) {
      await this.posting.postCustomerPayment({
        sourceId: result.receiptId, date: payDate, amount: result.totalApplied,
        toBank: dto.method === 'Bank', createdBy: user?.name ?? user?.email ?? null,
      });
    }
    // Reconexión automática tras el pago (paridad legacy: al pagar se reactiva).
    // Best-effort: nunca rompe el recaudo. Solo si el cliente estaba CORTADO. Respeta
    // el modo de red (dry-run salvo interruptor de Configuración encendido).
    try {
      const fresh = await this.prisma.subscriber.findUnique({ where: { id: dto.subscriberId }, select: { status: true } });
      if (fresh?.status === 'CORTADO') {
        await this.mikrotik.reconnect(dto.subscriberId, user);
      }
    } catch { /* el pago ya quedó registrado; la reconexión puede reintentarse manual */ }
    return result;
  }

  /** Anular una transacción: soft-delete + Voiding + reversa del saldo de la factura. */
  async voidTransaction(id: string, dto: VoidTxDto, user: AuthUser) {
    return this.prisma.$transaction((tx) => this.voidTransactionTx(tx, id, dto, user));
  }

  /**
   * Igual que `voidTransaction`, pero dentro de una transacción ya abierta por quien
   * llama. Lo usa `FacturasService.voidInvoice`, que necesita anular la factura y
   * reversar todos sus pagos en un solo commit.
   */
  async voidTransactionTx(tx: Tx, id: string, dto: VoidTxDto, user: AuthUser) {
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
    await this.recomputeCashBalance(tx, t.cashAccountId);
    return { id, status: 'ANULADA' };
  }

  /** Registrar un egreso/gasto de caja. */
  async createExpense(dto: ExpenseDto, user: AuthUser) {
    const amount = round2(Number(dto.amount));
    const when = dto.date ? dateOnly(dto.date) : dateOnly(new Date().toISOString());
    const result = await this.prisma.$transaction(async (tx) => {
      const t = await tx.transaction.create({
        data: {
          type: 'EXPENSE', category: dto.category, debit: amount, credit: 0,
          payerName: dto.payerName ?? null,
          method: dto.method,
          date: when,
          cashAccountId: dto.cashAccountId ?? null, accountName: dto.accountName ?? null,
          bankName: dto.method === 'Bank' ? (dto.bankName ?? null) : null,
          ext: true, status: 'VIGENTE', note: dto.note ?? null,
          issuerUserId: null,
        },
      });
      await this.recomputeCashBalance(tx, dto.cashAccountId);
      return { id: t.id, amount };
    });
    // Contabilización automática (DR gasto, CR banco/caja).
    await this.posting.postTreasuryExpense({
      sourceId: result.id, date: when, amount: result.amount, category: dto.category,
      fromBank: dto.method === 'Bank', createdBy: user?.name ?? user?.email ?? null,
    });
    return result;
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
      await this.recomputeCashBalance(tx, dto.fromCashAccountId);
      await this.recomputeCashBalance(tx, dto.toCashAccountId);
      return {
        amount, date,
        from: { cashAccountId: dto.fromCashAccountId, name: fromName, transactionId: out.id },
        to: { cashAccountId: dto.toCashAccountId, name: toName, transactionId: inc.id },
      };
    });
  }

  /**
   * Cajas disponibles: la tabla CashAccount es la autoritativa (incluye cajas
   * nuevas y con saldo persistente), fusionada con las cajas "derivadas" que
   * aparecen en transacciones antiguas pero aún no tienen fila propia, para no
   * perder selectores. El `id` expuesto es el legacyId (el que llevan las tx).
   */
  async cashAccounts() {
    const [accounts, derived] = await Promise.all([
      this.prisma.cashAccount.findMany({
        select: { id: true, legacyId: true, holder: true, balance: true, branchLegacy: true, accountNumber: true, code: true },
        orderBy: { holder: 'asc' },
      }),
      this.prisma.transaction.groupBy({
        by: ['cashAccountId', 'accountName'],
        where: { cashAccountId: { not: null } },
        _count: { _all: true },
      }),
    ]);
    const known = new Set(accounts.map((a) => a.legacyId).filter((x): x is number => x != null));
    const out = accounts
      .filter((a) => a.legacyId != null)
      .map((a) => ({
        id: a.legacyId as number, cuid: a.id, name: a.holder,
        balance: num(a.balance), branchLegacy: a.branchLegacy,
        accountNumber: a.accountNumber, code: a.code, persisted: true,
      }));
    // Derivadas: id presente en tx pero sin fila CashAccount.
    const seen = new Set<number>();
    for (const r of derived) {
      if (r.cashAccountId == null || known.has(r.cashAccountId) || seen.has(r.cashAccountId)) continue;
      seen.add(r.cashAccountId);
      out.push({
        id: r.cashAccountId, cuid: null as any, name: r.accountName ?? `Caja ${r.cashAccountId}`,
        balance: 0, branchLegacy: null, accountNumber: null, code: null, persisted: false,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Asigna el siguiente legacyId libre para una caja nueva (max entre cajas y tx + 1). */
  private async nextCashLegacyId(tx: Tx): Promise<number> {
    const [maxAcc, maxTx] = await Promise.all([
      tx.cashAccount.aggregate({ _max: { legacyId: true } }),
      tx.transaction.aggregate({ _max: { cashAccountId: true } }),
    ]);
    return Math.max(1000, (maxAcc._max.legacyId ?? 0), (maxTx._max.cashAccountId ?? 0)) + 1;
  }

  /** Crear una caja o banco. Le asigna un legacyId estable (el que usarán las tx). */
  async createCashAccount(dto: CashAccountDto, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const legacyId = await this.nextCashLegacyId(tx);
      const a = await tx.cashAccount.create({
        data: {
          legacyId, holder: dto.holder.trim(),
          accountNumber: dto.accountNumber ?? null, branchLegacy: dto.branchLegacy ?? null,
          code: dto.code ?? null, address: dto.address ?? null, phone: dto.phone ?? null,
          departmentRef: dto.departmentRef ?? null, balance: 0,
        },
      });
      return { id: a.legacyId, cuid: a.id, name: a.holder };
    });
  }

  /** Editar una caja (por su legacyId). */
  async updateCashAccount(legacyId: number, dto: CashAccountDto, user: AuthUser) {
    const a = await this.prisma.cashAccount.findFirst({ where: { legacyId } });
    if (!a) throw new NotFoundException('Caja no encontrada');
    const upd = await this.prisma.cashAccount.update({
      where: { id: a.id },
      data: {
        holder: dto.holder.trim(),
        accountNumber: dto.accountNumber ?? null, branchLegacy: dto.branchLegacy ?? null,
        code: dto.code ?? null, address: dto.address ?? null, phone: dto.phone ?? null,
        departmentRef: dto.departmentRef ?? null,
      },
    });
    return { id: upd.legacyId, cuid: upd.id, name: upd.holder };
  }

  /** Eliminar una caja. Bloquea si tiene movimientos asociados. */
  async deleteCashAccount(legacyId: number) {
    const a = await this.prisma.cashAccount.findFirst({ where: { legacyId } });
    if (!a) throw new NotFoundException('Caja no encontrada');
    const used = await this.prisma.transaction.count({ where: { cashAccountId: legacyId } });
    if (used > 0) throw new BadRequestException(`No se puede eliminar: la caja tiene ${used} movimiento(s). Ciérrala en lugar de borrarla.`);
    await this.prisma.cashAccount.delete({ where: { id: a.id } });
    return { id: legacyId, deleted: true };
  }

  /** Recalcular el saldo persistente de una caja desde sus movimientos. */
  async recomputeCashAccount(legacyId: number) {
    return this.prisma.$transaction(async (tx) => {
      await this.recomputeCashBalance(tx, legacyId);
      const a = await tx.cashAccount.findFirst({ where: { legacyId }, select: { balance: true } });
      return { id: legacyId, balance: num(a?.balance) };
    });
  }

  // --- Categorías de transacción (CRUD) ---

  /** Crear una categoría. */
  async createCategory(dto: TxCategoryDto) {
    const name = dto.name.trim();
    const exists = await this.prisma.transactionCategory.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
    if (exists) throw new BadRequestException('Ya existe una categoría con ese nombre');
    const max = await this.prisma.transactionCategory.aggregate({ _max: { legacyId: true } });
    const c = await this.prisma.transactionCategory.create({
      data: { name, legacyId: (max._max.legacyId ?? 0) + 1 },
    });
    return { id: c.id, name: c.name };
  }

  /** Renombrar una categoría (propaga el nombre a las transacciones que la usan). */
  async updateCategory(id: string, dto: TxCategoryDto) {
    const c = await this.prisma.transactionCategory.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Categoría no encontrada');
    const name = dto.name.trim();
    return this.prisma.$transaction(async (tx) => {
      await tx.transaction.updateMany({ where: { category: c.name }, data: { category: name } });
      const upd = await tx.transactionCategory.update({ where: { id }, data: { name } });
      return { id: upd.id, name: upd.name };
    });
  }

  /** Eliminar una categoría. Bloquea si está en uso. */
  async deleteCategory(id: string) {
    const c = await this.prisma.transactionCategory.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Categoría no encontrada');
    const used = await this.prisma.transaction.count({ where: { category: c.name } });
    if (used > 0) throw new BadRequestException(`No se puede eliminar: la categoría tiene ${used} movimiento(s).`);
    await this.prisma.transactionCategory.delete({ where: { id } });
    return { id, deleted: true };
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
