import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { CreateMaterialDto, SimpleCatalogDto, TransferDto, UpdateMaterialDto } from './dto/inventory.dto';

const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? 0 : Number(d));

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Resumen de inventario de material. */
  async stats() {
    const [count, categories, warehouses, lowStock, agg] = await Promise.all([
      this.prisma.material.count(),
      this.prisma.materialCategory.count(),
      this.prisma.materialWarehouse.count(),
      this.prisma.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*)::int AS c FROM "Material" WHERE alert IS NOT NULL AND alert > 0 AND qty <= alert`,
      // Valor físico: excluye "servicios" y filas basura (qty gigante = stock ilimitado del legacy).
      this.prisma.$queryRaw<{ v: number; u: number }[]>`SELECT COALESCE(SUM(price*qty),0)::float AS v, COALESCE(SUM(qty),0)::float AS u FROM "Material" WHERE qty < 100000`,
    ]);
    return {
      materiales: count, categorias: categories, bodegas: warehouses,
      stockBajo: Number(lowStock[0]?.c ?? 0),
      valorInventario: Number(agg[0]?.v ?? 0), unidades: Number(agg[0]?.u ?? 0),
    };
  }

  async categories() {
    const [rows, vals] = await Promise.all([
      this.prisma.materialCategory.findMany({ orderBy: { title: 'asc' }, include: { _count: { select: { materials: true } } } }),
      // Valor físico por categoría (excluye stock "ilimitado" del legacy, igual que stats).
      this.prisma.$queryRaw<{ id: string; v: number }[]>`SELECT "categoryId" AS id, COALESCE(SUM(price*qty),0)::float AS v FROM "Material" WHERE qty < 100000 AND "categoryId" IS NOT NULL GROUP BY "categoryId"`,
    ]);
    const valueById = new Map(vals.map((x) => [x.id, x.v]));
    return rows.map((c) => ({ id: c.id, title: c.title, extra: c.extra, materials: c._count.materials, value: valueById.get(c.id) ?? 0 }));
  }
  async warehouses() {
    const [rows, vals] = await Promise.all([
      this.prisma.materialWarehouse.findMany({ orderBy: { title: 'asc' }, include: { _count: { select: { materials: true } } } }),
      // Valor físico por bodega (excluye stock "ilimitado" del legacy, igual que stats).
      this.prisma.$queryRaw<{ id: string; v: number }[]>`SELECT "warehouseId" AS id, COALESCE(SUM(price*qty),0)::float AS v FROM "Material" WHERE qty < 100000 AND "warehouseId" IS NOT NULL GROUP BY "warehouseId"`,
    ]);
    const valueById = new Map(vals.map((x) => [x.id, x.v]));
    return rows.map((w) => ({ id: w.id, title: w.title, extra: w.extra, technicianRef: w.technicianRef, materials: w._count.materials, value: valueById.get(w.id) ?? 0 }));
  }
  createCategory(dto: SimpleCatalogDto) { return this.prisma.materialCategory.create({ data: { title: dto.title, extra: dto.extra ?? null } }); }
  updateCategory(id: string, dto: SimpleCatalogDto) { return this.prisma.materialCategory.update({ where: { id }, data: { title: dto.title, extra: dto.extra ?? null } }); }
  async deleteCategory(id: string) {
    const count = await this.prisma.material.count({ where: { categoryId: id } });
    if (count > 0) throw new BadRequestException(`No se puede eliminar: la categoría tiene ${count} material(es) asociado(s). Reasígnalos primero.`);
    await this.prisma.materialCategory.delete({ where: { id } });
    return { ok: true };
  }
  createWarehouse(dto: SimpleCatalogDto) { return this.prisma.materialWarehouse.create({ data: { title: dto.title, extra: dto.extra ?? null } }); }

  /** Listado de material con filtros. */
  async materials(params: { search?: string; categoryId?: string; warehouseId?: string; lowStock?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
    const where: Prisma.MaterialWhereInput = {};
    if (params.categoryId) where.categoryId = params.categoryId;
    if (params.warehouseId) where.warehouseId = params.warehouseId;
    const search = (params.search || '').trim();
    if (search) where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { code: { contains: search, mode: 'insensitive' } }];
    const [rows, total] = await Promise.all([
      this.prisma.material.findMany({ where, orderBy: { name: 'asc' }, skip: (page - 1) * pageSize, take: pageSize, include: { category: true, warehouse: true } }),
      this.prisma.material.count({ where }),
    ]);
    let items = rows.map((m) => ({
      id: m.id, name: m.name, code: m.code, category: m.category?.title ?? null, warehouse: m.warehouse?.title ?? null,
      price: num(m.price), cost: num(m.cost), taxRate: num(m.taxRate), qty: m.qty, alert: m.alert,
      low: m.alert != null && m.alert > 0 && m.qty <= m.alert, value: num(m.price) * m.qty,
    }));
    if (params.lowStock === '1') items = items.filter((i) => i.low);
    return { items, total, page, pageSize, pages: Math.ceil(total / pageSize) };
  }

  async materialDetail(id: string) {
    const m = await this.prisma.material.findUnique({ where: { id }, include: { category: true, warehouse: true } });
    if (!m) throw new NotFoundException('Material no encontrado');
    return {
      id: m.id, name: m.name, code: m.code, description: m.description,
      category: m.category ? { id: m.category.id, title: m.category.title } : null,
      warehouse: m.warehouse ? { id: m.warehouse.id, title: m.warehouse.title } : null,
      price: num(m.price), cost: num(m.cost), taxRate: num(m.taxRate), discRate: num(m.discRate),
      qty: m.qty, alert: m.alert, serviceType: m.serviceType, tvOrNet: m.tvOrNet,
    };
  }

  async createMaterial(dto: CreateMaterialDto) {
    return this.prisma.material.create({
      data: {
        name: dto.name, code: dto.code ?? null, categoryId: dto.categoryId ?? null, warehouseId: dto.warehouseId ?? null,
        price: dto.price ?? 0, cost: dto.cost ?? 0, taxRate: dto.taxRate ?? 0, qty: dto.qty ?? 0, alert: dto.alert ?? null, description: dto.description ?? null,
      },
    });
  }
  async updateMaterial(id: string, dto: UpdateMaterialDto) {
    const m = await this.prisma.material.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('Material no encontrado');
    return this.prisma.material.update({ where: { id }, data: { ...dto } });
  }
  async deleteMaterial(id: string) {
    const m = await this.prisma.material.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('Material no encontrado');
    await this.prisma.material.delete({ where: { id } });
    return { id, deleted: true };
  }

  /**
   * Emite un traspaso de material entre bodegas (flujo de dos pasos).
   * Descuenta del origen y deja el acta EN TRÁNSITO; el destino se acredita
   * al recibir (ver receiveActa). No mueve stock al destino todavía.
   */
  async transfer(dto: TransferDto, user: AuthUser) {
    if (dto.fromWarehouseId === dto.toWarehouseId) throw new BadRequestException('Bodega origen y destino deben ser distintas');
    if (!dto.items?.length) throw new BadRequestException('Sin ítems a transferir');
    // Consolida ítems repetidos y valida cantidades.
    const byMaterial = new Map<string, number>();
    for (const it of dto.items) {
      const qty = Number(it.qty);
      if (!it.materialId || !Number.isFinite(qty) || qty <= 0) throw new BadRequestException('Cada ítem debe tener una cantidad mayor a 0');
      byMaterial.set(it.materialId, (byMaterial.get(it.materialId) ?? 0) + qty);
    }
    const [from, to, receiver] = await Promise.all([
      this.prisma.materialWarehouse.findUnique({ where: { id: dto.fromWarehouseId } }),
      this.prisma.materialWarehouse.findUnique({ where: { id: dto.toWarehouseId } }),
      dto.receiverId ? this.prisma.user.findUnique({ where: { id: dto.receiverId }, select: { id: true, name: true } }) : Promise.resolve(null),
    ]);
    if (!from || !to) throw new NotFoundException('Bodega no encontrada');
    if (dto.receiverId && !receiver) throw new BadRequestException('El usuario que recibe no existe');

    return this.prisma.$transaction(async (tx) => {
      const acta = await tx.materialActa.create({
        data: {
          date: new Date(), fromWarehouseLegacy: from.legacyId ?? null, toWarehouseLegacy: to.legacyId ?? null,
          fromWarehouseId: from.id, toWarehouseId: to.id,
          fromWarehouseName: from.title, toWarehouseName: to.title, observations: dto.observations ?? null,
          status: 'En tránsito', itemsCount: byMaterial.size,
          createdByName: user.name,
          assignedToId: receiver?.id ?? null, assignedToName: receiver?.name ?? null,
        },
      });
      for (const [materialId, qty] of byMaterial) {
        const src = await tx.material.findUnique({ where: { id: materialId } });
        if (!src || src.warehouseId !== dto.fromWarehouseId) throw new BadRequestException('El material no está en la bodega origen');
        if (qty > src.qty) throw new BadRequestException(`Stock insuficiente de ${src.name} (${src.qty} disponibles)`);
        // Solo resta del origen; el destino se acredita al recibir.
        await tx.material.update({ where: { id: src.id }, data: { qty: src.qty - qty } });
        await tx.materialActaItem.create({ data: { actaId: acta.id, materialId: src.id, qty } });
      }
      return { actaId: acta.id, items: byMaterial.size, status: 'En tránsito' };
    });
  }

  /** Actas de traspaso (con filtros de búsqueda y estado). */
  async actas(params: { page?: number; pageSize?: number; search?: string; status?: string }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
    const and: Prisma.MaterialActaWhereInput[] = [];
    const q = params.search?.trim();
    if (q) {
      const ins = { contains: q, mode: 'insensitive' as const };
      and.push({ OR: [{ fromWarehouseName: ins }, { toWarehouseName: ins }, { observations: ins }, { createdByName: ins }, { receivedByName: ins }] });
    }
    if (params.status?.trim()) and.push({ status: params.status.trim() });
    const where: Prisma.MaterialActaWhereInput = and.length ? { AND: and } : {};
    const [rows, total] = await Promise.all([
      this.prisma.materialActa.findMany({ where, orderBy: { date: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: { items: { select: { qty: true } } } }),
      this.prisma.materialActa.count({ where }),
    ]);
    return {
      items: rows.map((a) => ({
        id: a.id, date: a.date, from: a.fromWarehouseName, to: a.toWarehouseName, observations: a.observations, status: a.status,
        items: a.items.length, units: a.items.reduce((s, it) => s + it.qty, 0),
        createdBy: a.createdByName, assignedTo: a.assignedToName, receivedBy: a.receivedByName, receivedAt: a.receivedAt,
      })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }
  async actaDetail(id: string, user?: AuthUser) {
    const a = await this.prisma.materialActa.findUnique({ where: { id }, include: { items: { include: { material: true } } } });
    if (!a) throw new NotFoundException('Acta no encontrada');
    const receivedCount = a.items.filter((it) => it.received).length;
    return {
      id: a.id, date: a.date, from: a.fromWarehouseName, to: a.toWarehouseName, observations: a.observations, status: a.status,
      createdBy: a.createdByName, assignedTo: a.assignedToName, assignedToId: a.assignedToId,
      receivedBy: a.receivedByName, receivedAt: a.receivedAt, createdAt: a.createdAt,
      units: a.items.reduce((s, it) => s + it.qty, 0),
      receivedCount, itemsTotal: a.items.length,
      // Flujo nuevo (en tránsito) y, si hay designado, solo él puede recibir.
      receivable: !!a.toWarehouseId && a.status !== 'Recibida',
      isReceiver: !!a.toWarehouseId && a.status !== 'Recibida' && (!a.assignedToId || a.assignedToId === user?.id),
      items: a.items.map((it) => ({
        id: it.id, material: it.material?.name ?? `#${it.materialLegacy}`, code: it.material?.code ?? null,
        qty: it.qty, price: num(it.material?.price ?? 0), value: num(it.material?.price ?? 0) * it.qty,
        received: it.received, receivedAt: it.receivedAt,
      })),
    };
  }

  /** Acredita un ítem en la bodega destino (busca/crea material por nombre). */
  private async creditItem(tx: Prisma.TransactionClient, warehouseId: string, src: { name: string; code: string | null; categoryId: string | null; price: Prisma.Decimal; cost: Prisma.Decimal; taxRate: Prisma.Decimal; discRate: Prisma.Decimal; alert: number | null; description: string | null }, qty: number) {
    const dst = await tx.material.findFirst({ where: { name: src.name, warehouseId } });
    if (dst) {
      await tx.material.update({ where: { id: dst.id }, data: { qty: dst.qty + qty } });
    } else {
      await tx.material.create({ data: {
        name: src.name, code: src.code, categoryId: src.categoryId, warehouseId,
        price: src.price, cost: src.cost, taxRate: src.taxRate, discRate: src.discRate, qty, alert: src.alert, description: src.description,
      } });
    }
  }

  /** Verifica que el usuario pueda recibir el acta (flujo nuevo + designado). */
  private assertCanReceive(a: { status: string; toWarehouseId: string | null; assignedToId: string | null }, user: AuthUser) {
    if (a.status === 'Recibida') throw new BadRequestException('El acta ya fue recibida');
    if (a.assignedToId && a.assignedToId !== user.id) throw new ForbiddenException('Solo la persona designada puede recibir este traspaso');
  }

  /**
   * Recibe UN ítem del acta (checklist): acredita ese ítem en el destino y lo
   * marca recibido. Cuando todos los ítems quedan recibidos, cierra el acta.
   * Solo el usuario designado (si lo hay) puede recibir.
   */
  async receiveActaItem(actaId: string, itemId: string, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const a = await tx.materialActa.findUnique({ where: { id: actaId }, include: { items: { include: { material: true } } } });
      if (!a) throw new NotFoundException('Acta no encontrada');
      if (!a.toWarehouseId) throw new BadRequestException('Esta acta no admite recepción por ítem');
      this.assertCanReceive(a, user);
      const item = a.items.find((it) => it.id === itemId);
      if (!item) throw new NotFoundException('Ítem no encontrado');
      if (item.received) throw new BadRequestException('Ese ítem ya fue recibido');

      if (item.material) await this.creditItem(tx, a.toWarehouseId, item.material, item.qty);
      await tx.materialActaItem.update({ where: { id: item.id }, data: { received: true, receivedAt: new Date() } });

      const remaining = a.items.filter((it) => it.id !== item.id && !it.received).length;
      const closed = remaining === 0;
      if (closed) {
        await tx.materialActa.update({ where: { id: actaId }, data: { status: 'Recibida', receivedAt: new Date(), receivedByName: user.name } });
      }
      return { id: actaId, itemId, received: true, status: closed ? 'Recibida' : a.status, receivedCount: a.items.filter((it) => it.received).length + 1, itemsTotal: a.items.length };
    });
  }

  /**
   * Recibe el acta COMPLETA (todos los ítems pendientes de una vez).
   * Idempotente por estado. Actas del flujo antiguo (sin toWarehouseId) solo se
   * sellan. Solo el usuario designado (si lo hay) puede recibir.
   */
  async receiveActa(id: string, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const a = await tx.materialActa.findUnique({ where: { id }, include: { items: { include: { material: true } } } });
      if (!a) throw new NotFoundException('Acta no encontrada');
      if (a.status === 'Recibida') throw new BadRequestException('El acta ya fue recibida');
      if (a.assignedToId && a.assignedToId !== user.id) throw new ForbiddenException('Solo la persona designada puede recibir este traspaso');

      // Acredita el destino solo para actas del flujo nuevo, ítems no recibidos aún.
      if (a.toWarehouseId) {
        for (const it of a.items) {
          if (it.received || !it.material) continue;
          await this.creditItem(tx, a.toWarehouseId, it.material, it.qty);
          await tx.materialActaItem.update({ where: { id: it.id }, data: { received: true, receivedAt: new Date() } });
        }
      }

      await tx.materialActa.update({ where: { id }, data: { status: 'Recibida', receivedAt: new Date(), receivedByName: user.name } });
      return { id, status: 'Recibida' };
    });
  }
}
