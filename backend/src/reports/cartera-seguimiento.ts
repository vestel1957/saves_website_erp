import { SubscriberStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { num, round2 } from '../common/money';
import { hoyEnColombia } from '../common/fecha-colombia';

/**
 * Seguimiento mensual de la cartera: qué pasó con cada abonado que el día 1 estaba
 * en CARTERA después de la gestión de cobro.
 *
 * La cohorte se FOTOGRAFÍA el día 1 (`abrirMes`) porque el estado pasado no se puede
 * reconstruir: el historial de estados pierde ~12% de los cambios (ver
 * metrics.service.ts). Mientras el mes está abierto todo lo demás se calcula en vivo;
 * al empezar el mes siguiente `cerrarMes` congela pagado, deuda final, estado final
 * y categoría, y ese mes ya no se mueve — es lo que permite compararlos entre sí.
 *
 * Qué cuenta como "pagado": los ingresos VIGENTES del abonado con fecha dentro del
 * mes, la misma definición que el reporte de Recaudo. "Recuperado" es lo pagado con
 * tope en la deuda del día 1: quien se reactiva paga además reconexión y el mes en
 * curso, y eso no es cartera recuperada.
 *
 * La deuda de hoy se parte en dos: la VIEJA (deuda del día 1 − recuperado) y la
 * NUEVA (facturas del mes aún sin pagar, menos notas crédito o depuraciones). La
 * clasificación mira sólo la vieja: quien saldó lo del día 1 y debe la factura del
 * mes en curso no es un "abono parcial" de cartera. Así inicial − recuperado + nueva
 * = final cuadra fila por fila.
 */

export type Categoria = 'RETIRADO' | 'ACTIVADO' | 'PARCIAL' | 'PAGO_SIN_ACTIVAR' | 'SIN_PAGO';

export const CATEGORIAS: { key: Categoria; label: string; desc: string }[] = [
  { key: 'ACTIVADO', label: 'Se reactivó y sigue', desc: 'Saldó la deuda vieja y tiene servicio' },
  { key: 'RETIRADO', label: 'Se retiró', desc: 'Pagó para quedar a paz y salvo y terminó el servicio' },
  { key: 'PARCIAL', label: 'Abonó una parte', desc: 'Pagó algo, pero aún le queda deuda vieja' },
  { key: 'PAGO_SIN_ACTIVAR', label: 'Pagó, sigue cortado', desc: 'Saldó la deuda vieja pero no se ha reactivado' },
  { key: 'SIN_PAGO', label: 'No pagó', desc: 'No pagó nada en el mes' },
];

/** Estados que significan que el abonado se fue. */
const ESTADOS_RETIRO: SubscriberStatus[] = ['RETIRADO', 'POR_RETIRAR', 'DEPURADO'];
/** Estados con servicio. COMPROMISO cuenta: tiene servicio mientras cumple el acuerdo. */
const ESTADOS_CON_SERVICIO: SubscriberStatus[] = ['ACTIVO', 'COMPROMISO', 'EXONERADO'];
/** Por debajo de esto se considera al día (el mismo umbral de los filtros de deuda). */
export const DEUDA_MINIMA = 20_000;

/** Lo que sigue sin pagar de la deuda del día 1. */
export const deudaViejaDe = (deudaInicial: number, pagado: number) => round2(Math.max(0, deudaInicial - Math.max(0, pagado)));

/**
 * La clasificación, sobre la deuda VIEJA (la del día 1 menos lo pagado): la factura
 * del mes en curso no convierte en "abono parcial" a quien saldó su cartera. El
 * orden importa: quien pagó y se retiró es RETIRADO aunque le quede saldo (se ve en
 * su fila); quien sigue debiendo de lo viejo es PARCIAL aunque ya tenga servicio.
 */
export function clasificar(pagado: number, deudaVieja: number, estadoFinal: SubscriberStatus | null): Categoria {
  if (pagado <= 0) return 'SIN_PAGO';
  if (estadoFinal && ESTADOS_RETIRO.includes(estadoFinal)) return 'RETIRADO';
  if (deudaVieja > DEUDA_MINIMA) return 'PARCIAL';
  if (estadoFinal && ESTADOS_CON_SERVICIO.includes(estadoFinal)) return 'ACTIVADO';
  return 'PAGO_SIN_ACTIVAR';
}

/** 'YYYY-MM' o 'YYYY-MM-DD' → 'YYYY-MM-01'. Sin argumento, el mes en curso en Colombia. */
export function primerDia(mes?: string): string {
  const base = mes && /^\d{4}-\d{2}/.test(mes) ? mes.slice(0, 7) : hoyEnColombia().toISOString().slice(0, 7);
  return `${base}-01`;
}

/** Último día del mes de `mes` ('YYYY-MM-01'), como texto. */
function ultimoDia(mes: string): string {
  const [y, m] = mes.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export function nombreMes(mes: string): string {
  const [y, m] = mes.split('-').map(Number);
  return `${MESES[m - 1][0].toUpperCase()}${MESES[m - 1].slice(1)} ${y}`;
}

const aFecha = (d: string) => new Date(`${d}T00:00:00.000Z`);

/**
 * Abre el mes: fotografía a quien está HOY en CARTERA con deuda. Idempotente (no
 * duplica ni pisa una foto ya tomada). Pensado para correr el día 1 de madrugada.
 */
export async function abrirMes(prisma: PrismaService, mes = primerDia()) {
  const ya = await prisma.carteraSeguimiento.count({ where: { mes: aFecha(mes) } });
  if (ya > 0) return { mes, creados: 0, yaAbierto: true };

  const rows = await prisma.$queryRaw<{ id: string; branchId: string | null; deuda: number; facturas: number }[]>`
    SELECT s.id, s."branchId", SUM(i.total - i."paidAmount")::float deuda, COUNT(*)::int facturas
    FROM "Subscriber" s JOIN "SubInvoice" i ON i."subscriberId" = s.id AND i.status IN ('DUE','PARTIAL')
    WHERE s.status = 'CARTERA'
    GROUP BY s.id, s."branchId"
    HAVING SUM(i.total - i."paidAmount") > 0`;

  const r = await prisma.carteraSeguimiento.createMany({
    skipDuplicates: true,
    data: rows.map((x) => ({
      mes: aFecha(mes), subscriberId: x.id, branchId: x.branchId, estadoInicial: 'CARTERA' as SubscriberStatus,
      deudaInicial: round2(Number(x.deuda)), facturasInicial: Number(x.facturas),
    })),
  });
  return { mes, creados: r.count, yaAbierto: false };
}

/**
 * Arma a posteriori la cohorte de un mes que no se fotografió el día 1 (septiembre de
 * 2026, cuando nació la pestaña). La deuda inicial se reconstruye con plata, que sí es
 * fiable: por cada factura emitida antes del día 1, lo que se debía entonces = total −
 * (lo pagado hoy − lo pagado desde el día 1). Queda marcado `reconstruido`.
 */
export async function reconstruirMes(prisma: PrismaService, mes: string, subscriberIds: string[]) {
  if (!subscriberIds.length) return { mes, creados: 0 };
  const rows = await prisma.$queryRaw<{ id: string; branchId: string | null; deuda: number; facturas: number }[]>`
    WITH pagado_desde AS (
      SELECT t."invoiceId", SUM(t.credit) m FROM "Transaction" t
      WHERE t.type = 'INCOME' AND t.status = 'VIGENTE' AND t."invoiceId" IS NOT NULL AND t.date >= ${mes}::date
      GROUP BY t."invoiceId"
    ), por_factura AS (
      SELECT i."subscriberId", GREATEST(i.total - (i."paidAmount" - COALESCE(p.m, 0)), 0) saldo
      FROM "SubInvoice" i LEFT JOIN pagado_desde p ON p."invoiceId" = i.id
      WHERE i."subscriberId" = ANY(${subscriberIds}) AND i.status <> 'CANCELED' AND i."invoiceDate" < ${mes}::date
    )
    SELECT s.id, s."branchId", SUM(f.saldo)::float deuda, COUNT(*) FILTER (WHERE f.saldo > 0)::int facturas
    FROM por_factura f JOIN "Subscriber" s ON s.id = f."subscriberId"
    GROUP BY s.id, s."branchId"
    HAVING SUM(f.saldo) > 0`;

  const r = await prisma.carteraSeguimiento.createMany({
    skipDuplicates: true,
    data: rows.map((x) => ({
      mes: aFecha(mes), subscriberId: x.id, branchId: x.branchId, estadoInicial: 'CARTERA' as SubscriberStatus,
      deudaInicial: round2(Number(x.deuda)), facturasInicial: Number(x.facturas), reconstruido: true,
    })),
  });
  return { mes, creados: r.count };
}

type Vivo = { subscriberId: string; pagado: number; pagos: number; deudaFinal: number; estadoFinal: SubscriberStatus | null };

/** Pagos del mes, deuda de hoy y estado de hoy de cada abonado de la cohorte. */
async function calcularVivo(prisma: PrismaService, mes: string): Promise<Map<string, Vivo>> {
  const fin = ultimoDia(mes);
  const rows = await prisma.$queryRaw<{ id: string; status: SubscriberStatus | null; pagado: number; pagos: number; deuda: number }[]>`
    SELECT c."subscriberId" id, s.status,
           COALESCE(p.pagado, 0)::float pagado, COALESCE(p.pagos, 0)::int pagos,
           COALESCE(d.deuda, 0)::float deuda
    FROM "CarteraSeguimiento" c
    LEFT JOIN "Subscriber" s ON s.id = c."subscriberId"
    LEFT JOIN (
      SELECT t."subscriberId", SUM(t.credit) pagado, COUNT(*) pagos FROM "Transaction" t
      WHERE t.type = 'INCOME' AND t.status = 'VIGENTE' AND t.date BETWEEN ${mes}::date AND ${fin}::date
      GROUP BY t."subscriberId"
    ) p ON p."subscriberId" = c."subscriberId"
    LEFT JOIN (
      SELECT i."subscriberId", SUM(i.total - i."paidAmount") deuda FROM "SubInvoice" i
      WHERE i.status IN ('DUE','PARTIAL') GROUP BY i."subscriberId"
    ) d ON d."subscriberId" = c."subscriberId"
    WHERE c.mes = ${mes}::date`;
  return new Map(rows.map((r) => [r.id, {
    subscriberId: r.id, estadoFinal: r.status, pagado: round2(Number(r.pagado)), pagos: Number(r.pagos),
    deudaFinal: round2(Math.max(0, Number(r.deuda))),
  }]));
}

/** Congela el cierre de un mes. Idempotente: un mes ya cerrado no se vuelve a tocar. */
export async function cerrarMes(prisma: PrismaService, mes: string) {
  const abiertas = await prisma.carteraSeguimiento.count({ where: { mes: aFecha(mes), cerradoEn: null } });
  if (!abiertas) return { mes, cerrados: 0 };
  const vivo = await calcularVivo(prisma, mes);
  const inicial = new Map((await prisma.carteraSeguimiento.findMany({
    where: { mes: aFecha(mes) }, select: { subscriberId: true, deudaInicial: true },
  })).map((g) => [g.subscriberId, num(g.deudaInicial)]));
  const ahora = new Date();
  const ops = [...vivo.values()].map((v) => prisma.carteraSeguimiento.update({
    where: { mes_subscriberId: { mes: aFecha(mes), subscriberId: v.subscriberId } },
    data: {
      pagado: v.pagado, pagos: v.pagos, deudaFinal: v.deudaFinal, estadoFinal: v.estadoFinal,
      categoria: clasificar(v.pagado, deudaViejaDe(inicial.get(v.subscriberId) ?? 0, v.pagado), v.estadoFinal), cerradoEn: ahora,
    },
  }));
  for (let i = 0; i < ops.length; i += 500) await prisma.$transaction(ops.slice(i, i + 500));
  return { mes, cerrados: ops.length };
}

/**
 * El paso del cron del día 1: cierra los meses anteriores que sigan abiertos y abre
 * el actual. Seguro de repetir.
 */
export async function pasoMensual(prisma: PrismaService) {
  const mes = primerDia();
  const pendientes = await prisma.carteraSeguimiento.findMany({
    where: { cerradoEn: null, mes: { lt: aFecha(mes) } }, select: { mes: true }, distinct: ['mes'],
  });
  const cerrados = [];
  for (const p of pendientes) cerrados.push(await cerrarMes(prisma, p.mes.toISOString().slice(0, 10)));
  const abierto = await abrirMes(prisma, mes);
  return { cerrados, abierto };
}

type Fila = {
  subscriberId: string; branchId: string | null; estadoInicial: SubscriberStatus; deudaInicial: number;
  facturasInicial: number; pagado: number; pagos: number; deudaFinal: number; estadoFinal: SubscriberStatus | null;
  categoria: Categoria;
  /** Lo pagado que abonó a la deuda del día 1 (tope: esa deuda). El resto es reconexión o mes corriente. */
  recuperado: number;
  /** Lo que sigue sin pagar de la deuda del día 1. */
  deudaVieja: number;
  /** deudaFinal − deudaVieja: facturas del mes sin pagar, menos notas o depuraciones (puede ser negativo). */
  deudaNueva: number;
};

/** Las filas de un mes: congeladas si ya cerró, calculadas en vivo si no. */
async function filasDelMes(prisma: PrismaService, mes: string, sede?: string): Promise<{ filas: Fila[]; abierto: boolean; reconstruido: boolean }> {
  const guardadas = await prisma.carteraSeguimiento.findMany({
    where: { mes: aFecha(mes), ...(sede ? { branchId: sede } : {}) },
  });
  // Sin filas (una sede sin nadie en cartera) el mes sigue abierto si es el de hoy.
  const abierto = guardadas.length ? guardadas.some((g) => !g.cerradoEn) : mes >= primerDia();
  const vivo = abierto ? await calcularVivo(prisma, mes) : null;
  const filas = guardadas.map((g): Fila => {
    const v = vivo?.get(g.subscriberId);
    const pagado = v ? v.pagado : num(g.pagado);
    const deudaFinal = v ? v.deudaFinal : num(g.deudaFinal);
    const estadoFinal = v ? v.estadoFinal : g.estadoFinal;
    const deudaInicial = num(g.deudaInicial);
    const deudaVieja = deudaViejaDe(deudaInicial, pagado);
    return {
      subscriberId: g.subscriberId, branchId: g.branchId, estadoInicial: g.estadoInicial,
      deudaInicial: num(g.deudaInicial), facturasInicial: g.facturasInicial,
      pagado, pagos: v ? v.pagos : g.pagos ?? 0, deudaFinal, estadoFinal,
      categoria: v ? clasificar(pagado, deudaVieja, estadoFinal) : (g.categoria as Categoria),
      recuperado: round2(Math.min(pagado, deudaInicial)),
      deudaVieja, deudaNueva: round2(deudaFinal - deudaVieja),
    };
  });
  return { filas, abierto, reconstruido: guardadas.some((g) => g.reconstruido) };
}

function resumir(filas: Fila[]) {
  const suma = (f: Fila[], k: 'deudaInicial' | 'pagado' | 'deudaFinal' | 'recuperado' | 'deudaVieja') => round2(f.reduce((a, x) => a + x[k], 0));
  const de = (c: Categoria) => filas.filter((f) => f.categoria === c);
  const carteraInicial = suma(filas, 'deudaInicial');
  const recuperado = suma(filas, 'recuperado');
  const carteraFinal = suma(filas, 'deudaFinal');
  return {
    usuariosInicial: filas.length,
    carteraInicial,
    recuperado,
    /** Todo lo que pagaron, incluida reconexión y mes corriente. */
    recaudado: suma(filas, 'pagado'),
    usuariosPagaron: filas.filter((f) => f.pagado > 0).length,
    recuperadoRetirados: suma(de('RETIRADO'), 'recuperado'),
    recuperadoActivados: suma(de('ACTIVADO'), 'recuperado'),
    recuperadoParciales: suma(de('PARCIAL'), 'recuperado'),
    recuperadoSinActivar: suma(de('PAGO_SIN_ACTIVAR'), 'recuperado'),
    usuariosPorCategoria: Object.fromEntries(CATEGORIAS.map((c) => [c.key, de(c.key).length])) as Record<Categoria, number>,
    /** Lo que sigue sin pagar de la deuda del día 1 (= inicial − recuperado). */
    deudaViejaPendiente: suma(filas, 'deudaVieja'),
    carteraFinal,
    /** Positivo = la cartera bajó. */
    diferencia: round2(carteraInicial - carteraFinal),
    /** Facturas nuevas del mes sin pagar, menos notas o depuraciones: final − deuda vieja pendiente. */
    otrosMovimientos: round2(carteraFinal - (carteraInicial - recuperado)),
    porcentajeRecuperado: carteraInicial > 0 ? round2((recuperado / carteraInicial) * 100) : 0,
  };
}

/** El reporte: resumen del mes, las cinco categorías, el detalle y la comparación mes a mes. */
export async function seguimientoCartera(prisma: PrismaService, opts: { mes?: string; sede?: string; categoria?: string }) {
  const disponibles = await prisma.carteraSeguimiento.findMany({ select: { mes: true }, distinct: ['mes'], orderBy: { mes: 'desc' } });
  const meses = disponibles.map((d) => d.mes.toISOString().slice(0, 10));
  const mes = opts.mes && meses.includes(primerDia(opts.mes)) ? primerDia(opts.mes) : meses[0];

  const sedes = (await prisma.branch.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }))
    .map((b) => ({ id: b.id, nombre: b.name }));
  const opciones = {
    meses: meses.map((m) => ({ value: m.slice(0, 7), label: nombreMes(m) })),
    sedes,
    categorias: CATEGORIAS.map((c) => ({ value: c.key, label: c.label })),
  };
  if (!mes) return { mes: null, vacio: true, opciones, comparativo: [], categorias: [], items: [], resumen: null };

  const { filas, abierto, reconstruido } = await filasDelMes(prisma, mes, opts.sede);

  const categorias = CATEGORIAS.map((c) => {
    const f = filas.filter((x) => x.categoria === c.key);
    return {
      ...c, usuarios: f.length,
      deudaInicial: round2(f.reduce((a, x) => a + x.deudaInicial, 0)),
      pagado: round2(f.reduce((a, x) => a + x.pagado, 0)),
      recuperado: round2(f.reduce((a, x) => a + x.recuperado, 0)),
      deudaVieja: round2(f.reduce((a, x) => a + x.deudaVieja, 0)),
      deudaFinal: round2(f.reduce((a, x) => a + x.deudaFinal, 0)),
    };
  });

  // Detalle: nombre, abonado y sede se leen de la ficha de hoy.
  const visibles = opts.categoria ? filas.filter((f) => f.categoria === opts.categoria) : filas;
  const fichas = await prisma.subscriber.findMany({
    where: { id: { in: visibles.map((f) => f.subscriberId) } },
    select: { id: true, abonado: true, firstName: true, lastName1: true, lastName2: true, fullName: true, companyName: true, branch: { select: { name: true } } },
  });
  const ficha = new Map(fichas.map((s) => [s.id, s]));
  const nombre = (s?: (typeof fichas)[number]) =>
    !s ? '—' : (s.companyName?.trim() || s.fullName?.trim() || [s.firstName, s.lastName1, s.lastName2].filter(Boolean).join(' ').trim() || '—');
  const items = visibles
    .map((f) => {
      const s = ficha.get(f.subscriberId);
      return {
        id: f.subscriberId, abonado: s?.abonado ?? null, nombre: nombre(s), sede: s?.branch?.name ?? 'Sin sede',
        estadoInicial: f.estadoInicial, estadoFinal: f.estadoFinal,
        deudaInicial: f.deudaInicial, pagado: f.pagado, recuperado: f.recuperado, pagos: f.pagos, deudaFinal: f.deudaFinal,
        deudaVieja: f.deudaVieja, deudaNueva: f.deudaNueva,
        categoria: f.categoria,
      };
    })
    .sort((a, b) => b.pagado - a.pagado || b.deudaInicial - a.deudaInicial);

  // Mes a mes (con la misma sede). Los cerrados salen de lo congelado; el abierto, en vivo.
  const comparativo = [];
  for (const m of meses) {
    const r = m === mes ? { filas, abierto } : await filasDelMes(prisma, m, opts.sede);
    comparativo.push({ mes: m.slice(0, 7), label: nombreMes(m), abierto: r.abierto, ...resumir(r.filas) });
  }

  return {
    mes: mes.slice(0, 7), mesLabel: nombreMes(mes), abierto, reconstruido,
    corteAl: abierto ? hoyEnColombia().toISOString().slice(0, 10) : ultimoDia(mes),
    sede: opts.sede ? sedes.find((s) => s.id === opts.sede)?.nombre ?? null : null,
    categoria: opts.categoria ?? null,
    resumen: resumir(filas), categorias, items, comparativo, opciones,
  };
}
