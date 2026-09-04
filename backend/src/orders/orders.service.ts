import { BadRequestException, ForbiddenException, NotFoundException } from '../core/http/errores';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { orden } from '../common/pagination-params';
import { AuthUser } from '../auth/current-user.decorator';
import { AddNoteDto, CategoryNameDto, CreateOrderDto, CreateSupplierDto, OrderItemDto, PayOrderDto, ReceiveOrderDto, UpdateOrderDto } from './dto/orders.dto';
import { num, round2 } from '../common/money';
import { nextTid, TID_SEQ } from '../common/tid';
import { ResponsibilityNotifierService } from '../responsibilities/responsibility-notifier.service';
import { SignatureOtpService } from '../common/signature/signature-otp.service';
import { anotarBorradoLegacy } from '../common/legacy-deletion';
import { comprobanteDe } from '../treasury/comprobante-legacy';

const dateOnly = (s?: string) => { const d = s ? new Date(s) : new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); };

// Convención legacy: purchase_items.pid = 0 marca una NOTA (no un producto). Aquí materialLegacy=0.
const NOTE_PID = 0;
const isNote = (it: { materialLegacy: number | null }) => it.materialLegacy === NOTE_PID;
// Notas que restan del total (crédito y retención) vs. suman (débito). Ver Purchase::crear_nota.
const noteSign = (type: string) => (type === 'Nota Debito' ? 1 : -1);

// Estados terminales: ninguna acción de dinero/stock es válida sobre ellos.
const TERMINAL = new Set(['cancelado', 'anulado', 'finalizado']);

// Toda escritura de aquí sobre una orden sella `editedAt` (ver SupplyOrder.editedAt):
// `purchase` se sincroniza desde el MySQL vivo del legacy, y sin el sello la pasada
// le devolvería el estado de allá a una orden que aquí ya se aprobó, recibió o pagó.
// Por eso el `data.editedAt = new Date()` justo antes de cada `supplyOrder.update`.

/** Monto legible para los avisos (mismo formato que usan promociones y campañas). */
const copFmt = (n: number) =>
  new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);

export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly porCargo: ResponsibilityNotifierService,
    private readonly firma: SignatureOtpService,
  ) {}

  // ------------------------------------------------------------------ //
  //  Flujo de aprobación                                               //
  // ------------------------------------------------------------------ //

  /** Umbral desde el cual una orden exige DOS firmas (0 = nunca). Ajuste `purchases.dualApprovalThreshold`. */
  private async dualThreshold(): Promise<number> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: 'purchases.dualApprovalThreshold' } });
    const n = Number(row?.value);
    return Number.isFinite(n) && n >= 0 ? n : 2_000_000;
  }

  /** Bitácora de la orden (rastro de auditoría que el legacy no tenía). */
  private logEvent(
    tx: Prisma.TransactionClient,
    orderId: string,
    e: { action: string; fromStatus?: string | null; toStatus?: string | null; detail?: string | null; user?: AuthUser | null },
  ) {
    return tx.supplyOrderEvent.create({
      data: {
        orderId, action: e.action,
        fromStatus: e.fromStatus ?? null, toStatus: e.toStatus ?? null, detail: e.detail ?? null,
        userId: e.user?.id ?? null, userName: e.user?.name ?? e.user?.email ?? null,
      },
    });
  }

  /**
   * Guarda del flujo nuevo: las órdenes creadas en la app (legacyId null) no se
   * pueden pagar ni recibir sin estar aprobadas. Las migradas del legacy quedan
   * como estaban (allá el flujo era manual y ya son historia).
   */
  private exigirAprobada(order: { legacyId: number | null; status: string }, accion: string) {
    if (TERMINAL.has(order.status)) {
      throw new BadRequestException(`La orden está "${order.status}"; no admite ${accion}.`);
    }
    if (order.legacyId === null && order.status === 'pendiente') {
      throw new BadRequestException(`La orden está pendiente de aprobación; no se puede ${accion} hasta que un autorizador la apruebe.`);
    }
  }

  /**
   * Pide el código de firma para aprobar esta orden: se lo manda al WhatsApp del
   * autorizador y devuelve a qué número salió (enmascarado) y cuándo vence.
   *
   * Se comprueba antes que la orden EXISTA y esté aprobable, para no gastar un
   * mensaje (y la cuota de plantillas) en una orden ya aprobada o cancelada. Y el
   * mensaje lleva el proveedor y el monto: quien recibe el código tiene que poder
   * ver QUÉ está firmando sin volver a la pantalla — es la mitad del valor de
   * mandarlo por otro canal.
   */
  async requestApprovalOtp(id: string, user: AuthUser) {
    const o = await this.prisma.supplyOrder.findUnique({
      where: { id },
      select: { tid: true, status: true, total: true, approvedById: true, supplier: { select: { name: true } } },
    });
    if (!o) throw new NotFoundException('Orden no encontrada');
    if (o.status !== 'pendiente') throw new BadRequestException(`La orden ya está aprobada (estado "${o.status}").`);
    if (o.approvedById === user.id) {
      throw new ForbiddenException('Usted ya firmó esta orden; la segunda aprobación debe darla otra persona.');
    }
    return this.firma.pedir({
      userId: user.id,
      purpose: 'purchase.approve',
      targetId: id,
      detalle: `la orden de compra #${o.tid} de ${o.supplier?.name ?? 'proveedor sin nombre'} por ${copFmt(num(o.total))}`,
    });
  }

  /**
   * Aprueba una orden (1ª o 2ª firma). Bajo el umbral basta una firma; desde el
   * umbral se exigen dos aprobadores DISTINTOS. El permiso `purchases.approve`
   * se verifica en el controller; aquí se valida la mecánica de firmas.
   *
   * La firma se cierra con un código de un solo uso que llega al WhatsApp del
   * autorizador (`signature.otpRequired`). Se consume ANTES de abrir la
   * transacción y a propósito: verificar cuesta un scrypt (~100 ms) y no se va a
   * tener una fila de `SupplyOrder` bloqueada con `FOR UPDATE` mientras se hashea.
   * El precio es que un código puede quedar quemado si la aprobación falla justo
   * después (orden que otro aprobó en ese instante) — se pide otro y ya; lo
   * contrario, un código reusable, sí sería un problema.
   */
  async approve(id: string, user: AuthUser, otp?: string) {
    const { required } = await this.firma.config();
    const firma = required
      ? await this.firma.firmar({ userId: user.id, purpose: 'purchase.approve', targetId: id, code: otp ?? '' })
      : null;

    const threshold = await this.dualThreshold();
    const r = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "SupplyOrder" WHERE id = ${id} FOR UPDATE`;
      const o = await tx.supplyOrder.findUnique({ where: { id } });
      if (!o) throw new NotFoundException('Orden no encontrada');
      if (TERMINAL.has(o.status)) throw new BadRequestException(`La orden está "${o.status}"; no se puede aprobar.`);
      if (o.status !== 'pendiente') throw new BadRequestException(`La orden ya está aprobada (estado "${o.status}").`);

      const total = num(o.total);
      const needsTwo = threshold > 0 && total >= threshold;
      // Cómo se firmó, para la bitácora: es lo que se va a mirar el día que
      // pregunten quién autorizó esta compra.
      const comoFirmo = firma ? ` ${SignatureOtpService.rastro(firma)}.` : '';

      if (!o.approvedById) {
        // Primera firma.
        const data: Prisma.SupplyOrderUpdateInput = {
          approvedById: user.id, approvedByName: user.name ?? user.email, approvedAt: new Date(),
        };
        if (!needsTwo) data.status = 'aprobado';
        data.editedAt = new Date();
        await tx.supplyOrder.update({ where: { id }, data });
        await this.logEvent(tx, id, {
          action: 'APROBAR', fromStatus: 'pendiente', toStatus: needsTwo ? 'pendiente' : 'aprobado',
          detail: (needsTwo ? `1ª firma. Por el monto (${total}) requiere una segunda aprobación.` : 'Aprobación única.') + comoFirmo, user,
        });
        return { ok: true, status: needsTwo ? 'pendiente' : 'aprobado', needsSecond: needsTwo };
      }

      // Segunda firma: debe ser una persona distinta.
      if (o.approvedById === user.id) {
        throw new ForbiddenException('Usted ya firmó esta orden; la segunda aprobación debe darla otra persona.');
      }
      await tx.supplyOrder.update({
        where: { id },
        data: { approved2ById: user.id, approved2ByName: user.name ?? user.email, approved2At: new Date(), status: 'aprobado', editedAt: new Date() },
      });
      await this.logEvent(tx, id, { action: 'APROBAR', fromStatus: 'pendiente', toStatus: 'aprobado', detail: `2ª firma.${comoFirmo}`, user });
      return { ok: true, status: 'aprobado', needsSecond: false };
    });

    await this.avisarAprobacion(id, r);
    return r;
  }

  /**
   * Avisos que deja una aprobación. Fuera de la transacción y sin poder tumbarla: la
   * orden ya está firmada, y un aviso que falla no puede deshacer una firma.
   *
   *  · Falta la 2ª firma → al encargado de compras. Sin esto una orden que pasa del
   *    tope se queda esperando en silencio a un segundo firmante que no sabe que existe;
   *    era la forma más fácil de que el control de doble firma pareciera un bloqueo.
   *  · Ya aprobada y con bodega destino → al encargado de esa bodega: le va a llegar
   *    material y tiene que estar para recibirlo.
   */
  private async avisarAprobacion(id: string, r: { status: string; needsSecond: boolean }) {
    const o = await this.prisma.supplyOrder
      .findUnique({
        where: { id },
        select: { tid: true, total: true, warehouseRef: true, supplier: { select: { name: true } } },
      })
      .catch(() => null);
    if (!o) return;

    const monto = copFmt(num(o.total));

    if (r.needsSecond) {
      await this.porCargo.notifyPost('compras', {
        kind: 'compras.orden_segunda_firma',
        title: `La orden #${o.tid} necesita una segunda aprobación`,
        body: `${o.supplier?.name ?? 'Proveedor'} · ${monto} — pasa del tope y ya tiene una firma.`,
        link: `/ordenes/${id}`,
        groupKey: `orden-compra:${id}`,
      });
      return;
    }

    if (r.status !== 'aprobado' || o.warehouseRef == null) return;

    const bodega = await this.prisma.materialWarehouse
      .findFirst({ where: { legacyId: o.warehouseRef }, select: { title: true } })
      .catch(() => null);

    await this.porCargo.notifyPost('bodega', {
      kind: 'bodega.material_en_camino',
      title: `Material en camino: orden #${o.tid} aprobada`,
      body: `${o.supplier?.name ?? 'Proveedor'} · ${monto}${bodega?.title ? ` — destino ${bodega.title}` : ''}`,
      link: `/ordenes/${id}`,
      groupKey: `orden-compra:${id}`,
    });
  }

  /** Cancela una orden. Bloqueado si ya tiene pagos o material recibido. */
  async cancel(id: string, user: AuthUser, reason?: string) {
    return this.prisma.$transaction(async (tx) => {
      const o = await tx.supplyOrder.findUnique({ where: { id }, include: { items: true } });
      if (!o) throw new NotFoundException('Orden no encontrada');
      if (TERMINAL.has(o.status)) throw new BadRequestException(`La orden ya está "${o.status}".`);
      if (num(o.paidAmount) > 0) throw new BadRequestException('La orden tiene pagos registrados; anule primero los pagos en tesorería.');
      if (o.items.some((i) => !isNote(i) && i.receivedQty > 0)) {
        throw new BadRequestException('La orden tiene material recibido; devuélvalo antes de cancelar.');
      }
      await tx.supplyOrder.update({ where: { id }, data: { status: 'cancelado', editedAt: new Date() } });
      await this.logEvent(tx, id, { action: 'CANCELAR', fromStatus: o.status, toStatus: 'cancelado', detail: reason ?? null, user });
      return { ok: true, status: 'cancelado' };
    });
  }

  /** Cierra el ciclo de la orden. Exige saldo en cero (todo pagado o ajustado con notas). */
  async finalize(id: string, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const o = await tx.supplyOrder.findUnique({ where: { id }, include: { items: true } });
      if (!o) throw new NotFoundException('Orden no encontrada');
      if (TERMINAL.has(o.status)) throw new BadRequestException(`La orden ya está "${o.status}".`);
      this.exigirAprobada(o, 'finalizar');
      const balance = round2(num(o.total) - num(o.paidAmount));
      if (balance > 0.01) throw new BadRequestException(`La orden tiene saldo pendiente (${balance}); páguelo o ajústelo con una nota antes de finalizar.`);
      const items = o.items.filter((i) => !isNote(i));
      if (o.kind === 'compra' && items.length && !items.every((i) => i.receivedQty >= i.qty)) {
        throw new BadRequestException('Hay ítems sin recibir por completo; reciba el material antes de finalizar.');
      }
      await tx.supplyOrder.update({ where: { id }, data: { status: 'finalizado', editedAt: new Date() } });
      await this.logEvent(tx, id, { action: 'FINALIZAR', fromStatus: o.status, toStatus: 'finalizado', user });
      return { ok: true, status: 'finalizado' };
    });
  }

  /**
   * Edita una orden mientras esté PENDIENTE (después de aprobada, el contenido
   * que se firmó no se toca; lo variable se maneja con notas). Reemplaza los
   * ítems y recalcula totales conservando las notas/retenciones existentes.
   */
  async update(id: string, dto: UpdateOrderDto, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const o = await tx.supplyOrder.findUnique({ where: { id }, include: { items: true } });
      if (!o) throw new NotFoundException('Orden no encontrada');
      if (o.status !== 'pendiente') {
        throw new BadRequestException('Solo se puede editar una orden pendiente. Una orden aprobada se ajusta con notas, o se cancela y se crea de nuevo.');
      }
      const data: Prisma.SupplyOrderUpdateInput = {};
      if (dto.orderDate !== undefined) data.orderDate = dateOnly(dto.orderDate);
      if (dto.dueDate !== undefined) data.dueDate = dto.dueDate ? dateOnly(dto.dueDate) : null;
      if (dto.categoryRef !== undefined) data.categoryRef = dto.categoryRef?.trim() || null;
      if (dto.notes !== undefined) data.notes = dto.notes || null;

      if (dto.items) {
        if (!dto.items.length) throw new BadRequestException('La orden no puede quedar sin ítems');
        const { rows, subtotal, tax, total } = this.computeTotals(dto.items);
        // Las notas (pid=0) sobreviven a la edición: su suma firmada re-ajusta el total nuevo.
        const noteAdjust = round2(o.items.filter(isNote).reduce((s, n) => s + num(n.price), 0));
        await tx.supplyOrderItem.deleteMany({ where: { orderId: id, NOT: { materialLegacy: NOTE_PID } } });
        await tx.supplyOrderItem.createMany({
          data: rows.map((r) => ({ orderId: id, materialId: r.materialId ?? null, product: r.product, qty: r.qty, price: r.price, taxRate: r.taxRate, subtotal: r.subtotal, taxTotal: r.taxTotal })),
        });
        data.subtotal = subtotal; data.tax = tax; data.total = round2(total + noteAdjust); data.itemsCount = rows.length;
        // Al editar, cualquier firma previa a medias (1ª de 2) queda invalidada.
        data.approvedById = null; data.approvedByName = null; data.approvedAt = null;
        data.approved2ById = null; data.approved2ByName = null; data.approved2At = null;
      }
      data.editedAt = new Date();
      await tx.supplyOrder.update({ where: { id }, data });
      await this.logEvent(tx, id, { action: 'EDITAR', detail: dto.items ? `Ítems reemplazados (${dto.items.length}); firmas reiniciadas.` : 'Cabecera actualizada.', user });
      const fresh = await tx.supplyOrder.findUnique({ where: { id }, select: { total: true } });
      return { ok: true, total: num(fresh?.total) };
    });
  }

  async stats() {
    const [byStatus, byKind, agg] = await Promise.all([
      this.prisma.supplyOrder.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.supplyOrder.groupBy({ by: ['kind'], _count: { _all: true }, _sum: { total: true } }),
      this.prisma.supplyOrder.aggregate({ _sum: { total: true }, _count: { _all: true } }),
    ]);
    const status: Record<string, number> = {}; for (const r of byStatus) status[r.status] = r._count._all;
    const kind: Record<string, { count: number; total: number }> = {};
    for (const r of byKind) kind[r.kind] = { count: r._count._all, total: num(r._sum.total) };
    return { total: agg._count._all, montoTotal: num(agg._sum.total), status, compra: kind['compra'] ?? { count: 0, total: 0 }, servicio: kind['servicio'] ?? { count: 0, total: 0 } };
  }

  /** Columnas ordenables de la tabla de órdenes de compra. */
  private static readonly ORDEN_ORDENES = {
    tid: 'tid',
    kind: 'kind',
    paid: 'paidAmount',
    supplier: 'supplier.name',
    branchRef: 'branchRef',
    date: 'orderDate',
    total: 'total',
    status: 'status',
    itemsCount: 'itemsCount',
  };

  async list(params: { kind?: string; status?: string; search?: string; category?: string; branch?: string; supplier?: string; minTotal?: string; maxTotal?: string; from?: string; to?: string; page?: number; pageSize?: number; sortBy?: string; sortDir?: string }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
    const where: Prisma.SupplyOrderWhereInput = {};
    if (params.kind) where.kind = params.kind;
    if (params.status) where.status = params.status;
    if (params.category) where.categoryRef = params.category;
    if (params.branch) where.branchRef = params.branch;
    if (params.supplier) where.supplierId = params.supplier;
    // Rango de fechas por orderDate (inclusive en ambos extremos).
    const from = (params.from || '').trim();
    const to = (params.to || '').trim();
    if (from || to) {
      where.orderDate = {};
      if (from) where.orderDate.gte = dateOnly(from);
      if (to) where.orderDate.lte = dateOnly(to);
    }
    // Rango de monto por total (inclusive).
    const minTotal = Number(params.minTotal);
    const maxTotal = Number(params.maxTotal);
    if (Number.isFinite(minTotal) || Number.isFinite(maxTotal)) {
      where.total = {};
      if (Number.isFinite(minTotal)) where.total.gte = minTotal;
      if (Number.isFinite(maxTotal)) where.total.lte = maxTotal;
    }
    const search = (params.search || '').trim();
    if (search) {
      const asNum = Number(search);
      where.OR = [
        ...(Number.isFinite(asNum) ? [{ tid: asNum }] : []),
        { supplier: { is: { name: { contains: search, mode: 'insensitive' as const } } } },
        { notes: { contains: search, mode: 'insensitive' } },
      ];
    }
    const [rows, total] = await Promise.all([
      this.prisma.supplyOrder.findMany({ where, orderBy: orden(params, OrdersService.ORDEN_ORDENES, { orderDate: 'desc' }), skip: (page - 1) * pageSize, take: pageSize, include: { supplier: true } }),
      this.prisma.supplyOrder.count({ where }),
    ]);
    return {
      items: rows.map((o) => ({
        id: o.id, tid: o.tid, supplier: o.supplier?.name ?? '—', supplierId: o.supplier?.id ?? null,
        kind: o.kind, date: o.orderDate, total: num(o.total), paid: num(o.paidAmount), status: o.status,
        branchRef: o.branchRef, itemsCount: o.itemsCount,
      })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  /**
   * La nota del movimiento, sin el enlace del comprobante.
   *
   * El writeback le pega al final ` | Comprobante: <url>` para que el legacy —que no
   * tiene columna de adjunto— pueda abrirlo (ver `notaConComprobante`), y la ida nos
   * devuelve esa nota tal cual. Aquí al lado hay una columna con el comprobante de
   * verdad, así que la URL sólo estorba.
   */
  private static sinEnlaceDeComprobante(note: string | null) {
    return note ? note.replace(/\s*\|\s*Comprobante:\s*\S+\s*$/, '').trim() || null : null;
  }

  /**
   * Pagos de una orden, con su comprobante.
   *
   * El soporte del pago NO se guarda como adjunto de la orden: vive en el EGRESO que
   * ese pago creó en tesorería (`Transaction.attach`, o `legacyAttach` si se subió en
   * el legacy). Así se sube una sola vez y se ve en los dos sitios — antes había que
   * cargarlo aquí y otra vez en el movimiento de caja.
   */
  private async pagosDeOrden(id: string) {
    const rows = await this.prisma.transaction.findMany({
      where: { supplyOrderId: id },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true, date: true, type: true, debit: true, credit: true, method: true,
        accountName: true, note: true, status: true, attach: true, attachName: true, legacyAttach: true,
      },
    });
    return rows.map((t) => ({
      id: t.id, date: t.date,
      amount: t.type === 'EXPENSE' ? num(t.debit) : num(t.credit),
      method: t.method, account: t.accountName, status: t.status,
      note: OrdersService.sinEnlaceDeComprobante(t.note),
      ...comprobanteDe(t),
    }));
  }

  async detail(id: string) {
    const [o, threshold, firmaCfg, payments] = await Promise.all([
      this.prisma.supplyOrder.findUnique({
        where: { id },
        include: {
          supplier: true,
          items: { orderBy: { id: 'asc' } },
          events: { orderBy: { createdAt: 'desc' }, take: 50 },
          files: { orderBy: { createdAt: 'desc' } },
        },
      }),
      this.dualThreshold(),
      this.firma.config(),
      this.pagosDeOrden(id),
    ]);
    if (!o) throw new NotFoundException('Orden no encontrada');
    // El total ya está neto de notas/retención; el saldo es total - pagado.
    const total = num(o.total);
    const paid = num(o.paidAmount);
    const needsTwo = threshold > 0 && total >= threshold;
    // Solo las órdenes de la app entran al flujo de aprobación; las del legacy son historia.
    const enFlujo = o.legacyId === null;
    return {
      id: o.id, tid: o.tid, kind: o.kind, status: o.status, date: o.orderDate, dueDate: o.dueDate,
      subtotal: num(o.subtotal), tax: num(o.tax), discount: num(o.discount), total, paid, balance: round2(total - paid),
      retentionType: o.retentionType, retention: num(o.retention),
      notes: o.notes, branchRef: o.branchRef, receivedAt: o.receivedAt,
      supplier: o.supplier ? { id: o.supplier.id, name: o.supplier.name, nit: o.supplier.nit, phone: o.supplier.phone, category: o.supplier.category } : null,
      items: o.items.filter((it) => !isNote(it)).map((it) => ({ id: it.id, product: it.product, qty: it.qty, price: num(it.price), taxRate: num(it.taxRate), subtotal: num(it.subtotal), taxTotal: num(it.taxTotal), received: it.receivedQty, materialId: it.materialId })),
      // Notas y retenciones que ajustaron el total (pid=0). amount negativo = descuento/retención.
      noteLines: o.items.filter(isNote).map((it) => ({ id: it.id, type: it.product, description: it.description, amount: num(it.price) })),
      // Flujo de aprobación
      approval: {
        enFlujo, needsTwo, threshold,
        createdByName: o.createdByName,
        firstBy: o.approvedByName, firstAt: o.approvedAt, firstById: o.approvedById,
        secondBy: o.approved2ByName, secondAt: o.approved2At,
        // Pendiente de firma: sin 1ª, o con 1ª pero le falta la 2ª por monto.
        awaiting: enFlujo && o.status === 'pendiente',
        // ¿Hay que firmar con código? Lo decide el ajuste, y la pantalla necesita
        // saberlo para pedirlo (o no) sin tener que provocar un error primero.
        otpRequired: firmaCfg.required,
      },
      events: o.events.map((e) => ({ id: e.id, action: e.action, from: e.fromStatus, to: e.toStatus, detail: e.detail, user: e.userName, at: e.createdAt })),
      files: o.files.map((f) => ({ id: f.id, name: f.originalName, size: f.size, mime: f.mimeType, by: f.uploadedByName, at: f.createdAt })),
      // Los egresos que pagaron esta orden, con su comprobante (ver `pagosDeOrden`).
      payments,
    };
  }

  // --- Proveedores ---
  /** Columnas ordenables de la tabla de proveedores. */
  private static readonly ORDEN_PROVEEDORES = {
    name: 'name',
    nit: 'nit',
    phone: 'phone',
    city: 'city',
    bank: 'bank',
    // Prisma sí sabe ordenar por el número de filas de una relación.
    orders: (dir: 'asc' | 'desc') => ({ supplyOrders: { _count: dir } }),
  };

  async suppliers(params: { category?: string; search?: string; page?: number; pageSize?: number; sortBy?: string; sortDir?: string }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
    const where: Prisma.SupplierWhereInput = {};
    if (params.category) where.category = Number(params.category);
    const search = (params.search || '').trim();
    if (search) where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { nit: { contains: search } }, { company: { contains: search, mode: 'insensitive' } }];
    const [rows, total] = await Promise.all([
      this.prisma.supplier.findMany({ where, orderBy: orden(params, OrdersService.ORDEN_PROVEEDORES, { name: 'asc' }), skip: (page - 1) * pageSize, take: pageSize, include: { _count: { select: { supplyOrders: true } } } }),
      this.prisma.supplier.count({ where }),
    ]);
    return {
      items: rows.map((s) => ({ id: s.id, name: s.name, nit: s.nit, phone: s.phone, email: s.email, city: s.city, category: s.category, bank: s.bank, orders: s._count.supplyOrders })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }
  createSupplier(dto: CreateSupplierDto) {
    return this.prisma.supplier.create({ data: {
      name: dto.name, category: dto.category ?? 1, nit: dto.nit ?? null, phone: dto.phone ?? null, email: dto.email ?? null,
      address: dto.address ?? null, city: dto.city ?? null, bank: dto.bank ?? null, account: dto.account ?? null, company: dto.company ?? null,
    } });
  }

  async updateSupplier(id: string, dto: CreateSupplierDto) {
    const s = await this.prisma.supplier.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('Proveedor no encontrado');
    return this.prisma.supplier.update({ where: { id }, data: {
      name: dto.name, category: dto.category ?? s.category, nit: dto.nit ?? null, phone: dto.phone ?? null, email: dto.email ?? null,
      address: dto.address ?? null, city: dto.city ?? null, bank: dto.bank ?? null, account: dto.account ?? null, company: dto.company ?? null,
    } });
  }

  /** Elimina un proveedor. Bloquea si tiene órdenes o devoluciones asociadas. */
  async deleteSupplier(id: string) {
    const s = await this.prisma.supplier.findUnique({ where: { id }, include: { _count: { select: { supplyOrders: true, stockReturns: true } } } });
    if (!s) throw new NotFoundException('Proveedor no encontrado');
    if (s._count.supplyOrders > 0 || s._count.stockReturns > 0) {
      throw new BadRequestException('No se puede eliminar: el proveedor tiene órdenes o devoluciones asociadas.');
    }
    await anotarBorradoLegacy(this.prisma, 'supplier', s, { label: s.name });
    await this.prisma.supplier.delete({ where: { id } });
    return { id, deleted: true };
  }

  /** Estado de cuenta del proveedor: órdenes, devoluciones, pagos y saldos. */
  async supplierStatement(id: string) {
    const s = await this.prisma.supplier.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('Proveedor no encontrado');
    const [orders, returns, payments] = await Promise.all([
      this.prisma.supplyOrder.findMany({ where: { supplierId: id }, orderBy: { createdAt: 'desc' }, select: { id: true, tid: true, orderDate: true, total: true, paidAmount: true, status: true, kind: true } }),
      this.prisma.stockReturn.findMany({ where: { supplierId: id }, orderBy: { createdAt: 'desc' }, select: { id: true, tid: true, date: true, total: true, paidAmount: true, status: true } }),
      this.prisma.transaction.findMany({ where: { supplierId: id, status: 'VIGENTE' }, orderBy: { date: 'desc' }, take: 200, select: { id: true, date: true, type: true, debit: true, credit: true, category: true, note: true, supplyOrderId: true } }),
    ]);
    const totalOrdered = round2(orders.reduce((a, o) => a + num(o.total), 0));
    const totalPaid = round2(orders.reduce((a, o) => a + num(o.paidAmount), 0));
    return {
      supplier: { id: s.id, name: s.name, nit: s.nit, phone: s.phone, email: s.email, city: s.city, bank: s.bank, account: s.account },
      orders: orders.map((o) => ({ id: o.id, tid: o.tid, date: o.orderDate, total: num(o.total), paid: num(o.paidAmount), balance: round2(num(o.total) - num(o.paidAmount)), status: o.status, kind: o.kind })),
      returns: returns.map((r) => ({ id: r.id, tid: r.tid, date: r.date, total: num(r.total), paid: num(r.paidAmount), status: r.status })),
      payments: payments.map((p) => ({ id: p.id, date: p.date, type: p.type, amount: p.type === 'EXPENSE' ? num(p.debit) : num(p.credit), category: p.category, note: p.note, orderId: p.supplyOrderId })),
      totals: { totalOrdered, totalPaid, saldo: round2(totalOrdered - totalPaid) },
    };
  }

  /** Pago/abono a una orden de compra: crea el egreso en tesorería y actualiza el saldo. */
  async paySupplyOrder(id: string, dto: PayOrderDto, user: AuthUser) {
    const amount = round2(Number(dto.amount));
    if (amount <= 0) throw new BadRequestException('El monto debe ser mayor a cero');

    return this.prisma.$transaction(async (tx) => {
      // La orden se lee DENTRO de la transacción y con la fila bloqueada. Leerla fuera
      // y sumar sobre esa foto es la misma carrera que tenía `collect`: dos abonos
      // simultáneos escribían el mismo `paidAmount` y uno se perdía, pero los DOS
      // egresos quedaban creados. La validación del saldo también va aquí: si no, dos
      // abonos que por separado caben pueden sobrepasar el total entre los dos.
      await tx.$queryRaw`SELECT id FROM "SupplyOrder" WHERE id = ${id} FOR UPDATE`;
      const order = await tx.supplyOrder.findUnique({ where: { id } });
      if (!order) throw new NotFoundException('Orden no encontrada');
      this.exigirAprobada(order, 'pagar');
      const balance = round2(num(order.total) - num(order.paidAmount));
      if (amount > balance + 0.01) throw new BadRequestException(`El abono (${amount}) supera el saldo de la orden (${balance}).`);

      // El motivo que escribe quien paga se AÑADE a la referencia de la orden, no
      // la reemplaza: el egreso tiene que poder rastrearse hasta la orden desde el
      // libro de caja aunque nadie escriba nada.
      const motivo = dto.note?.trim();
      const concepto = `Pago orden de compra #${order.tid}${motivo ? ` — ${motivo}` : ''}`;

      const t = await tx.transaction.create({
        data: {
          type: 'EXPENSE', category: 'Compras', debit: amount, credit: 0,
          method: dto.method ?? 'Cash', date: dateOnly(dto.date),
          cashAccountId: dto.cashAccountId ?? null, accountName: dto.accountName ?? null,
          bankName: dto.method === 'Bank' ? (dto.bankName ?? null) : null,
          ext: true, status: 'VIGENTE', issuerUserId: null,
          note: concepto,
          supplyOrderId: order.id, supplierId: order.supplierId,
        },
      });
      const newPaid = round2(num(order.paidAmount) + amount);
      // "abonado" = con pagos parciales (estado legacy); pagado del todo conserva
      // el estado de recepción y el cierre lo hace "finalizar".
      const data: Prisma.SupplyOrderUpdateInput = { paidAmount: newPaid };
      if (order.legacyId === null && order.status === 'aprobado' && newPaid < num(order.total)) data.status = 'abonado';
      data.editedAt = new Date();
      await tx.supplyOrder.update({ where: { id }, data });
      await this.logEvent(tx, id, {
        action: 'PAGAR',
        detail: `Abono ${amount} (${dto.method ?? 'Cash'}). Pagado ${newPaid} de ${num(order.total)}.${motivo ? ` Motivo: ${motivo}` : ''}`,
        user,
      });
      return { ok: true, transactionId: t.id, paidAmount: newPaid, balance: round2(num(order.total) - newPaid) };
    });
  }

  // --- Sedes (el nombre vive libre en SupplyOrder.branchRef; se listan las que existen) ---
  async branches() {
    const rows = await this.prisma.supplyOrder.groupBy({ by: ['branchRef'], _count: { _all: true }, orderBy: { branchRef: 'asc' } });
    return rows
      .filter((r) => r.branchRef != null && r.branchRef.trim() !== '')
      .map((r) => ({ name: r.branchRef as string, orders: r._count._all }));
  }

  // --- Categorías de compra (catálogo; el nombre vive en SupplyOrder.categoryRef) ---
  async categories() {
    const cats = await this.prisma.purchaseCategory.findMany({ orderBy: { name: 'asc' } });
    const counts = await this.prisma.supplyOrder.groupBy({ by: ['categoryRef'], _count: { _all: true } });
    const cmap = new Map(counts.map((c) => [c.categoryRef, c._count._all]));
    return cats.map((c) => ({ id: c.id, name: c.name, orders: cmap.get(c.name) ?? 0 }));
  }
  async createCategory(dto: CategoryNameDto) {
    const name = dto.name.trim();
    const exists = await this.prisma.purchaseCategory.findUnique({ where: { name } });
    if (exists) throw new BadRequestException('Ya existe una categoría con ese nombre.');
    return this.prisma.purchaseCategory.create({ data: { name } });
  }
  async updateCategory(id: string, dto: CategoryNameDto) {
    const cur = await this.prisma.purchaseCategory.findUnique({ where: { id } });
    if (!cur) throw new NotFoundException('Categoría no encontrada');
    const name = dto.name.trim();
    if (name !== cur.name) {
      const dup = await this.prisma.purchaseCategory.findUnique({ where: { name } });
      if (dup) throw new BadRequestException('Ya existe una categoría con ese nombre.');
    }
    const updated = await this.prisma.purchaseCategory.update({ where: { id }, data: { name } });
    // Renombrar: propaga el nuevo nombre a las órdenes que lo usaban.
    if (name !== cur.name) {
      await this.prisma.supplyOrder.updateMany({ where: { categoryRef: cur.name }, data: { categoryRef: name } });
    }
    return updated;
  }
  async deleteCategory(id: string) {
    const cur = await this.prisma.purchaseCategory.findUnique({ where: { id } });
    if (!cur) throw new NotFoundException('Categoría no encontrada');
    const used = await this.prisma.supplyOrder.count({ where: { categoryRef: cur.name } });
    if (used > 0) throw new BadRequestException(`No se puede eliminar: ${used} orden(es) usan esta categoría.`);
    await this.prisma.purchaseCategory.delete({ where: { id } });
    return { ok: true };
  }

  private computeTotals(items: OrderItemDto[]) {
    const rows = items.map((it) => {
      const qty = Math.max(0, Math.round(it.qty)); const price = round2(it.price); const taxRate = round2(it.taxRate ?? 0);
      const subtotal = round2(qty * price); const taxTotal = round2((subtotal * taxRate) / 100);
      return { ...it, qty, price, taxRate, subtotal, taxTotal };
    });
    return { rows, subtotal: round2(rows.reduce((s, r) => s + r.subtotal, 0)), tax: round2(rows.reduce((s, r) => s + r.taxTotal, 0)), total: round2(rows.reduce((s, r) => s + r.subtotal + r.taxTotal, 0)) };
  }
  /** Consecutivo de orden. Secuencia de Postgres. Ver common/tid.ts. */
  private nextTid(tx: Prisma.TransactionClient) {
    return nextTid(tx, TID_SEQ.supplyOrder);
  }

  async create(dto: CreateOrderDto, user: AuthUser) {
    if (!dto.items?.length) throw new BadRequestException('La orden no tiene ítems');
    const supplier = await this.prisma.supplier.findUnique({ where: { id: dto.supplierId } });
    if (!supplier) throw new NotFoundException('Proveedor no encontrado');
    const { rows, subtotal, tax, total } = this.computeTotals(dto.items);
    const warehouse = dto.warehouseId ? await this.prisma.materialWarehouse.findUnique({ where: { id: dto.warehouseId } }) : null;
    const creada = await this.prisma.$transaction(async (tx) => {
      const tid = await this.nextTid(tx);
      const o = await tx.supplyOrder.create({
        data: {
          tid, supplierId: supplier.id, supplierLegacy: supplier.legacyId ?? null,
          orderDate: dateOnly(dto.orderDate), dueDate: dto.dueDate ? dateOnly(dto.dueDate) : null,
          subtotal, tax, total, status: 'pendiente', kind: supplier.category === 2 ? 'servicio' : 'compra',
          categoryRef: dto.categoryRef?.trim() || null,
          warehouseRef: warehouse?.legacyId ?? null, notes: dto.notes ?? null, itemsCount: rows.length,
          createdById: user?.id ?? null, createdByName: user?.name ?? user?.email ?? null,
          items: { create: rows.map((r) => ({ materialId: r.materialId ?? null, product: r.product, qty: r.qty, price: r.price, taxRate: r.taxRate, subtotal: r.subtotal, taxTotal: r.taxTotal })) },
        },
      });
      // Retención capturada al crear (legacy newinvoice.php): se materializa como nota de retención que resta del total.
      if (dto.retention && dto.retention > 0 && dto.retentionType) {
        await this.applyNote(tx, o, { type: 'Retencion', retentionType: dto.retentionType, amount: dto.retention, description: 'Retención en la fuente' });
      }
      await this.logEvent(tx, o.id, { action: 'CREAR', toStatus: 'pendiente', detail: `Orden #${o.tid} (${rows.length} ítems).`, user });
      const fresh = await tx.supplyOrder.findUnique({ where: { id: o.id }, select: { total: true } });
      return { id: o.id, tid: o.tid, total: num(fresh?.total ?? total), kind: o.kind };
    });

    // Fuera de la transacción a propósito: si el aviso se demora, no tiene por qué
    // mantener abierta la escritura de la orden, y si la orden se revierte no se avisa
    // de una compra que no existe.
    await this.porCargo.notifyPost('compras', {
      kind: 'compras.orden_por_aprobar',
      title: `Orden de compra #${creada.tid} pendiente de aprobación`,
      body: `${supplier.name} · ${copFmt(creada.total)}`,
      link: `/ordenes/${creada.id}`,
      groupKey: `orden-compra:${creada.id}`,
    });

    return creada;
  }

  // --- Notas y retenciones sobre la orden (legacy Purchase::crear_nota / eliminar_nota) ---
  /**
   * Aplica una nota (crédito/débito/retención) como línea pid=0 que ajusta el total de la orden.
   * Crédito y retención restan; débito suma. La retención además acumula en el header (retention/retentionType)
   * para reportes tributarios. El total queda SIEMPRE neto → el saldo del proveedor y el pago lo respetan.
   */
  private async applyNote(
    tx: Prisma.TransactionClient,
    order: { id: string; total: Prisma.Decimal; paidAmount: Prisma.Decimal; retention: Prisma.Decimal; retentionType: string | null },
    input: { type: string; retentionType?: string | null; amount: number; description?: string | null },
  ) {
    const amount = round2(Math.abs(Number(input.amount)));
    if (!(amount > 0)) throw new BadRequestException('El monto de la nota debe ser mayor a cero');
    const isRet = input.type === 'Retencion';
    if (isRet && !input.retentionType) throw new BadRequestException('La retención requiere un tipo (Retefuente Servicios, Compras, etc.)');
    const signed = round2(noteSign(input.type) * amount);
    const newTotal = round2(num(order.total) + signed);
    if (newTotal < num(order.paidAmount) - 0.01) {
      throw new BadRequestException(`La nota deja el total (${newTotal}) por debajo de lo ya pagado (${num(order.paidAmount)}).`);
    }
    const label = isRet ? `Retención (${input.retentionType})` : input.type;
    const line = await tx.supplyOrderItem.create({
      data: {
        orderId: order.id, materialLegacy: NOTE_PID, product: label,
        qty: 1, price: signed, taxRate: 0, discount: 0, subtotal: signed, taxTotal: 0, discountTotal: 0,
        description: input.description ?? null,
      },
    });
    const data: Prisma.SupplyOrderUpdateInput = { total: newTotal };
    if (isRet) { data.retention = round2(num(order.retention) + amount); data.retentionType = input.retentionType!; }
    data.editedAt = new Date();
    await tx.supplyOrder.update({ where: { id: order.id }, data });
    return { lineId: line.id, newTotal, signed };
  }

  async addNote(id: string, dto: AddNoteDto, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.supplyOrder.findUnique({ where: { id } });
      if (!order) throw new NotFoundException('Orden no encontrada');
      if (TERMINAL.has(order.status)) throw new BadRequestException(`La orden está "${order.status}"; no admite notas.`);
      const res = await this.applyNote(tx, order, { type: dto.type, retentionType: dto.retentionType, amount: dto.amount, description: dto.description });
      await this.logEvent(tx, id, { action: 'NOTA', detail: `${dto.type} por ${dto.amount}${dto.description ? ` — ${dto.description}` : ''}`, user });
      return { ok: true, noteId: res.lineId, total: res.newTotal, balance: round2(res.newTotal - num(order.paidAmount)) };
    });
  }

  async removeNote(id: string, noteId: string) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.supplyOrder.findUnique({ where: { id } });
      if (!order) throw new NotFoundException('Orden no encontrada');
      const note = await tx.supplyOrderItem.findUnique({ where: { id: noteId } });
      if (!note || note.orderId !== id || !isNote(note)) throw new NotFoundException('Nota no encontrada');
      const signed = num(note.price); // ya viene con signo
      const newTotal = round2(num(order.total) - signed);
      if (newTotal < num(order.paidAmount) - 0.01) {
        throw new BadRequestException(`Eliminar la nota deja el total (${newTotal}) por debajo de lo ya pagado (${num(order.paidAmount)}).`);
      }
      const data: Prisma.SupplyOrderUpdateInput = { total: newTotal };
      const wasRetention = typeof note.product === 'string' && note.product.startsWith('Retención');
      if (wasRetention) {
        const others = await tx.supplyOrderItem.count({ where: { orderId: id, materialLegacy: NOTE_PID, product: { startsWith: 'Retención' }, id: { not: noteId } } });
        data.retention = round2(Math.max(0, num(order.retention) - Math.abs(signed)));
        if (others === 0) data.retentionType = null;
      }
      await tx.supplyOrderItem.delete({ where: { id: noteId } });
      data.editedAt = new Date();
      await tx.supplyOrder.update({ where: { id }, data });
      return { ok: true, removed: noteId, total: newTotal, balance: round2(newTotal - num(order.paidAmount)) };
    });
  }

  async remove(id: string) {
    const o = await this.prisma.supplyOrder.findUnique({ where: { id }, include: { items: true } });
    if (!o) throw new NotFoundException('Orden no encontrada');
    // Una orden con plata o stock movidos no se borra: se cancela o se finaliza,
    // y el rastro queda. Borrar era el agujero del legacy.
    if (num(o.paidAmount) > 0) throw new BadRequestException('La orden tiene pagos; no se puede eliminar (cancele o finalice).');
    if (o.items.some((i) => !isNote(i) && i.receivedQty > 0)) {
      throw new BadRequestException('La orden tiene material recibido; no se puede eliminar.');
    }
    // Lápida antes de borrar: sin ella la ida vuelve a crear la orden en la próxima
    // pasada (da de alta lo que ve en el legacy y no tiene aquí) y el borrado se deshace.
    await anotarBorradoLegacy(this.prisma, 'supplyOrder', o, { label: `Orden #${o.tid}` });
    await this.prisma.supplyOrder.delete({ where: { id } });
    return { id, deleted: true };
  }

  /** Recibir orden: suma stock al material por ítem (delta), recalcula estado. */
  async receive(id: string, dto: ReceiveOrderDto, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const o = await tx.supplyOrder.findUnique({ where: { id }, include: { items: true } });
      if (!o) throw new NotFoundException('Orden no encontrada');
      this.exigirAprobada(o, 'recibir material');
      const targetWarehouseId = dto.warehouseId ?? null;
      for (const r of dto.items) {
        const item = o.items.find((i) => i.id === r.itemId);
        if (!item) continue;
        const delta = r.received - item.receivedQty;
        if (delta !== 0 && item.materialId) {
          const mat = await tx.material.findUnique({ where: { id: item.materialId } });
          if (mat) await tx.material.update({ where: { id: mat.id }, data: { qty: Math.max(0, mat.qty + delta), editedAt: new Date() } });
        }
        await tx.supplyOrderItem.update({ where: { id: item.id }, data: { receivedQty: r.received } });
      }
      // Recalcular estado (las notas pid=0 no cuentan para la recepción).
      const updated = (await tx.supplyOrderItem.findMany({ where: { orderId: id } })).filter((i) => !isNote(i));
      const allReceived = updated.every((i) => i.receivedQty >= i.qty);
      const anyReceived = updated.some((i) => i.receivedQty > 0);
      const status = allReceived ? 'recibido' : anyReceived ? 'recibido parcial' : o.status;
      await tx.supplyOrder.update({ where: { id }, data: { status, receivedAt: new Date(), warehouseRef: undefined, editedAt: new Date() } });
      if (status !== o.status) {
        await this.logEvent(tx, id, { action: 'RECIBIR', fromStatus: o.status, toStatus: status, user });
      }
      return { id, status };
    });
  }

  // ------------------------------------------------------------------ //
  //  Adjuntos (metadata; el binario vive en uploads/orders/<id>/)      //
  // ------------------------------------------------------------------ //

  async addFile(id: string, meta: { originalName: string; storedName: string; mimeType: string; size: number }, user: AuthUser) {
    const o = await this.prisma.supplyOrder.findUnique({ where: { id }, select: { id: true } });
    if (!o) throw new NotFoundException('Orden no encontrada');
    const f = await this.prisma.supplyOrderFile.create({
      data: { orderId: id, ...meta, uploadedByName: user?.name ?? user?.email ?? null },
    });
    await this.prisma.$transaction((tx) => this.logEvent(tx, id, { action: 'ADJUNTO', detail: `Subido: ${meta.originalName}`, user }));
    return { id: f.id, name: f.originalName };
  }

  async fileMeta(id: string, fileId: string) {
    const f = await this.prisma.supplyOrderFile.findUnique({ where: { id: fileId } });
    if (!f || f.orderId !== id) throw new NotFoundException('Adjunto no encontrado');
    return f;
  }

  async deleteFile(id: string, fileId: string, user: AuthUser) {
    const f = await this.fileMeta(id, fileId);
    await this.prisma.supplyOrderFile.delete({ where: { id: f.id } });
    await this.prisma.$transaction((tx) => this.logEvent(tx, id, { action: 'ADJUNTO', detail: `Eliminado: ${f.originalName}`, user }));
    return f; // el controller borra el binario del disco
  }

  /** Datos para el PDF imprimible de la orden (con firmas de autorización). */
  async pdfData(id: string) {
    const d = await this.detail(id);
    return d;
  }

  /** Filas planas para exportar a Excel (respeta los mismos filtros del listado). */
  async exportRows(params: Parameters<OrdersService['list']>[0]) {
    const r = await this.list({ ...params, page: 1, pageSize: 100 });
    // Se recorren todas las páginas (tope sano de 20k filas).
    const all = [...r.items];
    for (let p = 2; p <= Math.min(r.pages, 200); p++) {
      all.push(...(await this.list({ ...params, page: p, pageSize: 100 })).items);
    }
    return all;
  }
}
