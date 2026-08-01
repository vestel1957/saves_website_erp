import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { FacturasService } from '../billing/facturas.service';
import {
  ApplyPromotionDto,
  CreatePromotionDto,
  UpdatePromotionDto,
} from './dto/promotions.dto';
import { num, round2 } from '../common/money';


/** Fecha de hoy sin hora (UTC), para comparar contra los campos @db.Date. */
function today(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function dateOnly(s: string): Date {
  const d = new Date(s);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Etiqueta en español de cada estado de cliente (para el historial). */
const STATUS_LABEL: Record<string, string> = {
  ACTIVO: 'Activo', CARTERA: 'Cartera', COMPROMISO: 'Compromiso', CORTADO: 'Cortado',
  DEPURADO: 'Depurado', EVENTO: 'Evento', EXONERADO: 'Exonerado', INSTALAR: 'Instalar',
  POR_RETIRAR: 'Por retirar', REPORTADO: 'Reportado', RETIRADO: 'Retirado',
  SUSPENDIDO: 'Suspendido', INACTIVO: 'Inactivo',
};
const statusLabel = (s: string) => `Estado: ${STATUS_LABEL[s] ?? s}`;

const isFlatFmt = (f: string) => f === 'flat' || f === 'bflat';
const isBeforeTaxFmt = (f: string) => f === 'b_p' || f === 'bflat';
const copFmt = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;

/** Valida y normaliza los campos de descuento según el formato elegido. */
function resolveDiscount(format: string, percentage?: number | null, flatAmount?: number | null) {
  if (isFlatFmt(format)) {
    if (!(Number(flatAmount) > 0))
      throw new BadRequestException('El monto fijo del descuento debe ser mayor a $0');
    return { discountFormat: format, percentage: 0, flatAmount: Number(flatAmount) };
  }
  if (!Number.isInteger(percentage) || (percentage as number) < 1 || (percentage as number) > 100)
    throw new BadRequestException('El porcentaje debe estar entre 1 y 100');
  return { discountFormat: format, percentage: percentage as number, flatAmount: null };
}

/** Etiqueta legible del descuento (para descripciones de nota crédito). */
function discountLabel(format: string, percentage: number, flatAmount: number | null): string {
  const core = isFlatFmt(format) ? copFmt(num(flatAmount)) : `${percentage}%`;
  return isBeforeTaxFmt(format) ? `${core}, antes de imp.` : core;
}

/**
 * Promociones de facturación (legacy `settings/promociones`). El superusuario
 * crea campañas y las asigna a funcionarios; esos funcionarios aplican el % a
 * las facturas de los clientes como nota crédito, mientras estén vigentes.
 */
@Injectable()
export class PromotionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly facturas: FacturasService,
  ) {}

  private assigneeSelect = {
    id: true,
    name: true,
    email: true,
  } as const;

  /** Mapea el usuario logueado a su ficha de funcionario (Staff) por email. */
  private async staffForUser(user: AuthUser) {
    if (!user?.email) return null;
    return this.prisma.staff.findFirst({
      where: { email: user.email },
      select: { id: true, name: true },
    });
  }

  // ---------------------------------------------------------------- Admin ----

  /** Todas las promociones con sus funcionarios asignados (superusuario). */
  async list() {
    const rows = await this.prisma.promotion.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        assignees: { select: this.assigneeSelect },
        _count: { select: { applications: true } },
      },
    });
    const t = today();
    return rows.map((p) => ({
      ...p,
      vigente: p.active && p.startDate <= t && p.endDate >= t,
      timesApplied: p._count.applications,
    }));
  }

  /** Nombre de cada Staff por id (para los snapshots del historial). */
  private async staffNames(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.staff.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private readonly GLOBAL_LABEL = 'Todos los funcionarios (global)';

  async create(dto: CreatePromotionDto, createdBy?: string) {
    const start = dateOnly(dto.startDate);
    const end = dateOnly(dto.endDate);
    if (end < start)
      throw new BadRequestException('La fecha final no puede ser anterior a la inicial');

    // Modo POR ESTADO: si viene subscriberStatus, la promo es por estado de
    // cliente (excluye funcionarios/global, legacy id_estado_clientes).
    const status = dto.subscriberStatus ?? null;
    const isState = status != null;
    const isGlobal = isState ? false : dto.global ?? false;
    const ids = isState || isGlobal ? [] : dto.assigneeIds ?? [];
    const names = await this.staffNames(ids);
    const name = dto.name.trim();
    const disc = resolveDiscount(dto.discountFormat ?? '%', dto.percentage, dto.flatAmount);

    return this.prisma.$transaction(async (tx) => {
      const promo = await tx.promotion.create({
        data: {
          name,
          description: dto.description?.trim() || null,
          percentage: disc.percentage,
          discountFormat: disc.discountFormat,
          flatAmount: disc.flatAmount,
          startDate: start,
          endDate: end,
          active: dto.active ?? true,
          global: isGlobal,
          subscriberStatus: status,
          createdBy: createdBy ?? null,
          assignees: ids.length ? { connect: ids.map((id) => ({ id })) } : undefined,
        },
        include: { assignees: { select: this.assigneeSelect } },
      });

      // Historial de la alta: por estado, por global, o por funcionario.
      const logs = isState
        ? [{ staffId: null, staffName: statusLabel(status!) }]
        : isGlobal
          ? [{ staffId: null, staffName: this.GLOBAL_LABEL }]
          : ids.map((sid) => ({ staffId: sid, staffName: names.get(sid) ?? sid }));
      if (logs.length) {
        await tx.promotionAssignmentLog.createMany({
          data: logs.map((l) => ({
            promotionId: promo.id,
            promotionName: name,
            staffId: l.staffId,
            staffName: l.staffName,
            action: 'ASSIGNED' as const,
            assignedByName: createdBy ?? null,
          })),
        });
      }
      return promo;
    });
  }

  async update(id: string, dto: UpdatePromotionDto, updatedBy?: string) {
    const existing = await this.prisma.promotion.findUnique({
      where: { id },
      include: { assignees: { select: { id: true, name: true } } },
    });
    if (!existing) throw new NotFoundException('Promoción no encontrada');

    const start = dto.startDate ? dateOnly(dto.startDate) : existing.startDate;
    const end = dto.endDate ? dateOnly(dto.endDate) : existing.endDate;
    if (end < start)
      throw new BadRequestException('La fecha final no puede ser anterior a la inicial');

    // Estado de cliente: undefined = no tocar; null = quitar; valor = fijar.
    const oldStatus = existing.subscriberStatus;
    const newStatus =
      dto.subscriberStatus === undefined ? oldStatus : dto.subscriberStatus;
    const isState = newStatus != null;
    // El modo estado excluye funcionarios/global.
    const isGlobal = isState ? false : dto.global ?? existing.global;
    const name = dto.name?.trim() ?? existing.name;

    const data: Prisma.PromotionUpdateInput = {
      name: dto.name?.trim() ?? undefined,
      description:
        dto.description === undefined ? undefined : dto.description?.trim() || null,
      startDate: start,
      endDate: end,
      active: dto.active ?? undefined,
      global: isGlobal,
      subscriberStatus: newStatus,
    };

    // Descuento: solo se recalcula si el usuario tocó algún campo de descuento.
    if (dto.discountFormat !== undefined || dto.percentage !== undefined || dto.flatAmount !== undefined) {
      const fmt = dto.discountFormat ?? existing.discountFormat;
      const pct = dto.percentage ?? existing.percentage;
      const flat = dto.flatAmount ?? (existing.flatAmount != null ? num(existing.flatAmount) : undefined);
      const disc = resolveDiscount(fmt, pct, flat);
      data.discountFormat = disc.discountFormat;
      data.percentage = disc.percentage;
      data.flatAmount = disc.flatAmount;
    }

    // Conjunto de funcionarios ANTES y DESPUÉS (para diff del historial).
    const oldWasGlobal = existing.global;
    const oldIds = existing.assignees.map((a) => a.id);
    const oldNames = new Map(existing.assignees.map((a) => [a.id, a.name]));
    // `newIds`: vacío si es estado o global; si vienen ids, se reemplaza el set.
    let newIds = oldIds;
    if (isState || isGlobal) newIds = [];
    else if (dto.assigneeIds) newIds = dto.assigneeIds;

    // Reasignación de funcionarios: estado/global limpian; ids reemplazan el set.
    if (isState || isGlobal) {
      data.assignees = { set: [] };
    } else if (dto.assigneeIds) {
      data.assignees = { set: dto.assigneeIds.map((sid) => ({ id: sid })) };
    }

    const addedIds = newIds.filter((x) => !oldIds.includes(x));
    const removedIds = oldIds.filter((x) => !newIds.includes(x));
    const addedNames = await this.staffNames(addedIds);

    return this.prisma.$transaction(async (tx) => {
      const promo = await tx.promotion.update({
        where: { id },
        data,
        include: { assignees: { select: this.assigneeSelect } },
      });

      const logEntries: Prisma.PromotionAssignmentLogCreateManyInput[] = [];
      // Bajas de funcionarios específicos.
      for (const sid of removedIds) {
        logEntries.push({
          promotionId: id, promotionName: name, staffId: sid,
          staffName: oldNames.get(sid) ?? sid, action: 'UNASSIGNED',
          assignedByName: updatedBy ?? null,
        });
      }
      // Altas de funcionarios específicos.
      for (const sid of addedIds) {
        logEntries.push({
          promotionId: id, promotionName: name, staffId: sid,
          staffName: addedNames.get(sid) ?? sid, action: 'ASSIGNED',
          assignedByName: updatedBy ?? null,
        });
      }
      // Transición de estado de cliente (promo por estado).
      if (oldStatus !== newStatus) {
        if (oldStatus) {
          logEntries.push({
            promotionId: id, promotionName: name, staffId: null,
            staffName: statusLabel(oldStatus), action: 'UNASSIGNED', assignedByName: updatedBy ?? null,
          });
        }
        if (newStatus) {
          logEntries.push({
            promotionId: id, promotionName: name, staffId: null,
            staffName: statusLabel(newStatus), action: 'ASSIGNED', assignedByName: updatedBy ?? null,
          });
        }
      }
      // Transiciones de/hacia "global" (todos los funcionarios).
      if (isGlobal && !oldWasGlobal) {
        logEntries.push({
          promotionId: id, promotionName: name, staffId: null,
          staffName: this.GLOBAL_LABEL, action: 'ASSIGNED', assignedByName: updatedBy ?? null,
        });
      } else if (!isGlobal && oldWasGlobal) {
        logEntries.push({
          promotionId: id, promotionName: name, staffId: null,
          staffName: this.GLOBAL_LABEL, action: 'UNASSIGNED', assignedByName: updatedBy ?? null,
        });
      }
      if (logEntries.length) {
        await tx.promotionAssignmentLog.createMany({ data: logEntries });
      }
      return promo;
    });
  }

  /**
   * Historial de asignaciones: qué promo se asignó/desasignó, a qué funcionario,
   * quién lo hizo y cuándo. Opcionalmente filtrado por promoción.
   */
  async assignmentHistory(promotionId?: string) {
    return this.prisma.promotionAssignmentLog.findMany({
      where: promotionId ? { promotionId } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: {
        id: true,
        promotionId: true,
        promotionName: true,
        staffId: true,
        staffName: true,
        action: true,
        assignedByName: true,
        createdAt: true,
      },
    });
  }

  async remove(id: string) {
    const existing = await this.prisma.promotion.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Promoción no encontrada');
    await this.prisma.promotion.delete({ where: { id } });
    return { ok: true };
  }

  // ------------------------------------------------------------ Funcionario ----

  /**
   * Promociones que el usuario puede aplicar hoy sobre una factura: vigentes y
   * (a) globales, (b) asignadas al usuario — réplica de `list_promos()` — o
   * (c) por estado, cuando el cliente de la factura está en ese estado (réplica
   * de `validar_promocion_estado_cus`). `invoiceId` es necesario para las (c).
   */
  async available(user: AuthUser, invoiceId?: string) {
    const t = today();
    const staff = await this.staffForUser(user);

    // Estado del cliente de la factura (para las promos por estado).
    let subStatus: string | null = null;
    if (invoiceId) {
      const inv = await this.prisma.subInvoice.findUnique({
        where: { id: invoiceId },
        select: { subscriber: { select: { status: true } } },
      });
      subStatus = inv?.subscriber?.status ?? null;
    }

    const or: Prisma.PromotionWhereInput[] = [
      { global: true },
      ...(staff ? [{ assignees: { some: { id: staff.id } } }] : []),
      ...(subStatus ? [{ subscriberStatus: subStatus as any }] : []),
    ];
    const where: Prisma.PromotionWhereInput = {
      active: true,
      startDate: { lte: t },
      endDate: { gte: t },
      OR: or,
    };
    return this.prisma.promotion.findMany({
      where,
      orderBy: { percentage: 'desc' },
      select: {
        id: true,
        name: true,
        description: true,
        percentage: true,
        discountFormat: true,
        flatAmount: true,
        startDate: true,
        endDate: true,
        global: true,
        subscriberStatus: true,
      },
    });
  }

  /**
   * Aplica una promoción a una factura como nota crédito. Valida vigencia y
   * autorización del funcionario, y evita aplicar la misma promo dos veces a la
   * misma factura (legacy `promo_sistema_clientes1`).
   */
  async apply(promotionId: string, dto: ApplyPromotionDto, user: AuthUser) {
    const t = today();
    const promo = await this.prisma.promotion.findUnique({
      where: { id: promotionId },
      include: { assignees: { select: { id: true } } },
    });
    if (!promo) throw new NotFoundException('Promoción no encontrada');
    if (!promo.active) throw new BadRequestException('La promoción está inactiva');
    if (promo.startDate > t || promo.endDate < t)
      throw new BadRequestException('La promoción no está vigente');

    const invoice = await this.prisma.subInvoice.findUnique({
      where: { id: dto.invoiceId },
      select: { id: true, total: true, subtotal: true, tid: true, subscriber: { select: { status: true } } },
    });
    if (!invoice) throw new NotFoundException('Factura no encontrada');

    const staff = await this.staffForUser(user);
    // Autorización: promo por estado → el cliente debe estar en ese estado;
    // promo por funcionario → global o asignada al usuario.
    const authorized = promo.subscriberStatus
      ? invoice.subscriber?.status === promo.subscriberStatus
      : promo.global || (staff != null && promo.assignees.some((a) => a.id === staff.id));
    if (!authorized) {
      throw new ForbiddenException(
        promo.subscriberStatus
          ? 'La promoción por estado no aplica al estado actual del cliente'
          : 'No tienes esta promoción asignada',
      );
    }

    const already = await this.prisma.promotionApplication.findUnique({
      where: {
        promotionId_invoiceId: { promotionId, invoiceId: dto.invoiceId },
      },
    });
    if (already)
      throw new BadRequestException('Esta promoción ya fue aplicada a esta factura');

    // Base del descuento: "antes de imp." → subtotal (sin IVA); si no → total (con IVA).
    // Monto fijo → valor tope-limitado a la base; porcentaje → base × %.
    const base = isBeforeTaxFmt(promo.discountFormat) ? num(invoice.subtotal) : num(invoice.total);
    const amount = isFlatFmt(promo.discountFormat)
      ? round2(Math.min(num(promo.flatAmount), base))
      : round2((base * promo.percentage) / 100);
    if (!(amount > 0))
      throw new BadRequestException('El descuento calculado es cero');
    const label = discountLabel(promo.discountFormat, promo.percentage, num(promo.flatAmount));

    // Reutiliza la lógica de notas crédito (recalcula total/saldo/estado/cache).
    const note = await this.facturas.createNote(
      dto.invoiceId,
      {
        type: 'CREDITO',
        amount,
        description: `Promoción: ${promo.name} (${label})`,
      },
      user,
    );

    await this.prisma.promotionApplication.create({
      data: {
        promotionId,
        invoiceId: dto.invoiceId,
        staffId: staff?.id ?? null,
        appliedByName: user?.name ?? user?.email ?? null,
        percentage: promo.percentage,
        amount,
      },
    });

    return {
      ok: true,
      promotion: promo.name,
      percentage: promo.percentage,
      amount,
      newTotal: note.newTotal,
      newBalance: note.newBalance,
      status: note.status,
    };
  }
}
