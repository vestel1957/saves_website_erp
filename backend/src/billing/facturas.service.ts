import { BadRequestException, ConflictException, NotFoundException } from '../core/http/errores';
import { InvoiceRon, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { orden } from '../common/pagination-params';
import { AuthUser } from '../auth/current-user.decorator';
import { PostingService } from '../accounting/posting.service';
import { CobranzasService } from '../treasury/cobranzas.service';
import {
  AsignarServicioDto, CreateInvoiceDto, CreateNoteDto, CreateNotesBulkDto, GenerateInvoicesDto, InvoiceItemDto,
  RETENTION_LABEL_TO_ENUM, UpdateInvoiceDto, VoidInvoiceDto,
} from './dto/facturas.dto';
import type { SubscribersService } from '../subscribers/subscribers.service';
import { num, round2 } from '../common/money';
import { aplicarAnticipos } from './anticipos';
import { aplicarNotaEnTx } from './nota-en-tx';
import { copHistorial, movimientoDeAuditoria, movimientoDeNota, type Movimiento } from './historial-factura';
import { nextTid, TID_SEQ } from '../common/tid';
import { subName } from '../common/subscriber-name';
import { exigirSedeSuscriptor, sedesDe } from '../common/sede-scope';
import { planDeUltimaFactura } from './plan-facturable';


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
  /** true = el plan no salió de SubscriberService sino de su última factura. */
  planDeUltimaFactura?: boolean;
  /** Saldo a favor del cliente imputado a esta factura al nacer (pago adelantado). */
  anticipo?: number;
  items?: { productName: string | null; qty: number; price: number; taxRate: number; taxTotal: number }[];
};

/** Línea de servicio derivada (misma forma que SubscriberService en la corrida). */

/** Escritura de facturación (Cobranza): crear factura, generar en lote y notas C/D. */
export class FacturasService {
  /**
   * Cerrojo de una sola corrida de facturación que ESCRIBE a la vez. Evita que el
   * cron del día 1 y un disparo manual (o dos manuales) lean `alreadyBilled` antes
   * de que el otro escriba y generen la mensualidad DOS veces al mismo abonado.
   * Un flag en memoria basta porque pm2 corre `instances: 1` (un solo proceso) y el
   * event loop hace atómico el "comprobar y marcar". Si algún día se escala a más de
   * una instancia, esto debe pasar a un advisory lock de Postgres.
   */
  private billingRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingService,
    private readonly cobranzas: CobranzasService,
    /**
     * Para "asignar servicio": el plan del abonado se cambia por el MISMO camino que
     * desde su ficha (snapshot en `SubscriberService` + perfil al router), no con una
     * segunda copia de esa lógica que se quedaría atrás a la primera diferencia.
     */
    private readonly subscribers: SubscribersService,
  ) {}

  /** Consecutivo de factura. Secuencia de Postgres: atómica, sin carrera. Ver common/tid.ts. */
  private nextTid(tx: Tx): Promise<number> {
    return nextTid(tx, TID_SEQ.subInvoice);
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
        productName: it.productName, productId: it.productId ?? 0,
        description: it.description ?? it.productName ?? 'Servicio',
        qty: it.qty || 1, price: num(it.price), taxRate: num(it.taxRate),
      })),
    };
  }

  /**
   * Facturas de un cliente para elegir sobre cuál se aplica una nota.
   *
   * Por defecto sólo las que DEBE (DUE/PARTIAL), que es el caso normal: la nota
   * crédito rebaja lo que está por cobrar. `scope=all` trae también las pagadas
   * y anuladas, porque a veces hay que ajustar una factura ya saldada (retención
   * que llega después) y el legacy lo permitía escribiendo el número a mano.
   */
  async subscriberInvoices(subscriberId: string, scope: string | undefined, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, subscriberId);
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: {
        id: true, abonado: true, docNumber: true, balance: true,
        firstName: true, secondName: true, lastName1: true, lastName2: true,
        companyName: true, fullName: true,
      },
    });
    if (!sub) throw new NotFoundException('Cliente no encontrado');

    const todas = scope === 'all';
    const rows = await this.prisma.subInvoice.findMany({
      where: { subscriberId, ...(todas ? {} : { status: { in: ['DUE', 'PARTIAL'] } }) },
      orderBy: [{ invoiceDate: 'desc' }, { tid: 'desc' }],
      // Con `all` el histórico de un cliente viejo son cientos de filas y el
      // selector no las necesita: las últimas 60 cubren de sobra el ajuste.
      take: todas ? 60 : 200,
      select: {
        id: true, tid: true, invoiceDate: true, dueDate: true,
        total: true, paidAmount: true, status: true,
      },
    });

    const items = rows.map((i) => ({
      id: i.id, tid: i.tid, date: i.invoiceDate, dueDate: i.dueDate,
      total: num(i.total), paid: num(i.paidAmount),
      balance: round2(num(i.total) - num(i.paidAmount)),
      status: i.status,
    }));

    return {
      subscriberId: sub.id,
      name: subName(sub) ?? 'Sin nombre',
      abonado: sub.abonado,
      docNumber: sub.docNumber,
      balance: num(sub.balance),
      totalDebt: round2(items.filter((i) => i.status === 'DUE' || i.status === 'PARTIAL').reduce((s, i) => s + i.balance, 0)),
      scope: todas ? 'all' : 'due',
      items,
    };
  }

  /** Crear una factura para un cliente. */
  async createInvoice(dto: CreateInvoiceDto, user: AuthUser) {
    if (!dto.items?.length) throw new BadRequestException('La factura no tiene ítems');
    // La cajera puede facturar en ventanilla (2026-08-27), pero sólo a clientes de SU
    // sede: sin esto, el alcance por sede que respetan el listado y el detalle se
    // puenteaba escribiendo otro `subscriberId` en el cuerpo.
    await exigirSedeSuscriptor(this.prisma, user, dto.subscriberId);
    const subscriber = await this.prisma.subscriber.findUnique({ where: { id: dto.subscriberId }, select: { id: true, branchId: true, eInvoice: true, status: true } });
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
          // Fija = cargo puntual (instalación, reconexión, venta); Recurrente = la
          // mensualidad del servicio, que es la que lleva periodo y la que el recibo
          // de caja rotula por mes. Ver `periodoFacturado` y `conceptoFactura`.
          status: 'DUE', kind: dto.kind ?? 'FIJA',
          // Estado del cliente estampado en la factura (paridad legacy `invoices.ron`):
          // el perfil del legacy y el detalle pintan el estado desde la ÚLTIMA factura,
          // así que sin esto el cliente queda "sin estado" allá. INACTIVO no existe en
          // InvoiceRon → va null.
          ron: subscriber.status === 'INACTIVO' ? null : (subscriber.status as unknown as InvoiceRon),
          eInvoiceFlag: subscriber.eInvoice ? 'Crear Factura Electronica' : null,
          itemsCount: rows.length, notes: dto.notes ?? null,
          items: {
            create: rows.map((r) => ({
              // El concepto (`productName`) es lo que leen los reportes de ventas; si la
              // línea se escribió a mano, la descripción ES el concepto.
              productId: r.productId ?? 0, productName: r.productName ?? r.description ?? null, description: r.description,
              qty: r.qty, price: r.price, taxRate: r.taxRate,
              subtotal: r.subtotal, taxTotal: r.taxTotal, discountTotal: 0,
              createdByUserId: null,
            })),
          },
        },
      });
      // Igual que en la corrida: si el cliente traía saldo a favor, se imputa a esta
      // factura en el mismo commit. Cubre la factura que se emite a mano (ventanilla,
      // plantilla recurrente) además de la del día 1.
      const anticipo = await aplicarAnticipos(tx, subscriber.id, { fecha: invoiceDate });
      return { id: inv.id, tid: inv.tid, total, subtotal, tax, anticipo: anticipo.total };
    });
    // Contabilización automática (DR cartera, CR ingreso + IVA). Idempotente; no rompe el flujo.
    await this.posting.postSalesInvoice({
      sourceId: result.id, date: invoiceDate, number: result.tid,
      subtotal: result.subtotal, tax: result.tax, createdBy: user?.name ?? user?.email ?? null,
    });
    return result;
  }

  /**
   * Editar una factura ya emitida: reemplaza sus conceptos y recalcula los totales.
   *
   * Paridad legacy (`Invoices::editaction`): allá el formulario de edición borra los
   * renglones de la factura y reinserta los que llegan, y reescribe el encabezado con
   * los totales recalculados. Aquí se hace lo mismo, con lo que el legacy no tenía:
   *
   *   · Se bloquea si ya fue timbrada ante la DIAN (ese documento no se toca: va por
   *     nota crédito) o si está anulada.
   *   · No se puede dejar la factura por debajo de lo ya pagado — el legacy sí dejaba,
   *     y la factura quedaba con saldo a favor invisible.
   *   · Las notas crédito/débito de la factura NO se tocan: son documentos aparte
   *     (una promoción aplicada, una retención) y borrarlas al editar el concepto
   *     sería deshacer un descuento sin dejar rastro. Siguen sumando al total.
   *   · Queda auditoría (antes/después + motivo) y ajuste contable por el delta.
   *
   * La factura queda marcada como editada aquí (`editedAt`): el sync de ida compara
   * la huella contra el MySQL vivo y, sin esa marca, restauraría los valores del
   * legacy y devolvería los renglones viejos en la siguiente pasada.
   */
  async updateInvoice(id: string, dto: UpdateInvoiceDto, user: AuthUser) {
    if (!dto.items?.length) throw new BadRequestException('La factura no puede quedar sin conceptos');

    const inv = await this.prisma.subInvoice.findUnique({
      where: { id },
      include: {
        items: { orderBy: { id: 'asc' } },
        electronicInvoices: { select: { type: true, dianNumber: true } },
      },
    });
    if (!inv) throw new NotFoundException('Factura no encontrada');
    await exigirSedeSuscriptor(this.prisma, user, inv.subscriberId);

    if (inv.status === 'CANCELED') throw new BadRequestException('La factura está anulada: no se puede editar');
    if (inv.electronicInvoices.some((e) => e.type === 'FACTURADA' && e.dianNumber)) {
      throw new BadRequestException(
        'La factura ya fue emitida ante la DIAN y no se puede modificar. Emita una nota crédito para ajustarla.',
      );
    }

    // Notas crédito/débito de la factura: se conservan tal cual y siguen contando.
    const esNota = (nombre: string | null) => nombre === 'Nota Credito' || nombre === 'Nota Debito';
    const notas = inv.items.filter((it) => esNota(it.productName));
    const notasSubtotal = round2(notas.reduce((s, it) => s + num(it.subtotal), 0));

    const { rows, subtotal: itemsSubtotal, tax } = this.computeTotals(dto.items);
    const subtotal = Math.max(0, round2(itemsSubtotal + notasSubtotal));
    const total = Math.max(0, round2(subtotal + tax));
    const paid = num(inv.paidAmount);
    if (total < paid) {
      throw new BadRequestException(
        `La factura ya tiene ${paid.toLocaleString('es-CO')} pagados y no puede quedar por debajo de esa cifra. ` +
        'Anule el pago o emita una nota crédito.',
      );
    }

    const invoiceDate = dto.invoiceDate ? dateOnly(dto.invoiceDate) : inv.invoiceDate;
    const dueDate = dto.dueDate ? dateOnly(dto.dueDate) : inv.dueDate;
    const status = total <= paid ? 'PAID' : paid > 0 ? 'PARTIAL' : 'DUE';
    const edit = (inv.editCount ?? 0) + 1;

    const before = {
      subtotal: num(inv.subtotal), tax: num(inv.tax), total: num(inv.total), status: inv.status,
      kind: inv.kind, invoiceDate: inv.invoiceDate, dueDate: inv.dueDate, notes: inv.notes,
      items: inv.items.map((it) => ({
        product: it.productName, description: it.description, qty: it.qty,
        price: num(it.price), taxRate: num(it.taxRate), subtotal: num(it.subtotal),
      })),
    };

    await this.prisma.$transaction(async (tx) => {
      // Fuera los conceptos viejos (las notas se quedan) y entran los nuevos, igual
      // que hace el legacy al editar. Los que venían del legacy se van con su
      // `legacyId`: por eso el sync tiene que saltarse esta factura.
      await tx.subInvoiceItem.deleteMany({
        where: { invoiceId: id, id: { notIn: notas.map((n) => n.id) } },
      });
      await tx.subInvoiceItem.createMany({
        data: rows.map((r) => ({
          invoiceId: id,
          productId: r.productId ?? 0,
          productName: r.productName ?? r.description ?? null,
          description: r.description,
          qty: r.qty, price: r.price, taxRate: r.taxRate,
          subtotal: r.subtotal, taxTotal: r.taxTotal, discountTotal: 0,
        })),
      });
      await tx.subInvoice.update({
        where: { id },
        data: {
          invoiceDate, dueDate, subtotal, tax, total, status,
          ...(dto.kind ? { kind: dto.kind } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes || null } : {}),
          itemsCount: rows.length + notas.length,
          editedAt: new Date(), editedBy: user?.name ?? user?.email ?? null,
          editCount: edit,
        },
      });
      await tx.auditLog.create({
        data: {
          action: 'UPDATE', entity: 'SubInvoice', entityId: id,
          before,
          after: {
            subtotal, tax, total, status,
            kind: dto.kind ?? inv.kind, invoiceDate, dueDate,
            notes: dto.notes !== undefined ? dto.notes || null : inv.notes,
            reason: dto.reason?.trim() || null,
            by: user?.name ?? user?.email ?? null,
            items: rows.map((r) => ({
              product: r.productName ?? r.description, description: r.description,
              qty: r.qty, price: r.price, taxRate: r.taxRate, subtotal: r.subtotal,
            })),
          },
        },
      });
    });

    // Ajuste contable por la diferencia. Sólo mueve el mayor si la factura tenía
    // asiento (las traídas del legacy no lo tienen) y si algo cambió de valor.
    await this.posting.postSalesInvoiceAdjustment({
      sourceId: id, date: invoiceDate, number: inv.tid, edit,
      deltaSubtotal: round2(subtotal - num(inv.subtotal)),
      deltaTax: round2(tax - num(inv.tax)),
      createdBy: user?.name ?? user?.email ?? null,
    });

    return {
      id, tid: inv.tid, subtotal, tax, total, status,
      balance: round2(total - paid),
      itemsCount: rows.length + notas.length,
      notesKept: notas.length,
      previousTotal: num(inv.total),
      editCount: edit,
    };
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

    // Serializar solo las corridas que escriben. dryRun no toca la BD → puede correr
    // en paralelo sin riesgo. El "comprobar y marcar" es atómico (no hay await entre
    // medias) porque el event loop es de un solo hilo.
    if (!dryRun) {
      if (this.billingRunning) {
        throw new ConflictException('Ya hay una generación de facturas en curso. Espera a que termine para evitar facturas duplicadas.');
      }
      this.billingRunning = true;
    }
    try {
      return await this.generateLocked(dto, user, { dryRun, asIfUnbilled });
    } finally {
      if (!dryRun) this.billingRunning = false;
    }
  }

  /**
   * Plan facturable de los abonados SIN fila en `SubscriberService`, derivado de sus
   * facturas. Vive en `plan-facturable.ts` desde 2026-08-25: lo necesita también el
   * prorrateo de reconexión —y son justo los mismos clientes, porque el hueco de la
   * migración se quedó en los que NO estaban en ACTIVO— y dos copias de esta consulta
   * es exactamente cómo se empiezan a cobrar dos precios distintos por el mismo plan.
   */
  private planDeUltimaFactura(ids: string[], monthStart: Date, before?: Date) {
    return planDeUltimaFactura(this.prisma, ids, monthStart, before);
  }

  /** Cuerpo real de la generación. Se llama SIEMPRE bajo el cerrojo de `generate`. */
  private async generateLocked(
    dto: GenerateInvoicesDto,
    user: AuthUser,
    { dryRun, asIfUnbilled }: { dryRun: boolean; asIfUnbilled: boolean },
  ) {
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
        status: true,           // se estampa en la factura como `ron` (estado del cliente)
        previousStatus: true,   // ultimo_estado (guard de reactivación)
        statusChangedAt: true,  // fecha_cambio
        services: {
          where: { status: 'ACTIVO', price: { gt: 0 } },
          select: { kind: true, planName: true, price: true, taxRate: true, qty: true },
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
    //
    // DISTINCT ON en SQL crudo a propósito: el `distinct` de Prisma (sin
    // nativeDistinct) deduplica EN MEMORIA, o sea que aquí se traía el histórico
    // completo de facturas de los ~5.000 objetivo (~236.000 filas) al proceso.
    // Eso pasó de 512 MB y PM2 mató el backend en plena corrida del día 1
    // (2026-08-01: quedó en 697 de 4.583). En SQL vuelve una fila por abonado.
    type PromoRow = {
      id: string; subscriberId: string; promo: number | null; promo2: number | null;
      promoModifiedDate: Date | null; promo2ModifiedDate: Date | null;
    };
    const promoRows = subs.length ? await this.prisma.$queryRaw<PromoRow[]>`
      SELECT DISTINCT ON (i."subscriberId")
             i.id, i."subscriberId", i.promo, i.promo2,
             i."promoModifiedDate", i."promo2ModifiedDate"
        FROM "SubInvoice" i
       WHERE i."subscriberId" IN (${Prisma.join(subs.map((s) => s.id))})
         ${asIfUnbilled ? Prisma.sql`AND i."invoiceDate" < ${monthStart}` : Prisma.empty}
       ORDER BY i."subscriberId", i."invoiceDate" DESC NULLS LAST, i.tid DESC` : [];
    const promoBySub = new Map(promoRows.map((r) => [r.subscriberId, r]));
    const curYm = `${invoiceDate.getUTCFullYear()}-${invoiceDate.getUTCMonth()}`;
    const ymOf = (d: Date | null | undefined) => (d ? `${d.getUTCFullYear()}-${d.getUTCMonth()}` : null);

    // Respaldo para los abonados sin SubscriberService (hueco de la migración):
    // su plan se deriva de sus facturas, igual que en la ficha. Solo se consulta
    // para quienes de verdad lo necesitan y aún no tienen factura del mes.
    // Los PUNTOS no cuentan como "tiene plan": son un accesorio que se suma al
    // servicio, no un servicio en sí. Sin esta distinción, un abonado con solo la
    // fila de puntos se daba por resuelto y se quedaba sin su TV/internet.
    const planDe = <T extends { kind: string }>(s: { services: T[] }) => s.services.filter((x) => x.kind !== 'PUNTOS');
    const sinServicio = subs
      .filter((s) => !planDe(s).length && !alreadyBilled.has(s.id))
      .map((s) => s.id);
    const planFactura = await this.planDeUltimaFactura(sinServicio, monthStart, asIfUnbilled ? monthStart : undefined);

    // ¿Quién trae saldo a favor sin imputar? Una sola consulta para todo el lote: son
    // ~5.000 abonados y preguntarlo uno a uno metía otros 5.000 viajes a la BD en la
    // corrida del día 1. Los que estén aquí verán su factura recién nacida pagada (del
    // todo o en parte) con lo que ya habían adelantado. Ver `aplicarAnticipos`.
    const conAnticipo = subs.length ? new Set(
      (await this.prisma.customerAdvance.findMany({
        where: { status: 'ABIERTO', subscriberId: { in: subs.map((s) => s.id) } },
        select: { subscriberId: true },
      })).map((r) => r.subscriberId),
    ) : new Set<string>();

    let generated = 0, skipped = 0, failed = 0;
    let anticiposAplicados = 0, anticiposMonto = 0;
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
      // Sin servicios activos con precio → se intenta el plan de sus facturas;
      // si tampoco hay de dónde derivarlo, nada que cobrar este mes.
      // El plan sale de SubscriberService o, si no lo tiene, de sus facturas. Los
      // puntos adicionales (decos de TV) van aparte y se suman a cualquiera de los
      // dos caminos: el respaldo por nombre de plan nunca los ve, porque "Punto
      // Adicional" no es un Plan del catálogo.
      const conPlan = planDe(s);
      const puntos = s.services.filter((x) => x.kind === 'PUNTOS');
      const base = conPlan.length ? conPlan : (planFactura.get(s.id) ?? []);
      const servicios: { kind: string; planName: string | null; price: Prisma.Decimal | number | null; taxRate: Prisma.Decimal | number | null; qty?: number }[] =
        [...base, ...puntos];
      const deUltimaFactura = !conPlan.length && base.length > 0;
      if (!servicios.length) { skip(s.id, 'NO_SERVICES'); continue; }

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
      // `invoices.puntos` del legacy: la ficha y el recibo lo leen de la cabecera.
      const nPuntos = puntos.reduce((n, x) => n + (x.qty ?? 1), 0) || null;
      const items: InvoiceItemDto[] = servicios.map((svc) => {
        const name = svc.planName || svc.kind;
        if (svc.kind === 'INTERNET') serviceCombo = svc.planName ?? serviceCombo;
        if (svc.kind === 'TV') serviceTv = svc.planName ?? serviceTv;
        return { productName: name, description: name, qty: svc.qty ?? 1, price: num(svc.price), taxRate: num(svc.taxRate) };
      });
      const { rows, subtotal, tax, total } = this.computeTotals(items);
      const shape = {
        subscriberId: s.id, action: 'BILL' as const,
        subtotal, tax, total, serviceCombo, serviceTv,
        ...(deUltimaFactura ? { planDeUltimaFactura: true } : {}),
        items: rows.map((r) => ({ productName: r.productName ?? null, qty: r.qty, price: r.price, taxRate: r.taxRate, taxTotal: r.taxTotal })),
      };

      // Simulación: se calculó todo el lote, no se escribe nada.
      if (dryRun) { generated++; bill(shape); continue; }

      try {
        const inv = await this.prisma.$transaction(async (tx) => {
          const tid = await this.nextTid(tx);
          const creada = await tx.subInvoice.create({
            data: {
              tid, subscriberId: s.id, invoiceDate, dueDate,
              subtotal, tax, total, paidAmount: 0, status: 'DUE', kind: 'RECURRENTE',
              // Estado del cliente al facturar (paridad legacy `invoices.ron`): el
              // legacy pinta el estado del perfil desde la última factura. La corrida
              // solo alcanza ACTIVO/COMPROMISO, así que el mapeo es directo.
              ron: s.status === 'COMPROMISO' ? 'COMPROMISO' : 'ACTIVO',
              itemsCount: rows.length,
              serviceCombo, serviceTv, puntos: nPuntos,
              // Alimenta la cola de timbrado DIAN si el abonado factura electrónicamente.
              eInvoiceFlag: s.eInvoice ? 'Crear Factura Electronica' : null,
              items: { create: rows.map((r) => ({
                productId: 0, productName: r.productName ?? null, description: r.description,
                qty: r.qty, price: r.price, taxRate: r.taxRate,
                subtotal: r.subtotal, taxTotal: r.taxTotal, discountTotal: 0,
              })) },
            },
          });
          // Saldo a favor → a esta factura, en el mismo commit que la crea: si el cliente
          // ya pagó este mes por adelantado en ventanilla, nace pagada y no aparece
          // debiendo. Es el `procesar_pagos_adelantados` que el legacy corre al final de
          // su corrida (`Invoices_model.php:1439`).
          const anticipo = conAnticipo.has(s.id)
            ? await aplicarAnticipos(tx, s.id, { fecha: invoiceDate })
            : null;
          return { creada, anticipo };
        });
        generated++;
        if (inv.anticipo?.total) { anticiposAplicados++; anticiposMonto = round2(anticiposMonto + inv.anticipo.total); }
        bill({ ...shape, tid: inv.creada.tid, ...(inv.anticipo?.total ? { anticipo: inv.anticipo.total } : {}) });
        // Contabilización automática de la factura recurrente (idempotente; no rompe el lote).
        await this.posting.postSalesInvoice({
          sourceId: inv.creada.id, date: invoiceDate, number: inv.creada.tid,
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
      // Cuántas nacieron ya pagadas (del todo o en parte) con saldo a favor del cliente.
      anticipos: anticiposAplicados, anticiposMonto,
      ...(dryRun ? { dryRun: true, asIfUnbilled, invoiceDate, dueDate, plan } : {}),
    };
  }

  /**
   * La factura de la que el LEGACY lee el plan del abonado para su corrida mensual.
   *
   * Allá el plan no vive en el cliente: `Invoices_model.php:1130` recorre las facturas
   * del abonado por `invoicedate DESC` y **se salta las fijas y las notas**; la primera
   * recurrente que encuentra es la que le dicta `combo`/`television`/`puntos` al mes
   * siguiente. Por eso "asignar servicio" sobre una factura fija (una instalación, un
   * traslado) no le cambiaría el plan a nadie: hay que escribir sobre ésta.
   *
   * Devuelve null si el abonado todavía no tiene ninguna recurrente (cliente nuevo,
   * facturado sólo aquí): entonces el legacy no tiene dónde leerlo y basta con dejar
   * el plan en `SubscriberService`, que es lo que factura este sistema.
   */
  private facturaQueDictaElPlan(subscriberId: string) {
    return this.prisma.subInvoice.findFirst({
      where: { subscriberId, kind: 'RECURRENTE', status: { not: 'CANCELED' } },
      orderBy: [{ invoiceDate: 'desc' }, { tid: 'desc' }],
      select: { id: true, tid: true, invoiceDate: true, legacyId: true, serviceTv: true, serviceCombo: true, puntos: true },
    });
  }

  /**
   * Historial de la factura: qué se le hizo, quién y por qué.
   *
   * El motivo del cambio se pedía desde el 27-08-2026 al editar y al anular, pero
   * moría dentro del JSON de `AuditLog`: en pantalla sólo quedaba el rótulo
   * "Editada" con la fecha, sin decir qué renglón se tocó ni por qué. Esto lo saca
   * a la luz, juntando las tres cosas que mueven una factura:
   *
   *   · la auditoría (edición, anulación, servicio asignado),
   *   · las notas crédito/débito (que cambian el total y no pasan por la auditoría:
   *     las aplica `aplicarNotaEnTx` dentro de la transacción de quien llame),
   *   · la emisión, que es el punto de partida.
   *
   * Sólo lectura. El formato de las frases vive en `historial-factura.ts`.
   */
  async historial(id: string, user?: AuthUser): Promise<{ items: Movimiento[] }> {
    const inv = await this.prisma.subInvoice.findUnique({
      where: { id },
      select: {
        id: true, tid: true, subscriberId: true, createdAt: true, invoiceDate: true,
        issuerUserId: true, total: true, legacyId: true,
      },
    });
    if (!inv) throw new NotFoundException('Factura no encontrada');
    await exigirSedeSuscriptor(this.prisma, user, inv.subscriberId);

    const [logs, notas] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: { entity: 'SubInvoice', entityId: id },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.subInvoiceItem.findMany({
        where: { invoiceId: id, productName: { in: ['Nota Credito', 'Nota Debito'] } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    // El autor de una nota y el emisor de la factura son ids de usuario del legacy
    // (`aauth_users`), no de este sistema: se traducen por `Staff.legacyId`.
    const legacyIds = [...new Set(
      [inv.issuerUserId, ...notas.map((n) => n.createdByUserId)].filter((v): v is number => v != null),
    )];
    const staff = legacyIds.length
      ? await this.prisma.staff.findMany({ where: { legacyId: { in: legacyIds } }, select: { legacyId: true, name: true } })
      : [];
    const nombreDe = (legacyId: number | null) =>
      (legacyId != null ? staff.find((s) => s.legacyId === legacyId)?.name ?? null : null);

    const items: Movimiento[] = [
      ...logs.map(movimientoDeAuditoria),
      ...notas.map((n) => movimientoDeNota({
        id: n.id, createdAt: n.createdAt, productName: n.productName,
        description: n.description, price: num(n.price), autor: nombreDe(n.createdByUserId),
      })),
      {
        id: `emitida-${inv.id}`,
        // La traída del legacy no tiene fecha de creación fiable (`createdAt` es la de
        // la importación): para esas manda la fecha de la factura.
        fecha: inv.legacyId != null ? inv.invoiceDate : inv.createdAt,
        tipo: 'EMITIDA' as const,
        titulo: 'Factura emitida',
        por: nombreDe(inv.issuerUserId),
        motivo: null,
        cambios: [`Total ${copHistorial(num(inv.total))}`],
      },
    ].sort((a, b) => b.fecha.getTime() - a.fecha.getTime());

    return { items };
  }

  /**
   * Qué se le va a cobrar al abonado la próxima facturación, para pintarlo en la ficha
   * de la factura junto a lo que ESTA cobró.
   *
   * Sale de `SubscriberService` —la fuente de la corrida de este sistema—; cuando el
   * abonado no tiene esas filas (el hueco de la migración: sólo se poblaron los ACTIVO)
   * se deriva de sus facturas igual que hace la corrida, para no enseñar "sin servicio"
   * a alguien que lleva años pagando.
   */
  async servicioAsignado(invoiceId: string, user?: AuthUser) {
    const inv = await this.prisma.subInvoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, subscriberId: true, kind: true, serviceAssignedAt: true, serviceAssignedBy: true },
    });
    if (!inv) throw new NotFoundException('Factura no encontrada');
    await exigirSedeSuscriptor(this.prisma, user, inv.subscriberId);

    const [contratados, dicta] = await Promise.all([
      this.prisma.subscriberService.findMany({
        where: { subscriberId: inv.subscriberId },
        select: { kind: true, planId: true, planName: true, price: true, taxRate: true, qty: true, status: true },
      }),
      this.facturaQueDictaElPlan(inv.subscriberId),
    ]);

    // Sin filas propias, el plan se deduce de las facturas (mismo criterio que la corrida).
    let derivado = false;
    let servicios = contratados.map((s) => ({
      kind: s.kind as string, planId: s.planId, planName: s.planName,
      price: num(s.price), taxRate: num(s.taxRate), qty: s.qty, status: s.status as string,
    }));
    if (!servicios.filter((s) => s.kind !== 'PUNTOS').length) {
      const hoy = new Date();
      const mes = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), 1));
      const map = await this.planDeUltimaFactura([inv.subscriberId], mes);
      const dedu = (map.get(inv.subscriberId) ?? []).map((s) => ({
        kind: s.kind, planId: null as string | null, planName: s.planName,
        price: s.price, taxRate: s.taxRate, qty: 1, status: 'ACTIVO',
      }));
      if (dedu.length) { servicios = [...dedu, ...servicios]; derivado = true; }
    }

    return {
      servicios, derivado,
      assignedAt: inv.serviceAssignedAt, assignedBy: inv.serviceAssignedBy,
      // Cuál es la factura que manda en el legacy y si es ésta en la que estamos.
      dicta: dicta ? { id: dicta.id, tid: dicta.tid, date: dicta.invoiceDate, esEsta: dicta.id === inv.id } : null,
    };
  }

  /**
   * "Asignar servicio": deja fijado el plan que se le cobrará al abonado de la próxima
   * facturación en adelante. Es el `ASIGNAR SERVICIO` del `invoices/edit.php` del legacy,
   * el sitio donde allá se registra que un cliente cambió de plan.
   *
   * NO reprecia esta factura ni ninguna ya emitida: sólo manda de aquí en adelante.
   *
   * Escribe en los DOS sitios donde hoy vive esa información, porque los dos sistemas
   * facturan y cada uno lee el suyo:
   *   1) `SubscriberService` del abonado — la fuente de la corrida de este sistema, de la
   *      ficha del cliente y del prorrateo. Pasa por `SubscribersService` para que el
   *      perfil del plan se empuje al router igual que al cambiar el plan desde la ficha.
   *   2) `television`/`combo`/`puntos` de la última factura RECURRENTE del abonado — la
   *      única fuente que tiene el legacy (ver `facturaQueDictaElPlan`). Queda marcada
   *      con `serviceAssignedAt` para que el writeback empuje esas tres columnas y el
   *      sync de ida no las devuelva al valor viejo.
   */
  async asignarServicio(id: string, dto: AsignarServicioDto, user: AuthUser) {
    if (dto.internet === undefined && dto.tv === undefined && dto.puntos === undefined) {
      throw new BadRequestException('No se indicó ningún servicio que cambiar.');
    }

    const inv = await this.prisma.subInvoice.findUnique({
      where: { id },
      select: { id: true, tid: true, subscriberId: true, serviceTv: true, serviceCombo: true, puntos: true },
    });
    if (!inv) throw new NotFoundException('Factura no encontrada');
    await exigirSedeSuscriptor(this.prisma, user, inv.subscriberId);

    // Los planes se resuelven ANTES de tocar nada: un id inventado tiene que dejar el
    // abonado como estaba, no a medio cambiar.
    const ids = [dto.internet, dto.tv].filter((v): v is string => !!v && v !== 'no');
    const planes = ids.length
      ? await this.prisma.plan.findMany({ where: { id: { in: ids } }, select: { id: true, kind: true, name: true } })
      : [];
    if (planes.length !== new Set(ids).size) throw new NotFoundException('Uno o más planes no existen.');
    const exigirKind = (planId: string | undefined, kind: 'INTERNET' | 'TV', etiqueta: string) => {
      if (!planId || planId === 'no') return;
      const p = planes.find((x) => x.id === planId)!;
      if (p.kind !== kind) throw new BadRequestException(`“${p.name}” no es un plan de ${etiqueta}.`);
    };
    exigirKind(dto.internet, 'INTERNET', 'internet');
    exigirKind(dto.tv, 'TV', 'televisión');

    const antes = await this.servicioAsignado(id, user);
    const pushRouter = dto.pushRouter !== false;

    // 1) El plan del abonado (lo que factura este sistema).
    const routers: unknown[] = [];
    for (const [valor, kind] of [[dto.internet, 'INTERNET'], [dto.tv, 'TV']] as const) {
      if (valor === undefined) continue;
      if (valor === 'no') { await this.subscribers.removeService(inv.subscriberId, kind, user); continue; }
      // `allowInactive`: aquí no se vende, se corrige. El plan que la factura ya cobra
      // suele ser uno de los ocultos del catálogo (ver `changePlan`).
      const r = await this.subscribers.changePlan(inv.subscriberId, valor, user, { pushRouter, allowInactive: true });
      if (r.router) routers.push(r.router);
    }
    if (dto.puntos !== undefined) await this.subscribers.setPuntos(inv.subscriberId, dto.puntos, user);

    // 2) El snapshot que lee el legacy. Se escribe SIEMPRE sobre la recurrente que manda,
    //    esté o no el usuario parado en ella: en una fija esas columnas no las mira nadie.
    const despues = await this.servicioAsignado(id, user);
    const nombreDe = (kind: string) => despues.servicios.find((s) => s.kind === kind)?.planName ?? null;
    const snapshot = {
      serviceCombo: nombreDe('INTERNET') ?? 'no',
      serviceTv: nombreDe('TV') ?? 'no',
      puntos: despues.servicios.find((s) => s.kind === 'PUNTOS')?.qty ?? 0,
    };
    const dicta = despues.dicta;
    if (dicta) {
      await this.prisma.subInvoice.update({
        where: { id: dicta.id },
        data: { ...snapshot, serviceAssignedAt: new Date(), serviceAssignedBy: user?.name ?? user?.email ?? null },
      });
    }

    await this.prisma.auditLog.create({
      data: {
        action: 'UPDATE', entity: 'SubInvoice', entityId: dicta?.id ?? id,
        before: { servicios: antes.servicios, desdeFactura: inv.tid },
        after: {
          servicios: despues.servicios, snapshot, desdeFactura: inv.tid,
          facturaQueDicta: dicta?.tid ?? null, pushRouter,
          reason: dto.reason?.trim() || null, by: user?.name ?? user?.email ?? null,
        },
      },
    });

    return { ok: true, ...despues, snapshot, routers };
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

    const authorLegacyId = await this.autorDeNota(user);

    return this.prisma.$transaction(async (tx) =>
      aplicarNotaEnTx(tx, invoiceId, { ...dto, amount, authorLegacyId, editedBy: user?.name ?? user?.email ?? null }),
    );
  }

  /**
   * Aplica la MISMA nota a VARIAS facturas de un cliente, en una sola transacción.
   *
   * El reparto (qué monto le toca a cada factura) llega ya hecho desde la pantalla,
   * que es donde se previsualiza; ver `CreateNotesBulkDto`. Aquí se comprueba lo que
   * el cliente del API no puede garantizar:
   *   - que las facturas existan (todas: si falta una, no se aplica ninguna),
   *   - que sean del MISMO abonado — un lote que cruce clientes sería un error de
   *     quien llama y dejaría notas regadas por cartera ajena,
   *   - que ese abonado esté dentro del alcance por sede de quien aplica.
   *
   * Lo de "todo o nada" no es adorno: media depuración de cartera aplicada es peor
   * que ninguna, porque nadie sabe dónde se quedó.
   */
  async createNotes(dto: CreateNotesBulkDto, user: AuthUser) {
    const items = dto.items ?? [];
    if (!items.length) throw new BadRequestException('Elige al menos una factura.');

    // Una misma factura repetida en el lote se aplicaría dos veces sin que nadie lo
    // pidiera (dos clics en la misma fila, o un reparto mal armado).
    const ids = items.map((i) => i.invoiceId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Hay una factura repetida en el lote.');

    for (const it of items) {
      if (!(round2(it.amount) > 0)) throw new BadRequestException('El monto de cada nota debe ser mayor a cero');
    }

    const facturas = await this.prisma.subInvoice.findMany({
      where: { id: { in: ids } },
      select: { id: true, tid: true, subscriberId: true },
    });
    if (facturas.length !== ids.length) throw new NotFoundException('Alguna de las facturas elegidas no existe');

    const subscriberIds = [...new Set(facturas.map((f) => f.subscriberId))];
    if (subscriberIds.length > 1) throw new BadRequestException('Las facturas del lote son de clientes distintos');
    const subscriberId = subscriberIds[0];
    if (!subscriberId) throw new BadRequestException('La factura no tiene cliente');
    await exigirSedeSuscriptor(this.prisma, user, subscriberId);

    const authorLegacyId = await this.autorDeNota(user);
    const editedBy = user?.name ?? user?.email ?? null;
    const tidDe = new Map(facturas.map((f) => [f.id, f.tid]));

    const results = await this.prisma.$transaction(
      async (tx) => {
        const salida = [];
        for (const it of items) {
          const r = await aplicarNotaEnTx(tx, it.invoiceId, {
            type: dto.type,
            amount: round2(it.amount),
            description: dto.description,
            retentionType: dto.retentionType,
            authorLegacyId,
            editedBy,
          });
          salida.push({ ...r, tid: tidDe.get(it.invoiceId) ?? null });
        }
        return salida;
      },
      // 50 notas son ~250 consultas: el tope de 5 s que Prisma pone por defecto a la
      // transacción interactiva se queda corto y el lote moriría a la mitad (bien
      // deshecho, pero sin haber hecho nada).
      { timeout: 60_000, maxWait: 15_000 },
    );

    return {
      count: results.length,
      total: round2(results.reduce((s, r) => s + r.amount, 0)),
      type: dto.type,
      subscriberId,
      results,
    };
  }

  /** Autor (Staff.legacyId) del usuario logueado, para firmar una nota. */
  async autorDeNota(user?: AuthUser): Promise<number | null> {
    if (!user?.email) return null;
    const staff = await this.prisma.staff.findFirst({ where: { email: user.email }, select: { legacyId: true } });
    return staff?.legacyId ?? null;
  }

  /** Listado de notas crédito/débito (ítems pid=0 con producto Nota …). */
  /**
   * Columnas ordenables de la tabla de notas.
   *
   * Una "nota" es en realidad un ítem de factura (`SubInvoiceItem`) cuyo
   * producto es "Nota Credito" / "Nota Debito", así que las claves son campos de
   * ese modelo: el tipo sale de `productName` y el monto de `price`. `sub`
   * (cliente) no está porque el nombre se arma a partir de cuatro campos del
   * suscriptor a través de la factura.
   */
  private static readonly ORDEN_NOTAS = {
    date: 'createdAt', type: 'productName', tid: 'invoice.tid',
    desc: 'description', amount: 'price',
  };

  /**
   * Listado de notas crédito/débito, filtrable.
   *
   * Filtros: texto (factura/cliente/descripción), tipo, SEDE, rango de fechas,
   * quién la registró y rango de monto. Todos son opcionales y se combinan.
   *
   * Acotado por sede (`sedesDe`): la nota cuelga de una factura, y ésta de un
   * suscriptor, así que la sede se filtra por la relación. Hasta ahora la vista
   * no lo aplicaba y una cajera veía las notas de todas las sedes.
   */
  async listNotes(params: {
    page?: number; pageSize?: number; search?: string; type?: string;
    branchId?: string; from?: string; to?: string; authorId?: string;
    montoMin?: string; montoMax?: string;
    sortBy?: string; sortDir?: string;
  }, user?: AuthUser) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));

    // Tipo: CREDITO / DEBITO acota el productName; cualquier otro valor no filtra.
    const t = (params.type || '').toUpperCase();
    const productName =
      t === 'CREDITO' ? { in: ['Nota Credito'] }
      : t === 'DEBITO' ? { in: ['Nota Debito'] }
      : { in: ['Nota Credito', 'Nota Debito'] };

    const where: Prisma.SubInvoiceItemWhereInput = { productName };
    const and: Prisma.SubInvoiceItemWhereInput[] = [];

    // Sede + filtro de sede elegido: se MEZCLAN en un único `subscriber` (si se
    // sobrescribiera, el filtro de la URL puentearía el acotado por sede).
    const sedes = await sedesDe(this.prisma, user);
    const sub: Prisma.SubscriberWhereInput = {};
    if (sedes) sub.branch = { legacyId: { in: sedes } };
    if (params.branchId) sub.branchId = params.branchId;
    if (Object.keys(sub).length) where.invoice = { subscriber: sub };

    // Rango de fechas sobre la fecha de la nota. El `hasta` se estira al final del
    // día: `createdAt` es un timestamp y con la medianoche se perdía ese mismo día.
    const desde = (params.from || '').trim();
    const hasta = (params.to || '').trim();
    if (desde || hasta) {
      where.createdAt = {
        ...(desde ? { gte: new Date(`${desde}T00:00:00.000Z`) } : {}),
        ...(hasta ? { lte: new Date(`${hasta}T23:59:59.999Z`) } : {}),
      };
    }

    // Rango de monto. Se compara en VALOR ABSOLUTO porque las notas crédito se
    // guardan en negativo (y unas pocas viejas del legacy, en positivo): sin las
    // dos ramas, filtrar "de 10.000 a 50.000" no devolvía ninguna crédito.
    const min = Number(params.montoMin);
    const max = Number(params.montoMax);
    const hayMin = Number.isFinite(min) && String(params.montoMin ?? '').trim() !== '';
    const hayMax = Number.isFinite(max) && String(params.montoMax ?? '').trim() !== '';
    if (hayMin || hayMax) {
      const pos = { ...(hayMin ? { gte: min } : {}), ...(hayMax ? { lte: max } : {}) };
      const neg = { ...(hayMax ? { gte: -max } : {}), ...(hayMin ? { lte: -min } : {}) };
      and.push({ OR: [{ price: pos }, { price: neg }] });
    }

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
      // Va dentro del AND (y no en `where.OR`) para que no compita con el resto de
      // condiciones compuestas: buscar tiene que ACOTAR, no ensanchar.
      and.push({ OR: or });
    }

    // El desplegable "Registrada por" se arma con los autores del set SIN ese
    // filtro (si no, al elegir uno desaparecerían los demás de la lista).
    // COPIA del array: `and` sigue creciendo abajo con el filtro de autor y, por
    // referencia, éste se colaría también en el desplegable.
    const whereSinAutor: Prisma.SubInvoiceItemWhereInput = { ...where, ...(and.length ? { AND: [...and] } : {}) };
    const autorId = Number(params.authorId);
    const filtraAutor = Number.isFinite(autorId) && String(params.authorId ?? '').trim() !== '';
    if (filtraAutor) and.push({ createdByUserId: autorId });
    if (and.length) where.AND = and;

    const [rows, total, porTipo, autores] = await Promise.all([
      this.prisma.subInvoiceItem.findMany({
        where, orderBy: orden(params, FacturasService.ORDEN_NOTAS, { createdAt: 'desc' }), skip: (page - 1) * pageSize, take: pageSize,
        include: { invoice: { select: { id: true, tid: true, subscriber: { select: { firstName: true, lastName1: true, companyName: true, fullName: true } } } } },
      }),
      this.prisma.subInvoiceItem.count({ where }),
      // Totales del set filtrado COMPLETO (no sólo de la página), por tipo.
      this.prisma.subInvoiceItem.groupBy({ by: ['productName'], where, _sum: { price: true }, _count: { _all: true } }),
      this.prisma.subInvoiceItem.groupBy({ by: ['createdByUserId'], where: whereSinAutor, _count: { _all: true } }),
    ]);

    // Resolver el autor (createdByUserId = id_usuario_crea legacy) → nombre del
    // empleado. Una sola consulta para la página y para el desplegable.
    const authorIds = [...new Set([
      ...rows.map((it) => it.createdByUserId),
      ...autores.map((a) => a.createdByUserId),
    ].filter((v): v is number => v != null))];
    const staff = authorIds.length
      ? await this.prisma.staff.findMany({ where: { legacyId: { in: authorIds } }, select: { legacyId: true, name: true } })
      : [];
    const authorById = new Map(staff.map((s) => [s.legacyId, s.name]));

    const sumaDe = (nombre: string) => {
      const g = porTipo.find((x) => x.productName === nombre);
      return { monto: Math.abs(num(g?._sum.price)), n: g?._count._all ?? 0 };
    };
    const credito = sumaDe('Nota Credito');
    const debito = sumaDe('Nota Debito');

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
      // Crédito REBAJA y débito RECARGA: el neto es la diferencia.
      sum: { credito: credito.monto, debito: debito.monto, neto: debito.monto - credito.monto },
      count: { credito: credito.n, debito: debito.n },
      autores: autores
        .filter((a) => a.createdByUserId != null)
        .map((a) => ({
          id: a.createdByUserId as number,
          name: authorById.get(a.createdByUserId as number) ?? `Usuario ${a.createdByUserId}`,
          count: a._count._all,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'es')),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }
}

// `aplicarNotaEnTx` se mudó a `nota-en-tx.ts` (ver allí por qué). Se re-exporta para
// que sus importadores de siempre —el recaudo, las promociones— no cambien.
export { aplicarNotaEnTx } from './nota-en-tx';
