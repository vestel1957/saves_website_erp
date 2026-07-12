import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? 0 : Number(d));
function range(from?: string, to?: string): { gte?: Date; lte?: Date } | undefined {
  if (!from && !to) return undefined;
  const r: { gte?: Date; lte?: Date } = {};
  if (from) r.gte = new Date(from);
  if (to) r.lte = new Date(to);
  return r;
}

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Recaudo: ingresos vigentes agrupados por caja y por método. */
  async recaudo(from?: string, to?: string) {
    const where: Prisma.TransactionWhereInput = { status: 'VIGENTE', type: 'INCOME' };
    const dr = range(from, to);
    if (dr) where.date = dr;
    const [byAccount, byMethod, total] = await Promise.all([
      this.prisma.transaction.groupBy({ by: ['accountName'], _sum: { credit: true }, _count: { _all: true }, where }),
      this.prisma.transaction.groupBy({ by: ['method'], _sum: { credit: true }, _count: { _all: true }, where }),
      this.prisma.transaction.aggregate({ _sum: { credit: true }, _count: { _all: true }, where }),
    ]);
    return {
      total: num(total._sum.credit), count: total._count._all,
      porCaja: byAccount.map((r) => ({ caja: r.accountName ?? 'Sin caja', total: num(r._sum.credit), count: r._count._all })).sort((a, b) => b.total - a.total),
      porMetodo: byMethod.map((r) => ({ metodo: r.method ?? 'Sin método', total: num(r._sum.credit), count: r._count._all })).sort((a, b) => b.total - a.total),
    };
  }

  /** Ventas por sede: facturas agrupadas por sede del cliente. */
  async ventasSede(from?: string, to?: string) {
    const dr = range(from, to);
    const rows = await this.prisma.$queryRaw<{ sede: string; total: number; cnt: number }[]>`
      SELECT COALESCE(b.name,'Sin sede') sede, COALESCE(SUM(i.total),0)::float total, COUNT(*)::int cnt
      FROM "SubInvoice" i
      LEFT JOIN "Subscriber" s ON s.id = i."subscriberId"
      LEFT JOIN "Branch" b ON b.id = s."branchId"
      ${dr?.gte ? Prisma.sql`WHERE i."invoiceDate" >= ${dr.gte}` : Prisma.empty}
      ${dr?.lte ? (dr.gte ? Prisma.sql`AND i."invoiceDate" <= ${dr.lte}` : Prisma.sql`WHERE i."invoiceDate" <= ${dr.lte}`) : Prisma.empty}
      GROUP BY b.name ORDER BY total DESC`;
    return { items: rows.map((r) => ({ sede: r.sede, total: Number(r.total), facturas: Number(r.cnt) })) };
  }

  /** Ingresos vs egresos por mes (últimos 12 meses con datos). */
  async ingresosEgresos() {
    const rows = await this.prisma.$queryRaw<{ m: string; income: number; expense: number }[]>`
      SELECT to_char(date_trunc('month', date),'YYYY-MM') m,
             COALESCE(SUM(credit) FILTER (WHERE type='INCOME'),0)::float income,
             COALESCE(SUM(debit) FILTER (WHERE type='EXPENSE'),0)::float expense
      FROM "Transaction" WHERE status='VIGENTE' GROUP BY 1 ORDER BY 1 DESC LIMIT 12`;
    return { items: [...rows].reverse().map((r) => ({ month: r.m, income: Number(r.income), expense: Number(r.expense), balance: Number(r.income) - Number(r.expense) })) };
  }

  /** Órdenes de servicio: por tipo y por estado. */
  async ordenes(from?: string, to?: string) {
    const where: Prisma.TicketWhereInput = {};
    const dr = range(from, to);
    if (dr) where.created = dr;
    const [byType, byStatus, byTech] = await Promise.all([
      this.prisma.ticket.groupBy({ by: ['type'], _count: { _all: true }, where, orderBy: { _count: { type: 'desc' } }, take: 20 }),
      this.prisma.ticket.groupBy({ by: ['status'], _count: { _all: true }, where }),
      this.prisma.ticket.groupBy({ by: ['assigned'], _count: { _all: true }, where, orderBy: { _count: { assigned: 'desc' } }, take: 15 }),
    ]);
    return {
      porTipo: byType.map((r) => ({ tipo: r.type, count: r._count._all })),
      porEstado: byStatus.map((r) => ({ estado: r.status, count: r._count._all })),
      porTecnico: byTech.filter((r) => r.assigned).map((r) => ({ tecnico: r.assigned, count: r._count._all })),
    };
  }

  /** Estadísticas de la base de clientes por estado (y por sede). */
  async estadisticasServicios() {
    const [byStatus, byBranch] = await Promise.all([
      this.prisma.subscriber.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.$queryRaw<{ sede: string; total: number; activos: number; cortados: number; cartera: number }[]>`
        SELECT COALESCE(b.name,'Sin sede') sede, COUNT(*)::int total,
               COUNT(*) FILTER (WHERE s.status='ACTIVO')::int activos,
               COUNT(*) FILTER (WHERE s.status='CORTADO')::int cortados,
               COUNT(*) FILTER (WHERE s.status='CARTERA')::int cartera
        FROM "Subscriber" s LEFT JOIN "Branch" b ON b.id=s."branchId"
        GROUP BY b.name ORDER BY total DESC`,
    ]);
    const estados: Record<string, number> = {};
    for (const r of byStatus) estados[r.status ?? '—'] = r._count._all;
    return { estados, porSede: byBranch.map((r) => ({ sede: r.sede, total: Number(r.total), activos: Number(r.activos), cortados: Number(r.cortados), cartera: Number(r.cartera) })) };
  }

  /** Cortes y activaciones por periodo (desde el historial de estados). */
  async cortesActivaciones(from?: string, to?: string) {
    const where: Prisma.SubscriberStatusHistoryWhereInput = { status: { in: ['CORTADO', 'ACTIVO', 'SUSPENDIDO', 'RETIRADO'] } };
    const dr = range(from, to);
    if (dr) where.date = dr;
    const byStatus = await this.prisma.subscriberStatusHistory.groupBy({ by: ['status'], _count: { _all: true }, where });
    const map: Record<string, number> = {};
    for (const r of byStatus) map[r.status] = r._count._all;
    return {
      cortes: map['CORTADO'] ?? 0, activaciones: map['ACTIVO'] ?? 0, suspensiones: map['SUSPENDIDO'] ?? 0, retiros: map['RETIRADO'] ?? 0,
      detalle: byStatus.map((r) => ({ estado: r.status, count: r._count._all })),
    };
  }

  /** Movimientos de clientes: altas vs retiros por periodo. */
  async movimientos(from?: string, to?: string) {
    const dr = range(from, to);
    const altasWhere: Prisma.SubscriberWhereInput = {};
    if (dr) altasWhere.entryDate = dr;
    const retiroWhere: Prisma.SubscriberStatusHistoryWhereInput = { status: 'RETIRADO' };
    if (dr) retiroWhere.date = dr;
    const [altas, retiros] = await Promise.all([
      this.prisma.subscriber.count({ where: altasWhere }),
      this.prisma.subscriberStatusHistory.count({ where: retiroWhere }),
    ]);
    return { altas, retiros, neto: altas - retiros };
  }

  /** Top clientes deudores. */
  async topDeudores() {
    const rows = await this.prisma.$queryRaw<{ id: string; name: string; abonado: number; bal: number; facturas: number }[]>`
      SELECT s.id, COALESCE(NULLIF(TRIM(s."fullName"),''), TRIM(CONCAT(s."firstName",' ',s."lastName1")), s."companyName",'—') name,
             s.abonado, SUM(i.total - i."paidAmount")::float bal, COUNT(*)::int facturas
      FROM "SubInvoice" i JOIN "Subscriber" s ON s.id = i."subscriberId"
      WHERE i.status IN ('DUE','PARTIAL') GROUP BY s.id, name, s.abonado ORDER BY bal DESC LIMIT 30`;
    return { items: rows.map((r) => ({ id: r.id, name: (r.name || '—').trim(), abonado: Number(r.abonado), balance: Number(r.bal), facturas: Number(r.facturas) })) };
  }
}
