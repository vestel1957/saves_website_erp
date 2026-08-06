import { BadRequestException, NotFoundException } from '../core/http/errores';
import { InvoiceKind, InvoiceRon, Prisma, SubscriberStatus, SubInvoiceStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ChangeStatusDto, CreateSubscriberDto, UpdateInvoiceDto, UpdateSubscriberDto } from './dto/update-subscriber.dto';
import { MikrotikService } from '../network/mikrotik.service';
import { MikrotikAdminService } from '../network/mikrotik-admin.service';
import { GenieacsService } from '../network/genieacs.service';
import type { AuthUser } from '../auth/current-user.decorator';
import { num } from '../common/money';
import { sedesDe, whereSedeSuscriptor, exigirSedeSuscriptor, exigirSedeDestino } from '../common/sede-scope';
import { nextTid, TID_SEQ } from '../common/tid';
import { orden, paginacion } from '../common/pagination-params';


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
  sortBy?: string; sortDir?: string; // orden pedido por la cabecera de la tabla
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
  // Datos de conectividad. El legacy los capturaba en el alta (`create.php`: name_s, contra,
  // perfil, Ipremota, tegnologia); en Nexus el DTO no los aceptaba y NADA escribía
  // `pppUsername`, así que un cliente creado aquí nunca podía aprovisionarse en el router.
  'pppUsername', 'pppPassword', 'pppProfile', 'ipRemote', 'installTech',
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

export class SubscribersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mikrotik: MikrotikService,
    private readonly mikrotikAdmin: MikrotikAdminService,
    private readonly genieacs: GenieacsService,
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

  /**
   * Los servicios que el cliente tiene contratados, sacados de su ÚLTIMA FACTURA.
   *
   * `SubscriberService` no está completo: se materializó de una sola pasada y solo
   * para los ACTIVO cuya factura casaba con el catálogo
   * (`scripts/seed-plans-from-services.js`), así que 2.350 clientes vivos se
   * quedaron sin ni una fila — los 1.266 de CARTERA en bloque, 278 de compromiso,
   * 223 activos… — y su ficha decía "sin plan" mientras el legacy sí enseñaba el
   * plan. No es que no tengan: es que aquí no se copió.
   *
   * El legacy lo lee de la factura (`invoices.combo` / `invoices.television`), que
   * aquí son `SubInvoice.serviceCombo` / `serviceTv`. Esta es la misma fuente, así
   * que lo que se ve coincide con lo que se le está cobrando.
   *
   * El precio sale del ítem de esa factura cuyo nombre casa con el plan; si no
   * casa, va sin precio antes que con uno inventado.
   */
  private async serviciosDeUltimaFactura(ids: string[]) {
    const porAbonado = new Map<string, { kind: string; planName: string; price: number | null; status: null; source: 'factura' }[]>();
    if (!ids.length) return porAbonado;

    const ultimas = await this.prisma.$queryRaw<
      { id: string; subscriberId: string; serviceCombo: string | null; serviceTv: string | null }[]
    >`
      SELECT DISTINCT ON (i."subscriberId") i.id, i."subscriberId", i."serviceCombo", i."serviceTv"
        FROM "SubInvoice" i
       WHERE i."subscriberId" IN (${Prisma.join(ids)})
       ORDER BY i."subscriberId", i."invoiceDate" DESC NULLS LAST, i.tid DESC`;
    if (!ultimas.length) return porAbonado;

    const items = await this.prisma.subInvoiceItem.findMany({
      where: { invoiceId: { in: ultimas.map((u) => u.id) } },
      select: { invoiceId: true, description: true, productName: true, price: true },
    });
    const itemsPorFactura = new Map<string, typeof items>();
    for (const it of items) {
      const arr = itemsPorFactura.get(it.invoiceId) ?? [];
      arr.push(it);
      itemsPorFactura.set(it.invoiceId, arr);
    }

    const norm = (s?: string | null) => (s ?? '').trim().toLowerCase();
    // 'no' es como el legacy escribe "este servicio no lo tiene".
    const contratado = (s?: string | null) => !!norm(s) && norm(s) !== 'no';

    for (const u of ultimas) {
      const deLaFactura = itemsPorFactura.get(u.id) ?? [];
      const precioDe = (plan: string) => {
        const it = deLaFactura.find((x) => norm(x.description) === norm(plan) || norm(x.productName) === norm(plan));
        return it && num(it.price) > 0 ? num(it.price) : null;
      };
      const lineas: { kind: string; planName: string; price: number | null; status: null; source: 'factura' }[] = [];
      if (contratado(u.serviceCombo)) {
        const plan = u.serviceCombo!.trim();
        lineas.push({ kind: 'INTERNET', planName: plan, price: precioDe(plan), status: null, source: 'factura' });
      }
      if (contratado(u.serviceTv)) {
        const plan = u.serviceTv!.trim();
        lineas.push({ kind: 'TV', planName: plan, price: precioDe(plan), status: null, source: 'factura' });
      }
      if (lineas.length) porAbonado.set(u.subscriberId, lineas);
    }
    return porAbonado;
  }

  /**
   * Tercera fuente: el PLAN QUE SE LE FACTURÓ, sacado de los ítems.
   *
   * Hay clientes cuya última factura trae los campos `combo`/`television` vacíos
   * pero cobra un ítem que se llama igual que un plan del catálogo ('100 Megas
   * F-26'). Se cruza el nombre del ítem contra `Plan`, que además dice si es
   * internet o televisión, y se toma el más reciente de cada tipo: es lo último
   * que la empresa le cobró por ese servicio.
   */
  private async serviciosDeItemsFacturados(ids: string[]) {
    const porAbonado = new Map<string, { kind: string; planName: string; price: number | null; status: null; source: 'factura' }[]>();
    if (!ids.length) return porAbonado;
    const filas = await this.prisma.$queryRaw<
      { subscriberId: string; kind: string; name: string; price: Prisma.Decimal | null }[]
    >`
      SELECT DISTINCT ON (i."subscriberId", pl.kind)
             i."subscriberId", pl.kind::text AS kind, pl.name, it.price
        FROM "SubInvoice" i
        JOIN "SubInvoiceItem" it ON it."invoiceId" = i.id
        JOIN "Plan" pl ON lower(btrim(pl.name)) = lower(btrim(COALESCE(it."productName", it.description)))
       WHERE i."subscriberId" IN (${Prisma.join(ids)})
       ORDER BY i."subscriberId", pl.kind, i."invoiceDate" DESC NULLS LAST, i.tid DESC`;
    for (const f of filas) {
      const arr = porAbonado.get(f.subscriberId) ?? [];
      arr.push({ kind: f.kind, planName: f.name, price: num(f.price) || null, status: null, source: 'factura' });
      porAbonado.set(f.subscriberId, arr);
    }
    return porAbonado;
  }

  /**
   * Último recurso: el PERFIL DEL ROUTER como plan de internet.
   *
   * `Subscriber.pppProfile` es `customers.perfil` del legacy — el perfil PPPoE con
   * el que el cliente navega ('10Megas', '300Megas'), o sea su velocidad real
   * aunque nadie le haya registrado el plan ni le haya facturado todavía. De los
   * 154 clientes vivos que no tienen ni servicio ni factura con plan, 38 sí tienen
   * un perfil de verdad; los otros traen basura de captura ('-', 'default',
   * 'Seleccione...' —y su errata 'Seleccine...') que no dice nada.
   *
   * El filtro es "tiene que llevar un número": todos los perfiles reales nombran
   * las megas ('10Megas', '1000Megas26D') y ninguna de las basuras lo hace. Es más
   * de fiar que ir listando las erratas una por una.
   */
  private servicioDePerfilPpp(pppProfile?: string | null) {
    const perfil = (pppProfile ?? '').trim();
    if (!/\d/.test(perfil)) return [];
    return [{ kind: 'INTERNET', planName: perfil, price: null, status: null, source: 'perfil' as const }];
  }

  /**
   * El plan de los clientes que no lo tienen registrado como servicio, buscándolo
   * por todas partes y en este orden: lo que dice su última factura → el plan del
   * catálogo que se le haya facturado alguna vez → el perfil con el que navega.
   *
   * Se resuelve en bloque (una consulta por fuente para toda la página) porque lo
   * usan tanto la ficha como el listado.
   */
  private async serviciosDeRespaldo(filas: { id: string; pppProfile?: string | null }[]) {
    const porAbonado = new Map<string, { kind: string; planName: string | null; price: number | null; status: string | null; source: string }[]>();
    if (!filas.length) return porAbonado;

    const deFactura = await this.serviciosDeUltimaFactura(filas.map((f) => f.id));
    for (const [id, svc] of deFactura) porAbonado.set(id, svc);

    const faltan = filas.filter((f) => !porAbonado.has(f.id));
    if (faltan.length) {
      const deItems = await this.serviciosDeItemsFacturados(faltan.map((f) => f.id));
      for (const [id, svc] of deItems) porAbonado.set(id, svc);
    }

    for (const f of filas) {
      if (porAbonado.has(f.id)) continue;
      const delPerfil = this.servicioDePerfilPpp(f.pppProfile);
      if (delPerfil.length) porAbonado.set(f.id, delPerfil);
    }
    return porAbonado;
  }

  /**
   * Columnas por las que la tabla de clientes puede pedir orden. La clave es la
   * de la columna en el frontend; lo que no esté aquí se sirve con el orden por
   * defecto (por número de abonado).
   */
  private static readonly ORDEN_LISTA = {
    abonado: 'abonado',
    // El nombre visible sale de los campos partidos del legacy (ver
    // `displayName`), así que se ordena por los mismos y en el mismo orden. Los
    // 7 registros que traen `fullName` y las razones sociales sin persona
    // quedan levemente fuera de sitio; no hay forma de ordenar un COALESCE
    // desde Prisma y por 7 filas de 21.829 no vale montar una vista.
    name: (dir: 'asc' | 'desc') => [
      { firstName: dir }, { secondName: dir }, { lastName1: dir }, { lastName2: dir },
    ],
    doc: 'docNumber',
    phone: 'phone1',
    branch: 'branch.name',
    status: 'status',
    balance: 'balance',
  };

  /** Listado paginado con búsqueda y filtros. */
  async list(params: ListFilter, user?: AuthUser) {
    // Con plan permitimos páginas más grandes (la vista de grupo carga muchos a la vez).
    const withPlan = params.withPlan === '1' || params.withPlan === 'true';
    const { page, pageSize } = paginacion(params, { maxPageSize: withPlan ? 500 : 100 });

    const where = await this.computeWhere(params, user);

    const [rows, total] = await Promise.all([
      this.prisma.subscriber.findMany({
        where,
        orderBy: orden(params, SubscribersService.ORDEN_LISTA, { abonado: 'asc' }),
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          branch: { select: { name: true } },
          ...(withPlan ? { services: { select: { kind: true, planName: true, price: true, status: true } } } : {}),
        },
      }),
      this.prisma.subscriber.count({ where }),
    ]);

    // A quien no se le copió el plan como servicio se le busca por las otras vías
    // (ver `serviciosDeRespaldo`): la lista tiene que decir qué tiene contratado.
    const respaldo = withPlan
      ? await this.serviciosDeRespaldo(rows.filter((r: any) => !r.services?.length).map((r: any) => ({ id: r.id, pppProfile: r.pppProfile })))
      : new Map();

    // Resuelve el plan de Internet y de TV para la lista.
    const planOf = (s: any, kind: 'INTERNET' | 'TV') => {
      const suyos = s.services?.length ? s.services : respaldo.get(s.id) ?? [];
      const svc = suyos.find((x: any) => x.kind === kind);
      return svc ? { plan: svc.planName ?? null, price: svc.price == null ? null : num(svc.price) } : null;
    };

    // Deuda real por cliente = Σ(total − pagado) de facturas sin pagar (NO el saldo a favor,
    // que es lo que guarda `subscriber.balance`). Se calcula siempre: la columna "Debe" de
    // los listados es la cifra que de verdad se mira, y son solo los ids de la página.
    const debtById = new Map<string, number>();
    if (rows.length) {
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
        debt: debtById.get(s.id) ?? 0,
        installTech: s.installTech,
        ...(withPlan ? { internet: planOf(s, 'INTERNET'), tv: planOf(s, 'TV') } : {}),
      })),
      total,
      page,
      pageSize,
      pages: Math.ceil(total / pageSize),
    };
  }

  /** Ficha completa de un suscriptor. */
  async detail(id: string, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, id);
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
      // Tres fuentes, de la mejor a la última: el servicio registrado, lo que dice
      // su última factura y el perfil con el que navega. Lo que enseñe el legacy
      // sale de alguna de ellas.
      services: s.services.length
        ? s.services.map((sv) => ({ kind: sv.kind, planName: sv.planName, status: sv.status, price: num(sv.price), source: 'plan' as const }))
        : (await this.serviciosDeRespaldo([{ id: s.id, pppProfile: s.pppProfile }])).get(s.id) ?? [],
      statusHistory: s.statusHistory.map((h) => ({ status: h.status, date: h.date, ticket: h.originTicketId, note: h.note })),
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

  /**
   * Catálogo de sedes para filtros y formularios, acotado a las del usuario.
   *
   * Va con el usuario porque este catálogo es lo que rellena TODO selector de sede
   * de la aplicación (filtro de clientes, filtro de facturas, alta de cliente): si
   * devolviera las 8 sedes, la cajera acotada seguiría viendo las demás en la lista
   * aunque el dato de atrás ya venga filtrado.
   */
  async branches(user?: AuthUser) {
    const sedes = await sedesDe(this.prisma, user);
    return this.prisma.branch.findMany({
      where: sedes ? { legacyId: { in: sedes } } : undefined,
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
  }

  /** WHERE compartido por la lista y por las operaciones masivas por filtro. */
  private buildListWhere(params: ListFilter): Prisma.SubscriberWhereInput {
    const where: Prisma.SubscriberWhereInput = {};
    const and: Prisma.SubscriberWhereInput[] = [];
    if (params.status) where.status = params.status as SubscriberStatus;
    if (params.branchId) where.branchId = params.branchId;

    // Servicio del cliente (según los servicios que tiene). Los tres valores son
    // excluyentes: "internet" y "tv" son solo-ese-servicio; quien tiene ambos
    // sale únicamente bajo "combo".
    if (params.servicio === 'internet') {
      and.push({ services: { some: { kind: 'INTERNET' } } });
      and.push({ services: { none: { kind: 'TV' } } });
    } else if (params.servicio === 'tv') {
      and.push({ services: { some: { kind: 'TV' } } });
      and.push({ services: { none: { kind: 'INTERNET' } } });
    } else if (params.servicio === 'combo') {
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
  private async computeWhere(params: ListFilter, user?: AuthUser): Promise<Prisma.SubscriberWhereInput> {
    const where = this.buildListWhere(params);
    // Acceso por sede. Va AQUÍ y no en cada método porque `computeWhere` es el embudo
    // único de `list`, `matchingIds` y, por tanto, de las operaciones masivas: filtrar
    // en un solo sitio evita que una masiva se salte el alcance que sí respeta el listado.
    const sede = whereSedeSuscriptor(await sedesDe(this.prisma, user));
    if (Object.keys(sede).length) Object.assign(where, sede);
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
  async matchingIds(filter: ListFilter, user?: AuthUser): Promise<string[]> {
    const rows = await this.prisma.subscriber.findMany({
      where: await this.computeWhere(filter, user),
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  private async resolveBulkIds(filter: ListFilter, user?: AuthUser): Promise<string[]> {
    // Con el usuario, para que una masiva NO pueda alcanzar sedes que el listado
    // no le deja ni ver. Sin esto, el filtro de sede sería puramente cosmético.
    const ids = await this.matchingIds(filter, user);
    if (ids.length === 0) throw new BadRequestException('No hay clientes que cumplan el filtro.');
    if (ids.length > SubscribersService.MAX_BULK) {
      throw new BadRequestException(`${ids.length} clientes exceden el máximo de ${SubscribersService.MAX_BULK} por operación. Afina el filtro (sede / estado).`);
    }
    return ids;
  }

  /**
   * Excluye del corte a los clientes con COMPROMISO de pago vigente (paridad legacy
   * `_compromiso_vencido`): un COMPROMISO solo se corta si su `promiseExpiry` ya pasó.
   * Sin fecha de promesa = protegido (mismo criterio conservador del legacy).
   */
  private async filterCuttable(ids: string[]): Promise<{ ids: string[]; protegidos: number }> {
    const rows = await this.prisma.subscriber.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, promiseExpiry: true },
    });
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const protectedIds = new Set(
      rows
        .filter((r) => r.status === 'COMPROMISO' && (!r.promiseExpiry || r.promiseExpiry >= today))
        .map((r) => r.id),
    );
    return { ids: ids.filter((id) => !protectedIds.has(id)), protegidos: protectedIds.size };
  }

  /** Corte masivo de TODOS los que cumplen el filtro (no depende de lo cargado en pantalla). */
  async cutByFilter(filter: ListFilter, user: AuthUser) {
    const all = await this.resolveBulkIds(filter, user);
    const { ids, protegidos } = await this.filterCuttable(all);
    if (ids.length === 0) {
      throw new BadRequestException('Todos los clientes del filtro tienen compromiso de pago vigente; no se cortó ninguno.');
    }
    const res = await this.mikrotik.cutBatch(ids, user);
    return { ...res, compromisosProtegidos: protegidos };
  }

  /** Reconexión masiva de TODOS los que cumplen el filtro. */
  async reconnectByFilter(filter: ListFilter, user: AuthUser) {
    const ids = await this.resolveBulkIds(filter, user);
    return this.mikrotik.reconnectBatch(ids, user);
  }

  /** Corte de TV masivo de TODOS los que cumplen el filtro (vía TR-069 u OLT por abonado). */
  async tvCutByFilter(filter: ListFilter, user: AuthUser) {
    const all = await this.resolveBulkIds(filter, user);
    // Misma regla que el corte de internet: un COMPROMISO vigente protege del corte.
    const { ids, protegidos } = await this.filterCuttable(all);
    if (ids.length === 0) {
      throw new BadRequestException('Todos los clientes del filtro tienen compromiso de pago vigente; no se cortó ninguno.');
    }
    const res = await this.genieacs.tvBatchBySubscribers(ids, false, user);
    return { ...res, compromisosProtegidos: protegidos };
  }

  /** Alta de TV masiva de TODOS los que cumplen el filtro. */
  async tvRestoreByFilter(filter: ListFilter, user: AuthUser) {
    const ids = await this.resolveBulkIds(filter, user);
    return this.genieacs.tvBatchBySubscribers(ids, true, user);
  }

  /** WhatsApp masivo a TODOS los que cumplen el filtro. */
  async messageByFilter(filter: ListFilter, message: string, user?: AuthUser) {
    const ids = await this.resolveBulkIds(filter, user);
    return this.mikrotik.messageBatch(ids, message);
  }

  /** Sedes con conteo de abonados por estado (para el flujo sede-primero de cortes masivos). */
  async branchesStats(user?: AuthUser) {
    const sedes = await sedesDe(this.prisma, user);
    const [branches, grouped] = await Promise.all([
      this.prisma.branch.findMany({
        where: sedes ? { legacyId: { in: sedes } } : undefined,
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      }),
      this.prisma.subscriber.groupBy({
        by: ['branchId', 'status'],
        where: sedes ? { branch: { legacyId: { in: sedes } } } : undefined,
        _count: { _all: true },
      }),
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

  /** Campos crudos editables (para precargar el wizard en modo edición). */
  async editForm(id: string, user?: AuthUser) {
    // Devuelve pppPassword en claro: sin este guard, un usuario acotado a la sede A
    // leía las credenciales PPPoE de un cliente de la sede B cambiando el id en la URL.
    await exigirSedeSuscriptor(this.prisma, user, id);
    const s = await this.prisma.subscriber.findUnique({
      where: { id },
      select: {
        id: true, abonado: true, firstName: true, secondName: true, lastName1: true, lastName2: true,
        companyName: true, customerType: true, docType: true, docNumber: true, email: true,
        phone1: true, phone2: true, birthDate: true, estrato: true, suscripcion: true, contractDate: true,
        departmentRef: true, cityRef: true, localityRef: true, neighborhood: true, addressLine: true,
        nomenclature: true, clausula: true, gpsLat: true, gpsLng: true, branchId: true,
        // Conectividad: sin esto el wizard mostraría los campos PPP vacíos al editar y
        // parecería que el cliente no los tiene.
        pppUsername: true, pppPassword: true, pppProfile: true, ipRemote: true, installTech: true,
      },
    });
    if (!s) throw new NotFoundException('Suscriptor no encontrado');
    return s;
  }

  /** Editar el perfil del cliente (pasos 1 y 2). Devuelve la ficha fresca. */
  async update(id: string, dto: UpdateSubscriberDto, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, id);
    // Y que no se lo lleve a una sede a la que no llega (ni lo deje sin sede).
    await exigirSedeDestino(this.prisma, user, dto.branchId);
    const s = await this.prisma.subscriber.findUnique({
      where: { id },
      select: { id: true, firstName: true, secondName: true, lastName1: true, lastName2: true, pppUsername: true },
    });
    if (!s) throw new NotFoundException('Suscriptor no encontrado');

    // Mismo guard de colisión que en `create`: el usuario PPP también se puede cambiar
    // editando, y un duplicado rompe el secret en el router. Sólo se valida si el nombre
    // CAMBIA — si no, el chequeo contra el router encontraría su propio secret y bloquearía
    // cualquier edición del cliente.
    const newPpp = dto.pppUsername?.trim();
    if (newPpp && newPpp.toLowerCase() !== (s.pppUsername ?? '').trim().toLowerCase()) {
      const { db, router } = await this.pppUsernameTaken(newPpp, dto.branchId, dto.installTech, id);
      if (db) {
        throw new BadRequestException(
          `El nombre de usuario PPP "${newPpp}" ya lo usa el abonado ${db.abonado} (${db.fullName ?? 'sin nombre'}).`,
        );
      }
      if (router === 'taken') {
        throw new BadRequestException(
          `El nombre de usuario PPP "${newPpp}" ya existe como secret en el Mikrotik de la sede.`,
        );
      }
    }

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
   * Cambio MANUAL de estado del abonado (Activo, Suspendido, Retirado, ...).
   * Es puramente administrativo: actualiza el cache de estado + historial, pero
   * NO toca el router — para cortar/reconectar de verdad está el modal de
   * Conexión (MikrotikService), que además marca CORTADO/ACTIVO por su cuenta.
   */
  async changeStatus(id: string, dto: ChangeStatusDto, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, id);
    const s = await this.prisma.subscriber.findUnique({
      where: { id }, select: { id: true, status: true },
    });
    if (!s) throw new NotFoundException('Suscriptor no encontrado');

    const next = dto.status as SubscriberStatus;
    if (s.status === next) throw new BadRequestException('El cliente ya está en ese estado.');

    // El historial no tiene columna de autor: el responsable va en la nota.
    const who = user?.name || user?.email || null;
    const extra = dto.note?.trim();
    const note = [`Cambio manual${who ? ` por ${who}` : ''}`, extra].filter(Boolean).join(': ');

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.subscriber.update({
        where: { id },
        data: { previousStatus: s.status ?? undefined, status: next, statusChangedAt: now },
      }),
      this.prisma.subscriberStatusHistory.create({
        data: { subscriberId: id, status: next, date: now, note },
      }),
    ]);
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
    await exigirSedeSuscriptor(this.prisma, user, subscriberId);
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
    await exigirSedeSuscriptor(this.prisma, user, subscriberId);
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

  /**
   * ¿El usuario PPP ya está tomado? Se consulta la BD (autoritativa) y, si se puede, el
   * router de la sede.
   *
   * El legacy (`Customers_model::validar_user_name`) consultaba SÓLO el Mikrotik y tenía el
   * `else` vacío: si el router no respondía devolvía null y el controller lo interpretaba
   * como "disponible" — fail-open en su única validación bloqueante, que es justo la causa
   * de las colisiones de secret. Aquí el router que no responde NUNCA se reporta como libre:
   * se devuelve `router: 'unreachable'` y la BD sigue mandando.
   */
  private async pppUsernameTaken(username: string, branchId?: string, installTech?: string | null, excludeId?: string) {
    const name = username.trim();
    const inDb = await this.prisma.subscriber.findFirst({
      // `excludeId`: al editar, el cliente no colisiona consigo mismo.
      where: { pppUsername: { equals: name, mode: 'insensitive' }, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true, abonado: true, fullName: true },
    });

    let router: 'free' | 'taken' | 'unreachable' | 'unknown' = 'unknown';
    if (branchId) {
      try {
        const branch = await this.prisma.branch.findUnique({ where: { id: branchId }, select: { legacyId: true } });
        if (branch) {
          const mk = await this.mikrotik.resolveRouter({
            id: '', legacyId: null, pppUsername: null, ipRemote: null,
            installTech: installTech ?? null, status: null, branch: { legacyId: branch.legacyId },
          } as any);
          const res = await this.mikrotikAdmin.secrets(mk.id, { search: name, pageSize: 200 });
          if (!res.ok) router = 'unreachable';
          else router = res.items.some((s: { name: string }) => s.name.toLowerCase() === name.toLowerCase()) ? 'taken' : 'free';
        }
      } catch {
        // Sin router para la sede / sede sin resolver: no podemos afirmar nada.
        router = 'unreachable';
      }
    }
    return { db: inDb, router };
  }

  /**
   * Chequeos de duplicados del alta, para que la pantalla avise antes de guardar.
   *
   * Paridad legacy: documento y dirección son ADVERTENCIA, no bloqueo. Las cédulas
   * repetidas son INTENCIONALES en este negocio — el flujo de facturación electrónica las
   * mapea a sucursales de Siigo (`sucursal_siigo` / `branch_office`), así que bloquearlas
   * rompería la emisión. El usuario PPP sí bloquea (ver `pppUsernameTaken`).
   */
  async checkDuplicates(dto: {
    docNumber?: string; branchId?: string; pppUsername?: string; installTech?: string;
    departmentRef?: string; cityRef?: string; localityRef?: string; neighborhood?: string; addressLine?: string;
  }) {
    const out: any = { document: null, address: null, pppUsername: null };

    if (dto.docNumber?.trim()) {
      const items = await this.prisma.subscriber.findMany({
        where: { docNumber: dto.docNumber.trim() },
        select: { id: true, abonado: true, fullName: true, status: true },
        take: 20,
      });
      out.document = {
        count: items.length, items, blocking: false,
        message: items.length
          ? `Ya existen ${items.length} cliente(s) con este documento. Se permite continuar: el mismo titular puede tener varias cuentas.`
          : null,
      };
    }

    // Dirección: igualdad exacta de los componentes, como el legacy.
    if (dto.addressLine?.trim() || dto.neighborhood) {
      const count = await this.prisma.subscriber.count({
        where: {
          departmentRef: dto.departmentRef ?? undefined,
          cityRef: dto.cityRef ?? undefined,
          localityRef: dto.localityRef ?? undefined,
          neighborhood: dto.neighborhood ?? undefined,
          addressLine: dto.addressLine?.trim() ?? undefined,
        },
      });
      out.address = {
        count, blocking: false,
        message: count ? `Ya hay ${count} cliente(s) registrado(s) en esta misma dirección.` : null,
      };
    }

    if (dto.pppUsername?.trim()) {
      const { db, router } = await this.pppUsernameTaken(dto.pppUsername, dto.branchId, dto.installTech);
      const taken = !!db || router === 'taken';
      out.pppUsername = {
        taken, blocking: true, router,
        message: db
          ? `Este nombre de usuario ya lo usa el abonado ${db.abonado} (${db.fullName ?? 'sin nombre'}).`
          : router === 'taken'
            ? 'Este nombre de usuario ya existe como secret en el Mikrotik de la sede.'
            : router === 'unreachable'
              ? 'Disponible en la base de datos, pero NO se pudo verificar contra el Mikrotik (router sin responder).'
              : 'Disponible.',
      };
    }
    return out;
  }

  /** Crear un cliente nuevo (abonado autogenerado max+1, estado INSTALAR). */
  async create(dto: CreateSubscriberDto, user?: AuthUser) {
    // Un usuario acotado sólo da de alta en SUS sedes (y tiene que indicar una).
    await exigirSedeDestino(this.prisma, user, dto.branchId ?? null);
    // Guard de colisión de secret PPP. El legacy NO tenía validación de servidor en el alta
    // (`Customers::addcustomer` insertaba directo); la única comprobación vivía en el JS de
    // la vista y se saltaba con un POST directo. Documento y dirección siguen SIN bloquear
    // (ver `checkDuplicates`).
    if (dto.pppUsername?.trim()) {
      const { db, router } = await this.pppUsernameTaken(dto.pppUsername, dto.branchId, dto.installTech);
      if (db) {
        throw new BadRequestException(
          `El nombre de usuario PPP "${dto.pppUsername.trim()}" ya lo usa el abonado ${db.abonado} (${db.fullName ?? 'sin nombre'}).`,
        );
      }
      if (router === 'taken') {
        throw new BadRequestException(
          `El nombre de usuario PPP "${dto.pppUsername.trim()}" ya existe como secret en el Mikrotik de la sede.`,
        );
      }
    }

    const data: any = buildProfileData(dto);
    if (data.abonado == null) {
      // Secuencia de Postgres, no MAX+1: dos altas simultáneas obtenían el mismo
      // número y, al no haber restricción única en la columna, se duplicaba sin ruido.
      data.abonado = await nextTid(this.prisma, TID_SEQ.subscriberAbonado);
    }
    data.fullName = composeName(dto.firstName, dto.secondName, dto.lastName1, dto.lastName2) ?? dto.companyName ?? null;
    data.status = 'INSTALAR' as SubscriberStatus;
    if (dto.branchId) data.branch = { connect: { id: dto.branchId } };

    const created = await this.prisma.subscriber.create({ data: data as Prisma.SubscriberCreateInput });
    return { id: created.id, abonado: created.abonado };
  }


  // ── Facturas ──────────────────────────────────────────────────

  /** Todas las facturas del cliente (para la pestaña con paginación en cliente). */
  async invoices(id: string, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, id);
    const rows = await this.prisma.subInvoice.findMany({
      where: { subscriberId: id },
      orderBy: { invoiceDate: 'desc' },
      select: INVOICE_SELECT,
    });
    return rows.map(mapInvoice);
  }

  // ── Facturas: editar / eliminar ───────────────────────────────

  /** Editar la cabecera de una factura del cliente (fecha, vencimiento, tipo, estado, notas). */
  async updateInvoice(subscriberId: string, invoiceId: string, dto: UpdateInvoiceDto, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, subscriberId);
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
  async deleteInvoice(subscriberId: string, invoiceId: string, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, subscriberId);
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
  async statement(id: string, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, id);
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
