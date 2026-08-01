import { Injectable, NotFoundException } from '@nestjs/common';
import { orden } from '../common/pagination-params';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { scopeDate } from '../common/date-scope';
import { SiigoClient } from './siigo-client';
import { UpdateSiigoAccountDto } from './dto/einvoice.dto';

function subName(s: { firstName: string | null; lastName1: string | null; companyName: string | null; fullName: string | null } | null): string {
  if (!s) return '—';
  return (s.fullName?.trim()) || [s.firstName, s.lastName1].filter(Boolean).join(' ').trim() || s.companyName || '—';
}
const SUB = { firstName: true, lastName1: true, companyName: true, fullName: true, id: true, abonado: true } as const;

@Injectable()
export class EinvoiceService {
  constructor(private readonly prisma: PrismaService) {}

  async stats() {
    const [total, byType, conDian, byServices, pendientes] = await Promise.all([
      this.prisma.electronicInvoice.count(),
      this.prisma.electronicInvoice.groupBy({ by: ['type'], _count: { _all: true } }),
      this.prisma.electronicInvoice.count({ where: { dianNumber: { not: null } } }),
      this.prisma.electronicInvoice.groupBy({ by: ['servicesBilled'], _count: { _all: true }, orderBy: { _count: { servicesBilled: 'desc' } }, take: 6 }),
      // Pendientes REALES por timbrar: facturas marcadas para e-factura que aún no se crearon.
      // (No confundir con "sin N° DIAN": las históricas migradas nunca guardaron el CUFE.)
      this.prisma.subInvoice.count({ where: { eInvoiceFlag: 'Crear Factura Electronica' } }),
    ]);
    const tipos: Record<string, number> = {};
    for (const r of byType) tipos[r.type] = r._count._all;
    return {
      total, conDian, sinDian: total - conDian, pendientes, tipos,
      porServicio: byServices.map((s) => ({ servicio: s.servicesBilled ?? '—', count: s._count._all })),
    };
  }

  /** Columnas ordenables de la tabla de facturas electrónicas. */
  private static readonly ORDEN_LISTA = {
    date: 'date', type: 'type', dian: 'dianNumber', fact: 'invoice.tid',
    serv: 'servicesBilled',
    error: 'errorMessage',
    client: (dir: 'asc' | 'desc') => [
      { subscriber: { firstName: dir } }, { subscriber: { lastName1: dir } },
    ],
  };

  async list(params: { search?: string; type?: string; from?: string; to?: string; all?: string; page?: number; pageSize?: number; sortBy?: string; sortDir?: string }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
    const where: Prisma.ElectronicInvoiceWhereInput = {};
    if (params.type) where.type = params.type as any;
    const search = (params.search || '').trim();
    if (search) {
      where.OR = [
        { dianNumber: { contains: search } },
        { subscriber: { is: { OR: [{ firstName: { contains: search, mode: 'insensitive' } }, { lastName1: { contains: search, mode: 'insensitive' } }, { companyName: { contains: search, mode: 'insensitive' } }] } } },
      ];
    } else {
      const period = scopeDate(params.from, params.to, params.all);
      if (period) where.date = period;
    }
    const [rows, total] = await Promise.all([
      this.prisma.electronicInvoice.findMany({
        where, orderBy: orden(params, EinvoiceService.ORDEN_LISTA, { date: 'desc' }), skip: (page - 1) * pageSize, take: pageSize,
        include: { subscriber: { select: SUB }, invoice: { select: { tid: true } } },
      }),
      this.prisma.electronicInvoice.count({ where }),
    ]);
    return {
      items: rows.map((e) => ({
        id: e.id, date: e.date, type: e.type, services: e.servicesBilled,
        client: subName(e.subscriber), subscriberId: e.subscriber?.id ?? null, abonado: e.subscriber?.abonado ?? null,
        invoiceTid: e.invoice?.tid ?? null, dianNumber: e.dianNumber, cufe: e.cufe, hasPdf: !!e.pdfUrl,
        payMethod: e.payMethod, error: e.errorMessage,
      })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
      periodo: params.all ? 'Histórico' : params.from || params.to ? 'Rango' : 'Año actual',
    };
  }

  /** Sedes con conteo de clientes y de marcados para e-factura (TV / Internet). */
  async branches() {
    const rows = await this.prisma.$queryRaw<
      { id: string; name: string; subs: number; tv: number; internet: number }[]
    >`
      SELECT b.id, b.name,
        count(s.id)::int AS subs,
        count(s.id) FILTER (WHERE s."eInvoiceTv")::int AS tv,
        count(s.id) FILTER (WHERE s."eInvoiceInternet")::int AS internet
      FROM "Branch" b
      LEFT JOIN "Subscriber" s ON s."branchId" = b.id
      GROUP BY b.id, b.name
      ORDER BY subs DESC`;
    return rows.map((r) => ({
      id: r.id, name: r.name,
      subscribers: Number(r.subs), tv: Number(r.tv), internet: Number(r.internet),
    }));
  }

  /** Clientes de una sede con sus flags de e-factura (TV/Internet) y plan. */
  async branchSubscribers(branchId: string, params: { search?: string; page?: number; pageSize?: number; sort?: string; dir?: string }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(params.pageSize) || 50));
    const where: Prisma.SubscriberWhereInput = { branchId };
    const search = (params.search || '').trim();
    if (search) {
      const asNum = Number(search);
      where.OR = [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName1: { contains: search, mode: 'insensitive' } },
        { companyName: { contains: search, mode: 'insensitive' } },
        { docNumber: { contains: search } },
        ...(Number.isFinite(asNum) ? [{ abonado: asNum }] : []),
      ];
    }
    const dir: Prisma.SortOrder = params.dir === 'desc' ? 'desc' : 'asc';
    const orderBy: Prisma.SubscriberOrderByWithRelationInput[] =
      params.sort === 'abonado' ? [{ abonado: dir }]
      : params.sort === 'status' ? [{ status: dir }, { firstName: 'asc' }]
      : params.sort === 'tv' ? [{ eInvoiceTv: dir }, { firstName: 'asc' }]
      : params.sort === 'internet' ? [{ eInvoiceInternet: dir }, { firstName: 'asc' }]
      : params.sort === 'name' ? [{ firstName: dir }, { lastName1: dir }]
      : [{ firstName: 'asc' }, { abonado: 'asc' }];
    const [rows, total] = await Promise.all([
      this.prisma.subscriber.findMany({
        where, orderBy,
        skip: (page - 1) * pageSize, take: pageSize,
        select: {
          id: true, abonado: true, firstName: true, lastName1: true, companyName: true, fullName: true,
          docType: true, docNumber: true, status: true, eInvoiceTv: true, eInvoiceInternet: true,
          services: { where: { kind: { in: ['TV', 'INTERNET'] } }, select: { kind: true, planName: true } },
        },
      }),
      this.prisma.subscriber.count({ where }),
    ]);
    return {
      items: rows.map((s) => ({
        id: s.id, abonado: s.abonado, name: subName(s),
        docType: s.docType, docNumber: s.docNumber, status: s.status,
        eInvoiceTv: s.eInvoiceTv, eInvoiceInternet: s.eInvoiceInternet,
        tvPlan: s.services.find((x) => x.kind === 'TV')?.planName ?? null,
        internetPlan: s.services.find((x) => x.kind === 'INTERNET')?.planName ?? null,
      })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  /** Marca qué facturar electrónicamente (TV/Internet) de un cliente; persiste los flags. */
  async setEflags(subscriberId: string, dto: { tv?: boolean; internet?: boolean }) {
    const sub = await this.prisma.subscriber.findUnique({
      where: { id: subscriberId },
      select: { eInvoiceTv: true, eInvoiceInternet: true, eInvoicePuntos: true },
    });
    if (!sub) throw new NotFoundException('Cliente no encontrado');
    const tv = dto.tv ?? sub.eInvoiceTv;
    const internet = dto.internet ?? sub.eInvoiceInternet;
    await this.prisma.subscriber.update({
      where: { id: subscriberId },
      data: { eInvoiceTv: tv, eInvoiceInternet: internet, eInvoice: tv || internet || sub.eInvoicePuntos },
    });
    return { id: subscriberId, eInvoiceTv: tv, eInvoiceInternet: internet };
  }

  /** Marca en lote una columna (TV o Internet) para varios clientes a la vez. */
  async bulkEflags(dto: { subscriberIds: string[]; service: 'tv' | 'internet'; value: boolean }) {
    const ids = (dto.subscriberIds || []).slice(0, 500);
    if (!ids.length) return { updated: 0 };
    const field = dto.service === 'tv' ? 'eInvoiceTv' : 'eInvoiceInternet';
    await this.prisma.subscriber.updateMany({
      where: { id: { in: ids } },
      data: dto.value ? { [field]: true, eInvoice: true } : { [field]: false },
    });
    return { updated: ids.length };
  }

  /** Serializa una cuenta Siigo para la UI (sin exponer credenciales) + estado. */
  private serializeAccount(a: {
    id: string; role: string; companyName: string | null; username: string; accessKey: string | null;
    apiBaseUrl: string; authUrl: string; subscriptionKey: string | null; documentId: number | null;
    creditNoteDocumentId: number | null;
    sellerId: number | null; ivaTaxId: number | null; paymentCash: number | null; paymentCredIt: number | null;
    contactEmail: string | null; active: boolean; token: string | null; tokenExpires: Date | null;
  }) {
    const required: [number | null, string][] = [
      [a.documentId, 'Tipo de comprobante DIAN (documentId)'],
      [a.sellerId, 'Vendedor (sellerId)'],
      [a.paymentCash, 'Medio de pago efectivo'],
    ];
    const missing = required.filter(([v]) => v == null).map(([, label]) => label);
    return {
      id: a.id, role: a.role, companyName: a.companyName, username: a.username,
      apiBaseUrl: a.apiBaseUrl, authUrl: a.authUrl, subscriptionKey: a.subscriptionKey,
      documentId: a.documentId, creditNoteDocumentId: a.creditNoteDocumentId,
      sellerId: a.sellerId, ivaTaxId: a.ivaTaxId,
      paymentCash: a.paymentCash, paymentCredit: a.paymentCredIt, contactEmail: a.contactEmail,
      active: a.active, hasAccessKey: !!a.accessKey, hasToken: !!a.token, tokenExpires: a.tokenExpires,
      ready: missing.length === 0, missing,
    };
  }

  /** Cuentas Siigo (Vestel TV / Internet) con su estado "lista para emitir". */
  async accounts() {
    const accs = await this.prisma.siigoAccount.findMany({ orderBy: { role: 'asc' } });
    return accs.map((a) => this.serializeAccount(a));
  }

  /** Actualiza el mapeo DIAN + credenciales de una cuenta Siigo. */
  async updateAccount(id: string, dto: UpdateSiigoAccountDto) {
    const acc = await this.prisma.siigoAccount.findUnique({ where: { id } });
    if (!acc) throw new NotFoundException('Cuenta Siigo no encontrada');
    const data: Prisma.SiigoAccountUpdateInput = {};
    if (dto.companyName !== undefined) data.companyName = dto.companyName;
    if (dto.role !== undefined) data.role = dto.role;
    if (dto.username !== undefined) data.username = dto.username;
    if (dto.apiBaseUrl !== undefined) data.apiBaseUrl = dto.apiBaseUrl;
    if (dto.authUrl !== undefined) data.authUrl = dto.authUrl;
    if (dto.subscriptionKey !== undefined) data.subscriptionKey = dto.subscriptionKey;
    if (dto.contactEmail !== undefined) data.contactEmail = dto.contactEmail;
    if (dto.active !== undefined) data.active = dto.active;
    // La access key solo se guarda si viene con contenido (no se puede leer de vuelta).
    if (typeof dto.accessKey === 'string' && dto.accessKey.trim()) data.accessKey = dto.accessKey.trim();
    if (dto.documentId !== undefined) data.documentId = dto.documentId;
    if (dto.creditNoteDocumentId !== undefined) data.creditNoteDocumentId = dto.creditNoteDocumentId;
    if (dto.sellerId !== undefined) data.sellerId = dto.sellerId;
    if (dto.ivaTaxId !== undefined) data.ivaTaxId = dto.ivaTaxId;
    if (dto.paymentCash !== undefined) data.paymentCash = dto.paymentCash;
    if (dto.paymentCredit !== undefined) data.paymentCredIt = dto.paymentCredit;
    const updated = await this.prisma.siigoAccount.update({ where: { id }, data });
    return this.serializeAccount(updated);
  }

  /**
   * Prueba las credenciales contra Siigo (solo autentica, NO emite nada; es
   * seguro aunque EINVOICE_LIVE=false). Si funciona, guarda el token vigente.
   */
  async testAccount(id: string) {
    const a = await this.prisma.siigoAccount.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Cuenta Siigo no encontrada');
    if (!a.username || !a.accessKey) {
      return { ok: false, error: 'Faltan credenciales (usuario / access key).' };
    }
    const client = new SiigoClient(a.authUrl, a.apiBaseUrl);
    try {
      const auth = await client.authenticate(a.username, a.accessKey);
      const expires = new Date(Date.now() + (auth.expires_in ?? 86400) * 1000);
      await this.prisma.siigoAccount.update({ where: { id }, data: { token: auth.access_token, tokenExpires: expires } });
      return { ok: true, message: 'Autenticación exitosa con Siigo.', tokenExpires: expires };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? 'Error autenticando con Siigo' };
    }
  }

  async detail(id: string) {
    const e = await this.prisma.electronicInvoice.findUnique({
      where: { id },
      include: { subscriber: { select: SUB }, invoice: { select: { id: true, tid: true, total: true } }, siigoAccount: true },
    });
    if (!e) throw new NotFoundException('Factura electrónica no encontrada');
    return {
      id: e.id, date: e.date, executedAt: e.executedAt, type: e.type, services: e.servicesBilled, payMethod: e.payMethod,
      subscriber: e.subscriber ? { id: e.subscriber.id, name: subName(e.subscriber), abonado: e.subscriber.abonado } : null,
      invoice: e.invoice ? { id: e.invoice.id, tid: e.invoice.tid } : null,
      siigoAccount: e.siigoAccount?.companyName ?? null,
      dian: { number: e.dianNumber, cufe: e.cufe, siigoId: e.siigoInvoiceId, pdfUrl: e.pdfUrl, xmlUrl: e.xmlUrl },
      error: e.errorMessage,
    };
  }
}
