import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { num, round2 } from '../common/money';


/** Fila cruda del reporte de IVA (una por documento). */
type IvaRow = {
  numero: number; fecha: Date; tercero: string; documento: string | null;
  base_gravable: number; base_exenta: number; ajustes: number; iva: number; total: number;
  retencion_tipo: string | null; retencion: number;
};
/** Fila cruda del resumen por tarifa. */
type TarifaRow = { tarifa: number; base: number; iva: number; documentos: number };
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

  /**
   * Reporte de IVA (ventas o compras).
   *
   * NO replica el legacy (`Export::taxstatement_o` / `Reports::taxviewstatements_load`), que
   * era un listado plano inservible como reporte fiscal: no filtraba por estado (sumaba el
   * IVA de facturas ANULADAS), publicaba `total` con el IVA incluido y como texto
   * (`concat('COP ', total)`), no discriminaba base gravable, no separaba exentos, ignoraba
   * las retenciones y no tenía `ORDER BY` (su acumulado era no determinista).
   *
   * Aquí: se excluyen los documentos anulados, se discrimina base gravable / IVA / tarifa,
   * se separan los exentos, se expone la retención y el orden es estable.
   *
   * Las notas crédito/débito se aíslan en `ajustes` en vez de contaminar las bases: en
   * ventas se reconocen por `productName` (ojo: en `SubInvoiceItem` TODOS los ítems llevan
   * `productId = 0`, no sólo las notas) y en compras por `materialLegacy = 0`.
   */
  async iva(type: string, from?: string, to?: string) {
    const isPurchase = String(type).toLowerCase().startsWith('compra');
    const dr = range(from, to);
    const gte = dr?.gte ?? new Date('1900-01-01');
    const lte = dr?.lte ?? new Date('2999-12-31');

    const rows = isPurchase
      ? await this.prisma.$queryRaw<IvaRow[]>`
          SELECT o.tid::int AS numero, o."orderDate" AS fecha,
                 COALESCE(p.name, 'Sin proveedor') AS tercero, p.nit AS documento,
                 COALESCE(SUM(CASE WHEN it."taxRate" > 0 AND COALESCE(it."materialLegacy", -1) <> 0 THEN it.subtotal ELSE 0 END), 0)::float AS base_gravable,
                 COALESCE(SUM(CASE WHEN it."taxRate" = 0 AND COALESCE(it."materialLegacy", -1) <> 0 THEN it.subtotal ELSE 0 END), 0)::float AS base_exenta,
                 COALESCE(SUM(CASE WHEN it."materialLegacy" = 0 THEN it.subtotal ELSE 0 END), 0)::float AS ajustes,
                 COALESCE(SUM(it."taxTotal"), 0)::float AS iva,
                 o.total::float AS total,
                 o."retentionType" AS retencion_tipo, o.retention::float AS retencion
          FROM "SupplyOrder" o
          LEFT JOIN "Supplier" p ON p.id = o."supplierId"
          LEFT JOIN "SupplyOrderItem" it ON it."orderId" = o.id
          WHERE LOWER(o.status) NOT IN ('canceled', 'cancelada', 'anulada')
            AND o."orderDate" >= ${gte} AND o."orderDate" <= ${lte}
          GROUP BY o.id, p.name, p.nit
          ORDER BY o."orderDate", o.tid`
      : await this.prisma.$queryRaw<IvaRow[]>`
          SELECT i.tid::int AS numero, i."invoiceDate" AS fecha,
                 COALESCE(s."companyName", s."fullName", 'Sin cliente') AS tercero, s."docNumber" AS documento,
                 COALESCE(SUM(CASE WHEN it."taxRate" > 0 AND COALESCE(it."productName", '') NOT IN ('Nota Credito', 'Nota Debito') THEN it.subtotal ELSE 0 END), 0)::float AS base_gravable,
                 COALESCE(SUM(CASE WHEN it."taxRate" = 0 AND COALESCE(it."productName", '') NOT IN ('Nota Credito', 'Nota Debito') THEN it.subtotal ELSE 0 END), 0)::float AS base_exenta,
                 COALESCE(SUM(CASE WHEN it."productName" IN ('Nota Credito', 'Nota Debito') THEN it.subtotal ELSE 0 END), 0)::float AS ajustes,
                 COALESCE(SUM(it."taxTotal"), 0)::float AS iva,
                 i.total::float AS total,
                 i."retentionType"::text AS retencion_tipo, 0::float AS retencion
          FROM "SubInvoice" i
          LEFT JOIN "Subscriber" s ON s.id = i."subscriberId"
          LEFT JOIN "SubInvoiceItem" it ON it."invoiceId" = i.id
          WHERE i.status <> 'CANCELED'
            AND i."invoiceDate" >= ${gte} AND i."invoiceDate" <= ${lte}
          GROUP BY i.id, s."companyName", s."fullName", s."docNumber"
          ORDER BY i."invoiceDate", i.tid`;

    // Resumen por tarifa: la tarifa se deriva del IVA sobre la base (una factura puede
    // mezclar líneas al 19% y exentas, así que se reparte por línea, no por documento).
    const porTarifa = isPurchase
      ? await this.prisma.$queryRaw<TarifaRow[]>`
          SELECT it."taxRate"::float AS tarifa,
                 COALESCE(SUM(it.subtotal), 0)::float AS base,
                 COALESCE(SUM(it."taxTotal"), 0)::float AS iva,
                 COUNT(DISTINCT o.id)::int AS documentos
          FROM "SupplyOrder" o
          JOIN "SupplyOrderItem" it ON it."orderId" = o.id
          WHERE LOWER(o.status) NOT IN ('canceled', 'cancelada', 'anulada')
            AND COALESCE(it."materialLegacy", -1) <> 0
            AND o."orderDate" >= ${gte} AND o."orderDate" <= ${lte}
          GROUP BY it."taxRate" ORDER BY it."taxRate" DESC`
      : await this.prisma.$queryRaw<TarifaRow[]>`
          SELECT it."taxRate"::float AS tarifa,
                 COALESCE(SUM(it.subtotal), 0)::float AS base,
                 COALESCE(SUM(it."taxTotal"), 0)::float AS iva,
                 COUNT(DISTINCT i.id)::int AS documentos
          FROM "SubInvoice" i
          JOIN "SubInvoiceItem" it ON it."invoiceId" = i.id
          WHERE i.status <> 'CANCELED'
            AND COALESCE(it."productName", '') NOT IN ('Nota Credito', 'Nota Debito')
            AND i."invoiceDate" >= ${gte} AND i."invoiceDate" <= ${lte}
          GROUP BY it."taxRate" ORDER BY it."taxRate" DESC`;

    const items = rows.map((r) => ({
      numero: Number(r.numero),
      fecha: r.fecha,
      tercero: r.tercero,
      documento: r.documento ?? null,
      baseGravable: Number(r.base_gravable),
      baseExenta: Number(r.base_exenta),
      ajustes: Number(r.ajustes),
      iva: Number(r.iva),
      total: Number(r.total),
      retencionTipo: r.retencion_tipo ?? null,
      retencion: Number(r.retencion),
    }));
    const sum = (k: keyof (typeof items)[number]) => items.reduce((a, b) => a + (Number(b[k]) || 0), 0);

    return {
      tipo: isPurchase ? 'compras' : 'ventas',
      desde: dr?.gte ?? null,
      hasta: dr?.lte ?? null,
      items,
      porTarifa: porTarifa.map((t) => ({
        tarifa: Number(t.tarifa), base: Number(t.base), iva: Number(t.iva), documentos: Number(t.documentos),
      })),
      totales: {
        documentos: items.length,
        baseGravable: round2(sum('baseGravable')),
        baseExenta: round2(sum('baseExenta')),
        ajustes: round2(sum('ajustes')),
        iva: round2(sum('iva')),
        total: round2(sum('total')),
        retencion: round2(sum('retencion')),
      },
    };
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
