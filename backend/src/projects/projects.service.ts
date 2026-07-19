import { Injectable, NotFoundException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
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

const dOnly = (s?: string) => (s ? new Date(s) : null);

@Injectable()
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

  async list(params: { search?: string; status?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
    const where: Prisma.ProjectWhereInput = {};
    if (params.status) where.status = params.status;
    const search = (params.search || '').trim();
    if (search) where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { subscriber: { is: { OR: [{ firstName: { contains: search, mode: 'insensitive' } }, { companyName: { contains: search, mode: 'insensitive' } }] } } }];
    const [rows, total] = await Promise.all([
      this.prisma.project.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: { subscriber: { select: SUB }, _count: { select: { milestones: true } } } }),
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
      include: { subscriber: { select: SUB }, milestones: { orderBy: { startDate: 'asc' } } },
    });
    if (!pr) throw new NotFoundException('Proyecto no encontrado');
    // Tareas: TodoTask con related=1 y rid=legacyId
    const tasks = pr.legacyId != null
      ? await this.prisma.todoTask.findMany({ where: { related: 1, rid: pr.legacyId }, orderBy: { tdate: 'desc' }, take: 100 })
      : [];
    return {
      id: pr.id, name: pr.name, status: pr.status, priority: pr.priority, progress: pr.progress,
      startDate: pr.startDate, endDate: pr.endDate, tag: pr.tag, phase: pr.phase, note: pr.note, worth: num(pr.worth),
      subscriber: pr.subscriber ? { id: pr.subscriber.id, name: subName(pr.subscriber), abonado: pr.subscriber.abonado } : null,
      milestones: pr.milestones.map((m) => ({ id: m.id, name: m.name, startDate: m.startDate, endDate: m.endDate, detail: m.detail, color: m.color })),
      tasks: tasks.map((t) => ({ id: t.id, name: t.name, status: t.status, start: t.start, dueDate: t.dueDate, priority: t.priority, description: t.description })),
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
}
