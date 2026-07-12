import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { SiigoClient } from './siigo-client';

/**
 * Emisión REAL de factura electrónica ante la DIAN vía Siigo.
 * Porta el flujo de `FacturasElectronicas.php`: resuelve la cuenta Siigo
 * (Vestel TV / Internet), arma el payload desde la SubInvoice, lo envía y
 * persiste el CUFE + PDF en `ElectronicInvoice`.
 *
 * ⚠️ Emitir una e-factura ante la DIAN es un acto legal e irreversible. Por eso
 * opera en DRY-RUN por defecto (arma y devuelve el payload sin enviar). Para
 * emitir de verdad hay que arrancar el backend con EINVOICE_LIVE=true y tener
 * la cuenta Siigo configurada (documentId, sellerId, ivaTaxId, medio de pago).
 */
@Injectable()
export class EinvoiceEmitService {
  private readonly logger = new Logger('EinvoiceEmit');
  private readonly live = process.env.EINVOICE_LIVE === 'true';

  constructor(private prisma: PrismaService) {}

  get isLive() {
    return this.live;
  }

  /** Resuelve la cuenta Siigo por servicio (TV/Internet); fallback: primera activa. */
  private async resolveAccount(servicesBilled?: string | null) {
    const accounts = await this.prisma.siigoAccount.findMany({ where: { active: true } });
    if (accounts.length === 0) throw new BadRequestException('No hay cuentas Siigo configuradas.');
    const wantTv = (servicesBilled ?? '').toLowerCase().includes('televi');
    const byRole = accounts.find((a) => (wantTv ? a.role === 'Tv' : a.role === 'Internet'));
    return byRole ?? accounts.find((a) => a.role === 'Internet') ?? accounts[0];
  }

  /** Token vigente de la cuenta (renovando si venció y estamos en LIVE). */
  private async ensureToken(account: any): Promise<string> {
    const now = Date.now();
    const valid = account.token && account.tokenExpires && new Date(account.tokenExpires).getTime() > now + 60_000;
    if (valid) return account.token;
    if (!this.live) return account.token ?? 'DRY_RUN_NO_TOKEN';
    const client = new SiigoClient(account.authUrl, account.apiBaseUrl);
    const auth = await client.authenticate(account.username, account.accessKey);
    const expires = new Date(now + (auth.expires_in ?? 86400) * 1000);
    await this.prisma.siigoAccount.update({
      where: { id: account.id },
      data: { token: auth.access_token, tokenExpires: expires },
    });
    return auth.access_token;
  }

  /** Construye el cuerpo de factura Siigo desde la SubInvoice. */
  private buildPayload(account: any, invoice: any, subscriber: any) {
    const docId = subscriber?.docNumber || subscriber?.legacyId?.toString() || '0';
    const items = (invoice.items ?? []).map((it: any) => {
      const item: any = {
        code: it.productId ? String(it.productId) : (account.defaultItemCode ?? 'GEN'),
        description: it.description || it.productName || 'Servicio',
        quantity: Number(it.qty) || 1,
        price: Number(it.price) || 0,
      };
      if (account.ivaTaxId && Number(it.taxRate) > 0) {
        item.taxes = [{ id: account.ivaTaxId }];
      }
      return item;
    });
    const total = Number(invoice.total) || items.reduce((s: number, i: any) => s + i.price * i.quantity, 0);
    // Medio de pago: crédito si el cliente está marcado como crédito y la cuenta
    // tiene ese medio configurado; si no, contado (efectivo). Porta get_m_pago_f_e.
    const isCredit = subscriber?.eInvoicePayMethod === 'CREDITO' && !!account.paymentCredIt;
    const paymentId = isCredit ? account.paymentCredIt : (account.paymentCash ?? null);
    const payload: any = {
      document: { id: account.documentId ?? null },
      date: new Date(invoice.invoiceDate).toISOString().slice(0, 10),
      customer: { identification: docId, branch_office: 0 },
      seller: account.sellerId ?? null,
      items,
      payments: [{ id: paymentId, value: total }],
    };
    if (account.contactEmail) payload.mail = { send: false };
    return payload;
  }

  /** Construye el payload de NOTA CRÉDITO referenciando la factura Siigo original. */
  private buildCreditNotePayload(account: any, invoice: any, subscriber: any, siigoInvoiceId: string, reason: string, causeCode: number) {
    const base = this.buildPayload(account, invoice, subscriber);
    return {
      ...base,
      document: { id: account.creditNoteDocumentId ?? account.documentId ?? null },
      invoice: siigoInvoiceId, // uuid de la factura original en Siigo
      cause: causeCode, // 1=Devolución, 2=Anulación, 3=Rebaja, 4=Otros (DIAN)
      reason: reason?.slice(0, 250) || 'Anulación de factura',
    };
  }

  /** Emite (o simula) la e-factura de una SubInvoice. */
  async emit(subInvoiceId: string, user?: AuthUser) {
    const invoice = await this.prisma.subInvoice.findUnique({
      where: { id: subInvoiceId },
      include: { items: true, subscriber: true },
    });
    if (!invoice) throw new NotFoundException('Factura no encontrada');

    // ¿ya emitida?
    const existing = await this.prisma.electronicInvoice.findFirst({
      where: { invoiceId: subInvoiceId, dianNumber: { not: null } },
    });
    if (existing) {
      throw new BadRequestException(`La factura ya fue emitida ante la DIAN (${existing.dianNumber}).`);
    }

    const servicesBilled = invoice.serviceCombo ? 'Internet' : invoice.serviceTv ? 'Television' : null;
    const account = await this.resolveAccount(servicesBilled);
    const payload = this.buildPayload(account, invoice, invoice.subscriber);

    if (!this.live) {
      return {
        ok: true,
        dryRun: true,
        account: { role: account.role, username: account.username },
        message: 'DRY-RUN: payload construido, NO se envió a la DIAN. Active EINVOICE_LIVE=true para emitir.',
        configReady: !!(account.documentId && account.sellerId && account.ivaTaxId && account.paymentCash),
        payload,
      };
    }

    // --- LIVE ---
    if (!(account.documentId && account.sellerId && account.paymentCash)) {
      throw new BadRequestException(
        'La cuenta Siigo no está configurada para emitir (faltan documentId / sellerId / medio de pago). Configúrela primero.',
      );
    }
    const token = await this.ensureToken(account);
    const client = new SiigoClient(account.authUrl, account.apiBaseUrl);
    const result = await client.createInvoice(token, payload);

    // Persistir el resultado en ElectronicInvoice
    const ei = await this.prisma.electronicInvoice.create({
      data: {
        siigoAccountId: account.id,
        subscriberId: invoice.subscriberId,
        invoiceId: invoice.id,
        date: new Date(invoice.invoiceDate),
        executedAt: new Date(),
        servicesBilled,
        type: result.ok ? 'FACTURADA' : 'ERROR',
        payloadJson: JSON.stringify({ payload, response: result.raw }).slice(0, 20000),
        siigoInvoiceId: result.id ?? null,
        dianNumber: result.number ?? null,
        cufe: result.cufe ?? null,
        pdfUrl: result.pdfUrl ?? null,
        errorMessage: result.ok ? null : (result.error ?? 'Error desconocido'),
      } as any,
    });
    if (!result.ok) {
      this.logger.warn(`Emisión fallida factura ${invoice.tid}: ${result.error}`);
      throw new BadRequestException(`Siigo rechazó la factura: ${result.error}`);
    }
    // Marcar la factura como timbrada para que su estado no siga diciendo "pendiente".
    await this.prisma.subInvoice.update({
      where: { id: invoice.id },
      data: { eInvoiceFlag: 'Factura Electronica Creada', eInvoiceGenDate: new Date(), eInvoiceServices: servicesBilled },
    });
    this.logger.log(`E-factura emitida: tid ${invoice.tid} → DIAN ${result.number}`);
    return {
      ok: true,
      dryRun: false,
      electronicInvoiceId: ei.id,
      dianNumber: result.number,
      cufe: result.cufe,
      pdfUrl: result.pdfUrl,
      message: `Factura emitida ante la DIAN: ${result.number}`,
    };
  }

  /**
   * Emite (o simula) una NOTA CRÉDITO electrónica ante la DIAN para una factura
   * que YA fue emitida. Referencia la factura Siigo original y persiste el
   * resultado como ElectronicInvoice tipo NOTA_CREDITO. Porta get_invoice_credito.
   */
  async emitCreditNote(subInvoiceId: string, reason: string, causeCode = 2, user?: AuthUser) {
    const invoice = await this.prisma.subInvoice.findUnique({
      where: { id: subInvoiceId },
      include: { items: true, subscriber: true },
    });
    if (!invoice) throw new NotFoundException('Factura no encontrada');

    // La factura debe haber sido emitida ante la DIAN (tener uuid Siigo).
    const emitted = await this.prisma.electronicInvoice.findFirst({
      where: { invoiceId: subInvoiceId, type: 'FACTURADA', siigoInvoiceId: { not: null } },
      orderBy: { createdAt: 'desc' },
    });
    if (!emitted?.siigoInvoiceId) {
      throw new BadRequestException('La factura no ha sido emitida ante la DIAN; no se puede crear una nota crédito.');
    }
    // ¿ya tiene nota crédito emitida?
    const existingNC = await this.prisma.electronicInvoice.findFirst({
      where: { invoiceId: subInvoiceId, type: 'NOTA_CREDITO', dianNumber: { not: null } },
    });
    if (existingNC) throw new BadRequestException(`La factura ya tiene una nota crédito (${existingNC.dianNumber}).`);

    const account = emitted.siigoAccountId
      ? await this.prisma.siigoAccount.findUnique({ where: { id: emitted.siigoAccountId } })
      : await this.resolveAccount(emitted.servicesBilled);
    if (!account) throw new BadRequestException('No se pudo resolver la cuenta Siigo de la factura original.');

    const payload = this.buildCreditNotePayload(account, invoice, invoice.subscriber, emitted.siigoInvoiceId, reason, causeCode);

    if (!this.live) {
      return {
        ok: true, dryRun: true,
        message: 'DRY-RUN: nota crédito construida, NO se envió a la DIAN. Active EINVOICE_LIVE=true para emitir.',
        configReady: !!(account.creditNoteDocumentId && account.sellerId),
        payload,
      };
    }

    if (!account.creditNoteDocumentId) {
      throw new BadRequestException('La cuenta Siigo no tiene configurado el comprobante de NOTA CRÉDITO (creditNoteDocumentId).');
    }
    const token = await this.ensureToken(account);
    const client = new SiigoClient(account.authUrl, account.apiBaseUrl);
    const result = await client.createCreditNote(token, payload);

    const ei = await this.prisma.electronicInvoice.create({
      data: {
        siigoAccountId: account.id,
        subscriberId: invoice.subscriberId,
        invoiceId: invoice.id,
        date: new Date(),
        executedAt: new Date(),
        servicesBilled: emitted.servicesBilled,
        type: result.ok ? 'NOTA_CREDITO' : 'ERROR',
        payloadJson: JSON.stringify({ payload, response: result.raw }).slice(0, 20000),
        siigoInvoiceId: result.id ?? null,
        dianNumber: result.number ?? null,
        cufe: result.cufe ?? null,
        pdfUrl: result.pdfUrl ?? null,
        errorMessage: result.ok ? null : (result.error ?? 'Error desconocido'),
      } as any,
    });
    if (!result.ok) {
      this.logger.warn(`Nota crédito fallida factura ${invoice.tid}: ${result.error}`);
      throw new BadRequestException(`Siigo rechazó la nota crédito: ${result.error}`);
    }
    this.logger.log(`Nota crédito emitida: tid ${invoice.tid} → DIAN ${result.number}`);
    return {
      ok: true, dryRun: false, electronicInvoiceId: ei.id,
      dianNumber: result.number, cufe: result.cufe, pdfUrl: result.pdfUrl,
      message: `Nota crédito emitida ante la DIAN: ${result.number}`,
    };
  }

  /**
   * Reintenta una e-factura que quedó en ERROR: reemite su factura asociada.
   * En LIVE borra el registro errado ANTES de reemitir (la reemisión crea uno
   * nuevo con el resultado), para no acumular duplicados. En dry-run solo simula.
   */
  async retry(electronicInvoiceId: string, user?: AuthUser) {
    const ei = await this.prisma.electronicInvoice.findUnique({
      where: { id: electronicInvoiceId },
      select: { id: true, invoiceId: true, type: true },
    });
    if (!ei) throw new NotFoundException('Factura electrónica no encontrada');
    if (!ei.invoiceId) {
      throw new BadRequestException('Esta factura electrónica no tiene factura asociada para reintentar.');
    }
    if (this.live && ei.type === 'ERROR') {
      await this.prisma.electronicInvoice.delete({ where: { id: ei.id } });
    }
    return this.emit(ei.invoiceId, user);
  }

  /**
   * Emite (o simula) EN LOTE las facturas pendientes por timbrar de una sede:
   * facturas con flag "Crear Factura Electronica" de clientes de la sede que están
   * marcados para e-factura (eInvoice=true). El servicio (TV/Internet) de cada
   * factura decide su cuenta Siigo. Procesa de a `limit` y avisa si quedan más.
   */
  async emitBranch(branchId: string, user?: AuthUser, limit = 100) {
    const pending = await this.prisma.subInvoice.findMany({
      where: {
        eInvoiceFlag: 'Crear Factura Electronica',
        subscriber: { is: { branchId, eInvoice: true } },
      },
      select: { id: true, tid: true },
      orderBy: { invoiceDate: 'desc' },
      take: limit + 1,
    });
    const hasMore = pending.length > limit;
    const batch = pending.slice(0, limit);
    let ok = 0;
    let failed = 0;
    let configReady = true;
    const errors: { tid: number; error: string }[] = [];
    for (const inv of batch) {
      try {
        const r: any = await this.emit(inv.id, user);
        if (r?.dryRun && r.configReady === false) configReady = false;
        if (r?.ok) ok++;
      } catch (e: any) {
        failed++;
        if (errors.length < 8) errors.push({ tid: inv.tid, error: e?.message ?? 'Error' });
      }
    }
    return {
      dryRun: !this.live,
      configReady,
      processed: batch.length,
      ok,
      failed,
      hasMore,
      errors,
      message: !this.live
        ? `DRY-RUN: se construyeron ${ok} payload(s) de la sede; no se envió nada a la DIAN.`
        : `Emitidas ${ok} factura(s) de la sede ante la DIAN${failed ? `, ${failed} con error` : ''}.`,
    };
  }
}
