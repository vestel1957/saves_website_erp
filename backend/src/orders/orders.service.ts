import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { AddNoteDto, CategoryNameDto, CreateOrderDto, CreateSupplierDto, OrderItemDto, PayOrderDto, ReceiveOrderDto } from './dto/orders.dto';

const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? 0 : Number(d));
const round2 = (n: number) => Math.round(n * 100) / 100;
const dateOnly = (s?: string) => { const d = s ? new Date(s) : new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); };

// Convención legacy: purchase_items.pid = 0 marca una NOTA (no un producto). Aquí materialLegacy=0.
const NOTE_PID = 0;
const isNote = (it: { materialLegacy: number | null }) => it.materialLegacy === NOTE_PID;
// Notas que restan del total (crédito y retención) vs. suman (débito). Ver Purchase::crear_nota.
const noteSign = (type: string) => (type === 'Nota Debito' ? 1 : -1);

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

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

  async list(params: { kind?: string; status?: string; search?: string; category?: string; branch?: string; supplier?: string; minTotal?: string; maxTotal?: string; from?: string; to?: string; page?: number; pageSize?: number }) {
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
      this.prisma.supplyOrder.findMany({ where, orderBy: { orderDate: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: { supplier: true } }),
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

  async detail(id: string) {
    const o = await this.prisma.supplyOrder.findUnique({ where: { id }, include: { supplier: true, items: { orderBy: { id: 'asc' } } } });
    if (!o) throw new NotFoundException('Orden no encontrada');
    // El total ya está neto de notas/retención; el saldo es total - pagado.
    const total = num(o.total);
    const paid = num(o.paidAmount);
    return {
      id: o.id, tid: o.tid, kind: o.kind, status: o.status, date: o.orderDate, dueDate: o.dueDate,
      subtotal: num(o.subtotal), tax: num(o.tax), discount: num(o.discount), total, paid, balance: round2(total - paid),
      retentionType: o.retentionType, retention: num(o.retention),
      notes: o.notes, branchRef: o.branchRef, receivedAt: o.receivedAt,
      supplier: o.supplier ? { id: o.supplier.id, name: o.supplier.name, nit: o.supplier.nit, phone: o.supplier.phone, category: o.supplier.category } : null,
      items: o.items.filter((it) => !isNote(it)).map((it) => ({ id: it.id, product: it.product, qty: it.qty, price: num(it.price), taxRate: num(it.taxRate), subtotal: num(it.subtotal), taxTotal: num(it.taxTotal), received: it.receivedQty, materialId: it.materialId })),
      // Notas y retenciones que ajustaron el total (pid=0). amount negativo = descuento/retención.
      noteLines: o.items.filter(isNote).map((it) => ({ id: it.id, type: it.product, description: it.description, amount: num(it.price) })),
    };
  }

  // --- Proveedores ---
  async suppliers(params: { category?: string; search?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
    const where: Prisma.SupplierWhereInput = {};
    if (params.category) where.category = Number(params.category);
    const search = (params.search || '').trim();
    if (search) where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { nit: { contains: search } }, { company: { contains: search, mode: 'insensitive' } }];
    const [rows, total] = await Promise.all([
      this.prisma.supplier.findMany({ where, orderBy: { name: 'asc' }, skip: (page - 1) * pageSize, take: pageSize, include: { _count: { select: { supplyOrders: true } } } }),
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
    const order = await this.prisma.supplyOrder.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('Orden no encontrada');
    const amount = round2(Number(dto.amount));
    if (amount <= 0) throw new BadRequestException('El monto debe ser mayor a cero');
    const balance = round2(num(order.total) - num(order.paidAmount));
    if (amount > balance + 0.01) throw new BadRequestException(`El abono (${amount}) supera el saldo de la orden (${balance}).`);
    return this.prisma.$transaction(async (tx) => {
      const t = await tx.transaction.create({
        data: {
          type: 'EXPENSE', category: 'Compras', debit: amount, credit: 0,
          method: dto.method ?? 'Cash', date: dateOnly(dto.date),
          cashAccountId: dto.cashAccountId ?? null, accountName: dto.accountName ?? null,
          bankName: dto.method === 'Bank' ? (dto.bankName ?? null) : null,
          ext: true, status: 'VIGENTE', issuerUserId: null,
          note: dto.note ?? `Pago orden de compra #${order.tid}`,
          supplyOrderId: order.id, supplierId: order.supplierId,
        },
      });
      const newPaid = round2(num(order.paidAmount) + amount);
      await tx.supplyOrder.update({ where: { id }, data: { paidAmount: newPaid } });
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
  private async nextTid(tx: Prisma.TransactionClient) {
    const max = await tx.supplyOrder.aggregate({ _max: { tid: true } });
    return (max._max.tid ?? 1000) + 1;
  }

  async create(dto: CreateOrderDto, user: AuthUser) {
    if (!dto.items?.length) throw new BadRequestException('La orden no tiene ítems');
    const supplier = await this.prisma.supplier.findUnique({ where: { id: dto.supplierId } });
    if (!supplier) throw new NotFoundException('Proveedor no encontrado');
    const { rows, subtotal, tax, total } = this.computeTotals(dto.items);
    const warehouse = dto.warehouseId ? await this.prisma.materialWarehouse.findUnique({ where: { id: dto.warehouseId } }) : null;
    return this.prisma.$transaction(async (tx) => {
      const tid = await this.nextTid(tx);
      const o = await tx.supplyOrder.create({
        data: {
          tid, supplierId: supplier.id, supplierLegacy: supplier.legacyId ?? null,
          orderDate: dateOnly(dto.orderDate), dueDate: dto.dueDate ? dateOnly(dto.dueDate) : null,
          subtotal, tax, total, status: 'pendiente', kind: supplier.category === 2 ? 'servicio' : 'compra',
          categoryRef: dto.categoryRef?.trim() || null,
          warehouseRef: warehouse?.legacyId ?? null, notes: dto.notes ?? null, itemsCount: rows.length,
          items: { create: rows.map((r) => ({ materialId: r.materialId ?? null, product: r.product, qty: r.qty, price: r.price, taxRate: r.taxRate, subtotal: r.subtotal, taxTotal: r.taxTotal })) },
        },
      });
      // Retención capturada al crear (legacy newinvoice.php): se materializa como nota de retención que resta del total.
      if (dto.retention && dto.retention > 0 && dto.retentionType) {
        await this.applyNote(tx, o, { type: 'Retencion', retentionType: dto.retentionType, amount: dto.retention, description: 'Retención en la fuente' });
      }
      const fresh = await tx.supplyOrder.findUnique({ where: { id: o.id }, select: { total: true } });
      return { id: o.id, tid: o.tid, total: num(fresh?.total ?? total), kind: o.kind };
    });
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
    await tx.supplyOrder.update({ where: { id: order.id }, data });
    return { lineId: line.id, newTotal, signed };
  }

  async addNote(id: string, dto: AddNoteDto, _user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.supplyOrder.findUnique({ where: { id } });
      if (!order) throw new NotFoundException('Orden no encontrada');
      const res = await this.applyNote(tx, order, { type: dto.type, retentionType: dto.retentionType, amount: dto.amount, description: dto.description });
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
      await tx.supplyOrder.update({ where: { id }, data });
      return { ok: true, removed: noteId, total: newTotal, balance: round2(newTotal - num(order.paidAmount)) };
    });
  }

  async remove(id: string) {
    const o = await this.prisma.supplyOrder.findUnique({ where: { id } });
    if (!o) throw new NotFoundException('Orden no encontrada');
    await this.prisma.supplyOrder.delete({ where: { id } });
    return { id, deleted: true };
  }

  /** Recibir orden: suma stock al material por ítem (delta), recalcula estado. */
  async receive(id: string, dto: ReceiveOrderDto, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const o = await tx.supplyOrder.findUnique({ where: { id }, include: { items: true } });
      if (!o) throw new NotFoundException('Orden no encontrada');
      const targetWarehouseId = dto.warehouseId ?? null;
      for (const r of dto.items) {
        const item = o.items.find((i) => i.id === r.itemId);
        if (!item) continue;
        const delta = r.received - item.receivedQty;
        if (delta !== 0 && item.materialId) {
          const mat = await tx.material.findUnique({ where: { id: item.materialId } });
          if (mat) await tx.material.update({ where: { id: mat.id }, data: { qty: Math.max(0, mat.qty + delta) } });
        }
        await tx.supplyOrderItem.update({ where: { id: item.id }, data: { receivedQty: r.received } });
      }
      // Recalcular estado
      const updated = await tx.supplyOrderItem.findMany({ where: { orderId: id } });
      const allReceived = updated.every((i) => i.receivedQty >= i.qty);
      const anyReceived = updated.some((i) => i.receivedQty > 0);
      const status = allReceived ? 'recibido' : anyReceived ? 'recibido parcial' : o.status;
      await tx.supplyOrder.update({ where: { id }, data: { status, receivedAt: new Date(), warehouseRef: undefined } });
      return { id, status };
    });
  }
}
