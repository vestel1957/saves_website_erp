import { BadRequestException, NotFoundException } from '../core/http/errores';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { AGREEMENT_DETAIL, CreateCallDto } from './dto/collections.dto';

const dateOnly = (s?: string) => {
  const d = s ? new Date(s) : new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};
const today = () => dateOnly();
const iso = (d?: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

type SubSel = { fullName: string | null; docNumber: string | null; phone1: string | null; abonado: number; status: string | null; promiseExpiry: Date | null };
const subName = (s?: { fullName: string | null } | null) => s?.fullName?.trim() || '—';

export interface AgreementFilter {
  responsible?: string;
  mine?: boolean;
  userName?: string;
  callType?: string;
  search?: string;
  state?: string; // 'vigente' | 'vencido'
  from?: string;
  to?: string;
  dueFrom?: string;
  dueTo?: string;
  page?: number;
  pageSize?: number;
}

export class CollectionsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Registra una llamada. Si es Acuerdo de Pago, fija el compromiso en el cliente
   *  (status COMPROMISO + promiseExpiry) → protege del corte masivo (ver cutByFilter). */
  async create(dto: CreateCallDto, user?: AuthUser) {
    const sub = await this.prisma.subscriber.findUnique({ where: { id: dto.subscriberId }, select: { id: true } });
    if (!sub) throw new NotFoundException('Cliente no encontrado');
    const isAgreement = dto.responseDetail === AGREEMENT_DETAIL;
    if (isAgreement && !dto.dueDate) throw new BadRequestException('Un acuerdo de pago requiere una fecha de compromiso.');
    const date = dateOnly(dto.date);
    const due = isAgreement ? dateOnly(dto.dueDate) : null;
    return this.prisma.$transaction(async (tx) => {
      const call = await tx.callLog.create({
        data: {
          subscriberId: sub.id, callType: dto.callType ?? null, responseType: dto.responseType ?? null,
          responseDetail: dto.responseDetail, responsible: user?.name ?? null,
          date, time: dto.time ?? null, dueDate: due, notes: dto.notes ?? null,
        },
      });
      if (isAgreement) {
        await tx.subscriber.update({ where: { id: sub.id }, data: { status: 'COMPROMISO', statusChangedAt: new Date(), promiseExpiry: due } });
        await tx.subscriberStatusHistory.create({
          data: { subscriberId: sub.id, status: 'COMPROMISO', date: new Date(), note: `Acuerdo de pago hasta ${iso(due)}${dto.notes ? ` — ${dto.notes}` : ''}` },
        });
      }
      return { id: call.id, agreement: isAgreement, promiseExpiry: iso(due) };
    });
  }

  /** Bitácora de llamadas de un cliente. */
  async listBySubscriber(subscriberId: string) {
    const rows = await this.prisma.callLog.findMany({
      where: { subscriberId },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map((c) => ({
      id: c.id, callType: c.callType, responseType: c.responseType, responseDetail: c.responseDetail,
      responsible: c.responsible, date: iso(c.date), time: c.time, dueDate: iso(c.dueDate), notes: c.notes,
      isAgreement: c.responseDetail === AGREEMENT_DETAIL,
    }));
  }

  async remove(id: string) {
    const c = await this.prisma.callLog.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Registro no encontrado');
    await this.prisma.callLog.delete({ where: { id } });
    return { id, deleted: true };
  }

  /** Catálogo de tipos de respuesta usados (para autocompletar). */
  async responseTypes() {
    const rows = await this.prisma.callLog.groupBy({ by: ['responseType'], _count: { _all: true } });
    return rows.filter((r) => r.responseType && r.responseType.trim()).map((r) => r.responseType as string).sort();
  }

  private agreementWhere(p: AgreementFilter): Prisma.CallLogWhereInput {
    const where: Prisma.CallLogWhereInput = { responseDetail: AGREEMENT_DETAIL };
    const responsible = p.mine && p.userName ? p.userName : p.responsible;
    if (responsible) where.responsible = responsible;
    if (p.callType) where.callType = p.callType;
    if (p.from || p.to) {
      where.date = {};
      if (p.from) where.date.gte = dateOnly(p.from);
      if (p.to) where.date.lte = dateOnly(p.to);
    }
    const dueRange: Prisma.DateTimeNullableFilter = {};
    if (p.dueFrom) dueRange.gte = dateOnly(p.dueFrom);
    if (p.dueTo) dueRange.lte = dateOnly(p.dueTo);
    // Vigente: compromiso aún no vencido; Vencido: ya pasó.
    if (p.state === 'vigente') dueRange.gte = today();
    else if (p.state === 'vencido') dueRange.lt = today();
    if (Object.keys(dueRange).length) where.dueDate = dueRange;
    const search = (p.search || '').trim();
    if (search) {
      where.subscriber = { is: { OR: [
        { fullName: { contains: search, mode: 'insensitive' } },
        { docNumber: { contains: search } },
      ] } };
    }
    return where;
  }

  private readonly subSelect = { fullName: true, docNumber: true, phone1: true, abonado: true, status: true, promiseExpiry: true } as const;

  private mapAgreement(c: { id: string; callType: string | null; responsible: string | null; date: Date; time: string | null; dueDate: Date | null; notes: string | null; subscriberId: string; subscriber: SubSel | null }) {
    const due = c.dueDate;
    const vencido = !!due && due < today();
    return {
      id: c.id, subscriberId: c.subscriberId, cliente: subName(c.subscriber), documento: c.subscriber?.docNumber ?? null,
      abonado: c.subscriber?.abonado ?? null, telefono: c.subscriber?.phone1 ?? null, estadoCliente: c.subscriber?.status ?? null,
      callType: c.callType, responsible: c.responsible, date: iso(c.date), time: c.time, dueDate: iso(due),
      vencido, notes: c.notes,
    };
  }

  /** Listado paginado de acuerdos de pago con filtros (legacy list_compromisos). */
  async agreements(p: AgreementFilter) {
    const page = Math.max(1, Number(p.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(p.pageSize) || 25));
    const where = this.agreementWhere(p);
    const [rows, total] = await Promise.all([
      this.prisma.callLog.findMany({ where, orderBy: [{ dueDate: 'asc' }, { date: 'desc' }], skip: (page - 1) * pageSize, take: pageSize, include: { subscriber: { select: this.subSelect } } }),
      this.prisma.callLog.count({ where }),
    ]);
    return { items: rows.map((c) => this.mapAgreement(c)), total, page, pageSize, pages: Math.ceil(total / pageSize) };
  }

  /** Todas las filas para exportar (legacy explortar_acuerdos). */
  async agreementRows(p: AgreementFilter) {
    const where = this.agreementWhere(p);
    const rows = await this.prisma.callLog.findMany({ where, orderBy: [{ dueDate: 'asc' }, { date: 'desc' }], include: { subscriber: { select: this.subSelect } } });
    return rows.map((c) => this.mapAgreement(c));
  }
}
