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
import {
  aporteEfectivo, CATEGORIA_SALDO, esNotaSaldo, notaSaldo, proximoDiaHabil, rangoDia,
  sinElBarridoDelDia, whereArrastre, whereEfectivo,
} from './cierre-legacy';
import { alcanceDe, exigirAcceso, puedeVer } from './caja-scope';
import { num, round2 } from '../common/money';


/**
 * ¿El método mueve dinero por banco (y no por el cajón de efectivo)?
 *
 * Decide el asiento contable (banco vs. caja) y si se guarda el nombre del banco.
 * `Cheque` cuenta como banco: se consigna, no se queda como efectivo en caja —si
 * contara como caja, aparecería en el arqueo del cierre, y un arqueo cuenta
 * billetes. Paridad legacy: el método "Cheque" sigue vivo allá (último uso ayer).
 */
const isBankMethod = (method: string | null | undefined) => method === 'Bank' || method === 'Cheque';

/**
 * Fondo fijo por defecto de una caja: la plata que NUNCA sale del cajón, y por eso no
 * entra en el excedente. La base real con que se abre = fondo fijo + arrastre del día
 * anterior.
 *
 * Es solo el DEFAULT: el valor real vive en `CashAccount.fixedFund`, porque no es una
 * constante del negocio — de los 3 únicos cierres reales que existen, uno cerró con
 * base de 300.000.
 */
const FONDO_FIJO_DEFAULT = 200000;

/** Categoría con la que `createTransfer` marca los dos lados de un traslado entre cajas. */
const CAT_TRANSFERENCIA = 'Transferencia';

/** Fondo fijo de una caja; cae al default si la caja no existe. */
async function fondoFijoDe(prisma: PrismaService, cashAccountId: number): Promise<number> {
  const acc = await prisma.cashAccount.findUnique({
    where: { legacyId: cashAccountId },
    select: { fixedFund: true },
  });
  return acc ? round2(num(acc.fixedFund)) : FONDO_FIJO_DEFAULT;
}

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

  /**
   * Serializa las operaciones de dinero de UN cliente bloqueando su fila hasta el
   * commit (`SELECT ... FOR UPDATE`).
   *
   * Hace falta porque el reparto de un pago es un read-modify-write sobre
   * `SubInvoice.paidAmount`: se lee el saldo, se calcula cuánto aplicar y se escribe
   * el nuevo pagado. Prisma corre en READ COMMITTED, así que dos recaudos simultáneos
   * del mismo cliente leían ambos `paidAmount = X`, escribían ambos `X + importe` y
   * uno de los dos abonos se perdía — pero las DOS filas INCOME quedaban creadas.
   * Resultado: la caja cuadraba el doble que la cartera, sin ninguna traza.
   *
   * Se bloquea el suscriptor y no las facturas: es UNA fila, siempre la misma, así que
   * dos transacciones concurrentes no pueden cogerse recursos en orden distinto y no
   * hay interbloqueo posible. Todas las facturas de un pago son de ese cliente.
   */
  private async lockSubscriber(tx: Tx, subscriberId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM "Subscriber" WHERE id = ${subscriberId} FOR UPDATE`;
  }

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
          bankName: isBankMethod(dto.method) ? (dto.bankName ?? null) : null,
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
        toBank: isBankMethod(dto.method), createdBy: user?.name ?? user?.email ?? null,
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
    const montoPedido = round2(Number(dto.amount));
    if (!(montoPedido > 0)) throw new BadRequestException('El monto debe ser mayor a cero');

    const payDate = dto.date ? dateOnly(dto.date) : dateOnly(new Date().toISOString());

    const result = await this.prisma.$transaction(async (tx) => {
      // Todo lo que sigue —leer saldos, repartir y escribir— va DENTRO de la
      // transacción y detrás del bloqueo del cliente. Antes las facturas se leían
      // fuera y el reparto se calculaba sobre esa foto vieja, así que dos recaudos
      // simultáneos perdían un abono. Ver `lockSubscriber`.
      await this.lockSubscriber(tx, dto.subscriberId);

      const sub = await tx.subscriber.findUnique({
        where: { id: dto.subscriberId },
        select: { id: true, balance: true, ...SUB_NAME_SELECT },
      });
      if (!sub) throw new NotFoundException('Cliente no encontrado');

      let amount = montoPedido;
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
        const found = await tx.subInvoice.findMany({
          where: { id: { in: dto.invoiceIds }, subscriberId: dto.subscriberId, status: { in: ['DUE', 'PARTIAL'] } },
        });
        const byId = new Map(found.map((i) => [i.id, i]));
        invoices = dto.invoiceIds.map((id) => byId.get(id)).filter((i): i is NonNullable<typeof i> => !!i);
      } else {
        invoices = await tx.subInvoice.findMany({
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

      const payer = subName(sub);
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
            bankName: isBankMethod(dto.method) ? (dto.bankName ?? null) : null,
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
        toBank: isBankMethod(dto.method), createdBy: user?.name ?? user?.email ?? null,
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

    // La reversa de abajo es el mismo read-modify-write sobre `paidAmount` que hace
    // `collect`, así que necesita el mismo bloqueo: sin él, anular un pago a la vez
    // que se registra otro se pisan y la factura queda con un saldo que no cuadra.
    // Se coge ANTES de tocar nada, y `FacturasService.voidInvoice` llama aquí antes
    // de actualizar la factura, así que el orden es siempre Subscriber -> SubInvoice
    // en los dos caminos: no hay ciclo de bloqueos.
    if (t.subscriberId) await this.lockSubscriber(tx, t.subscriberId);

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
    // Igual que en el ingreso: se valida antes de crear. Si no, un id de cliente
    // inexistente revienta como violación de clave foránea (error 500 opaco) en
    // vez de un 404 legible.
    if (dto.subscriberId) {
      const sub = await this.prisma.subscriber.findUnique({ where: { id: dto.subscriberId }, select: { id: true } });
      if (!sub) throw new NotFoundException('Cliente no encontrado');
    }
    const when = dto.date ? dateOnly(dto.date) : dateOnly(new Date().toISOString());
    const result = await this.prisma.$transaction(async (tx) => {
      const t = await tx.transaction.create({
        data: {
          type: 'EXPENSE', category: dto.category, debit: amount, credit: 0,
          payerName: dto.payerName ?? null,
          subscriberId: dto.subscriberId ?? null,
          method: dto.method,
          date: when,
          cashAccountId: dto.cashAccountId ?? null, accountName: dto.accountName ?? null,
          bankName: isBankMethod(dto.method) ? (dto.bankName ?? null) : null,
          ext: true, status: 'VIGENTE', note: dto.note ?? null,
          issuerUserId: null,
        },
      });
      await this.recomputeCashBalance(tx, dto.cashAccountId);
      // Ojo: NO se recalcula el saldo del cliente. El egreso nace `ext: true` y
      // `recomputeSubscriber` solo suma movimientos `ext: false`, así que ligar el
      // cliente aquí es informativo (deja constancia de a quién se le pagó) y no
      // le mueve la cartera. El ingreso sí la mueve porque nace `ext: false`.
      return { id: t.id, amount };
    });
    // Contabilización automática (DR gasto, CR banco/caja).
    await this.posting.postTreasuryExpense({
      sourceId: result.id, date: when, amount: result.amount, category: dto.category,
      fromBank: isBankMethod(dto.method), createdBy: user?.name ?? user?.email ?? null,
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
   *
   * Si se pasa `user`, la lista viene ACOTADA a lo que ese usuario puede ver: una cajera
   * sólo su caja + los bancos (port de `acc_list()` del legacy). Ver `caja-scope.ts`.
   */
  async cashAccounts(user?: AuthUser) {
    const alcance = user ? await alcanceDe(this.prisma, user) : null;
    // Nombre de la sede: `branchLegacy` no es una FK, se cruza a mano contra
    // `Branch.legacyId` (mismo patrón que `config.service.ts`). Verificado: es el mismo
    // espacio de ids que `accounts.sede` del legacy (3=Villanueva, 2=Yopal...).
    const sedes = await this.prisma.branch.findMany({ select: { legacyId: true, name: true } });
    const sedeDe = new Map(sedes.map((b) => [b.legacyId, b.name]));
    const nombreSede = (b: number | null) =>
      b === 0 ? 'Banco' : b == null ? null : (sedeDe.get(b) ?? `Sede ${b}`);
    const [accounts, derived] = await Promise.all([
      this.prisma.cashAccount.findMany({
        select: { id: true, legacyId: true, holder: true, balance: true, branchLegacy: true, accountNumber: true, code: true, fixedFund: true },
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
        sede: nombreSede(a.branchLegacy),
        accountNumber: a.accountNumber, code: a.code,
        fixedFund: num(a.fixedFund), persisted: true,
      }));
    // Derivadas: id presente en tx pero sin fila CashAccount.
    const seen = new Set<number>();
    for (const r of derived) {
      if (r.cashAccountId == null || known.has(r.cashAccountId) || seen.has(r.cashAccountId)) continue;
      seen.add(r.cashAccountId);
      out.push({
        id: r.cashAccountId, cuid: null as any, name: r.accountName ?? `Caja ${r.cashAccountId}`,
        balance: 0, branchLegacy: null, sede: null, accountNumber: null, code: null,
        // Sin fila CashAccount no hay fondo propio: se muestra el default.
        fixedFund: FONDO_FIJO_DEFAULT, persisted: false,
      });
    }
    const visibles = alcance
      ? out.filter((a) => puedeVer(alcance, a.id, a.branchLegacy))
      : out;
    return visibles.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * El alcance del usuario que pregunta, para que la UI se adapte sola: si es cajera se
   * le fija SU caja; si no, puede elegir sede y caja.
   */
  async miCaja(user: AuthUser) {
    const a = await alcanceDe(this.prisma, user);
    const caja = a.caja != null
      ? await this.prisma.cashAccount.findUnique({
          where: { legacyId: a.caja },
          select: { legacyId: true, holder: true, branchLegacy: true },
        })
      : null;
    return {
      /** true = puede elegir cualquier caja. false = está acotada a la suya. */
      todas: a.todas,
      esCajera: !a.todas,
      caja: caja ? { id: caja.legacyId, name: caja.holder, branchLegacy: caja.branchLegacy } : null,
      sedes: a.sedes,
    };
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
          // Omitido = el default del schema (200.000).
          ...(dto.fixedFund == null ? {} : { fixedFund: round2(dto.fixedFund) }),
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
        // Omitido = no se toca (no se pisa con el default al editar otro campo).
        ...(dto.fixedFund == null ? {} : { fixedFund: round2(dto.fixedFund) }),
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
   * Efectivo que hay en el cajón de una caja ese día, ANTES de barrerlo.
   *
   * Es la única cifra del cierre: en el legacy el excedente ES el efectivo (la base es
   * cero). El arrastre del día anterior ya viene dentro, porque entró como una
   * transacción `Saldo <fecha>` de tipo INCOME — por eso aquí no se suma nada aparte.
   */
  async efectivoDeCaja(cashAccountId: number, d: Date): Promise<number> {
    // Se traen las filas en vez de agregar en SQL porque el legacy trunca POR FILA
    // (`intval`), y un SUM() exacto no da lo mismo cuando hay centavos.
    const filas = await this.prisma.transaction.findMany({
      where: { ...whereEfectivo(cashAccountId, d), ...sinElBarridoDelDia(d) },
      select: { credit: true, debit: true },
    });
    return filas.reduce((s, f) => s + aporteEfectivo(f), 0);
  }

  /** ¿Ya se cerró esta caja este día? (la pata EXPENSE del arrastre es la marca). */
  async cierreDelDia(cashAccountId: number, d: Date) {
    return this.prisma.transaction.findFirst({
      where: {
        cashAccountId, date: rangoDia(d), type: 'EXPENSE',
        note: notaSaldo(d), status: 'VIGENTE',
      },
      select: { id: true, debit: true },
    });
  }

  /**
   * Arrastre que ENTRÓ a un día: la pata INCOME `Saldo <fecha>` que el cierre anterior
   * dejó fechada hoy. Se lee del libro, que es donde vive el arrastre en el modelo del
   * legacy — antes salía de `CashClose.surplus`, y sumar eso encima del libro contaba el
   * arrastre dos veces (la transacción YA está en el efectivo del día).
   */
  async getCarryover(cashAccountId: number, date: string): Promise<{ carryover: number; from: Date | null }> {
    const d = dateOnly(date);
    const candidatas = await this.prisma.transaction.findMany({
      where: { ...whereArrastre, cashAccountId, date: rangoDia(d), type: 'INCOME' },
      select: { credit: true, note: true },
    });
    // `esNotaSaldo` es lo que descarta los "Saldo de mano de obra..." y demás gastos
    // corrientes que empiezan igual pero no son arrastre.
    const entrada = candidatas.find((t) => esNotaSaldo(t.note));
    if (!entrada) return { carryover: 0, from: null };
    // La nota lleva la fecha del cierre que lo generó: 'Saldo 2026-07-16'.
    const from = new Date(`${entrada.note!.slice(6)}T00:00:00.000Z`);
    return { carryover: round2(num(entrada.credit)), from };
  }

  /**
   * Sugerencia de apertura para una caja/fecha: fondo fijo + arrastre del día anterior.
   *
   * OJO: el fondo fijo es una función PROPIA de SAVES (la apertura de caja no existe en
   * el legacy). El CIERRE no lo usa: allá la base es cero y se barre el efectivo entero.
   */
  async cashOpenSuggest(cashAccountId: number, date: string) {
    const [{ carryover, from }, existing, fondoFijo] = await Promise.all([
      this.getCarryover(cashAccountId, date),
      this.getCashOpen(cashAccountId, date),
      fondoFijoDe(this.prisma, cashAccountId),
    ]);
    return {
      fondoFijo,
      carryover,
      carryoverFrom: from,
      base: round2(fondoFijo + carryover),
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

  /**
   * Cierre de caja — réplica del legacy `Reports.php::sacar_pdf()` (~619-670).
   *
   * Barre el efectivo del cajón y lo arrastra al próximo día hábil escribiendo las dos
   * patas `Saldo <fecha>`. No hay base ni fondo fijo: el legacy se lleva todo (ver
   * `cierre-legacy.ts`). No escribe nada si el excedente no es > 0, y si el día ya está
   * cerrado no vuelve a escribir (guarda anti-duplicado del legacy).
   */
  async createCashClose(dto: CashCloseDto, user: AuthUser) {
    // Una cajera no puede cerrar la caja de otra sede.
    await exigirAcceso(this.prisma, user, dto.cashAccountId);
    const d = dateOnly(dto.date);
    const cuenta = await this.prisma.cashAccount.findUnique({
      where: { legacyId: dto.cashAccountId },
      select: { holder: true },
    });
    if (!cuenta) throw new NotFoundException('Caja no encontrada');

    const [efectivo, yaCerrado] = await Promise.all([
      this.efectivoDeCaja(dto.cashAccountId, d),
      this.cierreDelDia(dto.cashAccountId, d),
    ]);
    const habil = proximoDiaHabil(d);
    const base = { cashAccountId: dto.cashAccountId, date: d, accountName: cuenta.holder, excedente: efectivo, proximoDiaHabil: habil };

    // Ya cerrado: el legacy no reescribe (evita duplicar el arrastre). Devolvemos el
    // excedente que se barrió entonces, no el de ahora.
    if (yaCerrado) {
      return { ...base, excedente: round2(num(yaCerrado.debit)), escrito: false, motivo: 'ya-cerrado' as const };
    }
    // El legacy sólo arrastra saldos positivos. Un cajón vacío (o en negativo por un
    // descuadre) no genera movimiento: no hay nada que llevar al día siguiente.
    if (efectivo <= 0) {
      return { ...base, escrito: false, motivo: 'sin-excedente' as const };
    }

    const comun = {
      cashAccountId: dto.cashAccountId,
      accountName: cuenta.holder,
      category: CATEGORIA_SALDO,
      method: 'Cash',
      payerName: user.name || user.email, // legacy: `payer` = nombre del cajero
      note: notaSaldo(d), // ambas patas llevan la fecha del cierre
      status: 'VIGENTE' as const,
      ext: false,
      issuerUserId: null,
      invoiceId: null, // legacy `tid = -1` (sin factura)
    };

    // Las dos patas van juntas o no va ninguna: media pareja descuadraría la caja.
    await this.prisma.$transaction([
      this.prisma.transaction.create({
        data: { ...comun, type: 'EXPENSE', debit: efectivo, credit: 0, date: d },
      }),
      this.prisma.transaction.create({
        data: { ...comun, type: 'INCOME', debit: 0, credit: efectivo, date: habil },
      }),
    ]);

    return { ...base, escrito: true, motivo: null };
  }
}
