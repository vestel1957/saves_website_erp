import { BadRequestException, NotFoundException } from '../core/http/errores';
import { Logger } from '../core/logger';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { SiigoClient } from './siigo-client';
import { direccionDe } from '../common/subscriber-address';
import { exigirEmisorDeNotas } from '../billing/emisor-de-notas';

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

  /**
   * Cuenta Siigo que EMITE. Es una sola, como en el legacy: allá hay dos filas en
   * `config_facturacion_electronica` (Tv / Internet) pero el documento siempre se manda
   * con el token de la de Internet (`$ob1 = config id=2`) — la TV viaja como un ítem más
   * dentro de esa factura. La cuenta de TV quedó de vestigio (su bloque está comentado
   * en `Facturas_electronicas_model.php`), así que aquí NO se ramifica por servicio.
   */
  private async resolveAccount(_servicesBilled?: string | null) {
    const accounts = await this.prisma.siigoAccount.findMany({ where: { active: true } });
    if (accounts.length === 0) throw new BadRequestException('No hay cuentas Siigo configuradas.');
    return accounts.find((a) => a.role === 'Todo') ?? accounts.find((a) => a.role === 'Internet') ?? accounts[0];
  }

  /**
   * Códigos de producto de Siigo para los ítems de una factura. El legacy los saca de
   * `products.product_code` buscando el producto POR NOMBRE (`product_name == plan del
   * cliente`); aquí el mismo catálogo vive en `Material` (importado de `products`), así
   * que se resuelve igual: por nombre exacto del ítem.
   */
  private async codigosSiigo(items: any[]): Promise<Map<string, string>> {
    const nombres = [...new Set(items.map((it) => String(it.productName ?? it.description ?? '').trim()).filter(Boolean))];
    if (!nombres.length) return new Map();
    const materiales = await this.prisma.material.findMany({
      where: { name: { in: nombres }, code: { not: null } },
      select: { name: true, code: true, categoryLegacy: true, legacyId: true },
      // Hay nombres repetidos en el catálogo ("5Megas", "30MegasF"...). El legacy recorre
      // `products` y se queda con la PRIMERA coincidencia, así que se ordena por el id
      // legacy para elegir la misma que él.
      orderBy: { legacyId: 'asc' },
    });
    // Categorías facturables del legacy (`pcat IN (4,10,15)`): un plan y una herramienta
    // pueden llamarse igual, y el código que va a la DIAN es el del plan.
    const codes = new Map<string, string>();
    for (const m of [...materiales.filter((x) => [4, 10, 15].includes(x.categoryLegacy ?? -1)), ...materiales]) {
      if (!codes.has(m.name)) codes.set(m.name, m.code as string);
    }
    return codes;
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

  /**
   * Cuerpo de la factura para Siigo, con la misma forma que manda el legacy
   * (`Facturas_electronicas_model::generar_factura_customer_para_multiple` /
   * `FacturasElectronicas::guardar`), verificado contra documentos reales ya timbrados:
   *
   *   document.id 27274 · seller 945 · cost_center 69|167|165 · payments[0].id 2512
   *   items[].code = product_code del catálogo ("T02" para todo lo de TV)
   *   items[].taxes = [IVA 19%] SOLO si el ítem grava; los de 0% van SIN el nodo `taxes`
   *   observations = "Estrato : X" · date = el día en que se timbra
   */
  private buildPayload(account: any, invoice: any, subscriber: any, codes: Map<string, string>) {
    const docId = subscriber?.docNumber || subscriber?.legacyId?.toString() || '0';
    const items = (invoice.items ?? []).map((it: any) => this.buildItem(account, it, codes));
    const total = this.legTotal(invoice.items ?? []);

    // Medio de pago: crédito si el cliente está marcado como crédito y la cuenta tiene ese
    // medio configurado; si no, contado. El legacy vivo manda siempre contado (2512).
    const isCredit = subscriber?.eInvoicePayMethod === 'CREDITO' && !!account.paymentCredIt;
    const paymentId = isCredit ? account.paymentCredIt : (account.paymentCash ?? null);

    // La fecha del documento es la del TIMBRE, no la de la factura interna: el legacy manda
    // el día en que se emite (`new DateTime($_POST['sdate'])`, que la pantalla trae en hoy)
    // y la DIAN rechaza documentos con fecha vieja. Vencimiento: 20 días después.
    const hoy = new Date();
    const vence = new Date(hoy.getTime() + 20 * 86400_000);
    const ymd = (d: Date) => d.toISOString().slice(0, 10);

    const payload: any = {
      document: { id: account.documentId ?? null },
      date: ymd(hoy),
      customer: { identification: docId, branch_office: 0 },
      seller: account.sellerId ?? null,
      // El legacy manda "Estrato : " aunque el cliente no tenga estrato (así se ven las
      // facturas reales en Siigo); es lo que marca el documento como emitido por el CRM.
      observations: `Estrato : ${subscriber?.estrato ?? ''}`.trim(),
      items,
      payments: [{ id: paymentId, value: total, due_date: ymd(vence) }],
    };
    const costCenter = this.resolveCostCenter(account, subscriber);
    if (costCenter != null) payload.cost_center = costCenter;
    // SIN esto Siigo crea el documento pero lo deja en BORRADOR: no se manda a la DIAN, no
    // hay CUFE y no es una factura electrónica todavía. El legacy no lo manda —allá el
    // envío lo aprueba contabilidad a mano en Siigo—, pero aquí el botón promete "emitir
    // ante la DIAN", así que se timbra de una (apagable en `SiigoAccount.autoStamp`).
    payload.stamp = { send: account.autoStamp !== false };
    // El correo al cliente NO se dispara desde aquí: es un envío a terceros y se decide
    // aparte (en Siigo o marcando la cuenta), no como efecto secundario de facturar.
    payload.mail = { send: false };
    return payload;
  }

  /**
   * Un ítem de la factura con la forma del legacy: código del catálogo Siigo, la
   * descripción con la que Vestel las emite ("Servicio de Internet X" / "Television X" /
   * "Puntos de tv adicionales N") y el IVA desglosado.
   */
  private buildItem(account: any, it: any, codes: Map<string, string>) {
    const nombre = String(it.productName ?? it.description ?? '').trim();
    const qty = Number(it.qty) || 1;
    const price = Number(it.price) || 0;
    const rate = Number(it.taxRate) || 0;
    const tv = this.isTvItem(it);

    // Todo lo de TV va con el código "T02" (el legacy lo fija en cada rama de televisión);
    // el resto lleva el `product_code` del catálogo.
    const code = tv ? 'T02' : (codes.get(nombre) || (it.productId ? String(it.productId) : nombre) || 'GEN');

    const item: any = { code, description: this.describirItem(nombre, qty, tv), quantity: qty, price };
    if (rate > 0) {
      const valor = Math.round(price * qty * rate) / 100;
      item.taxes = [{
        id: account.ivaTaxId ?? null,
        name: `IVA ${rate}%`,
        type: 'IVA',
        percentage: rate,
        value: valor,
      }];
    }
    return item;
  }

  /** La descripción con la que el legacy rotula cada concepto en la factura DIAN. */
  private describirItem(nombre: string, qty: number, tv: boolean): string {
    if (!tv) return nombre ? `Servicio de Internet ${nombre}` : 'Servicio de Internet';
    if (/comercial/i.test(nombre)) return `Puntos de Tv Comerciales ${qty}`;
    if (/punto/i.test(nombre)) return `Puntos de tv adicionales ${qty}`;
    return `Television ${nombre}`.trim();
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

  /**
   * Cuerpo del tercero para Siigo, con la forma del legacy (`getCustomerJson` + los
   * ajustes de `generar_factura_customer_para_multiple`): nombres en mayúsculas, ciudad
   * DIAN según la sede, celular saneado a 10 dígitos y el contacto de la empresa.
   *
   * Dos cosas del legacy que NO se copian por ser defectos, no reglas: mandaba siempre
   * `check_digit: "4"` y `commercial_name: "Siigo"` heredados de la plantilla de ejemplo.
   */
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
    // El vendedor con el que se crea el tercero es otro que el de la factura (legacy: 282).
    const relatedUser = account?.customerSellerId ?? account?.sellerId ?? null;
    return {
      type: 'Customer',
      person_type: isCompany ? 'Company' : 'Person',
      id_type: isCompany ? '31' : '13',
      identification,
      name,
      branch_office: 0,
      active: true,
      vat_responsible: false,
      fiscal_responsibilities: [{ code: 'R-99-PN' }],
      address: {
        // La dirección NO está en `addressLine` (viene vacía o con basura del legacy): se
        // arma de `nomenclature`, igual que el legacy la concatenaba campo por campo.
        address: direccionDe(subscriber?.nomenclature, subscriber?.addressLine) || 'SIN DIRECCION',
        city: this.resolveCity(account, subscriber),
        postal_code: '00000',
      },
      phones: [{ indicative: '57', number: phone, extension: '000' }],
      contacts: [{
        first_name: first || 'CLIENTE',
        last_name: last || 'VESTEL',
        // El legacy hardcodeaba el correo de la empresa; aquí es configurable por cuenta y
        // sólo cae al del cliente si la cuenta no define uno.
        email: account?.contactEmail || subscriber?.email || undefined,
        phone: { indicative: '57', number: phone, extension: '000' },
      }],
      comments: `Estrato : ${subscriber?.estrato ?? ''}`.trim(),
      related_users: relatedUser ? { seller_id: relatedUser, collector_id: relatedUser } : undefined,
    };
  }

  /**
   * Ciudad DIAN del tercero según su sede. `cityByBranch` mapea el id legacy de la sede
   * (`customers.gid`) a `{state_code, city_code}`; lo que no esté en el mapa cae al
   * default (Yopal, 85/85001), igual que los ifs del legacy.
   */
  private resolveCity(account: any, subscriber: any) {
    const def = { country_code: 'Co', state_code: '85', city_code: '85001' };
    const map = account?.cityByBranch;
    if (!map || typeof map !== 'object') return def;
    const gid = subscriber?.branch?.legacyId;
    const hit = (gid != null ? map[String(gid)] : undefined) ?? map.default;
    if (!hit) return def;
    return {
      country_code: hit.country_code ?? 'Co',
      state_code: String(hit.state_code ?? def.state_code),
      city_code: String(hit.city_code ?? def.city_code),
    };
  }

  /** Construye el payload de NOTA CRÉDITO referenciando la factura Siigo original. */
  private buildCreditNotePayload(account: any, invoice: any, subscriber: any, siigoInvoiceId: string, reason: string, causeCode: number, codes: Map<string, string>) {
    const base = this.buildPayload(account, invoice, subscriber, codes);
    return {
      ...base,
      document: { id: account.creditNoteDocumentId ?? account.documentId ?? null },
      invoice: siigoInvoiceId, // uuid de la factura original en Siigo
      cause: causeCode, // 1=Devolución, 2=Anulación, 3=Rebaja, 4=Otros (DIAN)
      reason: reason?.slice(0, 250) || 'Anulación de factura',
    };
  }

  /**
   * Conceptos que NO viajan a la DIAN. El legacy no los manda porque arma la factura
   * electrónica desde los servicios del cliente, no desde los renglones de la factura:
   *  - los descuentos de promoción entran como renglón de precio NEGATIVO ("Nota Credito
   *    · Promoción 5% pronto pago") y Siigo no admite ítems en negativo;
   *  - "Saldo anterior" / "saldo inicial" son arrastre de cartera, no una venta.
   */
  private esTimbrable(it: any): boolean {
    const nombre = String(it.productName ?? it.description ?? '');
    if (Number(it.price) <= 0) return false;
    return !/^\s*(nota\s+(cr[eé]dito|d[eé]bito)|saldo)/i.test(nombre);
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
   * Freno al doble timbre: el LEGACY SIGUE EMITIENDO en paralelo y sus emisiones no
   * quedan atadas a la factura (`facturacion_electronica_siigo.invoice_id` viene NULL en
   * las 222 mil filas), así que la idempotencia por `invoiceId` no las ve. Lo que sí llega
   * por el sync cada 15 min es la fila con el ABONADO y la FECHA, y con eso alcanza: si a
   * este abonado ya se le timbró algo en el mismo mes, no se vuelve a emitir.
   *
   * Un segundo documento legítimo en el mismo mes (una afiliación aparte, p. ej.) se emite
   * con `forzar`, que es una decisión humana y explícita.
   */
  private async exigirSinTimbreDelMes(invoice: any, subscriber: any) {
    if (!invoice.subscriberId) return;
    const ref = new Date(invoice.invoiceDate);
    const desde = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1));
    const hasta = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 1));
    const previa = await this.prisma.electronicInvoice.findFirst({
      where: { subscriberId: invoice.subscriberId, type: 'FACTURADA', date: { gte: desde, lt: hasta } },
      orderBy: { date: 'desc' },
      select: { date: true, dianNumber: true, servicesBilled: true },
    });
    if (!previa) return;
    const cuando = previa.date.toISOString().slice(0, 10);
    throw new BadRequestException(
      `Este abonado ya tiene factura electrónica de ${cuando} (${previa.dianNumber ?? previa.servicesBilled ?? 'emitida en el legacy'}). No se timbra dos veces el mismo mes.`,
    );
  }

  /**
   * Emite (o simula) UNA pieza de e-factura contra una cuenta Siigo (un servicio).
   * NO cambia la bandera de la SubInvoice — eso lo decide el orquestador `emit`,
   * tras confirmar que todas las piezas del combo salieron bien.
   */
  private async emitLeg(invoice: any, subscriber: any, servicesBilled: string, items: any[], forzar = false) {
    // Idempotencia POR FACTURA: una sola e-factura DIAN por SubInvoice.
    const dup = await this.prisma.electronicInvoice.findFirst({
      where: { invoiceId: invoice.id, type: 'FACTURADA', dianNumber: { not: null } },
    });
    if (dup) throw new BadRequestException(`Esta factura ya fue emitida ante la DIAN (${dup.dianNumber}).`);
    if (!forzar) await this.exigirSinTimbreDelMes(invoice, subscriber);

    const account = await this.resolveAccount(servicesBilled);
    const legInvoice = { ...invoice, items, total: this.legTotal(items) };
    const payload = this.buildPayload(account, legInvoice, subscriber, await this.codigosSiigo(items));

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
    // Documento creado pero rechazado por la DIAN: no es una factura electrónica.
    const timbrada = result.ok && !result.error;
    const ei = await this.prisma.electronicInvoice.create({
      data: {
        siigoAccountId: account.id, subscriberId: invoice.subscriberId, invoiceId: invoice.id,
        date: new Date(invoice.invoiceDate), executedAt: new Date(), servicesBilled,
        type: timbrada ? 'FACTURADA' : 'ERROR',
        // Se guarda también el resultado del get-or-create del tercero: cuando Siigo
        // rechaza, casi siempre es por el cliente y es lo primero que hay que mirar.
        payloadJson: JSON.stringify({ payload, customer, response: result.raw }).slice(0, 20000),
        siigoInvoiceId: result.id ?? null, dianNumber: result.number ?? null,
        cufe: result.cufe ?? null, pdfUrl: result.pdfUrl ?? null,
        errorMessage: timbrada ? null : (result.error ?? 'Error desconocido'),
      } as any,
    });
    if (!timbrada) {
      this.logger.warn(`Emisión fallida factura ${invoice.tid} (${servicesBilled}): ${result.error}`);
      throw new BadRequestException(`Siigo rechazó la factura (${servicesBilled}): ${result.error}`);
    }
    this.logger.log(`E-factura emitida: tid ${invoice.tid} (${servicesBilled}) → DIAN ${result.number} [${result.stampStatus ?? 'sin sello'}]`);
    return {
      ok: true, dryRun: false, servicesBilled, electronicInvoiceId: ei.id,
      dianNumber: result.number, cufe: result.cufe, stampStatus: result.stampStatus, pdfUrl: result.pdfUrl,
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
  async emit(subInvoiceId: string, user?: AuthUser, forzar = false) {
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

    // Fuera lo que no es una venta (descuentos en negativo, arrastre de saldo) y luego
    // filtra por la selección de servicios del cliente. Sin selección → todo.
    let items = (invoice.items ?? []).filter((it) => this.esTimbrable(it));
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
    const doc = await this.emitLeg(invoice, sub, servicesBilled, items, forzar);

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
        // El estado del sello va en el mensaje a propósito: "creada en Siigo" y "aceptada
        // por la DIAN" no son lo mismo, y un documento que se quedó en BORRADOR (sin CUFE)
        // todavía no es una factura electrónica — hay que verlo, no descubrirlo después.
        : (doc as any).stampStatus === 'Accepted' || (doc as any).cufe
          ? `Factura emitida y aceptada por la DIAN: ${doc.dianNumber}`
          : `Factura ${doc.dianNumber} creada en Siigo, pero el sello quedó en «${(doc as any).stampStatus ?? 'sin estado'}»: aún NO está ante la DIAN.`,
    };
  }

  /**
   * Emite (o simula) una NOTA CRÉDITO electrónica ante la DIAN para una factura
   * que YA fue emitida. Referencia la factura Siigo original y persiste el
   * resultado como ElectronicInvoice tipo NOTA_CREDITO. Porta get_invoice_credito.
   */
  async emitCreditNote(subInvoiceId: string, reason: string, causeCode = 2, user?: AuthUser) {
    // Mismo candado que las notas internas: emitir una nota crédito es nominal
    // (ver `billing/emisor-de-notas.ts`). Cuenta también aquí porque una factura ya
    // timbrada NO se puede anular sin su nota crédito DIAN — o sea que ésta es la
    // otra puerta por la que se le rebaja al abonado lo que debe.
    exigirEmisorDeNotas(user);
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

    const payload = this.buildCreditNotePayload(account, invoice, invoice.subscriber, emitted.siigoInvoiceId, reason, causeCode, await this.codigosSiigo(invoice.items ?? []));

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
  async emitBranch(branchId: string, user?: AuthUser, mes?: string, limit = 100) {
    // El legacy acota SIEMPRE el lote a un mes (`DATE_FORMAT(invoicedate,'%Y-%m') = mes`).
    // Sin ese corte el lote se comería el atraso histórico (166 mil facturas marcadas desde
    // 2019) y timbraría ante la DIAN mensualidades de hace años.
    const periodo = /^\d{4}-\d{2}$/.test(mes ?? '') ? (mes as string) : new Date().toISOString().slice(0, 7);
    const desde = new Date(`${periodo}-01T00:00:00.000Z`);
    const hasta = new Date(Date.UTC(desde.getUTCFullYear(), desde.getUTCMonth() + 1, 1));
    const pending = await this.prisma.subInvoice.findMany({
      where: {
        eInvoiceFlag: 'Crear Factura Electronica',
        invoiceDate: { gte: desde, lt: hasta },
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
    // Las que ya tenían timbre de este mes (casi siempre porque las emitió el legacy) no
    // son un fallo: se cuentan aparte para que un lote sano no salga lleno de "errores".
    let omitidas = 0;
    let configReady = true;
    const errors: { tid: number; error: string }[] = [];
    for (const inv of batch) {
      try {
        const r: any = await this.emit(inv.id, user);
        if (r?.dryRun && r.configReady === false) configReady = false;
        if (r?.ok) ok++;
      } catch (e: any) {
        const msg = e?.message ?? 'Error';
        if (/ya (tiene factura electr|fue emitida)/i.test(msg)) { omitidas++; continue; }
        failed++;
        if (errors.length < 8) errors.push({ tid: inv.tid, error: msg });
      }
    }
    return {
      dryRun: !this.live,
      configReady,
      periodo,
      processed: batch.length,
      ok,
      failed,
      omitidas,
      hasMore,
      errors,
      message: !this.live
        ? `DRY-RUN: se construyeron ${ok} payload(s) de la sede (${periodo}); no se envió nada a la DIAN.${omitidas ? ` ${omitidas} ya venían timbradas.` : ''}`
        : `Emitidas ${ok} factura(s) de la sede (${periodo}) ante la DIAN${failed ? `, ${failed} con error` : ''}.${omitidas ? ` ${omitidas} ya venían timbradas (se omitieron).` : ''}`,
    };
  }
}
