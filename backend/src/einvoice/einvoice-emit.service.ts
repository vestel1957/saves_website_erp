import { BadRequestException, NotFoundException } from '../core/http/errores';
import { Logger } from '../core/logger';
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
    const date = new Date(invoice.invoiceDate);
    const payload: any = {
      document: { id: account.documentId ?? null },
      date: date.toISOString().slice(0, 10),
      customer: { identification: docId, branch_office: 0 },
      seller: account.sellerId ?? null,
      items,
      payments: [{
        id: paymentId,
        value: total,
        // Vencimiento del medio de pago (el legacy lo mandaba siempre).
        due_date: new Date(invoice.dueDate ?? invoice.invoiceDate).toISOString().slice(0, 10),
      }],
    };
    // Centro de costo por sede. El legacy lo ramificaba con ifs por `gid`
    // (Yopal 1074/69, Villanueva 1072/167, Monterrey 1070/165); aquí sale del mapa
    // configurable `SiigoAccount.costCenterByBranch` = {branchLegacyId: costCenterId}.
    const costCenter = this.resolveCostCenter(account, subscriber);
    if (costCenter != null) payload.cost_center = costCenter;
    // Observaciones: el legacy mandaba "Estrato : X".
    if (subscriber?.estrato) payload.observations = `Estrato : ${subscriber.estrato}`;
    if (account.contactEmail) payload.mail = { send: false };
    return payload;
  }

  /**
   * Centro de costo de la sede del cliente. `costCenterByBranch` mapea el id legacy de la
   * sede (`customers.gid`) al centro de costo de Siigo; si la sede no está en el mapa se usa
   * la clave `default` (el legacy hacía lo mismo por omisión: Mocoa caía al default).
   */
  private resolveCostCenter(account: any, subscriber: any): number | null {
    const map = account?.costCenterByBranch;
    if (!map || typeof map !== 'object') return null;
    const gid = subscriber?.branch?.legacyId;
    const raw = (gid != null ? map[String(gid)] : undefined) ?? map.default;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Garantiza que el tercero exista en Siigo antes de facturar (patrón get-or-create del
   * legacy: `GET /customers?identification=` y, si `total_results == 0`, `POST /customers`).
   * Igual que el legacy, NO actualiza los datos de un tercero ya existente (allí el update
   * estaba comentado). Nunca rompe la emisión: si la consulta falla se sigue adelante y que
   * sea Siigo quien rechace, con su mensaje real.
   */
  private async ensureCustomer(account: any, token: string, subscriber: any, client: SiigoClient) {
    const identification = subscriber?.docNumber || subscriber?.legacyId?.toString();
    if (!identification) return { skipped: 'sin documento' };
    const found = await client.findCustomer(token, identification);
    if (!found.ok || found.found !== false) return { existed: found.found === true, checked: found.ok };
    const created = await client.createCustomer(token, this.buildCustomerPayload(account, subscriber, identification));
    return { existed: false, created: created.ok, error: created.ok ? undefined : created.error };
  }

  /** Cuerpo del tercero para Siigo (porta `Facturas_electronicas_model` líneas 137-198). */
  private buildCustomerPayload(account: any, subscriber: any, identification: string) {
    const isCompany = String(subscriber?.docType ?? '').toUpperCase() === 'NIT';
    const up = (s: any) => String(s ?? '').trim().toUpperCase();
    const first = [up(subscriber?.firstName), up(subscriber?.secondName)].filter(Boolean).join(' ');
    const last = [up(subscriber?.lastName1), up(subscriber?.lastName2)].filter(Boolean).join(' ');
    // Persona natural: name = [nombres, apellidos]. Jurídica: un solo elemento (legacy).
    const name = isCompany
      ? [up(subscriber?.companyName) || [first, last].filter(Boolean).join(' ')]
      : [first || up(subscriber?.fullName), last].filter(Boolean);
    // Celular: el legacy manda "0" si no es un número de hasta 10 dígitos.
    const phone = /^\d{1,10}$/.test(String(subscriber?.phone1 ?? '')) ? String(subscriber.phone1) : '0';
    return {
      type: 'Customer',
      person_type: isCompany ? 'Company' : 'Person',
      id_type: isCompany ? '31' : '13',
      identification,
      name,
      active: true,
      vat_responsible: false,
      fiscal_responsibilities: [{ code: 'R-99-PN' }],
      address: {
        address: subscriber?.addressLine || 'SIN DIRECCION',
        city: { country_code: 'Co', state_code: '85', city_code: '85001' },
      },
      phones: [{ number: phone }],
      contacts: [{
        first_name: first || 'CLIENTE',
        last_name: last || 'VESTEL',
        // El legacy hardcodeaba el correo de la empresa; aquí es configurable por cuenta y
        // sólo cae al del cliente si la cuenta no define uno.
        email: account?.contactEmail || subscriber?.email || undefined,
        phone: { number: phone },
      }],
      related_users: account?.sellerId ? { seller_id: account.sellerId, collector_id: account.sellerId } : undefined,
    };
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

  /** ¿La línea es de TV? (Vestel: la TV lleva IVA 19%; el Internet 0%). */
  private isTvItem(it: any): boolean {
    return Number(it.taxRate) > 0 || /televi|punto/i.test(String(it.description || it.productName || ''));
  }

  /** Total (con IVA) de un subconjunto de ítems. */
  private legTotal(items: any[]): number {
    const t = items.reduce((s, it) => {
      const base = (Number(it.price) || 0) * (Number(it.qty) || 1);
      return s + base * (1 + (Number(it.taxRate) || 0) / 100);
    }, 0);
    return Math.round(t * 100) / 100;
  }

  /**
   * Emite (o simula) UNA pieza de e-factura contra una cuenta Siigo (un servicio).
   * NO cambia la bandera de la SubInvoice — eso lo decide el orquestador `emit`,
   * tras confirmar que todas las piezas del combo salieron bien.
   */
  private async emitLeg(invoice: any, subscriber: any, servicesBilled: string, items: any[]) {
    // Idempotencia POR FACTURA: una sola e-factura DIAN por SubInvoice.
    const dup = await this.prisma.electronicInvoice.findFirst({
      where: { invoiceId: invoice.id, type: 'FACTURADA', dianNumber: { not: null } },
    });
    if (dup) throw new BadRequestException(`Esta factura ya fue emitida ante la DIAN (${dup.dianNumber}).`);

    const account = await this.resolveAccount(servicesBilled);
    const legInvoice = { ...invoice, items, total: this.legTotal(items) };
    const payload = this.buildPayload(account, legInvoice, subscriber);

    if (!this.live) {
      return {
        ok: true, dryRun: true, servicesBilled,
        account: { role: account.role, username: account.username },
        configReady: !!(account.documentId && account.sellerId && account.ivaTaxId && account.paymentCash),
        payload,
      };
    }
    if (!(account.documentId && account.sellerId && account.paymentCash)) {
      throw new BadRequestException(`La cuenta Siigo de ${servicesBilled} no está configurada para emitir (faltan documentId / sellerId / medio de pago).`);
    }
    const token = await this.ensureToken(account);
    const client = new SiigoClient(account.authUrl, account.apiBaseUrl);
    // El tercero debe existir en Siigo antes de facturar (get-or-create, como el legacy).
    const customer = await this.ensureCustomer(account, token, subscriber, client);
    const result = await client.createInvoice(token, payload);
    const ei = await this.prisma.electronicInvoice.create({
      data: {
        siigoAccountId: account.id, subscriberId: invoice.subscriberId, invoiceId: invoice.id,
        date: new Date(invoice.invoiceDate), executedAt: new Date(), servicesBilled,
        type: result.ok ? 'FACTURADA' : 'ERROR',
        // Se guarda también el resultado del get-or-create del tercero: cuando Siigo
        // rechaza, casi siempre es por el cliente y es lo primero que hay que mirar.
        payloadJson: JSON.stringify({ payload, customer, response: result.raw }).slice(0, 20000),
        siigoInvoiceId: result.id ?? null, dianNumber: result.number ?? null,
        cufe: result.cufe ?? null, pdfUrl: result.pdfUrl ?? null,
        errorMessage: result.ok ? null : (result.error ?? 'Error desconocido'),
      } as any,
    });
    if (!result.ok) {
      this.logger.warn(`Emisión fallida factura ${invoice.tid} (${servicesBilled}): ${result.error}`);
      throw new BadRequestException(`Siigo rechazó la factura (${servicesBilled}): ${result.error}`);
    }
    this.logger.log(`E-factura emitida: tid ${invoice.tid} (${servicesBilled}) → DIAN ${result.number}`);
    return {
      ok: true, dryRun: false, servicesBilled, electronicInvoiceId: ei.id,
      dianNumber: result.number, cufe: result.cufe, pdfUrl: result.pdfUrl,
    };
  }

  /**
   * Emite la e-factura de una SubInvoice como UN SOLO documento DIAN (como Vestel
   * en producción: la TV va fusionada dentro del documento de Internet, una única
   * empresa Siigo). Qué servicios entran a la factura lo decide la SELECCIÓN del
   * cliente (`Subscriber.eInvoiceTv` / `eInvoiceInternet`, legacy f_elec_tv /
   * f_elec_internet, marcada en la pantalla "emitir"):
   *   - ambos marcados  → un documento con TV + Internet
   *   - solo uno marcado → un documento con ese servicio
   *   - ninguno marcado → se timbra la factura completa (todo lo que traiga)
   */
  async emit(subInvoiceId: string, user?: AuthUser) {
    const invoice = await this.prisma.subInvoice.findUnique({
      where: { id: subInvoiceId },
      // `branch.legacyId` (= `customers.gid` del legacy) resuelve el centro de costo Siigo.
      include: { items: true, subscriber: { include: { branch: { select: { legacyId: true } } } } },
    });
    if (!invoice) throw new NotFoundException('Factura no encontrada');

    const sub = invoice.subscriber;
    const wantTv = !!sub?.eInvoiceTv;
    const wantNet = !!sub?.eInvoiceInternet;
    const selective = wantTv || wantNet; // hay una selección explícita de servicios

    // Filtra los ítems por la selección del cliente. Sin selección → todo.
    let items = invoice.items ?? [];
    if (selective) {
      items = items.filter((it) => (this.isTvItem(it) ? wantTv : wantNet));
    }
    if (!items.length) {
      throw new BadRequestException(
        'No hay ítems para timbrar según la selección de servicios (TV / Internet) del cliente.',
      );
    }

    // Etiqueta de servicios incluidos (para el registro y para resolver la cuenta).
    const hasTv = items.some((it) => this.isTvItem(it));
    const hasNet = items.some((it) => !this.isTvItem(it));
    const isCombo = hasTv && hasNet;
    const servicesBilled = isCombo ? 'Combo' : hasTv ? 'Television' : 'Internet';

    // UN SOLO documento DIAN con todos los ítems seleccionados.
    const doc = await this.emitLeg(invoice, sub, servicesBilled, items);

    if (doc.ok && this.live) {
      await this.prisma.subInvoice.update({
        where: { id: invoice.id },
        data: {
          eInvoiceFlag: 'Factura Electronica Creada',
          eInvoiceGenDate: new Date(),
          eInvoiceServices: servicesBilled,
        },
      });
    }

    return {
      ...doc, combo: isCombo, servicesBilled,
      message: doc.dryRun
        ? `DRY-RUN: payload construido (${servicesBilled}), NO se envió a la DIAN. Active EINVOICE_LIVE=true para emitir.`
        : `Factura emitida ante la DIAN: ${doc.dianNumber}`,
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
      // La nota crédito reusa `buildPayload`, que necesita la sede para el centro de costo.
      include: { items: true, subscriber: { include: { branch: { select: { legacyId: true } } } } },
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
        // El porqué de la nota, en columna propia: dentro de `payloadJson` no lo leía
        // nadie y en la factura sólo quedaba el número DIAN.
        reason: reason.trim() || null,
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
