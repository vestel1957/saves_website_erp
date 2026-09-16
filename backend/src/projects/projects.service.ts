import { BadRequestException, NotFoundException } from '../core/http/errores';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Min, MinLength, ValidateNested } from 'class-validator';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { orden } from '../common/pagination-params';
import { bodegasConMaterial, buscarMaterialConStock, FiltroMaterial } from '../common/material-stock';
import { num } from '../common/money';

function subName(s: { firstName: string | null; lastName1: string | null; companyName: string | null; fullName: string | null } | null): string | null {
  if (!s) return null;
  return (s.fullName?.trim()) || [s.firstName, s.lastName1].filter(Boolean).join(' ').trim() || s.companyName || null;
}
const SUB = { firstName: true, lastName1: true, companyName: true, fullName: true, id: true, abonado: true } as const;

export class CreateProjectDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() subscriberId?: string;
  @IsOptional() @IsIn(['Waiting', 'Pending', 'Progress', 'Finished', 'Terminated']) status?: string;
  @IsOptional() @IsIn(['Low', 'Medium', 'High', 'Urgent']) priority?: string;
  @IsOptional() @IsInt() @Min(0) progress?: number;
  @IsOptional() @IsString() startDate?: string;
  @IsOptional() @IsString() endDate?: string;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsNumber() @Min(0) worth?: number;
}
export class UpdateProjectDto extends CreateProjectDto {}

export class MilestoneDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() startDate?: string;
  @IsOptional() @IsString() endDate?: string;
  @IsOptional() @IsString() detail?: string;
  @IsOptional() @IsString() color?: string;
}

/** Un ítem de material que se carga al proyecto. */
export class ProjectMaterialItemDto {
  @IsString() @MinLength(1) materialId!: string;
  @Type(() => Number) @IsInt() @Min(1) qty!: number;
}
/** Material cargado al proyecto (descuenta stock). */
export class ProjectMaterialsDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => ProjectMaterialItemDto)
  items!: ProjectMaterialItemDto[];
  @IsOptional() @IsString() note?: string;
}

const dOnly = (s?: string) => (s ? new Date(s) : null);

export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  async stats() {
    const [byStatus, agg] = await Promise.all([
      this.prisma.project.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.project.aggregate({ _sum: { worth: true }, _count: { _all: true } }),
    ]);
    const status: Record<string, number> = {};
    for (const r of byStatus) status[r.status] = r._count._all;
    return { total: agg._count._all, presupuestoTotal: num(agg._sum.worth), enProgreso: status['Progress'] ?? 0, finalizados: status['Finished'] ?? 0, status };
  }

  /**
   * Columnas ordenables de la tabla de proyectos. `progress` sí es columna real
   * (`progress`), y `milestones` es el conteo de una relación, que Prisma sabe
   * ordenar.
   */
  private static readonly ORDEN_LISTA = {
    name: 'name', status: 'status', priority: 'priority', progress: 'progress',
    worth: 'worth',
    client: (dir: 'asc' | 'desc') => [
      { subscriber: { firstName: dir } }, { subscriber: { lastName1: dir } },
    ],
    milestones: (dir: 'asc' | 'desc') => ({ milestones: { _count: dir } }),
  };

  async list(params: { search?: string; status?: string; page?: number; pageSize?: number; sortBy?: string; sortDir?: string }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
    const where: Prisma.ProjectWhereInput = {};
    if (params.status) where.status = params.status;
    const search = (params.search || '').trim();
    if (search) where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { subscriber: { is: { OR: [{ firstName: { contains: search, mode: 'insensitive' } }, { companyName: { contains: search, mode: 'insensitive' } }] } } }];
    const [rows, total] = await Promise.all([
      this.prisma.project.findMany({ where, orderBy: orden(params, ProjectsService.ORDEN_LISTA, { createdAt: 'desc' }), skip: (page - 1) * pageSize, take: pageSize, include: { subscriber: { select: SUB }, _count: { select: { milestones: true } } } }),
      this.prisma.project.count({ where }),
    ]);
    return {
      items: rows.map((pr) => ({
        id: pr.id, name: pr.name, status: pr.status, priority: pr.priority, progress: pr.progress,
        client: subName(pr.subscriber), subscriberId: pr.subscriber?.id ?? null,
        startDate: pr.startDate, endDate: pr.endDate, worth: num(pr.worth), milestones: pr._count.milestones,
      })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  async detail(id: string) {
    const pr = await this.prisma.project.findUnique({
      where: { id },
      include: {
        subscriber: { select: SUB },
        milestones: { orderBy: { startDate: 'asc' } },
        materials: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!pr) throw new NotFoundException('Proyecto no encontrado');
    // Tareas: TodoTask con related=1 y rid=legacyId
    const tasks = pr.legacyId != null
      ? await this.prisma.todoTask.findMany({ where: { related: 1, rid: pr.legacyId }, orderBy: { tdate: 'desc' }, take: 100 })
      : [];
    // `employeeId` es el id legacy del empleado (`aauth_users.id`), no un cuid.
    const eids = [...new Set(tasks.map((t) => t.employeeId).filter((n) => n > 0))];
    const autores = new Map(
      eids.length
        ? (await this.prisma.staff.findMany({ where: { legacyId: { in: eids } }, select: { legacyId: true, name: true } }))
            .map((r) => [r.legacyId!, r.name] as const)
        : [],
    );
    return {
      id: pr.id, name: pr.name, status: pr.status, priority: pr.priority, progress: pr.progress,
      startDate: pr.startDate, endDate: pr.endDate, tag: pr.tag, phase: pr.phase, note: pr.note, worth: num(pr.worth),
      subscriber: pr.subscriber ? { id: pr.subscriber.id, name: subName(pr.subscriber), abonado: pr.subscriber.abonado } : null,
      milestones: pr.milestones.map((m) => ({ id: m.id, name: m.name, startDate: m.startDate, endDate: m.endDate, detail: m.detail, color: m.color })),
      materials: pr.materials.map((m) => ({
        id: m.id, materialId: m.materialId, name: m.materialName, qty: m.qty,
        price: num(m.price), total: num(m.price) * m.qty,
        warehouse: m.warehouseName, employee: m.employeeName, note: m.note, createdAt: m.createdAt,
      })),
      /** Lo gastado en material, para contrastarlo contra `worth` (el presupuesto). */
      materialTotal: pr.materials.reduce((s, m) => s + num(m.price) * m.qty, 0),
      tasks: tasks.map((t) => ({
        id: t.id, name: t.name, status: t.status, start: t.start, dueDate: t.dueDate,
        priority: t.priority, description: t.description,
        // Quién la creó: el nombre sellado, o el del empleado del `eid` heredado.
        author: t.createdByName ?? autores.get(t.employeeId) ?? null,
      })),
    };
  }

  create(dto: CreateProjectDto) {
    return this.prisma.project.create({ data: {
      name: dto.name, subscriberId: dto.subscriberId ?? null, status: dto.status ?? 'Pending', priority: dto.priority ?? 'Medium',
      progress: dto.progress ?? 0, startDate: dOnly(dto.startDate), endDate: dOnly(dto.endDate), note: dto.note ?? null, worth: dto.worth ?? 0,
    } });
  }
  async update(id: string, dto: UpdateProjectDto) {
    const pr = await this.prisma.project.findUnique({ where: { id } });
    if (!pr) throw new NotFoundException('Proyecto no encontrado');
    const progress = dto.progress;
    const status = progress != null && progress >= 100 ? 'Finished' : dto.status;
    return this.prisma.project.update({ where: { id }, data: {
      name: dto.name, subscriberId: dto.subscriberId, status, priority: dto.priority, progress,
      startDate: dto.startDate ? dOnly(dto.startDate) : undefined, endDate: dto.endDate ? dOnly(dto.endDate) : undefined,
      note: dto.note, worth: dto.worth,
    } });
  }

  // --- Hitos (milestones) ---
  async createMilestone(projectId: string, dto: MilestoneDto) {
    const pr = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!pr) throw new NotFoundException('Proyecto no encontrado');
    const m = await this.prisma.milestone.create({
      data: { projectId, name: dto.name, startDate: dOnly(dto.startDate), endDate: dOnly(dto.endDate), detail: dto.detail ?? null, color: dto.color ?? null },
    });
    return { id: m.id };
  }
  async updateMilestone(id: string, dto: MilestoneDto) {
    const m = await this.prisma.milestone.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('Hito no encontrado');
    await this.prisma.milestone.update({
      where: { id }, data: { name: dto.name, startDate: dOnly(dto.startDate), endDate: dOnly(dto.endDate), detail: dto.detail ?? null, color: dto.color ?? null },
    });
    return { id, ok: true };
  }
  async deleteMilestone(id: string) {
    await this.prisma.milestone.delete({ where: { id } });
    return { id, deleted: true };
  }

  // --- Material del proyecto ---

  /** Bodegas con material, para entrar por el estante (mismo selector que soporte). */
  materialWarehouses(user: AuthUser, search?: string) {
    return bodegasConMaterial(this.prisma, user, search);
  }

  /** Materiales con stock para el selector del modal (mismo buscador que soporte). */
  searchMaterials(user: AuthUser, filtro: FiltroMaterial) {
    return buscarMaterialConStock(this.prisma, user, filtro);
  }

  /**
   * Carga material al proyecto y descuenta stock (`Material.qty`), igual que el
   * consumo de una orden. Transaccional: o entra la lista entera o no entra nada,
   * porque una obra que se lleva cinco cosas es un acto y no cinco.
   */
  async addMaterials(projectId: string, dto: ProjectMaterialsDto, user: AuthUser) {
    const pr = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!pr) throw new NotFoundException('Proyecto no encontrado');
    if (!dto.items?.length) throw new BadRequestException('Agrega al menos un material');

    const created = await this.prisma.$transaction(async (tx) => {
      const out: { name: string; qty: number }[] = [];
      for (const it of dto.items) {
        const m = await tx.material.findUnique({
          where: { id: it.materialId },
          select: { id: true, name: true, price: true, qty: true, warehouseId: true, warehouse: { select: { title: true } } },
        });
        if (!m) throw new NotFoundException('Material no encontrado');
        if (m.qty < it.qty) throw new BadRequestException(`Stock insuficiente de "${m.name}" (disponible ${m.qty})`);
        // `editedAt` es el blindaje contra el sync: sin él la próxima pasada del
        // legacy devuelve `products.qty` a como estaba y el gasto se evapora.
        await tx.material.update({ where: { id: m.id }, data: { qty: { decrement: it.qty }, editedAt: new Date() } });
        await tx.projectMaterial.create({
          data: {
            projectId, materialId: m.id, materialName: m.name, qty: it.qty, price: m.price,
            warehouseId: m.warehouseId, warehouseName: m.warehouse?.title ?? null,
            employeeName: user.name || user.email, note: dto.note?.trim() || null,
          },
        });
        out.push({ name: m.name, qty: it.qty });
      }
      return out;
    });
    return { ok: true, items: created };
  }

  /**
   * Quita un cargo de material del proyecto y DEVUELVE las unidades a su bodega.
   * Es la única forma de corregir un dedo sin que el stock quede descuadrado: si
   * el material ya no existe en el catálogo, la línea se borra igual y no hay a
   * dónde devolver.
   */
  async deleteMaterial(id: string) {
    const linea = await this.prisma.projectMaterial.findUnique({ where: { id } });
    if (!linea) throw new NotFoundException('Cargo de material no encontrado');
    await this.prisma.$transaction(async (tx) => {
      if (linea.materialId) {
        await tx.material.updateMany({
          where: { id: linea.materialId },
          data: { qty: { increment: linea.qty }, editedAt: new Date() },
        });
      }
      await tx.projectMaterial.delete({ where: { id } });
    });
    return { id, deleted: true, devuelto: linea.materialId ? linea.qty : 0 };
  }
}
