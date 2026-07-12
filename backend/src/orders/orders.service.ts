import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { CategoryNameDto, CreateOrderDto, CreateSupplierDto, OrderItemDto, ReceiveOrderDto } from './dto/orders.dto';

const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? 0 : Number(d));
const round2 = (n: number) => Math.round(n * 100) / 100;
const dateOnly = (s?: string) => { const d = s ? new Date(s) : new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); };

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
    return {
      id: o.id, tid: o.tid, kind: o.kind, status: o.status, date: o.orderDate, dueDate: o.dueDate,
      subtotal: num(o.subtotal), tax: num(o.tax), discount: num(o.discount), total: num(o.total), paid: num(o.paidAmount),
      notes: o.notes, branchRef: o.branchRef, receivedAt: o.receivedAt,
      supplier: o.supplier ? { id: o.supplier.id, name: o.supplier.name, nit: o.supplier.nit, phone: o.supplier.phone, category: o.supplier.category } : null,
      items: o.items.map((it) => ({ id: it.id, product: it.product, qty: it.qty, price: num(it.price), taxRate: num(it.taxRate), subtotal: num(it.subtotal), taxTotal: num(it.taxTotal), received: it.receivedQty, materialId: it.materialId })),
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
      return { id: o.id, tid: o.tid, total, kind: o.kind };
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
