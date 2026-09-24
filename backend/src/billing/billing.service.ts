import { BadRequestException, NotFoundException } from '../core/http/errores';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { scopeDate, currentYear } from '../common/date-scope';
import { WhatsappService } from '../common/whatsapp/whatsapp.service';
import { MailService } from '../common/mail/mail.service';
import { invoicePdfBuffer } from './billing-pdf';
import { ReciboRolloData } from '../common/pdf/recibo-rollo';
import { conceptoFactura } from '../common/concepto-factura';
import { etiquetaDeMotivo } from './motivos-factura';
import { terminoDePago } from '../common/terminos-pago';
import { num } from '../common/money';
import { sedesDe, whereSedePorSuscriptor, exigirSedeSuscriptor } from '../common/sede-scope';
import { AuthUser } from '../auth/current-user.decorator';
import { orden, paginacion } from '../common/pagination-params';

const cop = (n: number) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);


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

/**
 * Mes facturado, en texto ("abril de 2026").
 *
 * NO hay columna de periodo en `SubInvoice` (tampoco la había en el legacy: ver
 * `mapInvoice` en scripts/lib/vestel-map.js, que mapea la fila entera). El único
 * anclaje fiable es el mes de emisión, y SOLO vale para las recurrentes: la
 * corrida genera una única factura por abonado y mes calendario, así que ahí mes
 * de emisión == periodo cobrado.
 *
 * Las FIJA y las notas son cargos puntuales (instalación, reconexión, ajustes):
 * no se les inventa un periodo, se devuelve null y la pantalla las rotula como
 * lo que son. `invoiceDate` es columna `date`, así que se lee en UTC — leerla en
 * la zona de la sesión corre el mes en los días 1 (ver [[sql-crudo-fechas-date]]).
 */
function periodoFacturado(kind: string | null, invoiceDate: Date | null): string | null {
  if (kind !== 'RECURRENTE' || !invoiceDate) return null;
  return invoiceDate.toLocaleDateString('es-CO', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
    private readonly mail: MailService,
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

  /**
   * Envía la factura (PDF adjunto) por correo usando la plantilla INVOICE_AVAILABLE.
   * Tolerante: si SMTP no está configurado o el cliente no tiene correo, devuelve
   * sent:false con el motivo, sin romper.
   */
  async sendEmail(id: string) {
    const inv = await this.detail(id);
    const email = inv.subscriber?.email?.trim();
    if (!email) throw new BadRequestException('El cliente no tiene correo registrado.');
    const pdf = await invoicePdfBuffer(inv as any);
    const company = await this.prisma.companyInfo.findFirst({ select: { name: true } });
    const ctx: Record<string, string> = {
      nombre: inv.subscriber?.name ?? 'Cliente',
      abonado: String(inv.subscriber?.abonado ?? ''),
      factura: String(inv.tid),
      total: cop(inv.total),
      deuda: cop(inv.balance),
      vence: inv.dueDate ? new Date(inv.dueDate).toLocaleDateString('es-CO') : '—',
      empresa: company?.name ?? 'Vestel',
    };
    const res = await this.mail.sendTemplate('INVOICE_AVAILABLE', email, ctx, [
      { filename: `factura-${inv.tid}.pdf`, content: pdf, contentType: 'application/pdf' },
    ]);
    return { ...res, email };
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

  /**
   * Columnas ordenables de la tabla de facturas.
   *
   * `balance` (saldo) no está y no puede estar: es `total − pagado`, una cuenta
   * que Prisma no sabe poner en un `ORDER BY`. Como el listado se pagina en el
   * servidor, ordenar por saldo solo movería la página visible, así que la
   * columna no ofrece flecha en vez de ofrecer una que miente. Para "quién debe
   * más" está el listado de cartera.
   */
  private static readonly ORDEN_LISTA = {
    tid: 'tid',
    sub: (dir: 'asc' | 'desc') => [
      { subscriber: { firstName: dir } },
      { subscriber: { lastName1: dir } },
      { subscriber: { companyName: dir } },
    ],
    service: (dir: 'asc' | 'desc') => [{ serviceCombo: dir }, { serviceTv: dir }],
    date: 'invoiceDate',
    due: 'dueDate',
    total: 'total',
    status: 'status',
  };

  /** Listado paginado de facturas con filtros. */
  async list(params: {
    search?: string; status?: string; ron?: string; branchId?: string;
    from?: string; to?: string; all?: string; overdue?: string;
    page?: number; pageSize?: number;
    sortBy?: string; sortDir?: string;
  }, user?: AuthUser) {
    const { page, pageSize } = paginacion(params);
    const search = (params.search || '').trim();

    const where: Prisma.SubInvoiceWhereInput = {};
    // Acceso por sede: la factura hereda la sede de su suscriptor.
    Object.assign(where, whereSedePorSuscriptor(await sedesDe(this.prisma, user)));
    if (params.status) where.status = params.status as any;
    if (params.ron) where.ron = params.ron as any;
    if (params.branchId) {
      // Mezclar, no reemplazar: si se sobrescribiera `where.subscriber` se perdería
      // el acotado por sede de arriba y el filtro sería puenteable desde la URL.
      where.subscriber = { ...(where.subscriber as object ?? {}), branchId: params.branchId };
    }
    // Vencidas / con saldo: facturas sin pagar del todo (DUE o PARTIAL) cuya
    // fecha de vencimiento ya pasó. Herramienta directa para cobranza.
    if (params.overdue === '1' || params.overdue === 'true') {
      where.status = { in: ['DUE', 'PARTIAL'] as any };
      where.dueDate = { lt: new Date() };
    }
    // Por defecto AÑO ACTUAL, por velocidad: hay 456.000 facturas y 9 de cada 10 son
    // de años anteriores.
    //
    // Pero BUSCAR es otra cosa: quien escribe un número de factura, un documento o un
    // nombre está pidiendo esa factura, no "esa factura de este año", y la ventana del
    // año la hacía desaparecer sin decir nada —la #318921 (ago-2024) existía importada
    // y el listado contestaba "No se encontraron facturas"—. Así que una búsqueda
    // barre TODO el histórico salvo que se acote a mano con desde/hasta. Se puede: el
    // número de factura tiene índice único y el peor caso (por nombre) son 70 ms.
    const buscandoEnTodo = !!search && !params.from && !params.to;
    const period = scopeDate(params.from, params.to, params.all || (buscandoEnTodo ? '1' : undefined));
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
        where, orderBy: orden(params, BillingService.ORDEN_LISTA, { invoiceDate: 'desc' }),
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
        // Por qué se emitió, cuando se dijo (las importadas y las de la corrida no lo
        // traen): en el listado es lo que distingue un traslado de una venta de
        // equipo sin tener que abrir la factura.
        purpose: i.purpose, purposeLabel: etiquetaDeMotivo(i.purpose),
        service: [i.serviceCombo, i.serviceTv].filter((x) => x && x !== 'no').join(' · ') || null,
        eInvoiceFlag: i.eInvoiceFlag, // 'Crear Factura Electronica' | 'Factura Electronica Creada' | null
      })),
      sum: { total: sumTotal, balance: sumTotal - sumPaid },
      // Qué ventana de fechas se aplicó DE VERDAD. Sin esto la pantalla no puede
      // distinguir "no existe" de "no existe en este año", que es justo lo que
      // confundía al buscar una factura vieja.
      scope: !period ? 'historico' : params.from || params.to ? 'rango' : 'anio',
      scopeYear: period && !(params.from || params.to) ? currentYear() : null,
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  /** Detalle de una factura: ítems, cliente y pagos aplicados. */
  async detail(id: string, user?: AuthUser) {
    const dueno = await this.prisma.subInvoice.findUnique({ where: { id }, select: { subscriberId: true } });
    if (dueno) await exigirSedeSuscriptor(this.prisma, user, dueno.subscriberId);
    const i = await this.prisma.subInvoice.findUnique({
      where: { id },
      include: {
        subscriber: { select: { ...SUB_SELECT, docType: true, docNumber: true, email: true, phone1: true, branch: { select: { name: true } } } },
        items: { orderBy: { id: 'asc' } },
        transactions: { orderBy: { date: 'desc' } },
        electronicInvoices: { orderBy: { date: 'desc' }, take: 5 },
        // El trabajo que esta factura tiene detrás, si lo tiene: la orden que nace
        // cuando se pague (hoy, el traslado). Ver `PendingOrder`.
        pendingOrder: true,
      },
    });
    if (!i) throw new NotFoundException('Factura no encontrada');

    return {
      id: i.id, tid: i.tid, kind: i.kind, status: i.status, ron: i.ron,
      date: i.invoiceDate, dueDate: i.dueDate,
      subtotal: num(i.subtotal), tax: num(i.tax), discount: num(i.discount),
      total: num(i.total), paid: num(i.paidAmount), balance: num(i.total) - num(i.paidAmount),
      paymentMethod: i.paymentMethod, branchRef: i.branchRef,
      // Observación de la factura (`invoices.notes`). Sin devolverla, el editor la
      // abría vacía y al guardar la borraba: el que corregía un valor se llevaba por
      // delante la nota que había dejado otro.
      notes: i.notes,
      /**
       * POR QUÉ se emitió. `kind` dice el TIPO (fija/recurrente) y no el motivo:
       * afiliación, traslado, reconexión y venta de equipo son las cuatro «Fija».
       * Las facturas anteriores al 2026-09-08 —y las de la corrida mensual— no lo
       * traen, así que puede venir null.
       */
      purpose: i.purpose,
      purposeLabel: etiquetaDeMotivo(i.purpose),
      /**
       * El trabajo que arranca cuando esta factura se pague: qué orden, a dónde
       * (el traslado lleva la dirección nueva) y si ya se abrió. Es lo que hay que
       * ver en la factura para saber que cobrarla no es el final del asunto.
       */
      ordenAlPagar: i.pendingOrder
        ? {
            tipo: i.pendingOrder.type,
            motivo: etiquetaDeMotivo(i.pendingOrder.motivo),
            resumen: i.pendingOrder.resumen,
            ticketId: i.pendingOrder.ticketId,
            ticketCode: i.pendingOrder.ticketCode,
            abierta: !!i.pendingOrder.ticketId,
            error: i.pendingOrder.lastError,
          }
        : null,
      period: periodoFacturado(i.kind, i.invoiceDate),
      service: { combo: i.serviceCombo, tv: i.serviceTv, puntos: i.puntos, estadoCombo: i.estadoCombo, estadoTv: i.estadoTv },
      eInvoiceFlag: i.eInvoiceFlag,
      // Para la edición: si la factura vino del legacy, el cambio queda sólo en este
      // sistema (allá se sigue viendo el valor viejo mientras el legacy esté activo),
      // y una vez timbrada ante la DIAN ya no se puede tocar.
      fromLegacy: i.legacyId != null,
      stamped: i.electronicInvoices.some((e) => e.type === 'FACTURADA' && !!e.dianNumber),
      editedAt: i.editedAt, editedBy: i.editedBy, editCount: i.editCount,
      subscriber: i.subscriber ? {
        id: i.subscriber.id, name: subName(i.subscriber), abonado: i.subscriber.abonado,
        docType: i.subscriber.docType, docNumber: i.subscriber.docNumber,
        email: i.subscriber.email, phone: i.subscriber.phone1, branch: i.subscriber.branch?.name ?? null,
      } : null,
      items: i.items.map((it) => ({
        id: it.id, product: it.productName, description: it.description, qty: it.qty,
        // `productId` (pid del legacy) lo necesita el editor para reenviar la línea
        // sin perder el enlace al producto del catálogo.
        productId: it.productId ?? 0,
        // Una nota crédito/débito es un renglón más de la factura, pero no un
        // concepto editable: se muestra aparte y la edición no la toca.
        nota: it.productName === 'Nota Credito' || it.productName === 'Nota Debito',
        price: num(it.price), taxRate: num(it.taxRate), subtotal: num(it.subtotal), taxTotal: num(it.taxTotal),
        discountTotal: num(it.discountTotal),
      })),
      payments: i.transactions.map((t) => ({
        id: t.id, date: t.date, amount: num(t.credit), method: t.method,
        // Código de la transacción (el consecutivo del legacy, el mismo que Tesorería
        // muestra como "Código"): contabilidad cruza la factura contra el movimiento
        // con ese número. null = pago nacido aquí que aún no ha viajado al legacy.
        codigo: t.legacyId,
        category: t.category, status: t.status, note: t.note,
      })),
      electronic: i.electronicInvoices.map((e) => ({
        id: e.id, date: e.date, type: e.type, dianNumber: e.dianNumber, cufe: e.cufe, pdfUrl: e.pdfUrl,
        // Motivo de la nota crédito electrónica (por qué se anuló la factura).
        reason: e.reason,
      })),
    };
  }

  /**
   * Datos del recibo en ROLLO de 80 mm de una factura.
   *
   * El "Imprimir" del legacy (`invoices/view.php` → `Invoices::printinvoice`) nunca
   * sacó una hoja: cargaba mPDF con `format => [80, 250]`, o sea el papel de la
   * impresora de caja. Aquí se reconstruye ese mismo contenido: los ítems de la
   * factura, debajo las OTRAS facturas que el cliente sigue debiendo y el saldo
   * global — que es lo que la cajera le lee al cliente en el mostrador.
   */
  async reciboRolloData(id: string, user?: AuthUser): Promise<ReciboRolloData> {
    const inv = await this.detail(id, user);
    const term = await this.prisma.subInvoice.findUnique({ where: { id }, select: { term: true } });

    const pendientes = inv.subscriber
      ? await this.prisma.subInvoice.findMany({
          where: { subscriberId: inv.subscriber.id, status: { in: ['DUE', 'PARTIAL'] } },
          // Los `items` viajan sólo para reconocer la afiliación, que es el único
          // renglón que no se rotula por mes (ver `conceptoFactura`).
          select: {
            id: true, tid: true, invoiceDate: true, total: true, paidAmount: true,
            items: { select: { productName: true } },
          },
          orderBy: { invoiceDate: 'asc' },
        })
      : [];
    const saldoDe = (i: { total: Prisma.Decimal; paidAmount: Prisma.Decimal }) =>
      Math.max(0, num(i.total) - num(i.paidAmount));
    const balance = pendientes.reduce((s, i) => s + saldoDe(i), 0);
    // El pie del recibo manda a pagar con el "código de usuario", que es el
    // `customers.id` del legacy — aquí, `legacyId`. Los clientes creados en este
    // stack no lo tienen y el recibo cae al número de abonado.
    const codigo = inv.subscriber
      ? (await this.prisma.subscriber.findUnique({
          where: { id: inv.subscriber.id }, select: { legacyId: true },
        }))?.legacyId ?? null
      : null;

    // La fecha del papel es el día en que se PAGÓ la factura, no el de su emisión: es
    // el comprobante que se lleva el cliente. Se toma el último pago vigente (los
    // `payments` vienen por fecha descendente); si aún no tiene ninguno, hoy en
    // Colombia. `Transaction.date` es una columna `date` (medianoche UTC), igual que
    // la del recibo, así que `fechaSolo` la formatea sin correrla un día.
    const hoy = new Date(
      `${new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' })}T00:00:00Z`,
    );
    const ultimoPago = inv.payments.find((p) => p.status !== 'ANULADA' && p.amount > 0);
    const fechaPago = ultimoPago ? new Date(ultimoPago.date) : hoy;
    // La hora del membrete sólo tiene sentido si el pago es de hoy; la transacción no
    // guarda la suya, y estampar la de ahora junto a una fecha pasada sería inventarla.
    const esHoy = fechaPago.getTime() === hoy.getTime();

    return {
      number: String(inv.tid),
      date: fechaPago,
      createdAt: esHoy ? new Date() : null,
      branch: inv.branchRef ?? inv.subscriber?.branch ?? null,
      cashier: null,
      cashierRole: null,
      method: inv.paymentMethod,
      subscriber: inv.subscriber
        ? {
            name: inv.subscriber.name,
            abonado: inv.subscriber.abonado,
            docType: inv.subscriber.docType,
            docNumber: inv.subscriber.docNumber,
            email: inv.subscriber.email,
            codigo,
          }
        : null,
      // UN renglón por factura: el mes que se está pagando y su total. El legacy
      // desglosaba aquí los ítems (`foreach ($lista_items)`), y eso ponía el PLAN en
      // el papel del cliente —"100 Megas F-S", "Television", "Punto adicional"—; el
      // recibo no discrimina servicios (ver `conceptoFactura`), salvo la afiliación,
      // que se nombra por lo que es. El desglose sigue saliendo en la factura en hoja.
      items: [{
        tid: inv.tid,
        concept: conceptoFactura({
          tid: inv.tid, invoiceDate: inv.date,
          items: inv.items.map((it) => ({ productName: it.product })),
        }),
        amount: inv.total,
      }],
      // Las demás pendientes, que el legacy imprime en negrita cursiva debajo.
      pending: pendientes
        .filter((i) => i.id !== inv.id)
        .map((i) => ({ tid: i.tid, concept: conceptoFactura(i), amount: saldoDe(i) })),
      total: inv.total,
      paid: inv.paid,
      discount: inv.discount,
      balance,
      status: inv.status,
      // La condición de pago del legacy, que es lo que va al pie del papel; el
      // periodo del servicio ya sale en el renglón del concepto.
      terms: terminoDePago(term?.term),
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
