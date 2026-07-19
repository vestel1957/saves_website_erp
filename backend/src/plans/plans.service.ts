import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ServiceKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePlanDto, UpdatePlanDto } from './dto/plan.dto';
import { num } from '../common/money';


/** Catálogo de planes de servicio (fuente de precio de la mensualidad recurrente). */
@Injectable()
export class PlansService {
  constructor(private readonly prisma: PrismaService) {}

  /** Listado del catálogo. activeOnly=true para el selector de "cambiar plan". */
  async list(params: { activeOnly?: boolean; kind?: ServiceKind } = {}) {
    const where: Prisma.PlanWhereInput = {};
    if (params.activeOnly) where.active = true;
    if (params.kind) where.kind = params.kind;
    const rows = await this.prisma.plan.findMany({
      where,
      orderBy: [{ kind: 'asc' }, { price: 'asc' }],
      include: { _count: { select: { services: true } } },
    });
    return rows.map((p) => ({
      id: p.id, name: p.name, kind: p.kind, pppProfile: p.pppProfile,
      price: num(p.price), taxRate: num(p.taxRate), megas: p.megas, active: p.active,
      subscribers: p._count.services,
    }));
  }

  async create(dto: CreatePlanDto) {
    return this.prisma.plan.create({
      data: {
        name: dto.name.trim(),
        kind: dto.kind ?? 'INTERNET',
        pppProfile: dto.pppProfile?.trim() || null,
        price: dto.price,
        taxRate: dto.taxRate ?? 0,
        megas: dto.megas ?? null,
        active: dto.active ?? true,
      },
      select: { id: true },
    });
  }

  async update(id: string, dto: UpdatePlanDto) {
    const plan = await this.prisma.plan.findUnique({ where: { id }, select: { id: true } });
    if (!plan) throw new NotFoundException('Plan no encontrado');
    const data: Prisma.PlanUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.kind !== undefined) data.kind = dto.kind;
    if (dto.pppProfile !== undefined) data.pppProfile = dto.pppProfile.trim() || null;
    if (dto.price !== undefined) data.price = dto.price;
    if (dto.taxRate !== undefined) data.taxRate = dto.taxRate;
    if (dto.megas !== undefined) data.megas = dto.megas;
    if (dto.active !== undefined) data.active = dto.active;
    await this.prisma.plan.update({ where: { id }, data });
    return { id, updated: true };
  }

  /** Borra el plan solo si ningún abonado lo usa; si no, lo desactiva (soft). */
  async remove(id: string) {
    const used = await this.prisma.subscriberService.count({ where: { planId: id } });
    if (used > 0) {
      await this.prisma.plan.update({ where: { id }, data: { active: false } });
      return { id, deleted: false, deactivated: true, reason: `${used} abonado(s) usan este plan; se desactivó en vez de borrarlo.` };
    }
    await this.prisma.plan.delete({ where: { id } }).catch(() => {
      throw new BadRequestException('No se pudo eliminar el plan.');
    });
    return { id, deleted: true };
  }
}
