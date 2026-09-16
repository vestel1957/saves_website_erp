import { BadRequestException, ForbiddenException, NotFoundException } from '../core/http/errores';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { AGREEMENT_DETAIL, CreateCallDto, CreateNoteRequestDto, ResolveNoteRequestDto } from './dto/collections.dto';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';
import { puedeEmitirNotas } from '../billing/emisor-de-notas';
import type { NotificationsService } from '../common/notifications/notifications.service';
import {
  DETALLES_POR_RESPUESTA, RESPUESTAS_POR_TIPO, TIPOS_ATENCION, VENTA,
  esAcuerdo, esSolicitudDescuento, motivoInvalido, normalizarDetalle,
} from './llamada-catalogo';
import type { ResponsibilityNotifierService } from '../responsibilities/responsibility-notifier.service';

const dateOnly = (s?: string) => {
  const d = s ? new Date(s) : new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};
const today = () => dateOnly();
const iso = (d?: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

type SubSel = { fullName: string | null; docNumber: string | null; phone1: string | null; abonado: number; status: string | null; promiseExpiry: Date | null };
const subName = (s?: { fullName: string | null } | null) => s?.fullName?.trim() || '—';

const AVISO_SOLICITUD_NOTA = 'facturacion.solicitud_nota';
const pesos = (n: number) => `$${n.toLocaleString('es-CO', { maximumFractionDigits: 2 })}`;

type SolicitudConAsignado = Prisma.NoteRequestGetPayload<{ include: { assignedTo: { select: { id: true; name: true } } } }>;
const filaSolicitud = (r: SolicitudConAsignado) => ({
  id: r.id,
  type: r.type,
  amount: r.amount == null ? null : Number(r.amount),
  reason: r.reason,
  status: r.status,
  requestedByName: r.requestedByName,
  assignedTo: { id: r.assignedTo.id, name: r.assignedTo.name },
  response: r.response,
  resolvedByName: r.resolvedByName,
  resolvedAt: r.resolvedAt,
  createdAt: r.createdAt,
});

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
  constructor(
    private readonly prisma: PrismaService,
    /** Opcional a propósito: sin él la llamada se registra igual, sólo no avisa. */
    private readonly porCargo?: ResponsibilityNotifierService,
    /** La campanita de quien recibe una solicitud de nota. Opcional por lo mismo. */
    private readonly avisos?: NotificationsService,
  ) {}

  /**
   * Lo que necesita el formulario para dibujar los tres desplegables encadenados,
   * igual que el legacy: la cascada y —para "Venta Contestada"— los planes de
   * internet vivos, que allá salían de `paquetes('inter')`.
   */
  async catalog() {
    const planes = await this.prisma.plan.findMany({
      where: { active: true, kind: 'INTERNET' },
      orderBy: { name: 'asc' },
      select: { name: true },
    });
    return {
      tipos: TIPOS_ATENCION,
      respuestasPorTipo: RESPUESTAS_POR_TIPO,
      detallesPorRespuesta: DETALLES_POR_RESPUESTA,
      venta: { ...VENTA, planesInternet: planes.map((p) => p.name) },
      acuerdo: AGREEMENT_DETAIL,
    };
  }

  /** Registra una llamada. Si es Acuerdo de Pago, fija el compromiso en el cliente
   *  (status COMPROMISO + promiseExpiry) → protege del corte masivo (ver cutByFilter). */
  // ── Solicitudes de nota crédito/débito ─────────────────────────────────────
  //
  // Emitir la nota es nominal (`billing.notes.emit`): quien atiende la llamada no
  // puede, así que la pide desde la pestaña Cobranza y se la asigna a una de las
  // personas autorizadas. Pedirla no mueve un peso de cartera.

  /**
   * A quién se le puede asignar: las personas que HOY pueden emitir la nota. Sale
   * del permiso y no de una lista escrita aquí, para que conceder o quitar el
   * permiso con `scripts/autorizar-emisor-notas.ts` mueva también este desplegable.
   * Sin atajo de superusuario, igual que `exigirEmisorDeNotas`.
   */
  async emisoresDeNotas() {
    const clave = APP_PERMISSIONS.BILLING_NOTES_EMIT;
    const filas = await this.prisma.user.findMany({
      where: {
        isActive: true,
        OR: [
          { permissionOverrides: { some: { effect: 'ALLOW', permission: { key: clave } } } },
          { roles: { some: { role: { permissions: { some: { permission: { key: clave } } } } } } },
        ],
        NOT: { permissionOverrides: { some: { effect: 'DENY', permission: { key: clave } } } },
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, email: true },
    });
    return filas.map((u) => ({ id: u.id, name: u.name?.trim() || u.email }));
  }

  /** Las solicitudes del cliente, abiertas primero. Trae el cliente para rellenar la nota. */
  async solicitudesNota(subscriberId: string) {
    const [sub, filas] = await Promise.all([
      this.prisma.subscriber.findUnique({ where: { id: subscriberId }, select: { id: true, fullName: true, abonado: true } }),
      this.prisma.noteRequest.findMany({
        where: { subscriberId },
        orderBy: { createdAt: 'desc' },
        include: { assignedTo: { select: { id: true, name: true } } },
      }),
    ]);
    if (!sub) throw new NotFoundException('Cliente no encontrado');
    const items = filas.map(filaSolicitud);
    items.sort((a, b) => Number(b.status === 'PENDIENTE') - Number(a.status === 'PENDIENTE'));
    return { cliente: { id: sub.id, name: subName(sub), abonado: sub.abonado }, items };
  }

  async solicitarNota(dto: CreateNoteRequestDto, user: AuthUser) {
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: dto.subscriberId },
      select: { id: true, fullName: true, abonado: true },
    });
    if (!sub) throw new NotFoundException('Cliente no encontrado');
    const reason = dto.reason.trim();
    if (reason.length < 5) throw new BadRequestException('Escribe el motivo: por qué se pide la nota.');
    // Se valida contra la lista viva y no sólo en el desplegable: asignarla a quien
    // no puede emitirla la dejaría muerta en su campanita.
    const destino = (await this.emisoresDeNotas()).find((e) => e.id === dto.assignedToId);
    if (!destino) throw new BadRequestException('La persona elegida no está autorizada para emitir notas crédito/débito.');
    const monto = dto.amount && dto.amount > 0 ? Math.round(dto.amount * 100) / 100 : null;

    const creada = await this.prisma.noteRequest.create({
      data: {
        subscriberId: sub.id, type: dto.type, amount: monto, reason,
        requestedById: user.id, requestedByName: user.name, assignedToId: destino.id,
      },
      include: { assignedTo: { select: { id: true, name: true } } },
    });

    const tipo = dto.type === 'CREDITO' ? 'crédito' : 'débito';
    await this.avisos?.notify([destino.id], {
      kind: AVISO_SOLICITUD_NOTA,
      title: `Solicitud de nota ${tipo} · ${subName(sub)}`,
      body: `${user.name} te pide una nota ${tipo}${monto ? ` por ${pesos(monto)}` : ''} para el abonado ${sub.abonado}: ${reason}`,
      link: `/clientes/${sub.id}?tab=cobranza`,
      groupKey: `solicitud-nota:${creada.id}`,
    });
    return filaSolicitud(creada);
  }

  /**
   * Cerrarla: la nota se aplicó, o no procede. La cierra la persona asignada o
   * cualquiera que pueda emitir notas (si Johana se incapacita, Luis la toma).
   */
  async resolverSolicitudNota(id: string, dto: ResolveNoteRequestDto, user: AuthUser) {
    const sol = await this.prisma.noteRequest.findUnique({
      where: { id },
      include: { subscriber: { select: { id: true, fullName: true, abonado: true } } },
    });
    if (!sol) throw new NotFoundException('Solicitud no encontrada');
    if (sol.status !== 'PENDIENTE') throw new BadRequestException('Esta solicitud ya se cerró.');
    if (sol.assignedToId !== user.id && !puedeEmitirNotas(user)) {
      throw new ForbiddenException('Sólo la persona asignada, o alguien autorizado para emitir notas, puede cerrar esta solicitud.');
    }
    const response = dto.response?.trim() || null;
    if (dto.status === 'RECHAZADA' && (!response || response.length < 5)) {
      throw new BadRequestException('Escribe por qué no procede la nota.');
    }

    const cerrada = await this.prisma.noteRequest.update({
      where: { id },
      data: { status: dto.status, response, resolvedByName: user.name, resolvedAt: new Date() },
      include: { assignedTo: { select: { id: true, name: true } } },
    });

    // Ya no hay nada que hacer: el aviso sale de la campanita del asignado…
    await this.avisos?.retirar(`solicitud-nota:${id}`, AVISO_SOLICITUD_NOTA);
    // …y quien la pidió se entera, porque es quien le responde al cliente.
    if (sol.requestedById && sol.requestedById !== user.id) {
      const tipo = sol.type === 'CREDITO' ? 'crédito' : 'débito';
      await this.avisos?.notify([sol.requestedById], {
        kind: 'cobranza.solicitud_nota_cerrada',
        title: `Nota ${tipo} ${dto.status === 'APLICADA' ? 'aplicada' : 'rechazada'} · ${subName(sol.subscriber)}`,
        body: `${user.name}${response ? `: ${response}` : ''}`,
        link: `/clientes/${sol.subscriberId}?tab=cobranza`,
        groupKey: `solicitud-nota-cerrada:${id}`,
      });
    }
    return filaSolicitud(cerrada);
  }

  async create(dto: CreateCallDto, user?: AuthUser) {
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: dto.subscriberId },
      // `branch` para dirigir el aviso de descuento a cartera DE SU SEDE, que es
      // como lo repartía el legacy (`asignaciones.detalle = 'descuentos'`, una
      // persona por sede) y no a las 17 que tienen el permiso.
      select: { id: true, fullName: true, docNumber: true, abonado: true, branch: { select: { legacyId: true } } },
    });
    if (!sub) throw new NotFoundException('Cliente no encontrado');
    // La cascada del legacy se hace cumplir aquí y no sólo en el desplegable: es
    // lo que mantiene comparables las 110.426 llamadas históricas.
    const motivo = motivoInvalido(dto.callType, dto.responseType, dto.responseDetail);
    if (motivo) throw new BadRequestException(motivo);
    const responseDetail = normalizarDetalle(dto.responseDetail);
    const isAgreement = esAcuerdo(responseDetail);
    if (isAgreement && !dto.dueDate) throw new BadRequestException('Un acuerdo de pago requiere una fecha de compromiso.');
    const date = dateOnly(dto.date);
    const due = isAgreement ? dateOnly(dto.dueDate) : null;
    const creada = await this.prisma.$transaction(async (tx) => {
      const call = await tx.callLog.create({
        data: {
          subscriberId: sub.id, callType: dto.callType ?? null, responseType: dto.responseType ?? null,
          responseDetail, responsible: user?.name ?? null,
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
    // Pedir descuento no lo concede: en el legacy abría una tarea para que alguien
    // lo revisara, y aquí es el aviso al encargado de cartera. Fuera de la
    // transacción y sin await encadenado al resultado: avisar no puede tumbar el
    // registro de la llamada.
    if (esSolicitudDescuento(responseDetail)) await this.avisarDescuento(sub, dto.notes);
    return creada;
  }

  /** Avisa a cartera que un cliente pidió descuento (legacy: tarea 'descuentos'). */
  private async avisarDescuento(
    sub: { id: string; fullName: string | null; docNumber: string | null; abonado: number; branch?: { legacyId: number | null } | null },
    notas?: string | null,
  ) {
    if (!this.porCargo) return;
    const quien = sub.fullName?.trim() || `Abonado ${sub.abonado}`;
    await this.porCargo.notifyPost('cartera', {
      kind: 'cobranza.solicitud_descuento',
      title: `${quien} solicitó un descuento`,
      body: `Documento ${sub.docNumber ?? '—'} · abonado ${sub.abonado}${notas ? ` — ${notas}` : ''}`,
      link: `/clientes/${sub.id}`,
      groupKey: `descuento:${sub.id}`,
      sede: sub.branch?.legacyId ?? null,
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
      isAgreement: esAcuerdo(c.responseDetail),
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
    // Sin distinguir mayúsculas: el legacy escribió 114 acuerdos como
    // 'Acuerdo de pago' y son los mismos que los 3.577 'Acuerdo de Pago'.
    const where: Prisma.CallLogWhereInput = { responseDetail: { equals: AGREEMENT_DETAIL, mode: 'insensitive' } };
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
