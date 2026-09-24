import { NotFoundException } from '../core/http/errores';
import { Logger } from '../core/logger';
import { Prisma } from '@prisma/client';
import { JournalService, type PostEntryInput } from './journal.service';
import { MappingsService } from './mappings.service';
import { PrismaService } from '../prisma/prisma.service';
import { round2 } from '../common/money';
import { centroDeAbonado, centroDeTesoreria, centroSinFallar } from '../common/centro-costo';

type SalesInvoiceArgs = {
  sourceId: string; date: Date; number: string | number; subtotal: number; tax?: number;
  costCenterId?: string | null; createdBy?: string | null;
};
type SalesInvoiceAdjustmentArgs = {
  sourceId: string; date: Date; number: string | number; edit: number;
  deltaSubtotal: number; deltaTax?: number;
  costCenterId?: string | null; createdBy?: string | null;
};
type CustomerPaymentArgs = {
  sourceId: string; date: Date; amount: number; toBank?: boolean;
  costCenterId?: string | null; createdBy?: string | null;
};
type PurchaseBillArgs = {
  sourceId: string; date: Date; number: string | number; subtotal: number; tax?: number;
  costCenterId?: string | null; createdBy?: string | null;
};
type SupplierPaymentArgs = {
  sourceId: string; date: Date; amount: number; fromBank?: boolean; createdBy?: string | null;
};
type TreasuryExpenseArgs = {
  sourceId: string; date: Date; amount: number; category?: string | null; fromBank?: boolean;
  costCenterId?: string | null; createdBy?: string | null;
};
type TreasuryIncomeArgs = {
  sourceId: string; date: Date; amount: number; category?: string | null; toBank?: boolean;
  costCenterId?: string | null; createdBy?: string | null;
};

/**
 * Contabilización automática de documentos origen (integraciones básicas).
 *
 * Otros módulos (facturación, compras, tesorería) inyectan este servicio y llaman
 * al método correspondiente cuando emiten/pagan un documento. Cada asiento es
 * idempotente por (sourceType, sourceId): reintentar no duplica.
 *
 * Diseñado para NO romper el flujo de negocio: si falta un mapeo o algo falla, el
 * documento se emite igual y aquí se devuelve null. La diferencia con antes es que
 * el fallo **deja rastro**: se registra en `PendingPosting` con los argumentos
 * originales, así que se puede listar qué quedó sin contabilizar y reintentarlo.
 * Antes sólo había un `log.warn` y no había forma de saber cuáles eran.
 */
export class PostingService {
  private readonly log = new Logger(PostingService.name);

  constructor(
    private readonly journal: JournalService,
    private readonly mappings: MappingsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Ejecuta la contabilización sin dejar que su fallo rompa el flujo de negocio,
   * pero registrando el pendiente.
   *
   * El registro del pendiente va en su propio try/catch: si hasta eso falla, se
   * loguea y se sigue. Nunca puede tumbar la emisión de una factura.
   */
  private async safePost<T>(
    sourceType: string,
    sourceId: string,
    payload: unknown,
    fn: () => Promise<T>,
  ): Promise<T | null> {
    try {
      const res = await fn();
      await this.marcarResuelto(sourceType, sourceId);
      return res;
    } catch (e) {
      const msg = (e as Error).message;
      this.log.warn(`No se pudo contabilizar ${sourceType}/${sourceId}: ${msg}`);
      try {
        await this.prisma.pendingPosting.upsert({
          where: { sourceType_sourceId: { sourceType, sourceId } },
          create: {
            sourceType, sourceId,
            payload: payload as Prisma.InputJsonValue,
            error: msg,
          },
          update: {
            error: msg,
            attempts: { increment: 1 },
            resolvedAt: null,
            payload: payload as Prisma.InputJsonValue,
          },
        });
      } catch (e2) {
        this.log.error(`Tampoco se pudo registrar el pendiente contable: ${(e2 as Error).message}`);
      }
      return null;
    }
  }

  /** Si el documento tenía un pendiente, marcarlo resuelto (se conserva la traza). */
  private async marcarResuelto(sourceType: string, sourceId: string) {
    try {
      await this.prisma.pendingPosting.updateMany({
        where: { sourceType, sourceId, resolvedAt: null },
        data: { resolvedAt: new Date() },
      });
    } catch {
      /* no es crítico: el asiento ya quedó hecho */
    }
  }

  // --- Centro de costo (docs/centros-de-costo/PLAN.md, fase 3) ---
  //
  // Quien contabiliza pide aquí el centro y lo pasa en `costCenterId`. Ninguno de los dos
  // lanza: si el resolver falla, el asiento sale igual con null («Sin asignar») y un aviso.

  /** Centro de la sede del abonado (facturas, ajustes y recaudos). */
  centroDeAbonado(subscriberId: string | null | undefined): Promise<string | null> {
    return centroSinFallar(() => centroDeAbonado(this.prisma, subscriberId), `abonado ${subscriberId}`);
  }

  /**
   * Ingreso o egreso de tesorería: el centro que eligió el usuario (validado antes por quien
   * llama) o, si no eligió, el de la sede de la caja; la caja de banco va a Administración general.
   */
  async centroDeTesoreria(cashAccountLegacyId: number | null | undefined, elegido?: string | null): Promise<string | null> {
    if (elegido) return elegido;
    return centroSinFallar(() => centroDeTesoreria(this.prisma, cashAccountLegacyId), `caja ${cashAccountLegacyId}`);
  }

  /**
   * `journal.post` con red: si el asiento lleva centro y la base lo rechaza por clave
   * foránea (un centro que ya no existe, p. ej. al reintentar un pendiente viejo), se
   * contabiliza igual sin centro. Contabilizar nunca debe fallar por el centro de costo.
   */
  private async asentar(input: PostEntryInput) {
    try {
      return await this.journal.post(input);
    } catch (e) {
      const conCentro = input.lines.some((l) => l.costCenterId);
      if (!conCentro || (e as { code?: string })?.code !== 'P2003') throw e;
      console.warn(
        `[centro-costo] ${input.sourceType}/${input.sourceId}: la base rechazó el centro de costo; se contabiliza sin centro.`,
      );
      return this.journal.post({ ...input, lines: input.lines.map((l) => ({ ...l, costCenterId: null })) });
    }
  }

  // --- Consulta y reintento de pendientes ---

  /** Documentos que quedaron sin asiento. Por defecto sólo los no resueltos. */
  async listPending(params: { incluirResueltos?: boolean } = {}) {
    return this.prisma.pendingPosting.findMany({
      where: params.incluirResueltos ? {} : { resolvedAt: null },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
  }

  /**
   * Reintenta un pendiente con los argumentos guardados. `date` vuelve de JSON como
   * cadena ISO, así que hay que revivirla antes de reenviar.
   */
  async retryPending(id: string) {
    const p = await this.prisma.pendingPosting.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Pendiente contable no encontrado');

    const args = { ...(p.payload as Record<string, unknown>) } as { date?: unknown };
    if (typeof args.date === 'string') args.date = new Date(args.date);

    const post = this.despachador(p.sourceType);
    if (!post) {
      return { id, ok: false, error: `No sé reintentar un ${p.sourceType}` };
    }
    const res = await post(args as never);
    return { id, ok: res !== null };
  }

  /** Mapa sourceType -> método, para el reintento. */
  private despachador(sourceType: string): ((a: never) => Promise<unknown>) | null {
    const mapa: Record<string, (a: never) => Promise<unknown>> = {
      SALES_INVOICE: (a) => this.postSalesInvoice(a),
      SALES_INVOICE_ADJ: (a) => this.postSalesInvoiceAdjustment(a),
      CUSTOMER_PAYMENT: (a) => this.postCustomerPayment(a),
      PURCHASE_BILL: (a) => this.postPurchaseBill(a),
      SUPPLIER_PAYMENT: (a) => this.postSupplierPayment(a),
      TREASURY_EXPENSE: (a) => this.postTreasuryExpense(a),
      TREASURY_INCOME: (a) => this.postTreasuryIncome(a),
    };
    return mapa[sourceType] ?? null;
  }

  // --- Asientos ---

  /**
   * Factura de venta: CxC a débito; ingreso e IVA generado a crédito.
   *   DR SALES_AR (subtotal + iva)
   *   CR SALES_REVENUE (subtotal)
   *   CR SALES_TAX (iva)
   */
  async postSalesInvoice(p: SalesInvoiceArgs) {
    return this.safePost('SALES_INVOICE', p.sourceId, p, async () => {
      const subtotal = round2(p.subtotal);
      const tax = round2(p.tax ?? 0);
      const total = round2(subtotal + tax);
      if (total <= 0) return null;
      const m = await this.mappings.resolveMany(tax > 0 ? ['SALES_AR', 'SALES_REVENUE', 'SALES_TAX'] : ['SALES_AR', 'SALES_REVENUE']);
      const lines = [
        { accountId: m['SALES_AR'], debit: total, credit: 0, costCenterId: p.costCenterId ?? null },
        { accountId: m['SALES_REVENUE'], debit: 0, credit: subtotal, costCenterId: p.costCenterId ?? null },
      ];
      if (tax > 0) lines.push({ accountId: m['SALES_TAX'], debit: 0, credit: tax, costCenterId: p.costCenterId ?? null });
      return this.asentar({
        date: p.date, description: `Factura de venta ${p.number}`, reference: String(p.number),
        type: 'AUTOMATIC', sourceType: 'SALES_INVOICE', sourceId: p.sourceId, createdBy: p.createdBy ?? null, lines,
      });
    });
  }

  /**
   * Ajuste por EDICIÓN de una factura de venta: contabiliza sólo el DELTA contra el
   * asiento original, en vez de reversarlo y volverlo a emitir.
   *
   * Por qué el delta y no un reverso: el asiento original es idempotente por
   * (sourceType, sourceId), así que un re-post después del reverso devolvería el
   * asiento reversado en lugar de crear el nuevo, y la factura quedaría sin
   * contabilizar. El delta además deja el rastro de qué cambió y cuándo, que es lo
   * que pide una factura que ya salió.
   *
   * `edit` (el número de edición) entra en el sourceId para que la segunda edición
   * no choque con la primera y siga siendo idempotente por edición.
   */
  async postSalesInvoiceAdjustment(p: SalesInvoiceAdjustmentArgs) {
    const sourceId = `${p.sourceId}#${p.edit}`;
    return this.safePost('SALES_INVOICE_ADJ', sourceId, p, async () => {
      const dSubtotal = round2(p.deltaSubtotal);
      const dTax = round2(p.deltaTax ?? 0);
      const dTotal = round2(dSubtotal + dTax);
      if (dSubtotal === 0 && dTax === 0) return null;
      // Sin asiento original no hay nada que ajustar: las facturas traídas del legacy
      // no se contabilizaron aquí, y colgarles sólo el delta dejaría el mayor con un
      // ajuste que no corresponde a ningún ingreso registrado.
      const original = await this.prisma.journalEntry.findUnique({
        where: { sourceType_sourceId: { sourceType: 'SALES_INVOICE', sourceId: p.sourceId } },
        select: { id: true },
      });
      if (!original) return null;
      const m = await this.mappings.resolveMany(
        dTax !== 0 ? ['SALES_AR', 'SALES_REVENUE', 'SALES_TAX'] : ['SALES_AR', 'SALES_REVENUE'],
      );
      // Un delta puede ser negativo (la factura bajó de valor) y el subtotal y el IVA
      // pueden moverse en sentidos distintos (cambió el concepto por otro con otro
      // IVA), así que cada línea elige lado por su propio signo. Cuadra siempre
      // porque dTotal = dSubtotal + dTax.
      const lado = (v: number) => ({ debit: Math.max(v, 0), credit: Math.max(-v, 0) });
      const lines = [
        { accountId: m['SALES_AR'], ...lado(dTotal), costCenterId: p.costCenterId ?? null },
        { accountId: m['SALES_REVENUE'], ...lado(-dSubtotal), costCenterId: p.costCenterId ?? null },
      ];
      if (dTax !== 0) lines.push({ accountId: m['SALES_TAX'], ...lado(-dTax), costCenterId: p.costCenterId ?? null });
      return this.asentar({
        date: p.date, description: `Ajuste por edición de la factura ${p.number}`, reference: String(p.number),
        type: 'AUTOMATIC', sourceType: 'SALES_INVOICE_ADJ', sourceId,
        createdBy: p.createdBy ?? null,
        lines: lines.filter((l) => l.debit > 0 || l.credit > 0),
      });
    });
  }

  /**
   * Recaudo de factura (cliente paga): banco/caja a débito; CxC a crédito.
   */
  async postCustomerPayment(p: CustomerPaymentArgs) {
    return this.safePost('CUSTOMER_PAYMENT', p.sourceId, p, async () => {
      const amount = round2(p.amount);
      if (amount <= 0) return null;
      const cashKey = p.toBank === false ? 'CASH_DEFAULT' : 'BANK_DEFAULT';
      const m = await this.mappings.resolveMany([cashKey, 'SALES_AR']);
      return this.asentar({
        date: p.date, description: `Recaudo de cliente`, type: 'AUTOMATIC',
        sourceType: 'CUSTOMER_PAYMENT', sourceId: p.sourceId, createdBy: p.createdBy ?? null,
        lines: [
          { accountId: m[cashKey], debit: amount, credit: 0, costCenterId: p.costCenterId ?? null },
          { accountId: m['SALES_AR'], debit: 0, credit: amount, costCenterId: p.costCenterId ?? null },
        ],
      });
    });
  }

  /**
   * Factura de proveedor: gasto/compra e IVA descontable a débito; CxP a crédito.
   */
  async postPurchaseBill(p: PurchaseBillArgs) {
    return this.safePost('PURCHASE_BILL', p.sourceId, p, async () => {
      const subtotal = round2(p.subtotal);
      const tax = round2(p.tax ?? 0);
      const total = round2(subtotal + tax);
      if (total <= 0) return null;
      const m = await this.mappings.resolveMany(tax > 0 ? ['PURCHASE_AP', 'PURCHASE_EXPENSE', 'PURCHASE_TAX'] : ['PURCHASE_AP', 'PURCHASE_EXPENSE']);
      const lines = [
        { accountId: m['PURCHASE_EXPENSE'], debit: subtotal, credit: 0, costCenterId: p.costCenterId ?? null },
      ];
      if (tax > 0) lines.push({ accountId: m['PURCHASE_TAX'], debit: tax, credit: 0, costCenterId: p.costCenterId ?? null });
      lines.push({ accountId: m['PURCHASE_AP'], debit: 0, credit: total, costCenterId: p.costCenterId ?? null });
      return this.asentar({
        date: p.date, description: `Factura de compra ${p.number}`, reference: String(p.number),
        type: 'AUTOMATIC', sourceType: 'PURCHASE_BILL', sourceId: p.sourceId, createdBy: p.createdBy ?? null, lines,
      });
    });
  }

  /**
   * Pago a proveedor: CxP a débito; banco/caja a crédito.
   */
  async postSupplierPayment(p: SupplierPaymentArgs) {
    return this.safePost('SUPPLIER_PAYMENT', p.sourceId, p, async () => {
      const amount = round2(p.amount);
      if (amount <= 0) return null;
      const cashKey = p.fromBank === false ? 'CASH_DEFAULT' : 'BANK_DEFAULT';
      const m = await this.mappings.resolveMany([cashKey, 'PURCHASE_AP']);
      return this.asentar({
        date: p.date, description: `Pago a proveedor`, type: 'AUTOMATIC',
        sourceType: 'SUPPLIER_PAYMENT', sourceId: p.sourceId, createdBy: p.createdBy ?? null,
        lines: [
          { accountId: m['PURCHASE_AP'], debit: amount, credit: 0 },
          { accountId: m[cashKey], debit: 0, credit: amount },
        ],
      });
    });
  }

  /**
   * Egreso/gasto libre de tesorería (no ligado a una factura de proveedor):
   *   DR PURCHASE_EXPENSE (gasto por defecto)
   *   CR banco/caja
   */
  async postTreasuryExpense(p: TreasuryExpenseArgs) {
    return this.safePost('TREASURY_EXPENSE', p.sourceId, p, async () => {
      const amount = round2(p.amount);
      if (amount <= 0) return null;
      const cashKey = p.fromBank === false ? 'CASH_DEFAULT' : 'BANK_DEFAULT';
      const m = await this.mappings.resolveMany(['PURCHASE_EXPENSE', cashKey]);
      return this.asentar({
        date: p.date, description: p.category ? `Egreso — ${p.category}` : 'Egreso de tesorería',
        type: 'AUTOMATIC', sourceType: 'TREASURY_EXPENSE', sourceId: p.sourceId, createdBy: p.createdBy ?? null,
        lines: [
          { accountId: m['PURCHASE_EXPENSE'], debit: amount, credit: 0, costCenterId: p.costCenterId ?? null },
          { accountId: m[cashKey], debit: 0, credit: amount, costCenterId: p.costCenterId ?? null },
        ],
      });
    });
  }

  /**
   * Ingreso libre de tesorería (no ligado a una factura de venta):
   *   DR banco/caja
   *   CR SALES_REVENUE (ingreso por defecto)
   */
  async postTreasuryIncome(p: TreasuryIncomeArgs) {
    return this.safePost('TREASURY_INCOME', p.sourceId, p, async () => {
      const amount = round2(p.amount);
      if (amount <= 0) return null;
      const cashKey = p.toBank === false ? 'CASH_DEFAULT' : 'BANK_DEFAULT';
      const m = await this.mappings.resolveMany([cashKey, 'SALES_REVENUE']);
      return this.asentar({
        date: p.date, description: p.category ? `Ingreso — ${p.category}` : 'Ingreso de tesorería',
        type: 'AUTOMATIC', sourceType: 'TREASURY_INCOME', sourceId: p.sourceId, createdBy: p.createdBy ?? null,
        lines: [
          { accountId: m[cashKey], debit: amount, credit: 0, costCenterId: p.costCenterId ?? null },
          { accountId: m['SALES_REVENUE'], debit: 0, credit: amount, costCenterId: p.costCenterId ?? null },
        ],
      });
    });
  }
}
