import { BadRequestException, ForbiddenException, NotFoundException } from '../core/http/errores';
import { Prisma, PromotionTargetKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { FacturasService } from '../billing/facturas.service';
import {
  ApplyPromotionDto,
  CreatePromotionDto,
  PromotionAudienceDto,
  SubscriberStatusName,
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

/** Etiqueta en español de cada estado de cliente. */
const STATUS_LABEL: Record<string, string> = {
  ACTIVO: 'Activo', CARTERA: 'Cartera', COMPROMISO: 'Compromiso', CORTADO: 'Cortado',
  DEPURADO: 'Depurado', EVENTO: 'Evento', EXONERADO: 'Exonerado', INSTALAR: 'Instalar',
  POR_RETIRAR: 'Por retirar', REPORTADO: 'Reportado', RETIRADO: 'Retirado',
  SUSPENDIDO: 'Suspendido', INACTIVO: 'Inactivo',
};

const isFlatFmt = (f: string) => f === 'flat' || f === 'bflat';
const isBeforeTaxFmt = (f: string) => f === 'b_p' || f === 'bflat';
const copFmt = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;
const uniq = (xs: string[]) => Array.from(new Set(xs.filter(Boolean)));

/** Público de una promoción, ya normalizado (sin undefined). */
type Audience = {
  allSubscribers: boolean;
  subscriberStatuses: SubscriberStatusName[];
  subscriberIds: string[];
  planIds: string[];
  branchIds: string[];
  neighborhoodRefs: string[];
};

/** Un destinatario concreto del público, para la bitácora y las etiquetas. */
type TargetRef = { kind: PromotionTargetKind; key: string; label: string };

/** Lo que hace falta saber de un cliente para decidir si una promo lo alcanza. */
type SubscriberFacts = {
  id: string;
  status: string | null;
  branchId: string | null;
  neighborhood: string | null;
  /** Planes que se le están cobrando (servicios contratados o, si no tiene, su última factura). */
  planIds: string[];
};

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
 * Promociones de facturación (legacy `settings/promociones`).
 *
 * El destinatario de una promoción es el CLIENTE, no el funcionario (decisión
 * 2026-08-03). El superusuario crea la campaña y define su público —todos, ciertos
 * estados, clientes puntuales, planes, sedes o barrios— y la promo solo aparece
 * (y solo puede aplicarse) en las facturas de los clientes que están dentro. Así
 * nadie puede descontarle a un cliente que no correspondía.
 */
export class PromotionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly facturas: FacturasService,
  ) {}

  /** Relaciones del público que se devuelven junto a la promo. */
  private readonly targetInclude = {
    subscribers: { select: { id: true, fullName: true, abonado: true, status: true } },
    plans: { select: { id: true, name: true } },
    branches: { select: { id: true, name: true } },
  } as const;

  /** Mapea el usuario logueado a su ficha de funcionario (Staff) por email. */
  private async staffForUser(user: AuthUser) {
    if (!user?.email) return null;
    return this.prisma.staff.findFirst({
      where: { email: user.email },
      select: { id: true, name: true },
    });
  }

  // ------------------------------------------------------------- Público ----

  /** Normaliza el público que llega del DTO (sin undefined, sin duplicados). */
  private audienceOf(dto: PromotionAudienceDto): Audience {
    const all = dto.allSubscribers ?? false;
    return {
      allSubscribers: all,
      // "Todos los clientes" manda: los demás criterios se descartan para que no
      // quede un público a medias guardado que confunda al editar.
      subscriberStatuses: all ? [] : (uniq(dto.subscriberStatuses ?? []) as SubscriberStatusName[]),
      subscriberIds: all ? [] : uniq(dto.subscriberIds ?? []),
      planIds: all ? [] : uniq(dto.planIds ?? []),
      branchIds: all ? [] : uniq(dto.branchIds ?? []),
      neighborhoodRefs: all ? [] : uniq(dto.neighborhoodRefs ?? []),
    };
  }

  /** Público guardado de una promo ya cargada (con sus relaciones). */
  private audienceOfPromo(p: {
    allSubscribers: boolean;
    subscriberStatuses: string[];
    neighborhoodRefs: string[];
    subscribers: { id: string }[];
    plans: { id: string }[];
    branches: { id: string }[];
  }): Audience {
    return {
      allSubscribers: p.allSubscribers,
      subscriberStatuses: p.subscriberStatuses as SubscriberStatusName[],
      subscriberIds: p.subscribers.map((s) => s.id),
      planIds: p.plans.map((x) => x.id),
      branchIds: p.branches.map((b) => b.id),
      neighborhoodRefs: p.neighborhoodRefs,
    };
  }

  private hasCriteria(a: Audience) {
    return (
      a.allSubscribers ||
      a.subscriberStatuses.length > 0 ||
      a.subscriberIds.length > 0 ||
      a.planIds.length > 0 ||
      a.branchIds.length > 0 ||
      a.neighborhoodRefs.length > 0
    );
  }

  /**
   * Clientes SIN servicios contratados cuyo plan —el de su última factura— está
   * entre los buscados. Es el respaldo del hueco de la migración: 2.000 clientes
   * vivos no tienen `SubscriberService` y su plan solo se ve en lo que se les
   * cobra (mismo criterio que la corrida mensual). Los demás criterios se inyectan
   * en el SQL para no barrer los 17.000 sin servicios en cada consulta.
   */
  private async planFallbackIds(a: Audience, onlySubscriberId?: string): Promise<string[]> {
    if (!a.planIds.length) return [];
    const conds: Prisma.Sql[] = [
      Prisma.sql`NOT EXISTS (SELECT 1 FROM "SubscriberService" x WHERE x."subscriberId" = s.id)`,
    ];
    if (onlySubscriberId) conds.push(Prisma.sql`s.id = ${onlySubscriberId}`);
    if (a.subscriberStatuses.length)
      conds.push(Prisma.sql`s.status::text IN (${Prisma.join(a.subscriberStatuses)})`);
    if (a.branchIds.length) conds.push(Prisma.sql`s."branchId" IN (${Prisma.join(a.branchIds)})`);
    if (a.neighborhoodRefs.length)
      conds.push(Prisma.sql`s.neighborhood IN (${Prisma.join(a.neighborhoodRefs)})`);
    if (a.subscriberIds.length) conds.push(Prisma.sql`s.id IN (${Prisma.join(a.subscriberIds)})`);

    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH ult AS MATERIALIZED (
        SELECT s.id,
               (SELECT i.id FROM "SubInvoice" i
                 WHERE i."subscriberId" = s.id
                 ORDER BY i."invoiceDate" DESC, i.tid DESC LIMIT 1) AS "invoiceId"
          FROM "Subscriber" s
         WHERE ${Prisma.join(conds, ' AND ')}
      )
      SELECT DISTINCT u.id FROM ult u
        JOIN "SubInvoiceItem" it ON it."invoiceId" = u."invoiceId" AND it.price > 0
        JOIN "Plan" pl ON pl.id IN (${Prisma.join(a.planIds)})
         AND lower(btrim(pl.name)) = lower(btrim(COALESCE(it."productName", it.description)))`;
    return rows.map((r) => r.id);
  }

  /**
   * Filtro Prisma de los clientes que alcanza el público. `null` = no alcanza a
   * nadie (promo sin criterios): es deliberado, una promo sin público no descuenta.
   */
  private async audienceWhere(a: Audience): Promise<Prisma.SubscriberWhereInput | null> {
    if (a.allSubscribers) return {};
    if (!this.hasCriteria(a)) return null;

    const and: Prisma.SubscriberWhereInput[] = [];
    if (a.subscriberStatuses.length) and.push({ status: { in: a.subscriberStatuses as any } });
    if (a.branchIds.length) and.push({ branchId: { in: a.branchIds } });
    if (a.neighborhoodRefs.length) and.push({ neighborhood: { in: a.neighborhoodRefs } });
    if (a.subscriberIds.length) and.push({ id: { in: a.subscriberIds } });
    if (a.planIds.length) {
      const fallback = await this.planFallbackIds(a);
      and.push({
        OR: [
          { services: { some: { planId: { in: a.planIds } } } },
          ...(fallback.length ? [{ id: { in: fallback } }] : []),
        ],
      });
    }
    return { AND: and };
  }

  /** Cuántos clientes alcanza el público, con una muestra para verlo en pantalla. */
  async audience(dto: PromotionAudienceDto, sampleSize = 25) {
    const a = this.audienceOf(dto);
    const where = await this.audienceWhere(a);
    if (!where) return { count: 0, sample: [], sinCriterios: true };
    const [count, sample] = await Promise.all([
      this.prisma.subscriber.count({ where }),
      this.prisma.subscriber.findMany({
        where,
        take: sampleSize,
        orderBy: { abonado: 'asc' },
        select: { id: true, abonado: true, fullName: true, status: true },
      }),
    ]);
    return { count, sample, sinCriterios: false };
  }

  /** Datos del cliente que deciden si una promo lo alcanza. */
  private async subscriberFacts(subscriberId: string): Promise<SubscriberFacts | null> {
    const s = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: {
        id: true, status: true, branchId: true, neighborhood: true,
        services: { select: { planId: true } },
      },
    });
    if (!s) return null;
    let planIds = uniq(s.services.map((x) => x.planId ?? ''));
    // Sin servicios contratados → el plan sale de su última factura (mismo
    // respaldo que usa la corrida mensual).
    if (!s.services.length) {
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT DISTINCT pl.id
          FROM "SubInvoiceItem" it
          JOIN "Plan" pl ON lower(btrim(pl.name)) = lower(btrim(COALESCE(it."productName", it.description)))
         WHERE it.price > 0
           AND it."invoiceId" = (SELECT i2.id FROM "SubInvoice" i2 WHERE i2."subscriberId" = ${subscriberId}
                                  ORDER BY i2."invoiceDate" DESC, i2.tid DESC LIMIT 1)`;
      planIds = rows.map((r) => r.id);
    }
    return { id: s.id, status: s.status, branchId: s.branchId, neighborhood: s.neighborhood, planIds };
  }

  /** ¿El público de la promo alcanza a este cliente? (Y entre dimensiones, O dentro.) */
  private reaches(a: Audience, f: SubscriberFacts): boolean {
    if (a.allSubscribers) return true;
    if (!this.hasCriteria(a)) return false;
    if (a.subscriberStatuses.length && !(f.status && a.subscriberStatuses.includes(f.status as SubscriberStatusName)))
      return false;
    if (a.branchIds.length && !(f.branchId && a.branchIds.includes(f.branchId))) return false;
    if (a.neighborhoodRefs.length && !(f.neighborhood && a.neighborhoodRefs.includes(f.neighborhood)))
      return false;
    if (a.subscriberIds.length && !a.subscriberIds.includes(f.id)) return false;
    if (a.planIds.length && !f.planIds.some((p) => a.planIds.includes(p))) return false;
    return true;
  }

  // ------------------------------------------------------------ Bitácora ----

  /** Destinatarios del público, con su etiqueta legible (para la bitácora). */
  private async targetRefs(a: Audience): Promise<TargetRef[]> {
    if (a.allSubscribers)
      return [{ kind: 'ALL', key: 'ALL', label: 'Todos los clientes' }];

    const refs: TargetRef[] = a.subscriberStatuses.map((s) => ({
      kind: 'STATUS' as const, key: s, label: `Estado: ${STATUS_LABEL[s] ?? s}`,
    }));

    if (a.subscriberIds.length) {
      const subs = await this.prisma.subscriber.findMany({
        where: { id: { in: a.subscriberIds } },
        select: { id: true, fullName: true, abonado: true },
      });
      const byId = new Map(subs.map((s) => [s.id, s]));
      for (const id of a.subscriberIds) {
        const s = byId.get(id);
        refs.push({
          kind: 'SUBSCRIBER', key: id,
          label: `Cliente: ${s?.fullName?.trim() || 'sin nombre'} #${s?.abonado ?? '—'}`,
        });
      }
    }
    if (a.planIds.length) {
      const plans = await this.prisma.plan.findMany({
        where: { id: { in: a.planIds } }, select: { id: true, name: true },
      });
      const byId = new Map(plans.map((p) => [p.id, p.name]));
      for (const id of a.planIds) refs.push({ kind: 'PLAN', key: id, label: `Plan: ${byId.get(id) ?? id}` });
    }
    if (a.branchIds.length) {
      const branches = await this.prisma.branch.findMany({
        where: { id: { in: a.branchIds } }, select: { id: true, name: true },
      });
      const byId = new Map(branches.map((b) => [b.id, b.name]));
      for (const id of a.branchIds) refs.push({ kind: 'BRANCH', key: id, label: `Sede: ${byId.get(id) ?? id}` });
    }
    if (a.neighborhoodRefs.length) {
      const names = await this.neighborhoodNames(a.neighborhoodRefs);
      for (const ref of a.neighborhoodRefs)
        refs.push({ kind: 'NEIGHBORHOOD', key: ref, label: `Barrio: ${names.get(ref) ?? ref}` });
    }
    return refs;
  }

  /** Nombre de cada barrio por su id legacy (el que guarda `Subscriber.neighborhood`). */
  private async neighborhoodNames(refs: string[]): Promise<Map<string, string>> {
    const ids = uniq(refs).map((r) => Number(r)).filter((n) => Number.isFinite(n));
    if (!ids.length) return new Map();
    const rows = await this.prisma.neighborhood.findMany({
      where: { legacyId: { in: ids } },
      select: { legacyId: true, name: true },
    });
    return new Map(rows.map((r) => [String(r.legacyId), r.name]));
  }

  /** Escribe en la bitácora las altas y bajas de destinatarios entre dos públicos. */
  private async logTargetDiff(
    tx: Prisma.TransactionClient,
    promotionId: string,
    promotionName: string,
    before: TargetRef[],
    after: TargetRef[],
    changedByName?: string | null,
  ) {
    const k = (r: TargetRef) => `${r.kind}|${r.key}`;
    const beforeKeys = new Set(before.map(k));
    const afterKeys = new Set(after.map(k));
    const rows: Prisma.PromotionTargetLogCreateManyInput[] = [
      ...after.filter((r) => !beforeKeys.has(k(r))).map((r) => ({
        promotionId, promotionName, kind: r.kind, targetLabel: r.label,
        action: 'ADDED' as const, changedByName: changedByName ?? null,
      })),
      ...before.filter((r) => !afterKeys.has(k(r))).map((r) => ({
        promotionId, promotionName, kind: r.kind, targetLabel: r.label,
        action: 'REMOVED' as const, changedByName: changedByName ?? null,
      })),
    ];
    if (rows.length) await tx.promotionTargetLog.createMany({ data: rows });
  }

  // ---------------------------------------------------------------- Admin ----

  /** Todas las promociones con su público (superusuario). */
  async list() {
    const rows = await this.prisma.promotion.findMany({
      orderBy: { createdAt: 'desc' },
      include: { ...this.targetInclude, _count: { select: { applications: true } } },
    });
    const t = today();
    const names = await this.neighborhoodNames(rows.flatMap((r) => r.neighborhoodRefs));
    return rows.map((p) => ({
      ...p,
      neighborhoods: p.neighborhoodRefs.map((ref) => ({ ref, name: names.get(ref) ?? ref })),
      vigente: p.active && p.startDate <= t && p.endDate >= t,
      timesApplied: p._count.applications,
    }));
  }

  /** Catálogos para armar el público en pantalla (planes, sedes, barrios). */
  async catalogs() {
    const [plans, branches, neighborhoods] = await Promise.all([
      this.prisma.plan.findMany({
        where: { active: true },
        orderBy: [{ kind: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, kind: true },
      }),
      this.prisma.branch.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
      this.prisma.neighborhood.findMany({
        where: { legacyId: { not: null } },
        orderBy: { name: 'asc' },
        select: { legacyId: true, name: true },
      }),
    ]);
    return {
      plans,
      branches,
      neighborhoods: neighborhoods.map((n) => ({ ref: String(n.legacyId), name: n.name })),
    };
  }

  async create(dto: CreatePromotionDto, createdBy?: string) {
    const start = dateOnly(dto.startDate);
    const end = dateOnly(dto.endDate);
    if (end < start)
      throw new BadRequestException('La fecha final no puede ser anterior a la inicial');

    const a = this.audienceOf(dto);
    if (!this.hasCriteria(a))
      throw new BadRequestException(
        'Define a qué clientes alcanza la promoción (o marca "Todos los clientes")',
      );
    const name = dto.name.trim();
    const disc = resolveDiscount(dto.discountFormat ?? '%', dto.percentage, dto.flatAmount);
    const refs = await this.targetRefs(a);

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
          allSubscribers: a.allSubscribers,
          subscriberStatuses: a.subscriberStatuses as any,
          neighborhoodRefs: a.neighborhoodRefs,
          subscribers: a.subscriberIds.length ? { connect: a.subscriberIds.map((id) => ({ id })) } : undefined,
          plans: a.planIds.length ? { connect: a.planIds.map((id) => ({ id })) } : undefined,
          branches: a.branchIds.length ? { connect: a.branchIds.map((id) => ({ id })) } : undefined,
          createdBy: createdBy ?? null,
        },
        include: this.targetInclude,
      });
      await this.logTargetDiff(tx, promo.id, name, [], refs, createdBy);

      // La plantilla va en la MISMA transacción: si la promoción no llega a crearse,
      // no queda una plantilla huérfana de una campaña que nunca existió.
      if (dto.saveAsTemplate) {
        const plantilla = {
          description: dto.description?.trim() || null,
          discountFormat: disc.discountFormat,
          percentage: disc.percentage,
          flatAmount: disc.flatAmount,
          startDate: start,
          endDate: end,
          createdBy: createdBy ?? null,
        };
        // Mismo nombre = misma plantilla: se actualiza en vez de acumular copias.
        await tx.promotionTemplate.upsert({
          where: { name },
          create: { name, ...plantilla },
          update: plantilla,
        });
      }

      return promo;
    });
  }

  /** Plantillas guardadas, la más usada primero por nombre. */
  listTemplates() {
    return this.prisma.promotionTemplate.findMany({
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true, name: true, description: true, discountFormat: true,
        percentage: true, flatAmount: true, startDate: true, endDate: true,
      },
    });
  }

  async removeTemplate(id: string) {
    const t = await this.prisma.promotionTemplate.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Plantilla no encontrada');
    await this.prisma.promotionTemplate.delete({ where: { id } });
    return { ok: true };
  }

  async update(id: string, dto: UpdatePromotionDto, updatedBy?: string) {
    const existing = await this.prisma.promotion.findUnique({
      where: { id },
      include: this.targetInclude,
    });
    if (!existing) throw new NotFoundException('Promoción no encontrada');

    const start = dto.startDate ? dateOnly(dto.startDate) : existing.startDate;
    const end = dto.endDate ? dateOnly(dto.endDate) : existing.endDate;
    if (end < start)
      throw new BadRequestException('La fecha final no puede ser anterior a la inicial');

    const before = this.audienceOfPromo(existing);
    // El público se reemplaza entero: la pantalla siempre manda el estado completo.
    const after = this.audienceOf(dto);
    if (!this.hasCriteria(after))
      throw new BadRequestException(
        'Define a qué clientes alcanza la promoción (o marca "Todos los clientes")',
      );
    const name = dto.name?.trim() ?? existing.name;

    const data: Prisma.PromotionUpdateInput = {
      name: dto.name?.trim() ?? undefined,
      description:
        dto.description === undefined ? undefined : dto.description?.trim() || null,
      startDate: start,
      endDate: end,
      active: dto.active ?? undefined,
      allSubscribers: after.allSubscribers,
      subscriberStatuses: after.subscriberStatuses as any,
      neighborhoodRefs: after.neighborhoodRefs,
      subscribers: { set: after.subscriberIds.map((sid) => ({ id: sid })) },
      plans: { set: after.planIds.map((pid) => ({ id: pid })) },
      branches: { set: after.branchIds.map((bid) => ({ id: bid })) },
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

    const [refsBefore, refsAfter] = await Promise.all([
      this.targetRefs(before),
      this.targetRefs(after),
    ]);

    return this.prisma.$transaction(async (tx) => {
      const promo = await tx.promotion.update({ where: { id }, data, include: this.targetInclude });
      await this.logTargetDiff(tx, id, name, refsBefore, refsAfter, updatedBy);
      return promo;
    });
  }

  /**
   * Bitácora del público: qué destinatario se agregó o quitó de qué promoción,
   * quién lo hizo y cuándo. Es la traza de "¿por qué a este cliente se le descontó?".
   */
  async targetHistory(promotionId?: string) {
    return this.prisma.promotionTargetLog.findMany({
      where: promotionId ? { promotionId } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: {
        id: true,
        promotionId: true,
        promotionName: true,
        kind: true,
        targetLabel: true,
        action: true,
        changedByName: true,
        createdAt: true,
      },
    });
  }

  /** Facturas a las que ya se les aplicó la promo (a qué cliente, cuánto y quién). */
  async applications(promotionId: string) {
    const rows = await this.prisma.promotionApplication.findMany({
      where: { promotionId },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: {
        id: true, invoiceId: true, amount: true, percentage: true,
        appliedByName: true, createdAt: true,
      },
    });
    if (!rows.length) return [];
    const invoices = await this.prisma.subInvoice.findMany({
      where: { id: { in: rows.map((r) => r.invoiceId) } },
      select: { id: true, tid: true, subscriber: { select: { fullName: true, abonado: true } } },
    });
    const byId = new Map(invoices.map((i) => [i.id, i]));
    return rows.map((r) => {
      const inv = byId.get(r.invoiceId);
      return {
        ...r,
        tid: inv?.tid ?? null,
        subscriberName: inv?.subscriber?.fullName ?? null,
        abonado: inv?.subscriber?.abonado ?? null,
      };
    });
  }

  async remove(id: string) {
    const existing = await this.prisma.promotion.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Promoción no encontrada');
    await this.prisma.promotion.delete({ where: { id } });
    return { ok: true };
  }

  // ---------------------------------------------------------- Facturación ----

  /**
   * Promociones que hoy pueden aplicarse a una factura: vigentes y cuyo público
   * alcanza al CLIENTE de esa factura. Sin factura no hay respuesta posible: la
   * elegibilidad depende del cliente, no del usuario que pregunta.
   */
  async available(invoiceId?: string) {
    if (!invoiceId) return [];
    const inv = await this.prisma.subInvoice.findUnique({
      where: { id: invoiceId },
      select: { subscriberId: true },
    });
    if (!inv?.subscriberId) return [];
    const facts = await this.subscriberFacts(inv.subscriberId);
    if (!facts) return [];

    const t = today();
    const vigentes = await this.prisma.promotion.findMany({
      where: { active: true, startDate: { lte: t }, endDate: { gte: t } },
      orderBy: { percentage: 'desc' },
      include: this.targetInclude,
    });
    return vigentes
      .filter((p) => this.reaches(this.audienceOfPromo(p), facts))
      .map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        percentage: p.percentage,
        discountFormat: p.discountFormat,
        flatAmount: p.flatAmount,
        startDate: p.startDate,
        endDate: p.endDate,
        allSubscribers: p.allSubscribers,
        subscriberStatuses: p.subscriberStatuses,
      }));
  }

  /**
   * Aplica una promoción a una factura como nota crédito. Valida vigencia y que el
   * CLIENTE de la factura esté dentro del público de la promo —se revalida aquí,
   * no basta con que la pantalla la haya ofrecido— y evita aplicar la misma promo
   * dos veces a la misma factura (legacy `promo_sistema_clientes1`).
   */
  async apply(promotionId: string, dto: ApplyPromotionDto, user: AuthUser) {
    const t = today();
    const promo = await this.prisma.promotion.findUnique({
      where: { id: promotionId },
      include: this.targetInclude,
    });
    if (!promo) throw new NotFoundException('Promoción no encontrada');
    if (!promo.active) throw new BadRequestException('La promoción está inactiva');
    if (promo.startDate > t || promo.endDate < t)
      throw new BadRequestException('La promoción no está vigente');

    const invoice = await this.prisma.subInvoice.findUnique({
      where: { id: dto.invoiceId },
      select: { id: true, total: true, subtotal: true, tid: true, subscriberId: true },
    });
    if (!invoice) throw new NotFoundException('Factura no encontrada');

    const facts = invoice.subscriberId ? await this.subscriberFacts(invoice.subscriberId) : null;
    if (!facts || !this.reaches(this.audienceOfPromo(promo), facts))
      throw new ForbiddenException(
        'El cliente de esta factura no está dentro del público de la promoción',
      );

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

    const staff = await this.staffForUser(user);

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
