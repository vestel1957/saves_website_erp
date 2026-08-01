import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { orden } from '../pagination-params';

export interface AuditRecord {
  userId?: string;
  action: string;
  entity: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  ipAddress?: string;
}

/**
 * Writes immutable audit rows. Append-only — entries are never updated/deleted.
 * Shared across modules (inventory, SST, …) via the global AuditModule.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Lista paginada de la bitácora (para el visor en Sistemas). */
  /** Columnas ordenables del registro de actividad. */
  private static readonly ORDEN_LISTA = {
    createdAt: 'createdAt', userName: 'user.name', action: 'action',
    entity: 'entity', ipAddress: 'ipAddress',
  };

  async list(params: { search?: string; entity?: string; userId?: string; from?: string; to?: string; page?: number; pageSize?: number; sortBy?: string; sortDir?: string }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 30));
    const where: Prisma.AuditLogWhereInput = {};
    if (params.entity) where.entity = { contains: params.entity };
    if (params.userId) where.userId = params.userId;
    if (params.search) where.action = { contains: params.search, mode: 'insensitive' };
    if (params.from || params.to) {
      where.createdAt = {};
      if (params.from) where.createdAt.gte = new Date(params.from);
      if (params.to) where.createdAt.lte = new Date(`${params.to}T23:59:59`);
    }
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where, orderBy: orden(params, AuditService.ORDEN_LISTA, { createdAt: 'desc' }), skip: (page - 1) * pageSize, take: pageSize,
        include: { user: { select: { name: true, email: true } } },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id, action: r.action, entity: r.entity, entityId: r.entityId,
        userName: r.user?.name ?? null, userEmail: r.user?.email ?? null,
        ipAddress: r.ipAddress, createdAt: r.createdAt,
      })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  async record(r: AuditRecord) {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: r.userId,
          action: r.action,
          entity: r.entity,
          entityId: r.entityId,
          before: (r.before as Prisma.InputJsonValue) ?? undefined,
          after: (r.after as Prisma.InputJsonValue) ?? undefined,
          ipAddress: r.ipAddress,
        },
      });
    } catch (e) {
      // Auditing must never break the business operation.
      this.logger.warn(`No se pudo registrar auditoría: ${(e as Error).message}`);
    }
  }

}
