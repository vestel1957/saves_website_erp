import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TodoStatus, TodoPriority } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { CreateTaskDto, UpdateTaskDto, TaskFilter } from './dto/tasks.dto';

/**
 * Tareas / to-do (migrado de `Tools.php` + tabla `todolist` del legacy).
 *
 * Dos naturalezas conviven en la misma tabla, tal como en el legacy:
 *  · Tareas ligadas a una orden (`orderId` = `idorden`), del tipo "Revisar orden #N".
 *  · Notas sueltas del personal (`orderId` = 0).
 *
 * `employeeId`/`assigneeId` son ids legacy (`aauth_users.id`), no ids del stack
 * nuevo: se resuelven contra `Staff.legacyId` para mostrar nombres.
 */
@Injectable()
export class TasksService {
  constructor(private readonly prisma: PrismaService) {}

  /** Staff del usuario autenticado (vínculo por correo). Null si no tiene ficha. */
  private async staffOf(user?: AuthUser) {
    if (!user?.email) return null;
    return this.prisma.staff.findFirst({ where: { email: user.email }, select: { id: true, legacyId: true, name: true } });
  }

  /** Mapa legacyId → nombre, para pintar responsable/autor sin N+1 consultas. */
  private async namesByLegacyId(ids: number[]) {
    const uniq = [...new Set(ids.filter((n) => n > 0))];
    if (!uniq.length) return new Map<number, string>();
    const rows = await this.prisma.staff.findMany({ where: { legacyId: { in: uniq } }, select: { legacyId: true, name: true } });
    return new Map(rows.map((r) => [r.legacyId!, r.name]));
  }

  async stats(user?: AuthUser) {
    const me = await this.staffOf(user);
    const [due, progress, done, mine, overdue] = await Promise.all([
      this.prisma.todoTask.count({ where: { status: 'DUE' } }),
      this.prisma.todoTask.count({ where: { status: 'PROGRESS' } }),
      this.prisma.todoTask.count({ where: { status: 'DONE' } }),
      me?.legacyId
        ? this.prisma.todoTask.count({ where: { status: { not: 'DONE' }, OR: [{ employeeId: me.legacyId }, { assigneeId: me.legacyId }] } })
        : Promise.resolve(0),
      this.prisma.todoTask.count({ where: { status: { not: 'DONE' }, dueDate: { lt: new Date(new Date().toISOString().slice(0, 10)) } } }),
    ]);
    return { pendientes: due, enProgreso: progress, hechas: done, mias: mine, vencidas: overdue };
  }

  async list(f: TaskFilter, user?: AuthUser) {
    const page = Math.max(1, Number(f.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(f.pageSize) || 25));
    const where: Prisma.TodoTaskWhereInput = {};

    if (f.status) where.status = f.status as TodoStatus;
    if (f.priority) where.priority = f.priority as TodoPriority;
    if (f.orderId) where.orderId = Number(f.orderId);
    // "Solo órdenes" / "solo notas sueltas": en el legacy idorden=0 significa nota libre.
    if (f.kind === 'orden') where.orderId = { gt: 0 };
    else if (f.kind === 'nota') where.orderId = 0;

    if (f.mine) {
      const me = await this.staffOf(user);
      // Sin ficha de empleado vinculada no hay "mis tareas": devolvemos vacío en vez
      // de ignorar el filtro y mostrar las de todo el mundo.
      const legacyId = me?.legacyId ?? -1;
      where.OR = [{ employeeId: legacyId }, { assigneeId: legacyId }];
    } else if (f.assignee) {
      where.OR = [{ employeeId: Number(f.assignee) }, { assigneeId: Number(f.assignee) }];
    }

    const search = (f.search || '').trim();
    if (search) {
      const like: Prisma.TodoTaskWhereInput[] = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
      const n = Number(search);
      if (Number.isInteger(n) && n > 0) like.push({ orderId: n });
      // AND explícito: si ya hay un OR de responsable, un segundo OR lo pisaría.
      where.AND = [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), { OR: like }];
    }

    const [rows, total] = await Promise.all([
      this.prisma.todoTask.findMany({ where, orderBy: [{ tdate: 'desc' }, { legacyId: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.todoTask.count({ where }),
    ]);
    const names = await this.namesByLegacyId(rows.flatMap((r) => [r.employeeId, r.assigneeId]));
    const hoy = new Date().toISOString().slice(0, 10);
    return {
      items: rows.map((r) => ({
        id: r.id, legacyId: r.legacyId, name: r.name, status: r.status, priority: r.priority,
        tdate: r.tdate, start: r.start, dueDate: r.dueDate, description: r.description,
        orderId: r.orderId || null,
        author: names.get(r.employeeId) ?? null,
        assignee: names.get(r.assigneeId) ?? null,
        overdue: r.status !== 'DONE' && !!r.dueDate && r.dueDate.toISOString().slice(0, 10) < hoy,
      })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  async detail(id: string) {
    const t = await this.prisma.todoTask.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Tarea no encontrada');
    const names = await this.namesByLegacyId([t.employeeId, t.assigneeId]);
    return { ...t, author: names.get(t.employeeId) ?? null, assignee: names.get(t.assigneeId) ?? null };
  }

  /** Responsables seleccionables: empleados con ficha legacy (los que la tabla referencia). */
  async assignees() {
    const rows = await this.prisma.staff.findMany({
      where: { legacyId: { not: null }, banned: false },
      select: { legacyId: true, name: true },
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => ({ id: r.legacyId, name: r.name }));
  }

  private dOnly(s?: string | null) {
    if (!s) return null;
    const d = new Date(`${String(s).slice(0, 10)}T00:00:00Z`);
    return isNaN(d.getTime()) ? null : d;
  }

  async create(dto: CreateTaskDto, user?: AuthUser) {
    const me = await this.staffOf(user);
    // `legacyId` es obligatorio y único en el modelo (viene del ETL). Para las tareas
    // nacidas en el stack nuevo seguimos la secuencia por encima del máximo legacy,
    // así no chocan con una reejecución del ETL sobre el histórico.
    const max = await this.prisma.todoTask.aggregate({ _max: { legacyId: true } });
    const legacyId = (max._max.legacyId ?? 0) + 1;
    return this.prisma.todoTask.create({
      data: {
        legacyId,
        tdate: new Date(new Date().toISOString().slice(0, 10)),
        name: dto.name.trim(),
        status: (dto.status as TodoStatus) ?? 'DUE',
        priority: (dto.priority as TodoPriority) ?? 'MEDIUM',
        start: this.dOnly(dto.start),
        dueDate: this.dOnly(dto.dueDate),
        description: dto.description?.trim() || null,
        orderId: dto.orderId ?? 0,
        employeeId: me?.legacyId ?? 0,
        assigneeId: dto.assigneeId ?? me?.legacyId ?? 0,
        related: dto.related ?? null,
      },
    });
  }

  async update(id: string, dto: UpdateTaskDto) {
    const t = await this.prisma.todoTask.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Tarea no encontrada');
    const data: Prisma.TodoTaskUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.status !== undefined) data.status = dto.status as TodoStatus;
    if (dto.priority !== undefined) data.priority = dto.priority as TodoPriority;
    if (dto.start !== undefined) data.start = this.dOnly(dto.start);
    if (dto.dueDate !== undefined) data.dueDate = this.dOnly(dto.dueDate);
    if (dto.description !== undefined) data.description = dto.description?.trim() || null;
    if (dto.assigneeId !== undefined) data.assigneeId = dto.assigneeId ?? 0;
    if (dto.orderId !== undefined) data.orderId = dto.orderId ?? 0;
    return this.prisma.todoTask.update({ where: { id }, data });
  }

  async remove(id: string) {
    const t = await this.prisma.todoTask.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Tarea no encontrada');
    await this.prisma.todoTask.delete({ where: { id } });
    return { id, deleted: true };
  }
}
