import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Workbook } from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { orden } from '../common/pagination-params';
import { AuthUser } from '../auth/current-user.decorator';
import { CreateMaterialDto, SimpleCatalogDto, TransferDto, UpdateMaterialDto, WarehouseDto } from './dto/inventory.dto';
import { num } from '../common/money';
import { SUPERADMIN_PERMISSION } from '../auth/permissions.catalog';
import { bodegaMaterialDelTecnico, esTecnicoDeCampo } from '../common/tecnico-scope';
import { SignatureOtpService } from '../common/signature/signature-otp.service';
import { WhatsappService } from '../common/whatsapp/whatsapp.service';
import { pdfToBuffer } from '../common/pdf/pdf-buffer';
import { actaPdf, ActaPdfData } from '../common/pdf/pdf-docs';

/**
 * Categoría que la cajera puede entregarle a un técnico. Decisión de negocio
 * (2026-07-30): la cajera mueve consumible y nada más; herramienta, dotación y
 * activos los entrega bodega, que responde por la devolución.
 *
 * Es UN punto de cambio a propósito: si mañana nace otra categoría de consumible,
 * se añade aquí (o se convierte en un check por categoría) y no hay que tocar la
 * lógica del traspaso.
 */
const CONSUMABLE_CATEGORY_TITLES = ['CONSUMIBLES'];

/**
 * Áreas cuyo traspaso NO se restringe: ven todas las bodegas y todo el material.
 * Quien no esté en ninguna (la cajera) queda acotado a los técnicos de su sede y
 * a los consumibles.
 */
const UNRESTRICTED_AREAS = ['area.administracion', 'area.tecnicos'];

/**
 * Parsea el CSV legacy de sedes de `Staff.sedeAccede` ('-3-,-4-'). El '0' del
 * legacy, el vacío y el null significan TODAS, que aquí se representa con `[]`
 * (igual criterio que `User.sedesAccede`).
 */
function parseSedesCsv(csv: string | null | undefined): number[] {
  if (!csv) return [];
  const ids = csv.split(',').map((p) => Number(p.replace(/-/g, '').trim())).filter((n) => Number.isFinite(n) && n > 0);
  return [...new Set(ids)];
}

/** Dos ámbitos de sede se cruzan si comparten alguna, o si alguno es "todas" (`[]`). */
function sedesOverlap(a: number[], b: number[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  return a.some((x) => b.includes(x));
}

@Injectable()
export class InventoryService {
  private readonly logger = new Logger('Inventory');

  constructor(
    private readonly prisma: PrismaService,
    private readonly firma: SignatureOtpService,
    private readonly whatsapp: WhatsappService,
  ) {}

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
  /**
   * Bodegas de material. Un técnico de campo ve SÓLO la suya (2026-07-31): la
   * pantalla es "mi bodega", no el mapa del inventario de la empresa. Sin bodega
   * personal —o sin ficha de empleado— no ve ninguna, que es el lado seguro.
   */
  async warehouses(user?: AuthUser) {
    const soloSuya = await this.bodegaPropiaSiEsTecnico(user);
    const where: Prisma.MaterialWarehouseWhereInput = soloSuya ? { id: soloSuya.id ?? '—sin-bodega—' } : {};
    const [rows, vals] = await Promise.all([
      this.prisma.materialWarehouse.findMany({
        where,
        orderBy: { title: 'asc' },
        include: { _count: { select: { materials: true } }, manager: { select: { id: true, name: true } } },
      }),
      // Valor físico por bodega (excluye stock "ilimitado" del legacy, igual que stats).
      this.prisma.$queryRaw<{ id: string; v: number }[]>`SELECT "warehouseId" AS id, COALESCE(SUM(price*qty),0)::float AS v FROM "Material" WHERE qty < 100000 AND "warehouseId" IS NOT NULL GROUP BY "warehouseId"`,
    ]);
    const valueById = new Map(vals.map((x) => [x.id, x.v]));
    return rows.map((w) => ({
      id: w.id, title: w.title, extra: w.extra, technicianRef: w.technicianRef,
      managerId: w.managerId, managerName: w.manager?.name ?? null,
      materials: w._count.materials, value: valueById.get(w.id) ?? 0,
    }));
  }

  // ── Alcance del técnico de campo ────────────────────────────────────────────

  /**
   * Bodega a la que hay que acotar a este usuario, o `null` si no hay que acotarlo.
   *
   * El `{ id: null }` NO es lo mismo que `null`: significa "es técnico y no tiene
   * bodega personal" (no está vinculado o su almacén no existe), y en ese caso no
   * puede ver el material de nadie más. Los dos casos se distinguen a propósito —
   * confundirlos abriría el inventario entero justo al que menos debe verlo.
   */
  private async bodegaPropiaSiEsTecnico(user?: AuthUser): Promise<{ id: string | null } | null> {
    if (!esTecnicoDeCampo(user)) return null;
    const bodega = await bodegaMaterialDelTecnico(this.prisma, user!);
    return { id: bodega?.id ?? null };
  }

  /** Puerta de las escrituras: el técnico entra a mirar su bodega, no a administrar. */
  private exigirNoSerTecnico(user: AuthUser | undefined, accion: string): void {
    if (esTecnicoDeCampo(user)) {
      throw new ForbiddenException(`No tienes permiso para ${accion}. Tu acceso al inventario es de consulta sobre tu propia bodega.`);
    }
  }

  // ── Contexto del traspaso ───────────────────────────────────────────────────

  /** Sedes del usuario autenticado. `[]` = todas (gerencia/admin y el '0' legacy). */
  private async userSedes(userId: string): Promise<number[]> {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { sedesAccede: true } });
    return (u?.sedesAccede ?? []).filter((n) => Number.isFinite(n) && n > 0);
  }

  /** Ids de las categorías que cuentan como consumible (ver CONSUMABLE_CATEGORY_TITLES). */
  private async consumableCategoryIds(): Promise<string[]> {
    const rows = await this.prisma.materialCategory.findMany({
      where: { OR: CONSUMABLE_CATEGORY_TITLES.map((t) => ({ title: { equals: t, mode: 'insensitive' as const } })) },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Todo lo que la pantalla de "nuevo traspaso" necesita para pintarse, resuelto
   * en el servidor: qué modos puede usar, qué bodegas y qué técnicos ve, y quién
   * recibe en cada destino. La pantalla NO decide nada de esto; `transfer()`
   * vuelve a validarlo, así que tocar la petición a mano no salta la regla.
   */
  async transferContext(user: AuthUser) {
    const perms = user.permissions ?? [];
    const isSuperadmin = perms.includes(SUPERADMIN_PERMISSION);
    // "Bodega" = administración o técnicos. La cajera no está en ninguna: es la
    // única que queda restringida (decisión 2026-07-30).
    const unrestricted = isSuperadmin || UNRESTRICTED_AREAS.some((a) => perms.includes(a));

    const [warehouses, branches, staff, users, consumableIds, mySedes] = await Promise.all([
      this.prisma.materialWarehouse.findMany({
        orderBy: { title: 'asc' },
        include: { _count: { select: { materials: true } }, manager: { select: { id: true, name: true } } },
      }),
      this.prisma.branch.findMany({ orderBy: { legacyId: 'asc' }, select: { legacyId: true, name: true } }),
      this.prisma.staff.findMany({ where: { username: { not: null } }, select: { username: true, name: true, email: true, sedeAccede: true, banned: true } }),
      this.prisma.user.findMany({ where: { isActive: true }, select: { id: true, email: true } }),
      this.consumableCategoryIds(),
      this.userSedes(user.id),
    ]);

    const branchName = new Map(branches.map((b) => [b.legacyId, b.name]));
    // `technicianRef` viene del legacy y trae basura de captura (mayúsculas
    // distintas, espacios al final: 'OmarTec '), así que se casa normalizado.
    const staffByUsername = new Map(staff.map((s) => [(s.username ?? '').trim().toLowerCase(), s]));
    const userByEmail = new Map(users.map((u) => [(u.email ?? '').trim().toLowerCase(), u.id]));

    const todosLosTecnicos = warehouses
      .filter((w) => w.technicianRef)
      .map((w) => {
        const s = staffByUsername.get((w.technicianRef ?? '').trim().toLowerCase());
        const sedes = parseSedesCsv(s?.sedeAccede);
        return {
          warehouseId: w.id, warehouseTitle: w.title, technicianRef: w.technicianRef,
          name: s?.name ?? null,
          // Sin empleado que case, no hay a quién designar ni de qué sede es.
          // Pasa en 2 almacenes cuyo `technicianRef` quedó apuntando a un username
          // que ya no existe; se ven, con su aviso, para que los arreglen.
          linked: Boolean(s),
          retired: Boolean(s?.banned),
          userId: s?.email ? userByEmail.get(s.email.trim().toLowerCase()) ?? null : null,
          sedes, sedeNames: sedes.length ? sedes.map((n) => branchName.get(n) ?? `Sede ${n}`) : branches.map((b) => b.name),
          materials: w._count.materials,
        };
      });

    const technicians = todosLosTecnicos
      // A un ex-empleado no se le entrega material: su usuario está desactivado, no
      // puede firmar el acta y ya no trabaja aquí. Son 17 de 35 almacenes (Staff
      // `banned` calza 1-a-1 con `User.isActive=false`). El material que aún tengan
      // se recupera por el modo "entre bodegas", que sí lista todas las bodegas.
      .filter((t) => !t.retired)
      // La cajera sólo ve técnicos de su sede; sin empleado vinculado no se puede
      // saber la sede, así que no se le ofrece.
      .filter((t) => (unrestricted ? true : t.linked && sedesOverlap(mySedes, t.sedes)))
      .sort((a, b) => (a.name ?? a.warehouseTitle).localeCompare(b.name ?? b.warehouseTitle, 'es'));

    const mapWarehouse = (w: (typeof warehouses)[number]) => ({
      id: w.id, title: w.title, extra: w.extra,
      isTechnician: Boolean(w.technicianRef),
      managerId: w.managerId, managerName: w.manager?.name ?? null,
      materials: w._count.materials,
    });

    return {
      // La cajera no elige libremente quién recibe ni qué mueve.
      restricted: !unrestricted,
      // El tab "Entre bodegas" es de bodega/admin: abre todo el material y todas
      // las bodegas, que es justo lo que no se le da a caja.
      canWarehouseMode: unrestricted,
      onlyConsumable: !unrestricted,
      consumableCategoryIds: consumableIds,
      mySedes, mySedeNames: mySedes.length ? mySedes.map((n) => branchName.get(n) ?? `Sede ${n}`) : branches.map((b) => b.name),
      // Todas las bodegas (incluidas las de técnico) para el modo entre bodegas:
      // así bodega puede devolver material desde el almacén de un técnico.
      warehouses: warehouses.map(mapWarehouse),
      // Origen del modo "a técnico": bodegas generales. No se saca material de la
      // bodega personal de otro técnico para entregársela a un tercero.
      originWarehouses: warehouses.filter((w) => !w.technicianRef).map(mapWarehouse),
      technicians,
      // Cuántos almacenes de técnico quedaron fuera por ser de un ex-empleado, y
      // cuánto material siguen guardando: si no se dice, la lista corta parece
      // completa y ese material queda invisible.
      retiredTechnicians: todosLosTecnicos.filter((t) => t.retired).length,
      retiredMaterials: todosLosTecnicos.filter((t) => t.retired).reduce((a, t) => a + t.materials, 0),
    };
  }
  createCategory(dto: SimpleCatalogDto) { return this.prisma.materialCategory.create({ data: { title: dto.title, extra: dto.extra ?? null } }); }
  updateCategory(id: string, dto: SimpleCatalogDto) { return this.prisma.materialCategory.update({ where: { id }, data: { title: dto.title, extra: dto.extra ?? null } }); }
  async deleteCategory(id: string) {
    const count = await this.prisma.material.count({ where: { categoryId: id } });
    if (count > 0) throw new BadRequestException(`No se puede eliminar: la categoría tiene ${count} material(es) asociado(s). Reasígnalos primero.`);
    await this.prisma.materialCategory.delete({ where: { id } });
    return { ok: true };
  }
  createWarehouse(dto: WarehouseDto, user?: AuthUser) {
    this.exigirNoSerTecnico(user, 'crear bodegas');
    return this.prisma.materialWarehouse.create({ data: { title: dto.title, extra: dto.extra ?? null, managerId: dto.managerId || null } });
  }
  updateWarehouse(id: string, dto: WarehouseDto, user?: AuthUser) {
    this.exigirNoSerTecnico(user, 'editar bodegas');
    // `managerId: ''` (o null) desasigna al encargado; no enviarlo lo deja igual.
    const data: Prisma.MaterialWarehouseUpdateInput = { title: dto.title, extra: dto.extra ?? null };
    if (dto.managerId !== undefined) {
      data.manager = dto.managerId ? { connect: { id: dto.managerId } } : { disconnect: true };
    }
    return this.prisma.materialWarehouse.update({ where: { id }, data });
  }
  async deleteWarehouse(id: string, user?: AuthUser) {
    this.exigirNoSerTecnico(user, 'eliminar bodegas');
    const count = await this.prisma.material.count({ where: { warehouseId: id } });
    if (count > 0) throw new BadRequestException(`No se puede eliminar: la bodega tiene ${count} material(es). Trasládalos primero.`);
    await this.prisma.materialWarehouse.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * Importa materiales desde un Excel. Cabeceras reconocidas (fila 1, insensible a
   * mayúsculas): nombre, codigo, categoria, bodega, precio, costo, iva, cantidad,
   * alerta. Crea la categoría/bodega por título si no existe. Devuelve el resumen.
   */
  async importMaterials(buffer: Buffer) {
    const wb = new Workbook();
    await wb.xlsx.load(buffer as any);
    const ws = wb.worksheets[0];
    if (!ws) throw new BadRequestException('El archivo no tiene hojas.');

    const headers: Record<string, number> = {};
    ws.getRow(1).eachCell((cell, col) => { headers[String(cell.value ?? '').trim().toLowerCase()] = col; });
    const pick = (names: string[]) => { for (const n of names) if (headers[n] != null) return headers[n]; return null; };
    const cName = pick(['nombre', 'name', 'material', 'producto']);
    if (!cName) throw new BadRequestException('Falta la columna "nombre" en la primera fila.');
    const cCode = pick(['codigo', 'código', 'code', 'sku']);
    const cCat = pick(['categoria', 'categoría', 'category']);
    const cWh = pick(['bodega', 'almacen', 'almacén', 'warehouse']);
    const cPrice = pick(['precio', 'price', 'venta']);
    const cCost = pick(['costo', 'cost', 'compra']);
    const cTax = pick(['iva', 'impuesto', 'tax']);
    const cQty = pick(['cantidad', 'qty', 'stock', 'existencia']);
    const cAlert = pick(['alerta', 'minimo', 'mínimo', 'alert']);

    const [cats, whs] = await Promise.all([
      this.prisma.materialCategory.findMany({ select: { id: true, title: true } }),
      this.prisma.materialWarehouse.findMany({ select: { id: true, title: true } }),
    ]);
    const catMap = new Map(cats.map((c) => [c.title.trim().toLowerCase(), c.id]));
    const whMap = new Map(whs.map((w) => [w.title.trim().toLowerCase(), w.id]));

    const str = (row: any, col: number | null) => (col ? String(row.getCell(col).value ?? '').trim() : '');
    const numv = (row: any, col: number | null) => {
      if (!col) return 0;
      const v = row.getCell(col).value;
      const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^\d.-]/g, ''));
      return Number.isFinite(n) ? n : 0;
    };

    let created = 0, skipped = 0;
    const errors: string[] = [];
    for (let i = 2; i <= ws.rowCount; i++) {
      const row = ws.getRow(i);
      const name = str(row, cName);
      if (!name) { skipped++; continue; }
      try {
        let categoryId: string | null = null;
        const catTitle = str(row, cCat);
        if (catTitle) {
          const key = catTitle.toLowerCase();
          categoryId = catMap.get(key) ?? null;
          if (!categoryId) { const c = await this.prisma.materialCategory.create({ data: { title: catTitle } }); categoryId = c.id; catMap.set(key, c.id); }
        }
        let warehouseId: string | null = null;
        const whTitle = str(row, cWh);
        if (whTitle) {
          const key = whTitle.toLowerCase();
          warehouseId = whMap.get(key) ?? null;
          if (!warehouseId) { const w = await this.prisma.materialWarehouse.create({ data: { title: whTitle } }); warehouseId = w.id; whMap.set(key, w.id); }
        }
        await this.prisma.material.create({
          data: {
            name, code: str(row, cCode) || null, categoryId, warehouseId,
            price: numv(row, cPrice), cost: numv(row, cCost), taxRate: numv(row, cTax),
            qty: Math.round(numv(row, cQty)), alert: cAlert ? Math.round(numv(row, cAlert)) : null,
          },
        });
        created++;
      } catch (e) {
        if (errors.length < 12) errors.push(`Fila ${i} (${name}): ${(e as Error).message}`);
        skipped++;
      }
    }
    return { created, skipped, errors };
  }

  /** Listado de material con filtros. */
  /**
   * Columnas ordenables del inventario de materiales.
   *
   * `value` (valor = precio × stock) no está: es una multiplicación y Prisma no
   * la sabe poner en un ORDER BY. Se ordena por precio o por stock.
   */
  private static readonly ORDEN_MATERIALES = {
    name: 'name',
    code: 'code',
    category: 'category.title',
    warehouse: 'warehouse.title',
    price: 'price',
    qty: 'qty',
  };

  async materials(params: { search?: string; categoryId?: string; warehouseId?: string; lowStock?: string; onlyConsumable?: string; page?: number; pageSize?: number; sortBy?: string; sortDir?: string }, user?: AuthUser) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
    const where: Prisma.MaterialWhereInput = {};
    if (params.categoryId) where.categoryId = params.categoryId;
    // Lo que la cajera puede entregarle a un técnico. El filtro de verdad está en
    // `transfer()`; esto es para no ofrecerle en pantalla lo que le van a rechazar.
    if (params.onlyConsumable === '1') where.categoryId = { in: await this.consumableCategoryIds() };
    if (params.warehouseId) where.warehouseId = params.warehouseId;
    // A un técnico se le fija SU bodega, pida la que pida: el `warehouseId` de la
    // query se ignora en vez de servírselo (mismo criterio que `NetworkService.equipment`).
    const soloSuya = await this.bodegaPropiaSiEsTecnico(user);
    if (soloSuya) where.warehouseId = soloSuya.id ?? '—sin-bodega—';
    const search = (params.search || '').trim();
    if (search) where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { code: { contains: search, mode: 'insensitive' } }];
    const [rows, total] = await Promise.all([
      this.prisma.material.findMany({ where, orderBy: orden(params, InventoryService.ORDEN_MATERIALES, { name: 'asc' }), skip: (page - 1) * pageSize, take: pageSize, include: { category: true, warehouse: true } }),
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

  async materialDetail(id: string, user?: AuthUser) {
    const m = await this.prisma.material.findUnique({ where: { id }, include: { category: true, warehouse: true } });
    if (!m) throw new NotFoundException('Material no encontrado');
    // La lista ya va acotada; la ficha se abre por URL y necesita su propia puerta.
    const soloSuya = await this.bodegaPropiaSiEsTecnico(user);
    if (soloSuya && m.warehouseId !== soloSuya.id) {
      throw new ForbiddenException('Ese material no está en tu bodega.');
    }
    return {
      id: m.id, name: m.name, code: m.code, description: m.description,
      category: m.category ? { id: m.category.id, title: m.category.title } : null,
      warehouse: m.warehouse ? { id: m.warehouse.id, title: m.warehouse.title } : null,
      price: num(m.price), cost: num(m.cost), taxRate: num(m.taxRate), discRate: num(m.discRate),
      qty: m.qty, alert: m.alert, serviceType: m.serviceType, tvOrNet: m.tvOrNet,
    };
  }

  async createMaterial(dto: CreateMaterialDto, user?: AuthUser) {
    this.exigirNoSerTecnico(user, 'crear material');
    return this.prisma.material.create({
      data: {
        name: dto.name, code: dto.code ?? null, categoryId: dto.categoryId ?? null, warehouseId: dto.warehouseId ?? null,
        price: dto.price ?? 0, cost: dto.cost ?? 0, taxRate: dto.taxRate ?? 0, qty: dto.qty ?? 0, alert: dto.alert ?? null, description: dto.description ?? null,
      },
    });
  }
  async updateMaterial(id: string, dto: UpdateMaterialDto, user?: AuthUser) {
    this.exigirNoSerTecnico(user, 'editar material');
    const m = await this.prisma.material.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('Material no encontrado');
    return this.prisma.material.update({ where: { id }, data: { ...dto } });
  }
  async deleteMaterial(id: string, user?: AuthUser) {
    this.exigirNoSerTecnico(user, 'eliminar material');
    const m = await this.prisma.material.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('Material no encontrado');
    await this.prisma.material.delete({ where: { id } });
    return { id, deleted: true };
  }

  /**
   * Comprueba, contra el contexto del usuario, que este traspaso le está permitido,
   * y devuelve quién recibe. La pantalla ya filtra, pero la frontera es ésta: una
   * cajera que reenvíe la petición a mano choca igual con estas tres reglas.
   */
  private async resolveTransfer(dto: TransferDto, user: AuthUser, materialIds: string[]) {
    const ctx = await this.transferContext(user);
    const to = ctx.warehouses.find((w) => w.id === dto.toWarehouseId);
    const from = ctx.warehouses.find((w) => w.id === dto.fromWarehouseId);
    if (!from || !to) throw new NotFoundException('Bodega no encontrada');

    if (ctx.restricted) {
      // 1) sólo entrega a técnicos, 2) de su sede, 3) desde una bodega general.
      const tech = ctx.technicians.find((t) => t.warehouseId === to.id);
      if (!tech) throw new ForbiddenException('Sólo puedes entregarle material a un técnico de tu sede.');
      if (from.isTechnician) throw new ForbiddenException('El material debe salir de una bodega, no del almacén de otro técnico.');
      // 4) y sólo consumible.
      const noConsumible = await this.prisma.material.findFirst({
        where: { id: { in: materialIds }, OR: [{ categoryId: null }, { categoryId: { notIn: ctx.consumableCategoryIds } }] },
        select: { name: true },
      });
      if (noConsumible) throw new ForbiddenException(`"${noConsumible.name}" no es consumible; ese material lo entrega bodega.`);
    }

    // Quien recibe NO lo elige quien emite: en una bodega de técnico es el técnico
    // (dueño de su material) y en una bodega general su encargado. Si el destino no
    // tiene a nadie, el acta queda sin designado y la puede recibir cualquiera con
    // acceso — es el comportamiento que ya había, no un bloqueo nuevo.
    const tech = ctx.technicians.find((t) => t.warehouseId === to.id);
    const receiver = to.isTechnician
      ? (tech?.userId ? { id: tech.userId, name: tech.name ?? to.title } : null)
      : (to.managerId ? { id: to.managerId, name: to.managerName ?? to.title } : null);

    return { receiver };
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
    const [from, to, { receiver }] = await Promise.all([
      this.prisma.materialWarehouse.findUnique({ where: { id: dto.fromWarehouseId } }),
      this.prisma.materialWarehouse.findUnique({ where: { id: dto.toWarehouseId } }),
      // Valida permiso y deriva a quien recibe (técnico o encargado de la bodega).
      this.resolveTransfer(dto, user, [...byMaterial.keys()]),
    ]);
    if (!from || !to) throw new NotFoundException('Bodega no encontrada');

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
    }).then(async (r) => {
      // El acta sale sola hacia quien la tiene que firmar. Fuera de la transacción
      // a propósito: armar el PDF y hablar con Meta tarda, y no se va a tener el
      // stock bloqueado esperando a WhatsApp. Que el envío falle NO invalida el
      // traspaso —el material ya salió de la bodega—, solo queda sin avisar y se
      // devuelve el porqué para que la pantalla lo diga.
      const envio = await this.enviarActa(r.actaId).catch((e) => {
        this.logger.warn(`No se pudo enviar el acta ${r.actaId}: ${(e as Error).message}`);
        return { enviado: false as const, motivo: 'Error al enviar el acta.' };
      });
      return { ...r, envio };
    });
  }

  // ── El acta: PDF, envío automático y firma de quien recibe ─────────────────

  /** Datos del acta para el PDF (mismo render que se descarga y que se manda). */
  async actaPdfData(id: string): Promise<ActaPdfData & { assignedToId: string | null }> {
    const a = await this.prisma.materialActa.findUnique({
      where: { id },
      include: { items: { include: { material: true } } },
    });
    if (!a) throw new NotFoundException('Acta no encontrada');
    return {
      titulo: 'Acta de traspaso de material',
      // El id es un cuid: se muestran los últimos 6 en mayúsculas, que es lo que
      // alguien puede leer por teléfono sin equivocarse.
      numero: (a.legacyId ? String(a.legacyId) : a.id.slice(-6).toUpperCase()),
      date: a.date,
      status: a.status,
      from: a.fromWarehouseName ?? '—',
      to: a.toWarehouseName ?? '—',
      observations: a.observations,
      columnaDerecha: 'Cantidad',
      items: a.items.map((it) => ({
        descripcion: it.material?.name ?? `#${it.materialLegacy}`,
        detalle: it.material?.code ?? null,
        cantidad: String(it.qty),
      })),
      entrega: { nombre: a.createdByName, fecha: a.date },
      recibe: { nombre: a.receivedByName, fecha: a.receivedAt, nota: a.receivedSignature },
      assignedToId: a.assignedToId,
    };
  }

  /**
   * Le manda el acta en PDF, por WhatsApp, a quien tiene que firmarla.
   *
   * Sin designado no hay a quién mandársela (actas viejas o bodegas sin encargado):
   * no es un error, es que ese traspaso lo recibe cualquiera con acceso.
   */
  private async enviarActa(id: string): Promise<{ enviado: boolean; motivo?: string; a?: string | null }> {
    const data = await this.actaPdfData(id);
    if (!data.assignedToId) {
      return { enviado: false, motivo: 'La bodega destino no tiene encargado, así que no hay a quién mandarle el acta.' };
    }
    const { phone } = await this.firma.telefono(data.assignedToId);
    if (!phone) {
      return {
        enviado: false,
        motivo: `${data.recibe.nombre ?? 'Quien recibe'} no tiene celular registrado: no se le pudo mandar el acta. Puede firmarla igual entrando al sistema.`,
      };
    }

    const pdf = await pdfToBuffer((res) => actaPdf(res, data));
    const enviado = await this.whatsapp.sendDocument(
      phone,
      pdf,
      `acta-traspaso-${data.numero}.pdf`,
      `Traspaso de ${data.from} a ${data.to}: ${data.items.length} ítem(s). ` +
      `Para firmar el recibido entra al sistema (Inventario ▸ Actas) y pide tu código.`,
    );
    if (!enviado) {
      return { enviado: false, motivo: 'WhatsApp no pudo entregar el acta en este momento; queda disponible en el sistema.' };
    }
    await this.prisma.materialActa.update({
      where: { id },
      data: { notifiedAt: new Date(), notifiedTo: phone },
    });
    this.logger.log(`Acta ${data.numero} enviada a ••••${phone.slice(-4)} (${data.recibe.nombre ?? data.assignedToId}).`);
    return { enviado: true, a: SignatureOtpService.mask(phone) };
  }

  /** Reenvía el acta a quien la tiene que firmar (botón de la pantalla). */
  async reenviarActa(id: string, user: AuthUser) {
    const a = await this.prisma.materialActa.findUnique({ where: { id }, select: { status: true, toWarehouseId: true, assignedToId: true } });
    if (!a) throw new NotFoundException('Acta no encontrada');
    if (a.status === 'Recibida') throw new BadRequestException('El acta ya fue recibida y firmada.');
    this.assertCanReceive({ ...a, status: a.status }, user, { permitirEmisor: true });
    return this.enviarActa(id);
  }

  /** Manda al WhatsApp de quien recibe el código para firmar el acta. */
  async pedirCodigoActa(id: string, user: AuthUser) {
    const a = await this.prisma.materialActa.findUnique({
      where: { id },
      select: { status: true, toWarehouseId: true, assignedToId: true, fromWarehouseName: true, toWarehouseName: true, itemsCount: true },
    });
    if (!a) throw new NotFoundException('Acta no encontrada');
    this.assertCanReceive(a, user);
    return this.firma.pedir({
      userId: user.id,
      purpose: 'material.receive',
      targetId: id,
      detalle: `el recibido de ${a.itemsCount} ítem(s) de material que ${a.fromWarehouseName ?? 'otra bodega'} le manda a ${a.toWarehouseName ?? 'su bodega'}`,
    });
  }

  /** Actas de traspaso (con filtros de búsqueda y estado). */
  /** Columnas ordenables de la tabla de actas de traspaso. */
  private static readonly ORDEN_ACTAS = {
    date: 'date', from: 'fromWarehouseName', to: 'toWarehouseName',
    obs: 'observations', status: 'status',
    items: (dir: 'asc' | 'desc') => ({ items: { _count: dir } }),
  };

  async actas(params: { page?: number; pageSize?: number; search?: string; status?: string; sortBy?: string; sortDir?: string }) {
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
      this.prisma.materialActa.findMany({ where, orderBy: orden(params, InventoryService.ORDEN_ACTAS, { date: 'desc' }), skip: (page - 1) * pageSize, take: pageSize, include: { items: { select: { qty: true } } } }),
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
      // Cómo firmó quien recibió, y si se le alcanzó a mandar el acta por WhatsApp.
      receivedSignature: a.receivedSignature,
      notifiedAt: a.notifiedAt, notifiedTo: SignatureOtpService.mask(a.notifiedTo),
      units: a.items.reduce((s, it) => s + it.qty, 0),
      receivedCount, itemsTotal: a.items.length,
      // Todo marcado pero sin firmar: lo único que falta es su código.
      faltaFirma: !!a.toWarehouseId && a.status !== 'Recibida' && receivedCount === a.items.length && a.items.length > 0,
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

  /**
   * Verifica que el usuario pueda recibir el acta (flujo nuevo + designado).
   *
   * El designado ya no lo escoge quien emite: sale del destino (el técnico, o el
   * encargado de la bodega). Como ahora casi toda acta lleva designado, el
   * superadministrador puede firmar en su lugar; si no, un técnico de vacaciones
   * dejaría el material colgado en tránsito sin forma de acreditarlo.
   */
  private assertCanReceive(
    a: { status: string; toWarehouseId: string | null; assignedToId: string | null },
    user: AuthUser,
    opts: { permitirEmisor?: boolean } = {},
  ) {
    if (a.status === 'Recibida') throw new BadRequestException('El acta ya fue recibida');
    if (user.permissions?.includes(SUPERADMIN_PERMISSION)) return;
    // Reenviar el acta sí lo puede hacer quien la emitió (es su papel, y es quien
    // se entera de que al otro no le llegó); firmarla no.
    if (opts.permitirEmisor) return;
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
      // Marcar el último ítem YA NO cierra el acta: cerrarla es firmarla, y eso va
      // con código (ver `receiveActa`). Si no, el checklist sería la puerta de atrás
      // para cerrar un acta sin firma. El acta queda con todo recibido y esperando
      // la firma; la pantalla lo dice así.
      const todoRecibido = remaining === 0;
      return {
        id: actaId, itemId, received: true, status: a.status,
        receivedCount: a.items.filter((it) => it.received).length + 1,
        itemsTotal: a.items.length,
        faltaFirma: todoRecibido,
      };
    });
  }

  /**
   * Recibe y FIRMA el acta completa: acredita lo que falte en la bodega destino y
   * la cierra con la firma de quien recibe.
   *
   * La firma es un código de un solo uso que le llegó a su WhatsApp
   * (`signature.otpRequired`; el mismo mecanismo de las órdenes de compra). Se
   * consume ANTES de abrir la transacción —verificarlo cuesta un scrypt y no se va
   * a tener el stock bloqueado mientras tanto—; si la recepción falla justo después,
   * el código queda quemado y se pide otro.
   *
   * Las actas del flujo antiguo (sin `toWarehouseId`) solo se sellan, y sin código:
   * no tienen designado ni acreditan stock, son historia importada.
   */
  async receiveActa(id: string, user: AuthUser, code?: string) {
    const previa = await this.prisma.materialActa.findUnique({
      where: { id },
      select: { status: true, toWarehouseId: true, assignedToId: true },
    });
    if (!previa) throw new NotFoundException('Acta no encontrada');
    this.assertCanReceive(previa, user);

    const { required } = await this.firma.config();
    const exigeFirma = required && !!previa.toWarehouseId;
    if (exigeFirma && !code) {
      throw new BadRequestException('Este recibido va firmado: pide tu código y escríbelo para confirmar.');
    }
    const firma = exigeFirma
      ? await this.firma.firmar({ userId: user.id, purpose: 'material.receive', targetId: id, code: code ?? '' })
      : null;

    return this.prisma.$transaction(async (tx) => {
      const a = await tx.materialActa.findUnique({ where: { id }, include: { items: { include: { material: true } } } });
      if (!a) throw new NotFoundException('Acta no encontrada');
      this.assertCanReceive(a, user);

      // Acredita el destino solo para actas del flujo nuevo, ítems no recibidos aún.
      if (a.toWarehouseId) {
        for (const it of a.items) {
          if (it.received || !it.material) continue;
          await this.creditItem(tx, a.toWarehouseId, it.material, it.qty);
          await tx.materialActaItem.update({ where: { id: it.id }, data: { received: true, receivedAt: new Date() } });
        }
      }

      await tx.materialActa.update({
        where: { id },
        data: {
          status: 'Recibida', receivedAt: new Date(), receivedByName: user.name, receivedById: user.id,
          receivedSignature: firma ? SignatureOtpService.rastro(firma) : null,
        },
      });
      return { id, status: 'Recibida', firmada: !!firma };
    });
  }
}
