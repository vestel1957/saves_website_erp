import { BadRequestException, ForbiddenException, NotFoundException } from '../core/http/errores';
import { InvoiceKind, Prisma, PromotionTargetKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { FacturasService } from '../billing/facturas.service';
import {
  ApplyPromotionDto,
  CreatePromotionDto,
  InvoiceKindName,
  PromotionAudienceDto,
  SubscriberStatusName,
  UpdatePromotionDto,
} from './dto/promotions.dto';
import { num, round2 } from '../common/money';
import {
  Audience, SubscriberFacts, audienceOfPromo, discountLabel, hasCriteria,
  isBeforeTaxFmt, isFlatFmt, montoDeDescuento, reaches, subscriberFacts,
} from './publico';
import { alcanzaLaFactura, yaRebajadaEnOrigen } from './descuento-al-cobrar';

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

const uniq = (xs: string[]) => Array.from(new Set(xs.filter(Boolean)));


/** Un destinatario concreto del público, para la bitácora y las etiquetas. */
type TargetRef = { kind: PromotionTargetKind; key: string; label: string };


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

/**
 * TIPO de factura que rebaja la campaña, normalizado: sin repetidos y siempre en el
 * mismo orden (mensualidad, cargos), para que dos promociones equivalentes se
 * guarden igual y las consultas por lista exacta sean predecibles. Sin nada elegido,
 * la mensualidad: es lo que hacían todas las campañas antes de que el tipo se pudiera
 * pedir aparte (2026-09-10).
 */
function tiposDeFactura(kinds?: InvoiceKindName[] | null): InvoiceKind[] {
  const pedidos = new Set(kinds ?? []);
  const fuera = [InvoiceKind.RECURRENTE, InvoiceKind.FIJA].filter((k) => pedidos.has(k));
  return fuera.length ? fuera : [InvoiceKind.RECURRENTE];
}

/** Cómo se lee en pantalla el alcance de una campaña ("La mensualidad del mes"). */
function alcanceEnPalabras(p: { invoiceKinds: InvoiceKind[]; onlyCurrentMonth: boolean }): string {
  const tipos = tiposDeFactura(p.invoiceKinds as InvoiceKindName[]);
  const que = tipos.length === 2 ? 'las facturas' : tipos[0] === InvoiceKind.RECURRENTE ? 'las mensualidades' : 'los cargos sueltos';
  return p.onlyCurrentMonth ? `${que} del mes en curso` : `${que} pendientes, atrasadas incluidas`;
}

/** ¿El público es UN cliente en concreto y nada más? Es lo único que admite elegir facturas. */
function esUnCliente(a: Audience): boolean {
  return (
    !a.allSubscribers && a.subscriberIds.length === 1 && !a.subscriberStatuses.length
    && !a.planIds.length && !a.branchIds.length && !a.neighborhoodRefs.length
  );
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

  /**
   * ¿Se puede publicar esta promoción en el PORTAL DE PAGOS EN LÍNEA?
   *
   * El portal descuenta con la tabla `promos` del legacy, que sólo guarda un
   * porcentaje y un estado de cliente: no sabe de planes, sedes, barrios ni clientes
   * sueltos, y su cuenta es siempre `total * porcentaje / 100`. Lo que no encaja se
   * rechaza aquí y no al empujarlo, para que quien arma la campaña se entere en la
   * pantalla y no quince minutos después en un log del writeback.
   */
  private assertPublicableEnPortal(
    disc: { discountFormat: string; percentage: number },
    a: Audience,
  ) {
    if (disc.discountFormat !== '%')
      throw new BadRequestException(
        'El portal de pagos sólo sabe descontar un porcentaje sobre el total: '
        + 'cambia el descuento a % (después de impuestos) o no lo publiques allá',
      );
    if (!disc.percentage)
      throw new BadRequestException('El descuento del portal necesita un porcentaje mayor que cero');
    if (a.subscriberIds.length || a.planIds.length || a.branchIds.length || a.neighborhoodRefs.length)
      throw new BadRequestException(
        'El portal de pagos sólo distingue a los clientes por su ESTADO: '
        + 'un público por cliente, plan, sede o barrio no se puede publicar allá',
      );
    if (!a.allSubscribers && !a.subscriberStatuses.length)
      throw new BadRequestException('Elige a qué estados alcanza la promoción para publicarla en el portal');
  }

  /**
   * Las dos formas de descontar en el portal son EXCLUYENTES.
   *
   * `portalPublish` deja una fila en `promos` para que el portal ofrezca el descuento
   * con la mecánica del legacy (su banner rebaja la última factura). `portalPreapply`
   * rebaja la cartera por adelantado, así que allá el cliente ya ve el valor con el
   * descuento. Con las dos a la vez, el banner descontaría otra vez sobre lo ya
   * rebajado y el cliente se lo llevaría dos veces.
   */
  private assertPortalCoherente(portalPublish: boolean, portalPreapply: boolean) {
    if (portalPublish && portalPreapply)
      throw new BadRequestException(
        'Elige una sola forma para el portal: o lo cobra ya con el descuento, '
        + 'o se publica allá para que el portal lo ofrezca. Las dos a la vez '
        + 'se lo descontarían dos veces al cliente.',
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
    if (!hasCriteria(a)) return null;

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

  /**
   * Facturas elegidas a mano, validadas. Sólo tienen sentido con UN cliente de público
   * —con un grupo, "estas facturas" no significa nada— y todas tienen que ser de ese
   * cliente y cobrables (mensualidad o cargo): si no, la promoción apuntaría a algo
   * que nunca rebaja y nadie sabría por qué.
   */
  private async facturasElegidas(a: Audience, ids?: string[] | null): Promise<string[]> {
    const pedidas = uniq(ids ?? []);
    if (!pedidas.length) return [];
    if (!esUnCliente(a))
      throw new BadRequestException(
        'Elegir facturas sólo se puede cuando la promoción va a UN cliente en concreto',
      );
    const suyas = await this.prisma.subInvoice.count({
      where: {
        id: { in: pedidas },
        subscriberId: a.subscriberIds[0],
        kind: { in: [InvoiceKind.RECURRENTE, InvoiceKind.FIJA] },
      },
    });
    if (suyas !== pedidas.length)
      throw new BadRequestException('Alguna de las facturas elegidas no es de este cliente');
    return pedidas;
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
    if (!hasCriteria(a))
      throw new BadRequestException(
        'Define a qué clientes alcanza la promoción (o marca "Todos los clientes")',
      );
    const name = dto.name.trim();
    const disc = resolveDiscount(dto.discountFormat ?? '%', dto.percentage, dto.flatAmount);
    const refs = await this.targetRefs(a);
    const portalPublish = dto.portalPublish ?? false;
    if (portalPublish) this.assertPublicableEnPortal(disc, a);
    const portalPreapply = dto.portalPreapply ?? false;
    this.assertPortalCoherente(portalPublish, portalPreapply);
    const invoiceIds = await this.facturasElegidas(a, dto.invoiceIds);

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
          invoiceKinds: tiposDeFactura(dto.invoiceKinds),
          onlyCurrentMonth: dto.onlyCurrentMonth ?? true,
          invoiceIds,
          portalPublish,
          portalPreapply,
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
          invoiceKinds: tiposDeFactura(dto.invoiceKinds),
          onlyCurrentMonth: dto.onlyCurrentMonth ?? true,
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
        invoiceKinds: true, onlyCurrentMonth: true,
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

    const before = audienceOfPromo(existing);
    // El público se reemplaza entero: la pantalla siempre manda el estado completo.
    const after = this.audienceOf(dto);
    if (!hasCriteria(after))
      throw new BadRequestException(
        'Define a qué clientes alcanza la promoción (o marca "Todos los clientes")',
      );
    const name = dto.name?.trim() ?? existing.name;

    // Las facturas elegidas son de UN cliente: si el público deja de ser ese cliente,
    // se sueltan solas en vez de quedar apuntando a facturas de otro.
    const mismoCliente = esUnCliente(after) && esUnCliente(before)
      && after.subscriberIds[0] === before.subscriberIds[0];
    const invoiceIds = await this.facturasElegidas(
      after,
      dto.invoiceIds ?? (mismoCliente ? existing.invoiceIds : []),
    );

    const data: Prisma.PromotionUpdateInput = {
      name: dto.name?.trim() ?? undefined,
      description:
        dto.description === undefined ? undefined : dto.description?.trim() || null,
      startDate: start,
      endDate: end,
      active: dto.active ?? undefined,
      invoiceKinds: dto.invoiceKinds ? tiposDeFactura(dto.invoiceKinds) : undefined,
      onlyCurrentMonth: dto.onlyCurrentMonth ?? undefined,
      invoiceIds,
      allSubscribers: after.allSubscribers,
      subscriberStatuses: after.subscriberStatuses as any,
      neighborhoodRefs: after.neighborhoodRefs,
      subscribers: { set: after.subscriberIds.map((sid) => ({ id: sid })) },
      plans: { set: after.planIds.map((pid) => ({ id: pid })) },
      branches: { set: after.branchIds.map((bid) => ({ id: bid })) },
    };

    // Descuento: solo se recalcula si el usuario tocó algún campo de descuento.
    const fmt = dto.discountFormat ?? existing.discountFormat;
    const pct = dto.percentage ?? existing.percentage;
    const flat = dto.flatAmount ?? (existing.flatAmount != null ? num(existing.flatAmount) : undefined);
    const disc = resolveDiscount(fmt, pct, flat);
    if (dto.discountFormat !== undefined || dto.percentage !== undefined || dto.flatAmount !== undefined) {
      data.discountFormat = disc.discountFormat;
      data.percentage = disc.percentage;
      data.flatAmount = disc.flatAmount;
    }

    // El portal se revalida con lo que queda DESPUÉS de la edición: una promoción ya
    // publicada a la que se le cambia el público a "por sede" dejaría de ser
    // publicable, y el legacy no tiene dónde guardar eso.
    const portalPublish = dto.portalPublish ?? existing.portalPublish;
    if (portalPublish) this.assertPublicableEnPortal(disc, after);
    const portalPreapply = dto.portalPreapply ?? existing.portalPreapply;
    this.assertPortalCoherente(portalPublish, portalPreapply);
    data.portalPublish = portalPublish;
    data.portalPreapply = portalPreapply;
    // Al despublicarla se limpia la huella: las filas de `promos` las retira el
    // writeback en su siguiente pasada.
    if (!portalPublish && existing.portalPublish) {
      data.legacyPromoIds = [];
      data.portalPublishedAt = null;
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

  /**
   * Lo que el cliente debe, factura por factura, para elegir a mano a cuáles llega la
   * promoción. Mensualidades y cargos con saldo (las notas no se cobran). Trae lo que
   * la pantalla necesita para decir por qué alguna NO se puede rebajar: timbrada ante
   * la DIAN o ya rebajada por el portal — las mismas dos reglas de
   * `descuento-al-cobrar.ts`, que al cobrar la saltarían en silencio.
   *
   * El saldo se mira factura por factura y no por `status`: el legacy deja facturas
   * con `paidAmount` que no casa con su estado (ver [[facturas-sobrepagadas-legacy]]).
   */
  async facturasPendientes(subscriberId?: string) {
    if (!subscriberId) return [];
    const rows = await this.prisma.subInvoice.findMany({
      where: {
        subscriberId,
        status: { not: 'CANCELED' },
        kind: { in: [InvoiceKind.RECURRENTE, InvoiceKind.FIJA] },
      },
      orderBy: [{ invoiceDate: 'asc' }, { tid: 'asc' }],
      select: {
        id: true, tid: true, kind: true, invoiceDate: true,
        subtotal: true, total: true, paidAmount: true, discount: true,
        items: { where: { price: { gt: 0 } }, select: { productName: true, description: true }, take: 1 },
        electronicInvoices: {
          where: { type: 'FACTURADA', dianNumber: { not: null } }, select: { id: true }, take: 1,
        },
      },
    });
    return rows
      .map((r) => ({
        id: r.id,
        tid: r.tid,
        kind: r.kind,
        invoiceDate: r.invoiceDate,
        subtotal: num(r.subtotal),
        total: num(r.total),
        paidAmount: num(r.paidAmount),
        saldo: round2(num(r.total) - num(r.paidAmount)),
        concepto: (r.items[0]?.productName || r.items[0]?.description || '').trim() || null,
        timbrada: r.electronicInvoices.length > 0,
        rebajadaEnOrigen: yaRebajadaEnOrigen(r),
      }))
      .filter((r) => r.saldo > 0);
  }

  async remove(id: string) {
    const existing = await this.prisma.promotion.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Promoción no encontrada');
    await this.prisma.promotion.delete({ where: { id } });
    return { ok: true };
  }

  // ---------------------------------------------------------- Facturación ----

  /**
   * Promociones que hoy pueden aplicarse a una factura: vigentes, cuyo público
   * alcanza al CLIENTE de esa factura y cuyo alcance llega a ESTA factura. Sin
   * factura no hay respuesta posible: la elegibilidad depende del cliente, no del
   * usuario que pregunta.
   *
   * El alcance se mira aquí y no sólo al aplicar porque `apply` responde 400 y eso,
   * en pantalla, es ofrecer un botón que no funciona: una campaña de instalación
   * aparecía en la mensualidad y sólo al pulsarla se sabía que no era para ella.
   */
  async available(invoiceId?: string) {
    if (!invoiceId) return [];
    const inv = await this.prisma.subInvoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, subscriberId: true, kind: true, invoiceDate: true, discount: true },
    });
    if (!inv?.subscriberId) return [];
    // Ya rebajada por el portal del legacy: no se ofrece apilar otra encima.
    if (yaRebajadaEnOrigen(inv)) return [];
    const facts = await subscriberFacts(this.prisma, inv.subscriberId);
    if (!facts) return [];

    const t = today();
    const vigentes = await this.prisma.promotion.findMany({
      where: { active: true, startDate: { lte: t }, endDate: { gte: t } },
      orderBy: { percentage: 'desc' },
      include: this.targetInclude,
    });
    return vigentes
      .filter((p) => reaches(audienceOfPromo(p), facts) && alcanzaLaFactura(p, inv, t))
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
      select: {
        id: true, total: true, subtotal: true, paidAmount: true, tid: true, subscriberId: true,
        kind: true, invoiceDate: true, discount: true,
      },
    });
    if (!invoice) throw new NotFoundException('Factura no encontrada');

    // El alcance lo dice la promoción, también a mano: el pronto pago no rebaja la
    // mensualidad atrasada ni un cargo suelto, lo aplique quien lo aplique. Ver
    // `alcanzaLaFactura` en `descuento-al-cobrar.ts`.
    if (!alcanzaLaFactura(promo, invoice, t)) {
      throw new BadRequestException(
        `Esta promoción sólo rebaja ${alcanceEnPalabras(promo)}; esta factura no lo es`,
      );
    }
    // Ya trae descuento de cabecera (el portal de pagos del legacy se lo puso): no se
    // apila otro encima, que es como la factura 503819 salió con el 9,75 %.
    if (yaRebajadaEnOrigen(invoice)) {
      throw new BadRequestException(
        `Esta factura ya trae un descuento de ${Math.round(num(invoice.discount)).toLocaleString('es-CO')} puesto por el portal de pagos; no se aplica otra promoción encima`,
      );
    }

    const facts = invoice.subscriberId ? await subscriberFacts(this.prisma, invoice.subscriberId) : null;
    if (!facts || !reaches(audienceOfPromo(promo), facts))
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
    // Topado en lo que queda debiendo: sobre una factura ya abonada, el 50 % del total
    // puede pasar del saldo, y una nota crédito mayor la dejaría sobrepagada (un saldo
    // a favor que nadie pidió; ver [[facturas-sobrepagadas-legacy]]).
    const saldo = round2(num(invoice.total) - num(invoice.paidAmount));
    if (saldo <= 0) throw new BadRequestException('Esta factura ya está pagada');
    const amount = Math.min(montoDeDescuento(promo, invoice), saldo);
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
