import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { num } from '../common/money';

function subName(s: { firstName: string | null; lastName1: string | null; companyName: string | null; fullName: string | null } | null): string {
  if (!s) return '—';
  return (s.fullName?.trim()) || [s.firstName, s.lastName1].filter(Boolean).join(' ').trim() || s.companyName || '—';
}

@Injectable()
export class DashboardService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  // Calienta la caché al arrancar (en segundo plano, sin bloquear el boot) para
  // que ni el primer usuario tras un reinicio espere el cómputo completo.
  onModuleInit() {
    void this.summary().catch(() => { /* se reintenta en la primera petición real */ });
  }

  // El resumen agrega ~17 consultas sobre tablas grandes (SubInvoice 443k,
  // Transaction 498k): 2-5s de cómputo. Los KPIs no necesitan estar al segundo,
  // así que se cachean con stale-while-revalidate: se responde al instante con
  // el último valor y se recalcula en segundo plano cuando queda viejo.
  private cache: { data: Awaited<ReturnType<DashboardService['computeSummary']>>; at: number } | null = null;
  private refreshing: Promise<unknown> | null = null;
  private static readonly TTL_MS = Number(process.env.DASHBOARD_TTL_MS) || 60_000;

  async summary() {
    const now = Date.now();
    if (this.cache) {
      // Hay valor cacheado: se responde ya. Si está viejo, se dispara un refresco
      // en segundo plano (sin bloquear ni duplicar cómputos concurrentes).
      if (now - this.cache.at > DashboardService.TTL_MS && !this.refreshing) {
        this.refreshing = this.computeSummary()
          .then((data) => { this.cache = { data, at: Date.now() }; })
          .catch(() => { /* mantiene el valor anterior si falla el refresco */ })
          .finally(() => { this.refreshing = null; });
      }
      return this.cache.data;
    }
    // Primera vez (o tras un reinicio): se calcula de forma síncrona.
    const data = await this.computeSummary();
    this.cache = { data, at: Date.now() };
    return data;
  }

  private async computeSummary() {
    const [
      subsTotal, subsActive, cartera, aging, facturado, byInvStatus,
      txAgg, supportByStatus, equip, ports, invValue, ordersAgg, series, topDebt, topTypes,
    ] = await Promise.all([
      this.prisma.subscriber.count(),
      this.prisma.subscriber.count({ where: { status: 'ACTIVO' } }),
      this.prisma.subInvoice.aggregate({ _sum: { total: true, paidAmount: true }, _count: { _all: true }, where: { status: { in: ['DUE', 'PARTIAL'] } } }),
      this.prisma.$queryRaw<{ corriente: number; d30: number; d60: number; d90: number }[]>`
        SELECT COALESCE(SUM(bal) FILTER (WHERE d <= 30),0)::float corriente,
               COALESCE(SUM(bal) FILTER (WHERE d BETWEEN 31 AND 60),0)::float d30,
               COALESCE(SUM(bal) FILTER (WHERE d BETWEEN 61 AND 90),0)::float d60,
               COALESCE(SUM(bal) FILTER (WHERE d > 90),0)::float d90
        FROM (SELECT (total-"paidAmount") bal, (CURRENT_DATE-"dueDate") d FROM "SubInvoice" WHERE status IN ('DUE','PARTIAL')) t`,
      this.prisma.subInvoice.aggregate({ _sum: { total: true }, _count: { _all: true } }),
      this.prisma.subInvoice.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.transaction.aggregate({ _sum: { credit: true, debit: true }, where: { status: 'VIGENTE' } }),
      this.prisma.ticket.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.equipment.count(),
      this.prisma.port.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.$queryRaw<{ v: number }[]>`SELECT COALESCE(SUM(price*qty),0)::float v FROM "Material" WHERE qty < 100000`,
      this.prisma.supplyOrder.aggregate({ _sum: { total: true }, _count: { _all: true } }),
      this.prisma.$queryRaw<{ m: string; income: number; expense: number }[]>`
        SELECT to_char(date_trunc('month', date),'YYYY-MM') m,
               COALESCE(SUM(credit) FILTER (WHERE type='INCOME'),0)::float income,
               COALESCE(SUM(debit) FILTER (WHERE type='EXPENSE'),0)::float expense
        FROM "Transaction" WHERE status='VIGENTE' GROUP BY 1 ORDER BY 1 DESC LIMIT 12`,
      this.prisma.$queryRaw<{ id: string; name: string; bal: number }[]>`
        SELECT s.id, COALESCE(NULLIF(TRIM(s."fullName"),''), TRIM(CONCAT(s."firstName",' ',s."lastName1")), s."companyName",'—') name,
               SUM(i.total - i."paidAmount")::float bal
        FROM "SubInvoice" i JOIN "Subscriber" s ON s.id = i."subscriberId"
        WHERE i.status IN ('DUE','PARTIAL') GROUP BY s.id, name ORDER BY bal DESC LIMIT 8`,
      this.prisma.ticket.groupBy({ by: ['type'], _count: { _all: true }, orderBy: { _count: { type: 'desc' } }, take: 8 }),
    ]);

    const [clientStatus, ventasSede] = await Promise.all([
      this.prisma.subscriber.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.$queryRaw<{ sede: string; total: number; abonados: number }[]>`
        SELECT COALESCE(b.name,'Sin sede') sede, COALESCE(SUM(i.total),0)::float total, COUNT(DISTINCT s.id)::int abonados
        FROM "Subscriber" s
        LEFT JOIN "Branch" b ON b.id = s."branchId"
        LEFT JOIN "SubInvoice" i ON i."subscriberId" = s.id
        GROUP BY b.name ORDER BY total DESC LIMIT 6`,
    ]);
    const estadoClientes: Record<string, number> = {};
    for (const r of clientStatus) estadoClientes[r.status ?? '—'] = r._count._all;

    const invStatus: Record<string, number> = {};
    for (const r of byInvStatus) invStatus[r.status] = r._count._all;
    const supStatus: Record<string, number> = {};
    for (const r of supportByStatus) supStatus[r.status] = r._count._all;
    const portMap: Record<string, number> = {};
    for (const r of ports) portMap[r.status] = r._count._all;
    const ag = aging[0] ?? { corriente: 0, d30: 0, d60: 0, d90: 0 };

    return {
      clientes: { total: subsTotal, activos: subsActive },
      cartera: {
        total: num(cartera._sum.total) - num(cartera._sum.paidAmount), facturas: cartera._count._all,
        aging: { corriente: ag.corriente, d31_60: ag.d30, d61_90: ag.d60, d90: ag.d90 },
      },
      facturacion: { total: num(facturado._sum.total), facturas: facturado._count._all, pagadas: invStatus['PAID'] ?? 0, pendientes: (invStatus['DUE'] ?? 0) + (invStatus['PARTIAL'] ?? 0) },
      tesoreria: { ingresos: num(txAgg._sum.credit), egresos: num(txAgg._sum.debit), balance: num(txAgg._sum.credit) - num(txAgg._sum.debit) },
      soporte: { pendientes: (supStatus['PENDIENTE'] ?? 0) + (supStatus['REALIZANDO'] ?? 0), resueltas: supStatus['RESUELTO'] ?? 0, total: Object.values(supStatus).reduce((a, b) => a + b, 0) },
      red: { equipos: equip, puertosUsados: portMap['Ocupado'] ?? 0, puertosLibres: portMap['Disponible'] ?? 0 },
      inventario: { valor: invValue[0]?.v ?? 0 },
      compras: { total: ordersAgg._count._all, monto: num(ordersAgg._sum.total) },
      serieMensual: [...series].reverse().map((r) => ({ month: r.m, income: r.income, expense: r.expense })),
      topDeudores: topDebt.map((r) => ({ id: r.id, name: (r.name || '—').trim(), balance: r.bal })),
      ordenesPorTipo: topTypes.map((t) => ({ type: t.type, count: t._count._all })),
      estadoClientes,
      ventasPorSede: ventasSede.map((r) => ({ sede: r.sede, total: Number(r.total), abonados: Number(r.abonados) })),
    };
  }
}
