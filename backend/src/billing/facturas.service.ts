import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { PostingService } from '../accounting/posting.service';
import { CobranzasService } from '../treasury/cobranzas.service';
import {
  CreateInvoiceDto, CreateNoteDto, GenerateInvoicesDto, InvoiceItemDto,
  RETENTION_LABEL_TO_ENUM, VoidInvoiceDto,
} from './dto/facturas.dto';
import { num, round2 } from '../common/money';


function dateOnly(s?: string): Date {
  const d = s ? new Date(s) : new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86400000);

/**
 * Fecha de vencimiento en el día fijo `day` del mes (paridad legacy: día 20).
 * Si ese día ya pasó respecto a la fecha de emisión, rueda al mes siguiente.
 * `day` se acota a [1,28] para evitar meses cortos.
 */
function dueOnDay(base: Date, day: number): Date {
  const d = Math.min(28, Math.max(1, Math.round(day) || 20));
  const year = base.getUTCFullYear();
  let month = base.getUTCMonth();
  if (base.getUTCDate() > d) month += 1; // el día ya pasó → mes siguiente
  return new Date(Date.UTC(year, month, d));
}

type Tx = Prisma.TransactionClient;

/** Por qué un abonado objetivo no terminó facturado en la corrida. */
export type GenerateSkipReason =
  | 'ALREADY_BILLED'  // ya tenía factura en el mes
  | 'REACTIVATED'     // volvió de RETIRADO dentro del mes (lo cubre la reconexión)
  | 'NO_SERVICES'     // sin SubscriberService activo con precio
  | 'PROMO'           // mes de promoción gratis (contador promo)
  | 'PROMO2'          // mes de promoción gratis (contador promo2)
  | 'ERROR';          // la escritura falló

/** Decisión de la corrida para un abonado. En `dryRun` es lo que se HARÍA. */
export type GeneratePlanRow = {
  subscriberId: string;
  action: 'BILL' | 'SKIP' | 'FAIL';
  reason?: GenerateSkipReason;
  error?: string;
  tid?: number;
  subtotal?: number;
  tax?: number;
  total?: number;
  serviceCombo?: string | null;
  serviceTv?: string | null;
  items?: { productName: string | null; qty: number; price: number; taxRate: number; taxTotal: number }[];
};

/** Escritura de facturación (Cobranza): crear factura, generar en lote y notas C/D. */
@Injectable()
export class FacturasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingService,
    private readonly cobranzas: CobranzasService,
  ) {}

  private async nextTid(tx: Tx): Promise<number> {
    const max = await tx.subInvoice.aggregate({ _max: { tid: true } });
    return (max._max.tid ?? 0) + 1;
  }

  /** Día de vencimiento configurado (ajuste `billing.dueDay`, por defecto 20). */
  private async billingDueDay(): Promise<number> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: 'billing.dueDay' } });
    const n = Number(row?.value);
    return Number.isFinite(n) && n >= 1 && n <= 28 ? n : 20;
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
    const subscriber = await this.prisma.subscriber.findUnique({ where: { id: dto.subscriberId }, select: { id: true, branchId: true, eInvoice: true } });
    if (!subscriber) throw new NotFoundException('Cliente no encontrado');

    const { rows, subtotal, tax, total } = this.computeTotals(dto.items);
    const invoiceDate = dateOnly(dto.invoiceDate);
    const dueDate = dto.dueDate ? dateOnly(dto.dueDate) : dueOnDay(invoiceDate, await this.billingDueDay());

    const result = await this.prisma.$transaction(async (tx) => {
      const tid = await this.nextTid(tx);
      const inv = await tx.subInvoice.create({
        data: {
          tid, subscriberId: subscriber.id, issuerUserId: null,
          invoiceDate, dueDate,
          subtotal, tax, total, paidAmount: 0,
          status: 'DUE', kind: 'FIJA',
          eInvoiceFlag: subscriber.eInvoice ? 'Crear Factura Electronica' : null,
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
    // Contabilización automática (DR cartera, CR ingreso + IVA). Idempotente; no rompe el flujo.
    await this.posting.postSalesInvoice({
      sourceId: result.id, date: invoiceDate, number: result.tid,
      subtotal: result.subtotal, tax: result.tax, createdBy: user?.name ?? user?.email ?? null,
    });
    return result;
  }

  /**
   * Generar la facturación recurrente en lote: una mensualidad por abonado, armada
   * desde su plan (`SubscriberService` activos), NO clonando la última factura.
   * Así los cargos puntuales (instalación, reconexión) no se arrastran al mes siguiente.
   *
   * Con `dto.dryRun` no escribe nada y devuelve `plan` (la decisión y el motivo por
   * abonado); con `dto.asIfUnbilled` además re-simula un mes ya facturado.
   */
  async generate(dto: GenerateInvoicesDto, user: AuthUser) {
    const dryRun = dto.dryRun === true;
    const asIfUnbilled = dto.asIfUnbilled === true;
    // asIfUnbilled desactiva el anti-duplicado: fuera de una simulación volvería a
    // facturar un mes ya facturado. Solo se permite acompañado de dryRun.
    if (asIfUnbilled && !dryRun) {
      throw new BadRequestException('asIfUnbilled solo se permite junto con dryRun.');
    }

    const invoiceDate = dateOnly(dto.invoiceDate);
    const dueDate = dto.dueDays ? addDays(invoiceDate, dto.dueDays) : dueOnDay(invoiceDate, await this.billingDueDay());
    const monthStart = new Date(Date.UTC(invoiceDate.getUTCFullYear(), invoiceDate.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(invoiceDate.getUTCFullYear(), invoiceDate.getUTCMonth() + 1, 1));

    // Población objetivo. Paridad legacy Invoices_model.php:1112: la facturación
    // recurrente SOLO incluye abonados en estado Activo o Compromiso; nunca factura
    // a Cortado/Retirado/Suspendido/etc. → evita cobro y doble cobro a inactivos.
    const subWhere: Prisma.SubscriberWhereInput = { status: { in: ['ACTIVO', 'COMPROMISO'] } };
    if (dto.subscriberIds?.length) subWhere.id = { in: dto.subscriberIds };
    else if (dto.branchId) subWhere.branchId = dto.branchId;

    // SIN tope por defecto: la corrida del mes tiene que cubrir a TODOS los
    // facturables (el legacy factura el grupo entero). `limit` es una ayuda de
    // pruebas, no un default — un tope silencioso deja el mes a medio facturar
    // y el lote reporta éxito igual. `orderBy` fija qué entra cuando sí hay tope.
    const subs = await this.prisma.subscriber.findMany({
      where: subWhere,
      orderBy: { id: 'asc' },
      ...(dto.limit ? { take: dto.limit } : {}),
      select: {
        id: true,
        eInvoice: true,
        previousStatus: true,   // ultimo_estado (guard de reactivación)
        statusChangedAt: true,  // fecha_cambio
        services: {
          where: { status: 'ACTIVO', price: { gt: 0 } },
          select: { kind: true, planName: true, price: true, taxRate: true },
        },
      },
    });

    // ¿Quiénes ya tienen factura este mes? Una sola consulta (usa el índice de
    // invoiceDate) en vez de un count por abonado — evita N roundtrips a la BD.
    // Con asIfUnbilled el mes se trata como vacío (es lo que se está simulando).
    const alreadyBilled = asIfUnbilled ? new Set<string>() : new Set(
      (await this.prisma.subInvoice.findMany({
        where: { invoiceDate: { gte: monthStart, lt: monthEnd } },
        select: { subscriberId: true },
      })).map((r) => r.subscriberId),
    );

    // Contadores de meses de promoción gratis: se leen de la última factura de cada
    // abonado (paridad legacy `invoices.promo/promo2`). Mientras haya meses gratis, NO
    // se factura y el contador se descuenta una vez por mes calendario.
    // Con asIfUnbilled se lee la última factura ANTERIOR al mes: si no, se leerían
    // los contadores de la factura del propio mes que se está re-simulando.
    const promoBySub = new Map(
      (await this.prisma.subInvoice.findMany({
        where: {
          subscriberId: { in: subs.map((s) => s.id) },
          ...(asIfUnbilled ? { invoiceDate: { lt: monthStart } } : {}),
        },
        orderBy: [{ invoiceDate: 'desc' }, { tid: 'desc' }],
        distinct: ['subscriberId'],
        select: { id: true, subscriberId: true, promo: true, promo2: true, promoModifiedDate: true, promo2ModifiedDate: true },
      })).map((r) => [r.subscriberId, r]),
    );
    const curYm = `${invoiceDate.getUTCFullYear()}-${invoiceDate.getUTCMonth()}`;
    const ymOf = (d: Date | null | undefined) => (d ? `${d.getUTCFullYear()}-${d.getUTCMonth()}` : null);

    let generated = 0, skipped = 0, failed = 0;
    const plan: GeneratePlanRow[] = [];
    const bill = (row: GeneratePlanRow) => { plan.push(row); return row; };
    const skip = (subscriberId: string, reason: GenerateSkipReason) => {
      skipped++; plan.push({ subscriberId, action: 'SKIP', reason });
    };

    for (const s of subs) {
      // ¿ya tiene factura este mes? → skip (evita duplicar).
      if (alreadyBilled.has(s.id)) { skip(s.id, 'ALREADY_BILLED'); continue; }
      // Guard de reactivación (legacy): si el abonado venía de RETIRADO y se reactivó
      // dentro del mes que se factura, NO se genera el mes completo (ese mes lo cubre
      // el flujo de reconexión/prorrateo) → evita el doble cobro al reactivado.
      if (s.previousStatus === 'RETIRADO' && ymOf(s.statusChangedAt) === curYm) { skip(s.id, 'REACTIVATED'); continue; }
      // Sin servicios activos con precio → nada que cobrar este mes.
      if (!s.services.length) { skip(s.id, 'NO_SERVICES'); continue; }

      // ¿Mes de promoción gratis? → no se factura; se descuenta el contador una vez/mes.
      const promo = promoBySub.get(s.id);
      if (promo && promo.promo != null && (promo.promo > 0 || ymOf(promo.promoModifiedDate) === curYm)) {
        if (!dryRun && ymOf(promo.promoModifiedDate) !== curYm) {
          await this.prisma.subInvoice.update({ where: { id: promo.id }, data: { promo: promo.promo - 1, promoModifiedDate: invoiceDate } });
        }
        skip(s.id, 'PROMO'); continue;
      }
      if (promo && promo.promo2 != null && (promo.promo2 > 0 || ymOf(promo.promo2ModifiedDate) === curYm)) {
        if (!dryRun && ymOf(promo.promo2ModifiedDate) !== curYm) {
          await this.prisma.subInvoice.update({ where: { id: promo.id }, data: { promo2: promo.promo2 > 0 ? promo.promo2 - 1 : 0, promo2ModifiedDate: invoiceDate } });
        }
        skip(s.id, 'PROMO2'); continue;
      }

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
      const shape = {
        subscriberId: s.id, action: 'BILL' as const,
        subtotal, tax, total, serviceCombo, serviceTv,
        items: rows.map((r) => ({ productName: r.productName ?? null, qty: r.qty, price: r.price, taxRate: r.taxRate, taxTotal: r.taxTotal })),
      };

      // Simulación: se calculó todo el lote, no se escribe nada.
      if (dryRun) { generated++; bill(shape); continue; }

      try {
        const inv = await this.prisma.$transaction(async (tx) => {
          const tid = await this.nextTid(tx);
          return tx.subInvoice.create({
            data: {
              tid, subscriberId: s.id, invoiceDate, dueDate,
              subtotal, tax, total, paidAmount: 0, status: 'DUE', kind: 'RECURRENTE',
              itemsCount: rows.length,
              serviceCombo, serviceTv,
              // Alimenta la cola de timbrado DIAN si el abonado factura electrónicamente.
              eInvoiceFlag: s.eInvoice ? 'Crear Factura Electronica' : null,
              items: { create: rows.map((r) => ({
                productId: 0, productName: r.productName ?? null, description: r.description,
                qty: r.qty, price: r.price, taxRate: r.taxRate,
                subtotal: r.subtotal, taxTotal: r.taxTotal, discountTotal: 0,
              })) },
            },
          });
        });
        generated++;
        bill({ ...shape, tid: inv.tid });
        // Contabilización automática de la factura recurrente (idempotente; no rompe el lote).
        await this.posting.postSalesInvoice({
          sourceId: inv.id, date: invoiceDate, number: inv.tid,
          subtotal, tax, createdBy: user?.name ?? user?.email ?? null,
        });
      } catch (e) {
        // Un fallo NO es una omisión: se cuenta y se nombra aparte. Antes caía en el
        // mismo saco que los skips legítimos y una colisión de tid (nextTid es
        // MAX(tid)+1, con carrera real) quedaba invisible.
        failed++;
        plan.push({ subscriberId: s.id, action: 'FAIL', reason: 'ERROR', error: (e as Error).message });
      }
    }
    return {
      targeted: subs.length, generated, skipped, failed,
      ...(dryRun ? { dryRun: true, asIfUnbilled, invoiceDate, dueDate, plan } : {}),
    };
  }

  /**
   * Anula una factura de venta. Conserva la UX del legacy (`Transactions::cancelinvoice`:
   * botón "Anular" + motivo) pero no sus efectos destructivos. El legacy borraba los pagos
   * (`DELETE FROM transactions`), no validaba nada (permitía anular una pagada y duplicaba
   * el stock devuelto al anular dos veces), no recalculaba el saldo del cliente y ponía
   * `facturacion_electronica = NULL`, con lo que la factura quedaba viva ante la DIAN y
   * volvía a ser candidata a timbrado.
   *
   * Aquí: los pagos se anulan con rastro (`Voiding`), es idempotente, se recalcula el saldo
   * y se bloquea si la factura ya fue timbrada y todavía no tiene su nota crédito DIAN.
   * Los montos (subtotal/tax/total) NO se ponen en cero: la factura sale de cartera por
   * `status = CANCELED` (todas las consultas filtran `DUE`/`PARTIAL`) y así el documento
   * conserva sus valores reales para los reportes fiscales.
   */
  async voidInvoice(id: string, dto: VoidInvoiceDto, user: AuthUser) {
    const inv = await this.prisma.subInvoice.findUnique({
      where: { id },
      include: {
        transactions: { where: { status: 'VIGENTE', category: 'Sales', type: 'INCOME' }, select: { id: true } },
        electronicInvoices: { select: { type: true, dianNumber: true } },
      },
    });
    if (!inv) throw new NotFoundException('Factura no encontrada');
    if (inv.status === 'CANCELED') throw new BadRequestException('La factura ya está anulada');

    // Guard DIAN (el legacy no lo tenía): una factura ya timbrada sólo se anula después
    // de emitir su nota crédito electrónica.
    const stamped = inv.electronicInvoices.some((e) => e.type === 'FACTURADA' && e.dianNumber);
    const credited = inv.electronicInvoices.some((e) => e.type === 'NOTA_CREDITO' && e.dianNumber);
    if (stamped && !credited) {
      throw new BadRequestException(
        'La factura ya fue emitida ante la DIAN. Emita primero la nota crédito electrónica y luego anule.',
      );
    }

    const before = {
      status: inv.status,
      total: num(inv.total),
      paidAmount: num(inv.paidAmount),
      notes: inv.notes,
      ron: inv.ron,
      voidedPayments: inv.transactions.length,
    };

    await this.prisma.$transaction(async (tx) => {
      // Reversa de cada pago con rastro. Debe ir ANTES de marcar la factura: cada reverso
      // recalcula paidAmount y la deja en DUE/PARTIAL.
      for (const t of inv.transactions) {
        await this.cobranzas.voidTransactionTx(
          tx, t.id, { reason: `Anulación de la factura ${inv.tid}`, detail: dto.reason }, user,
        );
      }
      await tx.subInvoice.update({
        where: { id },
        data: { status: 'CANCELED', ron: 'ANULADO', notes: dto.reason },
      });
      await tx.auditLog.create({
        data: {
          action: 'VOID', entity: 'SubInvoice', entityId: id,
          before, after: { status: 'CANCELED', ron: 'ANULADO', reason: dto.reason, by: user?.name ?? user?.email ?? null },
        },
      });
    });
    return { id, tid: inv.tid, status: 'CANCELED', voidedPayments: inv.transactions.length };
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

      // Retención (opcional). Paridad legacy: se guarda el TIPO en la línea y también en
      // el header (`invoices.tipo_retencion`), donde la última nota pisa a la anterior;
      // el VALOR es el `amount` que digitó el usuario — el legacy no lo calcula, y los
      // porcentajes sólo se aplican al armar el payload de Siigo.
      const retention = dto.retentionType ? RETENTION_LABEL_TO_ENUM[dto.retentionType] : null;

      await tx.subInvoiceItem.create({
        data: {
          invoiceId, productId: 0, productName: product,
          description: dto.description ?? product,
          qty: 1, price, taxRate: 0, subtotal: price, taxTotal: 0, discountTotal: 0,
          retentionType: retention,
          createdByUserId: authorLegacyId,
        },
      });
      await tx.subInvoice.update({
        where: { id: invoiceId },
        data: {
          subtotal, total, status, itemsCount: { increment: 1 },
          ...(retention ? { retentionType: retention } : {}),
        },
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
