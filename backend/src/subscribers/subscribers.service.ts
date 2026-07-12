import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InvoiceKind, InvoiceRon, Prisma, SubscriberStatus, SubInvoiceStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSubscriberDto, UpdateInvoiceDto, UpdateSubscriberDto } from './dto/update-subscriber.dto';
import { MikrotikService } from '../network/mikrotik.service';
import type { AuthUser } from '../auth/current-user.decorator';

const num = (d: Prisma.Decimal | null | undefined) => (d == null ? 0 : Number(d));

/** Estados de factura que cuentan como deuda. */
const UNPAID_STATUSES: SubInvoiceStatus[] = ['DUE', 'PARTIAL'];

/** Filtro compartido por la lista de clientes y las operaciones masivas. */
type ListFilter = {
  search?: string; status?: string; branchId?: string;
  servicio?: string; // internet | tv | combo
  tecnologia?: string; // FTTH | EOC
  cuenta?: string; // aldia | debe | compromiso
  deuda?: string; // 1 | gt2 (nº de facturas sin pagar)
  page?: number; pageSize?: number; withPlan?: string;
};

/** Nombre visible del suscriptor a partir de los campos legacy partidos. */
function displayName(s: {
  firstName: string | null; secondName: string | null;
  lastName1: string | null; lastName2: string | null;
  companyName: string | null; fullName: string | null;
}): string {
  if (s.fullName && s.fullName.trim()) return s.fullName.trim();
  const parts = [s.firstName, s.secondName, s.lastName1, s.lastName2].map((p) => (p || '').trim()).filter(Boolean);
  const person = parts.join(' ');
  if (person) return person;
  return (s.companyName || '').trim() || 'Sin nombre';
}

/** Campos de factura que consumen la ficha y la lista de facturas. */
const INVOICE_SELECT: Prisma.SubInvoiceSelect = {
  id: true, tid: true, invoiceDate: true, dueDate: true, total: true,
  paidAmount: true, status: true, ron: true, kind: true, notes: true, serviceCombo: true, serviceTv: true,
  promo: true, promo2: true, promoModifiedDate: true, promo2ModifiedDate: true,
  eInvoiceFlag: true, eInvoiceGenDate: true, eInvoiceServices: true,
  electronicInvoices: {
    orderBy: { date: 'desc' }, take: 1,
    select: { dianNumber: true, cufe: true, pdfUrl: true, date: true, siigoInvoiceId: true },
  },
};

/** Da forma a una factura (misma estructura para la ficha y la lista paginada). */
function mapInvoice(i: any) {
  const ei = i.electronicInvoices[0];
  return {
    id: i.id, tid: i.tid, date: i.invoiceDate, dueDate: i.dueDate,
    total: num(i.total), paid: num(i.paidAmount), balance: num(i.total) - num(i.paidAmount),
    status: i.status, ron: i.ron, kind: i.kind, notes: i.notes, combo: i.serviceCombo, tv: i.serviceTv,
    promo: {
      p1: i.promo, p2: i.promo2, date1: i.promoModifiedDate, date2: i.promo2ModifiedDate,
      has: !!(i.promo || i.promo2),
    },
    eInvoice: {
      flag: i.eInvoiceFlag, services: i.eInvoiceServices, genDate: i.eInvoiceGenDate,
      created: i.eInvoiceFlag === 'Factura Electronica Creada' || !!ei,
      dian: ei?.dianNumber ?? null, cufe: ei?.cufe ?? null, pdfUrl: ei?.pdfUrl ?? null, date: ei?.date ?? null,
    },
  };
}

/** Compone el nombre visible a partir de las 4 partes; null si todas vacías. */
function composeName(...parts: (string | null | undefined)[]): string | null {
  const joined = parts.map((p) => (p || '').trim()).filter(Boolean).join(' ');
  return joined || null;
}

/** Campos string del perfil que se aplican tal cual ("" → null). */
const PROFILE_STR_FIELDS = [
  'firstName', 'secondName', 'lastName1', 'lastName2', 'companyName', 'customerType',
  'docType', 'docNumber', 'email', 'phone1', 'phone2', 'estrato', 'suscripcion',
  'departmentRef', 'cityRef', 'localityRef', 'neighborhood', 'addressLine', 'gpsLat', 'gpsLng',
] as const;

/** Traduce el DTO del wizard (pasos 1-2) a data de Prisma (sin branch ni fullName). */
function buildProfileData(dto: Record<string, any>): any {
  const data: any = {};
  for (const k of PROFILE_STR_FIELDS) if (dto[k] !== undefined) data[k] = dto[k] === '' ? null : dto[k];
  if (dto.abonado !== undefined) data.abonado = dto.abonado;
  if (dto.clausula !== undefined) data.clausula = dto.clausula;
  if (dto.birthDate !== undefined) data.birthDate = dto.birthDate ? new Date(dto.birthDate) : null;
  if (dto.contractDate !== undefined) data.contractDate = dto.contractDate ? new Date(dto.contractDate) : null;
  if (dto.nomenclature !== undefined) data.nomenclature = dto.nomenclature ?? null;
  return data;
}

@Injectable()
export class SubscribersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mikrotik: MikrotikService,
  ) {}

  /** Tarjetas de resumen: totales por estado + cartera global. */
  async stats() {
    const [byStatus, total, cartera] = await Promise.all([
      this.prisma.subscriber.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.subscriber.count(),
      this.prisma.subInvoice.aggregate({
        _sum: { total: true, paidAmount: true },
        where: { status: { in: ['DUE', 'PARTIAL'] } },
      }),
    ]);
    const status: Record<string, number> = {};
    for (const r of byStatus) status[r.status ?? 'SIN_ESTADO'] = r._count._all;
    return {
      total,
      activos: status['ACTIVO'] ?? 0,
      cartera: status['CARTERA'] ?? 0,
      cortados: status['CORTADO'] ?? 0,
      suspendidos: status['SUSPENDIDO'] ?? 0,
      status,
      carteraTotal: num(cartera._sum.total) - num(cartera._sum.paidAmount),
    };
  }

  /** Listado paginado con búsqueda y filtros. */
  async list(params: ListFilter) {
    const page = Math.max(1, Number(params.page) || 1);
    // Con plan permitimos páginas más grandes (la vista de grupo carga muchos a la vez).
    const withPlan = params.withPlan === '1' || params.withPlan === 'true';
    const pageSize = Math.min(withPlan ? 500 : 100, Math.max(1, Number(params.pageSize) || 25));

    const where = await this.computeWhere(params);

    const [rows, total] = await Promise.all([
      this.prisma.subscriber.findMany({
        where,
        orderBy: { abonado: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          branch: { select: { name: true } },
          ...(withPlan ? { services: { select: { kind: true, planName: true, price: true, status: true } } } : {}),
        },
      }),
      this.prisma.subscriber.count({ where }),
    ]);

    // Resuelve el plan de Internet y de TV (activos) para la vista de grupo.
    const planOf = (s: any, kind: 'INTERNET' | 'TV') => {
      const svc = (s.services ?? []).find((x: any) => x.kind === kind);
      return svc ? { plan: svc.planName ?? null, price: num(svc.price) } : null;
    };

    // Deuda real por cliente = Σ(total − pagado) de facturas sin pagar (NO el saldo a favor).
    const debtById = new Map<string, number>();
    if (withPlan && rows.length) {
      const grouped = await this.prisma.subInvoice.groupBy({
        by: ['subscriberId'],
        where: { subscriberId: { in: rows.map((r) => r.id) }, status: { in: UNPAID_STATUSES } },
        _sum: { total: true, paidAmount: true },
      });
      for (const g of grouped) debtById.set(g.subscriberId, Math.max(0, num(g._sum.total) - num(g._sum.paidAmount)));
    }

    return {
      items: rows.map((s) => ({
        id: s.id,
        abonado: s.abonado,
        name: displayName(s),
        docType: s.docType,
        docNumber: s.docNumber,
        phone: s.phone1,
        email: s.email,
        status: s.status,
        branch: s.branch?.name ?? null,
        balance: num(s.balance),
        installTech: s.installTech,
        ...(withPlan ? { internet: planOf(s, 'INTERNET'), tv: planOf(s, 'TV'), debt: debtById.get(s.id) ?? 0 } : {}),
      })),
      total,
      page,
      pageSize,
      pages: Math.ceil(total / pageSize),
    };
  }

  /** Ficha completa de un suscriptor. */
  /** Datos para el contrato de servicio (PDF). */
  async contractData(id: string) {
    const s = await this.prisma.subscriber.findUnique({
      where: { id },
      select: {
        firstName: true, lastName1: true, companyName: true, fullName: true,
        docType: true, docNumber: true, abonado: true, addressLine: true,
        phone1: true, email: true, pppProfile: true, pppService: true,
        contractDate: true, branch: { select: { name: true } },
      } as any,
    });
    if (!s) throw new NotFoundException('Cliente no encontrado');
    const a = s as any;
    const name = (a.fullName || [a.firstName, a.lastName1].filter(Boolean).join(' ') || a.companyName || '—').trim();
    return {
      name, docType: a.docType, docNumber: a.docNumber, abonado: a.abonado,
      addressLine: a.addressLine, branch: a.branch?.name ?? null,
      phone: a.phone1, email: a.email, plan: a.pppProfile ?? null,
      profile: a.pppProfile ?? null, service: a.pppService ?? null,
      contractDate: a.contractDate,
    };
  }

  async detail(id: string) {
    const s = await this.prisma.subscriber.findUnique({
      where: { id },
      include: {
        branch: { select: { name: true } },
        services: true,
        statusHistory: { orderBy: { date: 'desc' }, take: 20 },
        tickets: {
          orderBy: { created: 'desc' },
          take: 30,
          select: {
            id: true, code: true, type: true, subject: true, status: true,
            created: true, finalDate: true, assigned: true, problem: true,
          },
        },
        invoices: {
          orderBy: { invoiceDate: 'desc' },
          take: 12,
          select: INVOICE_SELECT,
        },
        equipment: {
          orderBy: { arrival: 'desc' },
          select: {
            id: true, code: true, brand: true, serial: true, mac: true,
            installType: true, port: true, vlan: true, nat: true, status: true, observation: true, arrival: true,
          },
        },
        notes: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!s) throw new NotFoundException('Suscriptor no encontrado');

    const cartera = await this.prisma.subInvoice.aggregate({
      _sum: { total: true, paidAmount: true },
      _count: { _all: true },
      where: { subscriberId: id, status: { in: ['DUE', 'PARTIAL'] } },
    });

    return {
      id: s.id,
      abonado: s.abonado,
      suscripcion: s.suscripcion,
      name: displayName(s),
      companyName: s.companyName,
      docType: s.docType,
      docNumber: s.docNumber,
      email: s.email,
      phone1: s.phone1,
      phone2: s.phone2,
      birthDate: s.birthDate,
      contractDate: s.contractDate,
      entryDate: s.entryDate,
      estrato: s.estrato,
      branch: s.branch?.name ?? null,
      addressLine: s.addressLine,
      neighborhood: s.neighborhood,
      gps: s.gpsLat && s.gpsLng ? { lat: s.gpsLat, lng: s.gpsLng } : null,
      status: s.status,
      previousStatus: s.previousStatus,
      statusChangedAt: s.statusChangedAt,
      // Red
      network: {
        pppUsername: s.pppUsername,
        pppProfile: s.pppProfile,
        ipLocal: s.ipLocal,
        ipRemote: s.ipRemote,
        macEquipo: s.macEquipo,
        macOnt: s.macOnt,
        installTech: s.installTech,
      },
      // Dinero
      balance: num(s.balance),
      debit: num(s.debitCache),
      credit: num(s.creditCache),
      receivable: num(cartera._sum.total) - num(cartera._sum.paidAmount),
      dueInvoices: cartera._count._all,
      // Facturación electrónica
      eInvoice: {
        enabled: s.eInvoice, tv: s.eInvoiceTv, internet: s.eInvoiceInternet, puntos: s.eInvoicePuntos,
      },
      services: s.services.map((sv) => ({ kind: sv.kind, planName: sv.planName, status: sv.status, price: num(sv.price) })),
      statusHistory: s.statusHistory.map((h) => ({ status: h.status, date: h.date, ticket: h.originTicketId })),
      workOrders: s.tickets.map((t) => ({
        id: t.id, code: t.code, type: t.type, subject: t.subject, status: t.status,
        created: t.created, finalDate: t.finalDate, assigned: t.assigned, problem: t.problem,
      })),
      invoices: s.invoices.map(mapInvoice),
      equipment: s.equipment.map((e) => ({
        id: e.id, code: e.code, brand: e.brand, serial: e.serial, mac: e.mac,
        installType: e.installType, port: e.port, vlan: e.vlan, nat: e.nat, status: e.status,
        observation: e.observation, arrival: e.arrival,
      })),
      notes: s.notes.map((n) => ({ id: n.id, body: n.body, author: n.authorName, createdAt: n.createdAt })),
    };
  }

  /** Catálogo de sedes para filtros. */
  branches() {
    return this.prisma.branch.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } });
  }

  /** WHERE compartido por la lista y por las operaciones masivas por filtro. */
  private buildListWhere(params: ListFilter): Prisma.SubscriberWhereInput {
    const where: Prisma.SubscriberWhereInput = {};
    const and: Prisma.SubscriberWhereInput[] = [];
    if (params.status) where.status = params.status as SubscriberStatus;
    if (params.branchId) where.branchId = params.branchId;

    // Servicio del cliente (según los servicios que tiene).
    if (params.servicio === 'internet') and.push({ services: { some: { kind: 'INTERNET' } } });
    else if (params.servicio === 'tv') and.push({ services: { some: { kind: 'TV' } } });
    else if (params.servicio === 'combo') {
      and.push({ services: { some: { kind: 'INTERNET' } } });
      and.push({ services: { some: { kind: 'TV' } } });
    }

    // Tecnología: FTTH agrupa fibra; EOC aparte.
    if (params.tecnologia === 'FTTH') where.installTech = { in: ['GPON', 'EPON', 'FIBRA'] };
    else if (params.tecnologia === 'EOC') where.installTech = 'EOC';

    // Estado de la cuenta (deuda / al día / compromiso).
    if (params.cuenta === 'debe') and.push({ invoices: { some: { status: { in: UNPAID_STATUSES } } } });
    else if (params.cuenta === 'aldia') and.push({ invoices: { none: { status: { in: UNPAID_STATUSES } } } });
    else if (params.cuenta === 'compromiso') and.push({ status: 'COMPROMISO' });

    if (and.length) where.AND = and;
    const search = (params.search || '').trim();
    if (search) {
      // Cada palabra debe calzar en algún campo (nombre partido en 4 columnas,
      // razón social, documento o teléfono) → permite buscar "María Daza".
      const tokens = search.split(/\s+/).filter(Boolean);
      const perToken = (tok: string): Prisma.SubscriberWhereInput => ({
        OR: [
          { firstName: { contains: tok, mode: 'insensitive' } },
          { secondName: { contains: tok, mode: 'insensitive' } },
          { lastName1: { contains: tok, mode: 'insensitive' } },
          { lastName2: { contains: tok, mode: 'insensitive' } },
          { companyName: { contains: tok, mode: 'insensitive' } },
          { docNumber: { contains: tok } },
          { phone1: { contains: tok } },
        ],
      });
      const asNum = Number(search);
      where.OR = [
        { AND: tokens.map(perToken) },
        ...(Number.isFinite(asNum) ? [{ abonado: asNum }] : []),
      ];
    }
    return where;
  }

  /** IDs de abonados según nº de facturas sin pagar (1 factura = 1 mes). */
  private async debtCountIds(deuda: string): Promise<string[]> {
    const rows = deuda === 'gt2'
      ? await this.prisma.$queryRaw<{ subscriberId: string }[]>`SELECT "subscriberId" FROM "SubInvoice" WHERE status IN ('DUE','PARTIAL') GROUP BY "subscriberId" HAVING count(*) > 2`
      : await this.prisma.$queryRaw<{ subscriberId: string }[]>`SELECT "subscriberId" FROM "SubInvoice" WHERE status IN ('DUE','PARTIAL') GROUP BY "subscriberId" HAVING count(*) = 1`;
    return rows.map((r) => r.subscriberId);
  }

  /** WHERE final: base + filtro por nº de facturas (deuda) resuelto vía SQL. */
  private async computeWhere(params: ListFilter): Promise<Prisma.SubscriberWhereInput> {
    const where = this.buildListWhere(params);
    if (params.deuda === '1' || params.deuda === 'gt2') {
      const ids = await this.debtCountIds(params.deuda);
      const and = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
      and.push({ id: { in: ids } });
      where.AND = and;
    }
    return where;
  }

  /** Tope de seguridad para operaciones masivas por filtro (evita cortes catastróficos). */
  private static readonly MAX_BULK = 2000;

  /** IDs de todos los abonados que cumplen el filtro (sin paginar). */
  async matchingIds(filter: ListFilter): Promise<string[]> {
    const rows = await this.prisma.subscriber.findMany({
      where: await this.computeWhere(filter),
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  private async resolveBulkIds(filter: ListFilter): Promise<string[]> {
    const ids = await this.matchingIds(filter);
    if (ids.length === 0) throw new BadRequestException('No hay clientes que cumplan el filtro.');
    if (ids.length > SubscribersService.MAX_BULK) {
      throw new BadRequestException(`${ids.length} clientes exceden el máximo de ${SubscribersService.MAX_BULK} por operación. Afina el filtro (sede / estado).`);
    }
    return ids;
  }

  /** Corte masivo de TODOS los que cumplen el filtro (no depende de lo cargado en pantalla). */
  async cutByFilter(filter: ListFilter, user: AuthUser) {
    const ids = await this.resolveBulkIds(filter);
    return this.mikrotik.cutBatch(ids, user);
  }

  /** Reconexión masiva de TODOS los que cumplen el filtro. */
  async reconnectByFilter(filter: ListFilter, user: AuthUser) {
    const ids = await this.resolveBulkIds(filter);
    return this.mikrotik.reconnectBatch(ids, user);
  }

  /** WhatsApp masivo a TODOS los que cumplen el filtro. */
  async messageByFilter(filter: ListFilter, message: string) {
    const ids = await this.resolveBulkIds(filter);
    return this.mikrotik.messageBatch(ids, message);
  }

  /** Sedes con conteo de abonados por estado (para el flujo sede-primero de cortes masivos). */
  async branchesStats() {
    const [branches, grouped] = await Promise.all([
      this.prisma.branch.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
      this.prisma.subscriber.groupBy({ by: ['branchId', 'status'], _count: { _all: true } }),
    ]);
    const byBranch = new Map<string, Record<string, number>>();
    for (const g of grouped) {
      if (!g.branchId) continue;
      const bucket = byBranch.get(g.branchId) ?? {};
      bucket[g.status ?? 'SIN'] = (bucket[g.status ?? 'SIN'] ?? 0) + g._count._all;
      byBranch.set(g.branchId, bucket);
    }
    return branches.map((b) => {
      const byStatus = byBranch.get(b.id) ?? {};
      const total = Object.values(byStatus).reduce((s, n) => s + n, 0);
      return {
        id: b.id, name: b.name, total, byStatus,
        activos: byStatus['ACTIVO'] ?? 0,
        cortados: byStatus['CORTADO'] ?? 0,
        cartera: byStatus['CARTERA'] ?? 0,
      };
    });
  }

  // ── Catálogos de dirección (selects en cascada del wizard) ─────
  geoDepartments() {
    return this.prisma.department.findMany({ orderBy: { name: 'asc' }, select: { legacyId: true, name: true } });
  }
  geoCities(departmentLegacy?: number) {
    return this.prisma.city.findMany({
      where: departmentLegacy ? { departmentLegacy } : {}, orderBy: { name: 'asc' }, select: { legacyId: true, name: true },
    });
  }
  geoLocalities(cityLegacy?: number) {
    return this.prisma.locality.findMany({
      where: cityLegacy ? { cityLegacy } : {}, orderBy: { name: 'asc' }, select: { legacyId: true, name: true },
    });
  }
  geoNeighborhoods(localityLegacy?: number) {
    return this.prisma.neighborhood.findMany({
      where: localityLegacy ? { localityLegacy } : {}, orderBy: { name: 'asc' }, select: { legacyId: true, name: true },
    });
  }

  /** Campos crudos editables (para precargar el wizard en modo edición). */
  async editForm(id: string) {
    const s = await this.prisma.subscriber.findUnique({
      where: { id },
      select: {
        id: true, abonado: true, firstName: true, secondName: true, lastName1: true, lastName2: true,
        companyName: true, customerType: true, docType: true, docNumber: true, email: true,
        phone1: true, phone2: true, birthDate: true, estrato: true, suscripcion: true, contractDate: true,
        departmentRef: true, cityRef: true, localityRef: true, neighborhood: true, addressLine: true,
        nomenclature: true, clausula: true, gpsLat: true, gpsLng: true, branchId: true,
      },
    });
    if (!s) throw new NotFoundException('Suscriptor no encontrado');
    return s;
  }

  /** Editar el perfil del cliente (pasos 1 y 2). Devuelve la ficha fresca. */
  async update(id: string, dto: UpdateSubscriberDto) {
    const s = await this.prisma.subscriber.findUnique({
      where: { id },
      select: { id: true, firstName: true, secondName: true, lastName1: true, lastName2: true },
    });
    if (!s) throw new NotFoundException('Suscriptor no encontrado');

    const data = buildProfileData(dto);
    if (dto.branchId !== undefined) {
      data.branch = dto.branchId ? { connect: { id: dto.branchId } } : { disconnect: true };
    }
    // Recalcular fullName si cambió alguna parte del nombre.
    if (['firstName', 'secondName', 'lastName1', 'lastName2'].some((k) => (dto as any)[k] !== undefined)) {
      data.fullName = composeName(dto.firstName ?? s.firstName, dto.secondName ?? s.secondName, dto.lastName1 ?? s.lastName1, dto.lastName2 ?? s.lastName2);
    }

    await this.prisma.subscriber.update({ where: { id }, data });
    return this.detail(id);
  }

  /**
   * Cambia el plan del abonado desde el catálogo:
   *  1) actualiza el SubscriberService del mismo `kind` con name+price del plan
   *     (ese snapshot es lo que factura el cron mensual → precio nuevo automático);
   *  2) fija el pppProfile del abonado al perfil del plan;
   *  3) empuja el perfil al router (dry-run salvo MIKROTIK_LIVE=true).
   * No reprecia facturas ya emitidas; aplica desde la siguiente facturación.
   */
  async changePlan(subscriberId: string, planId: string, user?: AuthUser) {
    const [sub, plan] = await Promise.all([
      this.prisma.subscriber.findUnique({ where: { id: subscriberId }, select: { id: true } }),
      this.prisma.plan.findUnique({ where: { id: planId } }),
    ]);
    if (!sub) throw new NotFoundException('Suscriptor no encontrado');
    if (!plan) throw new NotFoundException('Plan no encontrado');
    if (!plan.active) throw new BadRequestException('El plan está inactivo; actívalo antes de asignarlo.');

    const price = num(plan.price);
    const taxRate = num(plan.taxRate);

    // 1) Snapshot del plan en el servicio (fuente de la próxima factura).
    const existing = await this.prisma.subscriberService.findFirst({
      where: { subscriberId, kind: plan.kind }, select: { id: true },
    });
    if (existing) {
      await this.prisma.subscriberService.update({
        where: { id: existing.id },
        data: { planId: plan.id, planName: plan.name, price, taxRate, megas: plan.megas, status: 'ACTIVO' },
      });
    } else {
      await this.prisma.subscriberService.create({
        data: { subscriberId, kind: plan.kind, planId: plan.id, planName: plan.name, price, taxRate, megas: plan.megas, status: 'ACTIVO' },
      });
    }

    // 2) Perfil PPP del abonado ← perfil del plan (si lo define).
    if (plan.pppProfile) {
      await this.prisma.subscriber.update({ where: { id: subscriberId }, data: { pppProfile: plan.pppProfile } });
    }

    // 3) Empuja el perfil al router. No revienta el cambio si el router falla.
    let router = null as Awaited<ReturnType<MikrotikService['applyProfile']>> | null;
    if (plan.pppProfile) {
      router = await this.mikrotik.applyProfile(subscriberId, plan.pppProfile, user).catch((e) => ({
        ok: false, dryRun: true, action: 'PROFILE' as const, subscriberId,
        steps: [], message: `No se empujó al router: ${(e as Error).message}`, error: (e as Error).message,
      }));
    }

    return {
      ok: true,
      plan: { id: plan.id, name: plan.name, price, pppProfile: plan.pppProfile },
      router,
    };
  }

  /**
   * Cambia varios planes del abonado en una sola operación (ej. Internet + TV).
   * Cada planId toca el servicio de su propio `kind`; si llegan dos del mismo
   * kind, manda el último. Devuelve un resultado por plan aplicado.
   */
  async changePlans(subscriberId: string, planIds: string[], user?: AuthUser) {
    const uniqueIds = [...new Set(planIds.filter(Boolean))];
    if (uniqueIds.length === 0) throw new BadRequestException('Selecciona al menos un plan.');

    const plans = await this.prisma.plan.findMany({ where: { id: { in: uniqueIds } }, select: { id: true, kind: true } });
    if (plans.length !== uniqueIds.length) throw new NotFoundException('Uno o más planes no existen.');

    // Un solo plan por kind: si hay colisión, gana el último de la lista.
    const byKind = new Map<string, string>();
    for (const id of uniqueIds) {
      const p = plans.find((x) => x.id === id)!;
      byKind.set(p.kind, id);
    }

    const results: Awaited<ReturnType<SubscribersService['changePlan']>>[] = [];
    for (const id of byKind.values()) {
      results.push(await this.changePlan(subscriberId, id, user));
    }
    return { ok: true, results };
  }

  /** Crear un cliente nuevo (abonado autogenerado max+1, estado INSTALAR). */
  async create(dto: CreateSubscriberDto) {
    const data: any = buildProfileData(dto);
    if (data.abonado == null) {
      const max = await this.prisma.subscriber.aggregate({ _max: { abonado: true } });
      data.abonado = (max._max.abonado ?? 0) + 1;
    }
    data.fullName = composeName(dto.firstName, dto.secondName, dto.lastName1, dto.lastName2) ?? dto.companyName ?? null;
    data.status = 'INSTALAR' as SubscriberStatus;
    if (dto.branchId) data.branch = { connect: { id: dto.branchId } };

    const created = await this.prisma.subscriber.create({ data: data as Prisma.SubscriberCreateInput });
    return { id: created.id, abonado: created.abonado };
  }

  /** Lista de archivos adjuntos del cliente (metadata). */
  async listFiles(id: string) {
    const files = await this.prisma.subscriberFile.findMany({
      where: { subscriberId: id },
      orderBy: { createdAt: 'desc' },
    });
    return files.map((f) => ({
      id: f.id, name: f.originalName, mimeType: f.mimeType, size: f.size,
      uploadedBy: f.uploadedByName, createdAt: f.createdAt,
    }));
  }

  /** Registra la metadata de un archivo ya guardado en disco por multer. */
  async addFile(id: string, file: { originalname: string; filename: string; mimetype: string; size: number }, uploadedByName?: string) {
    const row = await this.prisma.subscriberFile.create({
      data: {
        subscriberId: id,
        originalName: Buffer.from(file.originalname, 'latin1').toString('utf8'),
        storedName: file.filename,
        mimeType: file.mimetype,
        size: file.size,
        uploadedByName: uploadedByName ?? null,
      },
    });
    return { id: row.id, name: row.originalName, mimeType: row.mimeType, size: row.size, createdAt: row.createdAt };
  }

  /** Metadata de un archivo (para descargar/servir). Valida que pertenezca al cliente. */
  async fileMeta(subscriberId: string, fileId: string) {
    const f = await this.prisma.subscriberFile.findFirst({ where: { id: fileId, subscriberId } });
    if (!f) throw new NotFoundException('Archivo no encontrado');
    return f;
  }

  /** Elimina el registro del archivo. Devuelve el nombre en disco para que el controller lo borre. */
  async deleteFile(subscriberId: string, fileId: string) {
    const f = await this.fileMeta(subscriberId, fileId);
    await this.prisma.subscriberFile.delete({ where: { id: f.id } });
    return f.storedName;
  }

  // ── Notas ─────────────────────────────────────────────────────

  async addNote(id: string, body: string, authorName?: string) {
    const exists = await this.prisma.subscriber.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('Suscriptor no encontrado');
    const n = await this.prisma.subscriberNote.create({
      data: { subscriberId: id, body: body.trim(), authorName: authorName ?? null },
    });
    return { id: n.id, body: n.body, author: n.authorName, createdAt: n.createdAt };
  }

  async deleteNote(id: string, noteId: string) {
    const n = await this.prisma.subscriberNote.findFirst({ where: { id: noteId, subscriberId: id } });
    if (!n) throw new NotFoundException('Nota no encontrada');
    await this.prisma.subscriberNote.delete({ where: { id: n.id } });
    return { ok: true };
  }

  // ── Facturas ──────────────────────────────────────────────────

  /** Todas las facturas del cliente (para la pestaña con paginación en cliente). */
  async invoices(id: string) {
    const rows = await this.prisma.subInvoice.findMany({
      where: { subscriberId: id },
      orderBy: { invoiceDate: 'desc' },
      select: INVOICE_SELECT,
    });
    return rows.map(mapInvoice);
  }

  // ── Facturas: editar / eliminar ───────────────────────────────

  /** Editar la cabecera de una factura del cliente (fecha, vencimiento, tipo, estado, notas). */
  async updateInvoice(subscriberId: string, invoiceId: string, dto: UpdateInvoiceDto) {
    const inv = await this.prisma.subInvoice.findFirst({
      where: { id: invoiceId, subscriberId }, select: { id: true },
    });
    if (!inv) throw new NotFoundException('Factura no encontrada');

    const data: Prisma.SubInvoiceUpdateInput = {};
    if (dto.invoiceDate !== undefined) data.invoiceDate = new Date(dto.invoiceDate);
    if (dto.dueDate !== undefined) data.dueDate = new Date(dto.dueDate);
    if (dto.kind !== undefined) data.kind = dto.kind as InvoiceKind;
    if (dto.ron !== undefined) data.ron = (dto.ron || null) as InvoiceRon | null;
    if (dto.notes !== undefined) data.notes = dto.notes || null;

    await this.prisma.subInvoice.update({ where: { id: inv.id }, data });
    return this.detail(subscriberId);
  }

  /**
   * Eliminar una factura. Por seguridad SOLO si no tiene movimientos de dinero
   * asociados (pagos, servicios adicionales o e-factura). Los ítems caen en cascada.
   */
  async deleteInvoice(subscriberId: string, invoiceId: string) {
    const inv = await this.prisma.subInvoice.findFirst({
      where: { id: invoiceId, subscriberId },
      select: {
        id: true, tid: true,
        _count: { select: { transactions: true, receipts: true, additionalServices: true, electronicInvoices: true } },
      },
    });
    if (!inv) throw new NotFoundException('Factura no encontrada');

    const cnt = inv._count;
    const blockers: string[] = [];
    if (cnt.transactions) blockers.push(`${cnt.transactions} pago(s)`);
    if (cnt.receipts) blockers.push(`${cnt.receipts} recibo(s)`);
    if (cnt.additionalServices) blockers.push(`${cnt.additionalServices} servicio(s) adicional(es)`);
    if (cnt.electronicInvoices) blockers.push('e-factura');
    if (blockers.length) {
      throw new BadRequestException(
        `No se puede eliminar la factura #${inv.tid}: tiene ${blockers.join(', ')} asociado(s). Anúlalos primero.`,
      );
    }

    await this.prisma.subInvoice.delete({ where: { id: inv.id } });
    return { ok: true, tid: inv.tid };
  }

  // ── Estado de cuenta ──────────────────────────────────────────

  /**
   * Ledger cronológico del cliente: cargos (facturas) y abonos (pagos vigentes),
   * con saldo acumulado. `pazysalvo = true` si no hay saldo pendiente.
   */
  async statement(id: string) {
    const s = await this.prisma.subscriber.findUnique({
      where: { id },
      select: {
        id: true, docType: true, docNumber: true, abonado: true, addressLine: true,
        firstName: true, secondName: true, lastName1: true, lastName2: true, companyName: true, fullName: true,
        branch: { select: { name: true } },
      },
    });
    if (!s) throw new NotFoundException('Suscriptor no encontrado');

    const [invoices, payments] = await Promise.all([
      this.prisma.subInvoice.findMany({
        where: { subscriberId: id },
        select: { id: true, tid: true, invoiceDate: true, total: true },
      }),
      this.prisma.transaction.findMany({
        where: { subscriberId: id, type: 'INCOME', status: 'VIGENTE' },
        select: { id: true, date: true, credit: true, method: true, invoiceId: true },
      }),
    ]);

    type Mov = { date: Date; kind: 'CARGO' | 'ABONO'; concept: string; ref: string | null; debit: number; credit: number };
    const movs: Mov[] = [];
    for (const i of invoices) movs.push({ date: i.invoiceDate, kind: 'CARGO', concept: `Factura #${i.tid}`, ref: String(i.tid), debit: num(i.total), credit: 0 });
    for (const p of payments) movs.push({ date: p.date, kind: 'ABONO', concept: `Pago${p.method ? ` (${p.method})` : ''}`, ref: null, debit: 0, credit: num(p.credit) });

    // Orden cronológico ascendente + saldo acumulado.
    movs.sort((a, b) => a.date.getTime() - b.date.getTime());
    let balance = 0;
    const rows = movs.map((m) => {
      balance += m.debit - m.credit;
      return { ...m, balance: Math.round(balance * 100) / 100 };
    });

    const totalCharges = rows.reduce((t, r) => t + r.debit, 0);
    const totalPayments = rows.reduce((t, r) => t + r.credit, 0);
    const finalBalance = Math.round((totalCharges - totalPayments) * 100) / 100;

    return {
      subscriber: {
        name: displayName(s), abonado: s.abonado, docType: s.docType, docNumber: s.docNumber,
        addressLine: s.addressLine, branch: s.branch?.name ?? null,
      },
      totalCharges, totalPayments, balance: finalBalance,
      pazysalvo: finalBalance <= 0,
      movements: rows.reverse(), // más recientes primero para la UI
    };
  }
}
