import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { scopeDate } from '../common/date-scope';
import { AuthUser } from '../auth/current-user.decorator';
import { sedesDe, whereSedePorSuscriptor, exigirSedeSuscriptor } from '../common/sede-scope';
import { paginacion } from '../common/pagination-params';

function subName(s: {
  firstName: string | null; secondName: string | null; lastName1: string | null;
  lastName2: string | null; companyName: string | null; fullName: string | null;
} | null): string | null {
  if (!s) return null;
  if (s.fullName && s.fullName.trim()) return s.fullName.trim();
  const p = [s.firstName, s.secondName, s.lastName1, s.lastName2].map((x) => (x || '').trim()).filter(Boolean).join(' ');
  return p || (s.companyName || '').trim() || null;
}
const SUB = { firstName: true, secondName: true, lastName1: true, lastName2: true, companyName: true, fullName: true, id: true, abonado: true } as const;

@Injectable()
export class SupportService {
  constructor(private readonly prisma: PrismaService) {}

  async stats() {
    const [byStatus, byType, byTech, todos] = await Promise.all([
      this.prisma.ticket.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.ticket.groupBy({ by: ['type'], _count: { _all: true }, orderBy: { _count: { type: 'desc' } }, take: 10 }),
      this.prisma.ticket.groupBy({ by: ['assigned'], _count: { _all: true }, where: { assigned: { not: null } }, orderBy: { _count: { assigned: 'desc' } }, take: 50 }),
      this.prisma.todoTask.count({ where: { status: { in: ['DUE', 'PROGRESS'] } } }),
    ]);
    const status: Record<string, number> = {};
    for (const r of byStatus) status[r.status] = r._count._all;
    return {
      total: Object.values(status).reduce((a, b) => a + b, 0),
      pendientes: (status['PENDIENTE'] ?? 0) + (status['REALIZANDO'] ?? 0),
      resueltos: status['RESUELTO'] ?? 0,
      anuladas: status['ANULADA'] ?? 0,
      status,
      topTypes: byType.map((t) => ({ type: t.type, count: t._count._all })),
      topTechs: byTech
        .filter((t) => t.assigned && t.assigned.trim())
        .map((t) => ({ tec: t.assigned as string, count: t._count._all })),
      todosPending: todos,
    };
  }

  /** Opciones para los selectores de filtro: sedes y tipos de orden (detalle). */
  async filterOptions() {
    const [sedes, byType] = await Promise.all([
      this.prisma.branch.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
      this.prisma.ticket.groupBy({ by: ['type'], orderBy: { type: 'asc' } }),
    ]);
    return { sedes, types: byType.map((t) => t.type).filter((t) => t && t.trim()) };
  }

  async tickets(params: { search?: string; status?: string; type?: string; tec?: string; priority?: string; sede?: string; from?: string; to?: string; all?: string; page?: number; pageSize?: number }, user?: AuthUser) {
    const { page, pageSize } = paginacion(params);
    const where: Prisma.TicketWhereInput = {};
    // Acceso por sede: el ticket la hereda de su suscriptor. Un ticket SIN suscriptor
    // (interno) no lo ve un usuario acotado, por el mismo criterio conservador que
    // aplica el resto del alcance.
    Object.assign(where, whereSedePorSuscriptor(await sedesDe(this.prisma, user)));
    if (params.status) where.status = params.status as any;
    if (params.type) where.type = params.type;
    if (params.priority?.trim()) where.priority = params.priority.trim();
    if (params.tec?.trim()) where.assigned = params.tec.trim() === '__none__' ? null : params.tec.trim();
    if (params.sede?.trim()) where.subscriber = { is: { branchId: params.sede.trim() } };
    // Por defecto AÑO ACTUAL (aplica también al buscar; usar all=1 para histórico).
    const period = scopeDate(params.from, params.to, params.all);
    if (period) where.created = period;
    if (params.search?.trim()) {
      const s = params.search.trim();
      const n = Number(s);
      where.OR = [
        { subject: { contains: s, mode: 'insensitive' } },
        { assigned: { contains: s, mode: 'insensitive' } },
        ...(Number.isFinite(n) ? [{ code: n }, { legacyId: n }] : []),
        { subscriber: { is: { OR: [{ firstName: { contains: s, mode: 'insensitive' as const } }, { lastName1: { contains: s, mode: 'insensitive' as const } }, ...(Number.isFinite(n) ? [{ abonado: n }] : [])] } } },
      ];
    }
    const [rows, total] = await Promise.all([
      this.prisma.ticket.findMany({ where, orderBy: { created: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: { subscriber: { select: { ...SUB, neighborhood: true, branch: { select: { name: true } } } } } }),
      this.prisma.ticket.count({ where }),
    ]);
    // Resolver barrio: subscriber.neighborhood guarda el id legacy → Neighborhood.name.
    const nbLegacyIds = [...new Set(rows.map((t) => Number(t.subscriber?.neighborhood)).filter((n) => Number.isFinite(n)))];
    const nbs = nbLegacyIds.length ? await this.prisma.neighborhood.findMany({ where: { legacyId: { in: nbLegacyIds } }, select: { legacyId: true, name: true } }) : [];
    const barrioByLegacy = new Map(nbs.map((n) => [n.legacyId, n.name]));
    const barrioOf = (nb: string | null | undefined) => {
      const n = Number(nb);
      return Number.isFinite(n) ? (barrioByLegacy.get(n) ?? null) : null;
    };
    return {
      items: rows.map((t) => ({ id: t.id, code: t.code, legacyId: t.legacyId, subject: t.subject, type: t.type, description: t.problem, priority: t.priority, created: t.created, status: t.status, assigned: t.assigned, client: subName(t.subscriber), subscriberId: t.subscriber?.id ?? null, sede: t.subscriber?.branch?.name ?? null, barrio: barrioOf(t.subscriber?.neighborhood), finalDate: t.finalDate })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  /** Resuelve el nombre del barrio a partir del id legacy guardado en subscriber.neighborhood. */
  private async resolveBarrio(neighborhood: string | null | undefined): Promise<string | null> {
    if (!neighborhood) return null;
    const n = Number(neighborhood);
    if (!Number.isFinite(n)) return null;
    const nb = await this.prisma.neighborhood.findFirst({ where: { legacyId: n }, select: { name: true } });
    return nb?.name ?? null;
  }

  async ticketDetail(id: string, user?: AuthUser) {
    const dueno = await this.prisma.ticket.findUnique({ where: { id }, select: { subscriberId: true } });
    if (dueno?.subscriberId) await exigirSedeSuscriptor(this.prisma, user, dueno.subscriberId);
    const t = await this.prisma.ticket.findUnique({
      where: { id },
      include: {
        subscriber: {
          select: {
            ...SUB, docNumber: true, phone1: true, phone2: true, addressLine: true, nomenclature: true,
            neighborhood: true, gpsLat: true, gpsLng: true, pppProfile: true, macEquipo: true,
            branch: { select: { name: true } },
          },
        },
      },
    });
    if (!t) throw new NotFoundException('Orden no encontrada');

    const sub = t.subscriber;
    const threads = t.code
      ? await this.prisma.ticketThread.findMany({ where: { ticketCode: t.code }, orderBy: { date: 'asc' } })
      : [];
    const services = sub ? await this.prisma.subscriberService.findMany({ where: { subscriberId: sub.id }, select: { kind: true, planName: true, price: true, status: true } }) : [];
    const equipment = sub ? await this.prisma.equipment.findMany({ where: { subscriberId: sub.id }, select: { code: true, mac: true, serial: true, installType: true, port: true, vlan: true, nat: true, status: true } }) : [];
    const debtRows = sub ? await this.prisma.subInvoice.findMany({ where: { subscriberId: sub.id, status: { in: ['DUE', 'PARTIAL'] } }, select: { total: true, paidAmount: true } }) : [];
    const materials = await this.prisma.ticketMaterial.findMany({ where: { ticketId: t.id }, orderBy: { createdAt: 'asc' } });
    const barrio = await this.resolveBarrio(sub?.neighborhood);

    const debt = debtRows.reduce((s, i) => s + Math.max(0, Number(i.total) - Number(i.paidAmount)), 0);
    const nomen = (sub?.nomenclature ?? null) as Record<string, unknown> | null;
    const strOf = (k: string) => (nomen && typeof nomen[k] === 'string' ? (nomen[k] as string) : null);

    return {
      id: t.id, code: t.code, subject: t.subject, type: t.type, created: t.created, finalDate: t.finalDate,
      status: t.status, priority: t.priority, problem: t.problem, section: t.section, assigned: t.assigned,
      signature: t.signatureName ? { name: t.signatureName, cc: t.signatureCc, rel: t.signatureRel, hasImage: !!t.signatureImage } : null,
      subscriber: sub
        ? {
            id: sub.id, name: subName(sub), abonado: sub.abonado, doc: sub.docNumber,
            phone: sub.phone1, phone2: sub.phone2, address: sub.addressLine,
            referencia: strOf('referencia'), residencia: strOf('residencia'),
            barrio, branch: sub.branch?.name ?? null,
            gpsLat: sub.gpsLat, gpsLng: sub.gpsLng, profile: sub.pppProfile, macEquipo: sub.macEquipo,
            debt,
            services: services.map((s) => ({ kind: s.kind, plan: s.planName, price: s.price != null ? Number(s.price) : null, status: s.status })),
          }
        : null,
      equipment: equipment.map((e) => ({ code: e.code, mac: e.mac, serial: e.serial, installType: e.installType, port: e.port, vlan: e.vlan, nat: e.nat, status: e.status })),
      materials: materials.map((m) => ({ id: m.id, name: m.materialName, qty: m.qty, price: Number(m.price), total: Number(m.price) * m.qty, warehouse: m.warehouseName, employee: m.employeeName, date: m.createdAt })),
      threads: threads.map((h) => ({ id: h.id, message: h.message, date: h.date, employeeId: h.employeeId, attach: h.attach, attachName: h.attachName, geoLat: h.geoLat, geoLng: h.geoLng })),
    };
  }

  /** Arma los datos para el PDF de la orden de servicio (acta técnica). */
  async serviceOrderPdfData(id: string) {
    const t = await this.ticketDetail(id);
    const s = t.subscriber;
    return {
      code: t.code != null ? String(t.code) : '—',
      type: t.type, subject: t.subject, status: t.status, priority: t.priority,
      created: t.created, finalDate: t.finalDate, technician: t.assigned,
      problem: t.problem, section: t.section,
      subscriber: s
        ? {
            name: s.name ?? '—', doc: s.doc, abonado: s.abonado, phone: [s.phone, s.phone2].filter(Boolean).join(' · ') || null,
            address: s.address, barrio: s.barrio, branch: s.branch,
            services: s.services?.length ? s.services.map((x) => `${x.kind}: ${x.plan ?? '—'}`).join(' · ') : null,
            debt: s.debt,
          }
        : null,
      equipment: t.equipment.map((e) => ({ mac: e.mac, installType: e.installType, port: e.port, vlan: e.vlan, nat: e.nat, serial: e.serial })),
      materials: t.materials.map((m) => ({ name: m.name, qty: m.qty, price: m.price, total: m.total })),
      threads: t.threads.map((h) => ({ message: h.message, date: h.date, hasPhoto: !!h.attach })),
      signature: t.signature,
    };
  }

  /**
   * "Mi jornada": órdenes del técnico logueado + contadores. Resuelve el Staff del
   * usuario por email (o nombre) — no hay FK User→Staff — y filtra `Ticket.assigned`
   * por `username||name`. Si no se puede resolver, cae a la cola abierta del equipo
   * para que el técnico igual vea trabajo accionable.
   */
  async myWork(user: AuthUser) {
    const staff = await this.prisma.staff.findFirst({
      where: { banned: false, OR: [{ email: { equals: user.email, mode: 'insensitive' } }, { name: { equals: user.name, mode: 'insensitive' } }] },
      select: { name: true, username: true },
    });
    const assignedKey = staff ? staff.username || staff.name : null;
    const resolved = !!assignedKey;
    const base: Prisma.TicketWhereInput = resolved ? { assigned: assignedKey } : {};

    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    const [pendiente, realizando, resueltoHoy, open] = await Promise.all([
      this.prisma.ticket.count({ where: { ...base, status: 'PENDIENTE' } }),
      this.prisma.ticket.count({ where: { ...base, status: 'REALIZANDO' } }),
      this.prisma.ticket.count({ where: { ...base, status: 'RESUELTO', finalDate: { gte: dayStart } } }),
      this.prisma.ticket.findMany({
        where: { ...base, status: { in: ['PENDIENTE', 'REALIZANDO'] } },
        orderBy: { created: 'desc' }, take: 20,
        include: { subscriber: { select: { ...SUB, addressLine: true, phone1: true, branch: { select: { name: true } } } } },
      }),
    ]);

    return {
      resolved,
      tech: staff ? { name: staff.name, username: staff.username } : null,
      counts: { pendiente, realizando, resueltoHoy },
      tickets: open.map((t) => ({
        id: t.id, code: t.code, subject: t.subject, type: t.type, status: t.status, priority: t.priority,
        created: t.created, client: subName(t.subscriber), subscriberId: t.subscriber?.id ?? null,
        address: t.subscriber?.addressLine ?? null, phone: t.subscriber?.phone1 ?? null, sede: t.subscriber?.branch?.name ?? null,
      })),
    };
  }

  /** Datos del archivo adjunto de una entrada del hilo (para descargar/previsualizar). */
  async getThreadAttachment(threadId: string) {
    const th = await this.prisma.ticketThread.findUnique({ where: { id: threadId }, select: { attach: true, attachName: true } });
    if (!th?.attach) throw new NotFoundException('Adjunto no encontrado');
    return { storedName: th.attach, originalName: th.attachName ?? th.attach };
  }

}
