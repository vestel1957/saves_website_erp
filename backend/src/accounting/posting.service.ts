import { Injectable, Logger } from '@nestjs/common';
import { JournalService } from './journal.service';
import { MappingsService } from './mappings.service';
import { round2 } from '../common/money';


/**
 * Contabilización automática de documentos origen (integraciones básicas).
 *
 * Otros módulos (facturación, compras, tesorería) inyectan este servicio y llaman
 * al método correspondiente cuando emiten/pagan un documento. Cada asiento es
 * idempotente por (sourceType, sourceId): reintentar no duplica.
 *
 * Diseñado para NO romper el flujo de negocio: si falta un mapeo o algo falla,
 * se registra el error y se devuelve null (el documento se emite igual; el asiento
 * puede regenerarse luego desde Contabilidad).
 */
@Injectable()
export class PostingService {
  private readonly log = new Logger(PostingService.name);

  constructor(
    private readonly journal: JournalService,
    private readonly mappings: MappingsService,
  ) {}

  private async safePost(fn: () => Promise<any>): Promise<any | null> {
    try {
      return await fn();
    } catch (e) {
      this.log.warn(`No se pudo contabilizar automáticamente: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Factura de venta: CxC a débito; ingreso e IVA generado a crédito.
   *   DR SALES_AR (subtotal + iva)
   *   CR SALES_REVENUE (subtotal)
   *   CR SALES_TAX (iva)
   */
  async postSalesInvoice(p: {
    sourceId: string; date: Date; number: string | number; subtotal: number; tax?: number;
    costCenterId?: string | null; createdBy?: string | null;
  }) {
    return this.safePost(async () => {
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
      return this.journal.post({
        date: p.date, description: `Factura de venta ${p.number}`, reference: String(p.number),
        type: 'AUTOMATIC', sourceType: 'SALES_INVOICE', sourceId: p.sourceId, createdBy: p.createdBy ?? null, lines,
      });
    });
  }

  /**
   * Recaudo de factura (cliente paga): banco/caja a débito; CxC a crédito.
   */
  async postCustomerPayment(p: {
    sourceId: string; date: Date; amount: number; toBank?: boolean; createdBy?: string | null;
  }) {
    return this.safePost(async () => {
      const amount = round2(p.amount);
      if (amount <= 0) return null;
      const cashKey = p.toBank === false ? 'CASH_DEFAULT' : 'BANK_DEFAULT';
      const m = await this.mappings.resolveMany([cashKey, 'SALES_AR']);
      return this.journal.post({
        date: p.date, description: `Recaudo de cliente`, type: 'AUTOMATIC',
        sourceType: 'CUSTOMER_PAYMENT', sourceId: p.sourceId, createdBy: p.createdBy ?? null,
        lines: [
          { accountId: m[cashKey], debit: amount, credit: 0 },
          { accountId: m['SALES_AR'], debit: 0, credit: amount },
        ],
      });
    });
  }

  /**
   * Factura de proveedor: gasto/compra e IVA descontable a débito; CxP a crédito.
   */
  async postPurchaseBill(p: {
    sourceId: string; date: Date; number: string | number; subtotal: number; tax?: number;
    costCenterId?: string | null; createdBy?: string | null;
  }) {
    return this.safePost(async () => {
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
      return this.journal.post({
        date: p.date, description: `Factura de compra ${p.number}`, reference: String(p.number),
        type: 'AUTOMATIC', sourceType: 'PURCHASE_BILL', sourceId: p.sourceId, createdBy: p.createdBy ?? null, lines,
      });
    });
  }

  /**
   * Pago a proveedor: CxP a débito; banco/caja a crédito.
   */
  async postSupplierPayment(p: {
    sourceId: string; date: Date; amount: number; fromBank?: boolean; createdBy?: string | null;
  }) {
    return this.safePost(async () => {
      const amount = round2(p.amount);
      if (amount <= 0) return null;
      const cashKey = p.fromBank === false ? 'CASH_DEFAULT' : 'BANK_DEFAULT';
      const m = await this.mappings.resolveMany([cashKey, 'PURCHASE_AP']);
      return this.journal.post({
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
  async postTreasuryExpense(p: {
    sourceId: string; date: Date; amount: number; category?: string | null; fromBank?: boolean; createdBy?: string | null;
  }) {
    return this.safePost(async () => {
      const amount = round2(p.amount);
      if (amount <= 0) return null;
      const cashKey = p.fromBank === false ? 'CASH_DEFAULT' : 'BANK_DEFAULT';
      const m = await this.mappings.resolveMany(['PURCHASE_EXPENSE', cashKey]);
      return this.journal.post({
        date: p.date, description: p.category ? `Egreso — ${p.category}` : 'Egreso de tesorería',
        type: 'AUTOMATIC', sourceType: 'TREASURY_EXPENSE', sourceId: p.sourceId, createdBy: p.createdBy ?? null,
        lines: [
          { accountId: m['PURCHASE_EXPENSE'], debit: amount, credit: 0 },
          { accountId: m[cashKey], debit: 0, credit: amount },
        ],
      });
    });
  }

  /**
   * Ingreso libre de tesorería (no ligado a una factura de venta):
   *   DR banco/caja
   *   CR SALES_REVENUE (ingreso por defecto)
   */
  async postTreasuryIncome(p: {
    sourceId: string; date: Date; amount: number; category?: string | null; toBank?: boolean; createdBy?: string | null;
  }) {
    return this.safePost(async () => {
      const amount = round2(p.amount);
      if (amount <= 0) return null;
      const cashKey = p.toBank === false ? 'CASH_DEFAULT' : 'BANK_DEFAULT';
      const m = await this.mappings.resolveMany([cashKey, 'SALES_REVENUE']);
      return this.journal.post({
        date: p.date, description: p.category ? `Ingreso — ${p.category}` : 'Ingreso de tesorería',
        type: 'AUTOMATIC', sourceType: 'TREASURY_INCOME', sourceId: p.sourceId, createdBy: p.createdBy ?? null,
        lines: [
          { accountId: m[cashKey], debit: amount, credit: 0 },
          { accountId: m['SALES_REVENUE'], debit: 0, credit: amount },
        ],
      });
    });
  }
}
