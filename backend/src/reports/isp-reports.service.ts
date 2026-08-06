import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Reportes propios de un ISP.
 *
 * Van aparte de `reports.service.ts` (que porta los del legacy) y de
 * `metrics.service.ts` (que es la memoria histórica): estos contestan preguntas del
 * NEGOCIO de vender internet — dónde puedo conectar, quién entra en ciclo de corte,
 * cuánto de lo que facturo entra de verdad, cuánto vale un cliente y cuánto dura.
 *
 * Cada uno se montó sobre datos que se verificaron ANTES de escribirlo. Los que no
 * pasaron esa comprobación no están aquí y no se inventaron: disponibilidad del
 * servicio (no hay registro de caídas), tiempo de reparación (no hay sellos de hora
 * fiables), consumo por cliente (no entra al ERP) y ventas por vendedor (el abonado
 * no tiene ese campo).
 */

/** Rango inclusivo por los dos extremos, como el resto de reportes. */
function rango(from?: string, to?: string) {
  const hoy = new Date().toISOString().slice(0, 10);
  const desde = from || `${hoy.slice(0, 4)}-01-01`;
  const hasta = to || hoy;
  return { desde, hasta };
}

const pct = (parte: number, total: number): number | null =>
  total > 0 ? Math.round((1000 * parte) / total) / 10 : null;

export class IspReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private async sedes() {
    const rows = await this.prisma.branch.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
    return rows.map((b) => ({ id: b.id, nombre: b.name }));
  }

  private async nombreSede(sede?: string) {
    if (!sede) return null;
    const b = await this.prisma.branch.findUnique({ where: { id: sede }, select: { name: true } });
    return b?.name ?? null;
  }

  /**
   * ÍNDICE DE RECAUDO: de lo que se factura, cuánto entra.
   *
   * El índice puede pasar del 100% y eso NO es un error: el recaudo de un mes incluye
   * pagos de facturas viejas. Un mes por encima de 100 significa que se está
   * recuperando cartera; varios meses por debajo, que la cartera está creciendo. Sin
   * esa aclaración el número se lee al revés.
   */
  async indiceRecaudo(from?: string, to?: string, sede?: string) {
    const { desde, hasta } = rango(from, to);
    const fSedeInv = sede ? Prisma.sql`AND s."branchId" = ${sede}` : Prisma.empty;
    const fSedeTx = sede ? Prisma.sql`AND sb."branchId" = ${sede}` : Prisma.empty;

    const filas = await this.prisma.$queryRaw<{ mes: string; facturado: number; recaudado: number; facturas: number }[]>`
      WITH f AS (
        SELECT to_char(date_trunc('month', i."invoiceDate"), 'YYYY-MM') mes,
               COALESCE(SUM(i.total), 0)::float facturado, COUNT(*)::int facturas
          FROM "SubInvoice" i LEFT JOIN "Subscriber" s ON s.id = i."subscriberId"
         WHERE i.status <> 'CANCELED' AND i."invoiceDate" BETWEEN ${desde}::date AND ${hasta}::date ${fSedeInv}
         GROUP BY 1
      ), r AS (
        SELECT to_char(date_trunc('month', t.date), 'YYYY-MM') mes,
               COALESCE(SUM(t.credit), 0)::float recaudado
          FROM "Transaction" t LEFT JOIN "Subscriber" sb ON sb.id = t."subscriberId"
         WHERE t.status = 'VIGENTE' AND t.type = 'INCOME'
           AND t.date BETWEEN ${desde}::date AND ${hasta}::date ${fSedeTx}
         GROUP BY 1
      )
      SELECT COALESCE(f.mes, r.mes) mes,
             COALESCE(f.facturado, 0) facturado,
             COALESCE(r.recaudado, 0) recaudado,
             COALESCE(f.facturas, 0) facturas
        FROM f FULL OUTER JOIN r ON r.mes = f.mes
       ORDER BY 1`;

    const items = filas.map((r) => ({
      mes: r.mes,
      facturado: Number(r.facturado), recaudado: Number(r.recaudado), facturas: Number(r.facturas),
      indice: pct(Number(r.recaudado), Number(r.facturado)),
      diferencia: Number(r.recaudado) - Number(r.facturado),
    }));
    const facturado = items.reduce((s, r) => s + r.facturado, 0);
    const recaudado = items.reduce((s, r) => s + r.recaudado, 0);

    return {
      desde, hasta, sede: await this.nombreSede(sede),
      totales: { facturado, recaudado, indice: pct(recaudado, facturado), diferencia: recaudado - facturado },
      items,
      opciones: { sedes: await this.sedes() },
    };
  }

  /**
   * ARPU: cuánto deja cada cliente al mes.
   *
   * El divisor NO es "abonados activos" sino los abonados DISTINTOS facturados en el
   * mes. Es a propósito: el estado activo de un mes pasado no se puede reconstruir
   * (el historial del ERP no es fiable, 12% de desfase), mientras que "a quién le
   * facturé" sale de las facturas y es auditable. Además es el divisor correcto para
   * un ISP: mide sobre la base que efectivamente generó cobro.
   */
  async arpu(from?: string, to?: string, sede?: string) {
    const { desde, hasta } = rango(from, to);
    const fSedeInv = sede ? Prisma.sql`AND s."branchId" = ${sede}` : Prisma.empty;
    const fSedeTx = sede ? Prisma.sql`AND sb."branchId" = ${sede}` : Prisma.empty;

    const filas = await this.prisma.$queryRaw<{ mes: string; abonados: number; facturado: number; recaudado: number }[]>`
      WITH f AS (
        SELECT to_char(date_trunc('month', i."invoiceDate"), 'YYYY-MM') mes,
               COUNT(DISTINCT i."subscriberId")::int abonados,
               COALESCE(SUM(i.total), 0)::float facturado
          FROM "SubInvoice" i LEFT JOIN "Subscriber" s ON s.id = i."subscriberId"
         WHERE i.status <> 'CANCELED' AND i."invoiceDate" BETWEEN ${desde}::date AND ${hasta}::date ${fSedeInv}
         GROUP BY 1
      ), r AS (
        SELECT to_char(date_trunc('month', t.date), 'YYYY-MM') mes,
               COALESCE(SUM(t.credit), 0)::float recaudado
          FROM "Transaction" t LEFT JOIN "Subscriber" sb ON sb.id = t."subscriberId"
         WHERE t.status = 'VIGENTE' AND t.type = 'INCOME'
           AND t.date BETWEEN ${desde}::date AND ${hasta}::date ${fSedeTx}
         GROUP BY 1
      )
      SELECT f.mes, f.abonados, f.facturado, COALESCE(r.recaudado, 0) recaudado
        FROM f LEFT JOIN r ON r.mes = f.mes ORDER BY 1`;

    const items = filas.map((r) => {
      const ab = Number(r.abonados) || 0;
      return {
        mes: r.mes, abonados: ab,
        facturado: Number(r.facturado), recaudado: Number(r.recaudado),
        arpuFacturado: ab ? Math.round(Number(r.facturado) / ab) : null,
        arpuRecaudado: ab ? Math.round(Number(r.recaudado) / ab) : null,
      };
    });
    const ultimo = items.at(-1) ?? null;
    const primero = items[0] ?? null;

    return {
      desde, hasta, sede: await this.nombreSede(sede),
      items,
      resumen: {
        ultimoMes: ultimo?.mes ?? null,
        arpuActual: ultimo?.arpuRecaudado ?? null,
        arpuFacturadoActual: ultimo?.arpuFacturado ?? null,
        abonadosActual: ultimo?.abonados ?? null,
        variacionPct: primero?.arpuRecaudado && ultimo?.arpuRecaudado
          ? Math.round(((ultimo.arpuRecaudado - primero.arpuRecaudado) / primero.arpuRecaudado) * 1000) / 10
          : null,
      },
      opciones: { sedes: await this.sedes() },
    };
  }

  /**
   * CAPACIDAD DE RED: dónde se puede conectar sin obra.
   *
   * Es el reporte que decide si una venta se puede instalar mañana o hay que ampliar
   * una caja. `portCount` de la NAP es la capacidad declarada; los puertos reales son
   * las filas de `Port`. Se muestran los dos porque no siempre coinciden, y esa
   * diferencia es en sí una alerta (una NAP con menos puertos registrados que su
   * capacidad tiene trabajo de inventario pendiente).
   */
  async capacidadRed(sede?: string) {
    const fSede = sede ? Prisma.sql`WHERE n."branchId" = ${sede}` : Prisma.empty;

    const naps = await this.prisma.$queryRaw<{
      id: string; nap: string; sede: string; direccion: string | null;
      capacidad: number; puertos: number; ocupados: number; libres: number;
    }[]>`
      SELECT n.id, n.name nap, COALESCE(b.name, 'Sin sede') sede, n.address direccion,
             COALESCE(n."portCount", 0)::int capacidad,
             COUNT(p.id)::int puertos,
             COUNT(p.id) FILTER (WHERE p.status = 'Ocupado')::int ocupados,
             COUNT(p.id) FILTER (WHERE p.status = 'Disponible')::int libres
        FROM "Nap" n
        LEFT JOIN "Branch" b ON b.id = n."branchId"
        LEFT JOIN "Port" p ON p."napId" = n.id
        ${fSede}
       GROUP BY n.id, n.name, b.name, n.address, n."portCount"
       ORDER BY COUNT(p.id) FILTER (WHERE p.status = 'Disponible') ASC, n.name ASC`;

    const items = naps.map((n) => ({
      ...n,
      ocupacionPct: pct(n.ocupados, n.puertos),
      saturada: n.puertos > 0 && n.libres === 0,
      // Sin puertos registrados no se puede decir si está llena o vacía: es un vacío
      // de inventario, y se marca como tal en vez de contarla como "disponible".
      sinInventario: n.puertos === 0,
    }));

    const conPuertos = items.filter((n) => !n.sinInventario);
    const totalPuertos = conPuertos.reduce((s, n) => s + n.puertos, 0);
    const libres = conPuertos.reduce((s, n) => s + n.libres, 0);
    const ocupados = conPuertos.reduce((s, n) => s + n.ocupados, 0);

    // Por sede: es como se decide dónde hay que invertir en obra.
    const porSede = new Map<string, { sede: string; naps: number; libres: number; ocupados: number; saturadas: number }>();
    for (const n of conPuertos) {
      const a = porSede.get(n.sede) ?? { sede: n.sede, naps: 0, libres: 0, ocupados: 0, saturadas: 0 };
      a.naps++; a.libres += n.libres; a.ocupados += n.ocupados; if (n.saturada) a.saturadas++;
      porSede.set(n.sede, a);
    }

    return {
      sede: await this.nombreSede(sede),
      resumen: {
        naps: items.length,
        napsConInventario: conPuertos.length,
        sinInventario: items.length - conPuertos.length,
        puertos: totalPuertos, libres, ocupados,
        ocupacionPct: pct(ocupados, totalPuertos),
        saturadas: conPuertos.filter((n) => n.saturada).length,
        casiLlenas: conPuertos.filter((n) => !n.saturada && (n.ocupacionPct ?? 0) >= 90).length,
      },
      porSede: [...porSede.values()].sort((a, b) => a.libres - b.libres),
      // Las que primero hay que mirar. Se ordenan por CUÁNTA gente hay colgando
      // (puertos ocupados), no por porcentaje: una NAP con un único puerto y ese
      // puerto ocupado sale al 100% pero no le bloquea una venta a nadie, y encabezar
      // el listado con esas esconde las cajas de 16 puertos que sí están llenas.
      criticas: items
        .filter((n) => !n.sinInventario && (n.saturada || (n.ocupacionPct ?? 0) >= 90))
        .sort((a, b) => b.ocupados - a.ocupados)
        .slice(0, 60),
      opciones: { sedes: await this.sedes() },
    };
  }

  /**
   * REINCIDENCIA DE CORTES Y RECONEXIONES.
   *
   * Separa dos cosas que hoy se confunden en el volumen de órdenes: el cliente que
   * entra en ciclo cortar-reconectar todos los meses (eso es COBRANZA, no técnica) y
   * el que reincide de verdad. El ciclo se mide por reconexiones, que es la orden que
   * marca "volvió a pagar después de que se le cortó".
   */
  async reincidencia(from?: string, to?: string, sede?: string) {
    const { desde, hasta } = rango(from, to);
    const fSede = sede ? Prisma.sql`AND s."branchId" = ${sede}` : Prisma.empty;

    const filas = await this.prisma.$queryRaw<{
      id: string; abonado: number | null; cliente: string | null; sede: string;
      estado: string; reconexiones: number; cortes: number; ultima: Date | null; deuda: number;
    }[]>`
      SELECT s.id, s.abonado,
             COALESCE(NULLIF(TRIM(s."fullName"), ''),
                      NULLIF(TRIM(CONCAT(s."firstName", ' ', s."lastName1")), ''),
                      NULLIF(TRIM(s."companyName"), '')) cliente,
             COALESCE(b.name, 'Sin sede') sede, s.status::text estado,
             COUNT(*) FILTER (WHERE k.type ILIKE 'Reconexion%')::int reconexiones,
             COUNT(*) FILTER (WHERE k.type ILIKE 'Corte%')::int cortes,
             MAX(k.created) ultima,
             COALESCE((SELECT SUM(i.total - i."paidAmount") FROM "SubInvoice" i
                        WHERE i."subscriberId" = s.id AND i.status IN ('DUE','PARTIAL')), 0)::float deuda
        FROM "Ticket" k
        JOIN "Subscriber" s ON s.id = k."subscriberId"
        LEFT JOIN "Branch" b ON b.id = s."branchId"
       WHERE (k.type ILIKE 'Reconexion%' OR k.type ILIKE 'Corte%')
         AND k.created BETWEEN ${desde}::date AND ${hasta}::date
         ${fSede}
       GROUP BY s.id, s.abonado, cliente, b.name, s.status
      HAVING COUNT(*) FILTER (WHERE k.type ILIKE 'Reconexion%') >= 1
       ORDER BY 6 DESC
       LIMIT 100`;

    const items = filas.map((r) => ({
      id: r.id, abonado: r.abonado, cliente: r.cliente ?? `Abonado ${r.abonado ?? '—'}`,
      sede: r.sede, estado: r.estado,
      reconexiones: Number(r.reconexiones), cortes: Number(r.cortes),
      ultima: r.ultima, deuda: Number(r.deuda),
    }));

    // ⚠️ El RESUMEN y la DISTRIBUCIÓN se calculan aparte, SIN el límite.
    // La primera versión los sacaba de la lista recortada a 200 filas y el resultado
    // era una mentira redonda: decía "200 clientes, todos crónicos" cuando esos 200
    // eran solo la cola peor, y la distribución empezaba en 10 reconexiones porque
    // los que tuvieron 1 o 2 ni aparecían. La lista es una MUESTRA; los totales
    // tienen que salir del universo entero.
    const agregado = await this.prisma.$queryRaw<{
      veces: number; clientes: number; reconexiones: number; cortes: number; deuda: number;
    }[]>`
      WITH porCliente AS (
        SELECT s.id,
               COUNT(*) FILTER (WHERE k.type ILIKE 'Reconexion%')::int reconexiones,
               COUNT(*) FILTER (WHERE k.type ILIKE 'Corte%')::int cortes,
               COALESCE((SELECT SUM(i.total - i."paidAmount") FROM "SubInvoice" i
                          WHERE i."subscriberId" = s.id AND i.status IN ('DUE','PARTIAL')), 0)::float deuda
          FROM "Ticket" k
          JOIN "Subscriber" s ON s.id = k."subscriberId"
         WHERE (k.type ILIKE 'Reconexion%' OR k.type ILIKE 'Corte%')
           AND k.created BETWEEN ${desde}::date AND ${hasta}::date
           ${fSede}
         GROUP BY s.id
        HAVING COUNT(*) FILTER (WHERE k.type ILIKE 'Reconexion%') >= 1
      )
      SELECT reconexiones veces, COUNT(*)::int clientes,
             SUM(reconexiones)::int reconexiones, SUM(cortes)::int cortes,
             SUM(deuda)::float deuda
        FROM porCliente GROUP BY reconexiones
       -- ORDER BY 1 y no "reconexiones": ese nombre lo resuelve Postgres contra la
       -- columna de salida (que es el SUM), no contra la de agrupación, y la
       -- distribución salía desordenada (15, 14, 13, 1, 11…).
       ORDER BY 1`;

    const cronicos = agregado.filter((a) => Number(a.veces) >= 3);
    return {
      desde, hasta, sede: await this.nombreSede(sede),
      resumen: {
        clientes: agregado.reduce((s2, a) => s2 + Number(a.clientes), 0),
        reconexiones: agregado.reduce((s2, a) => s2 + Number(a.reconexiones), 0),
        cortes: agregado.reduce((s2, a) => s2 + Number(a.cortes), 0),
        cronicos: cronicos.reduce((s2, a) => s2 + Number(a.clientes), 0),
        deudaCronicos: cronicos.reduce((s2, a) => s2 + Number(a.deuda), 0),
      },
      distribucion: agregado.map((a) => ({ veces: Number(a.veces), clientes: Number(a.clientes) })),
      /** MUESTRA: los 100 con más reconexiones. Los totales de arriba NO salen de aquí. */
      items,
      opciones: { sedes: await this.sedes() },
    };
  }

  /**
   * ANTIGÜEDAD Y PERMANENCIA por cohorte de ingreso.
   *
   * `Subscriber.entryDate` es de las pocas fechas totalmente fiables de esta base, y
   * el estado ACTUAL también: cruzándolos se sabe, de los que entraron en cada año,
   * cuántos siguen. Lo que NO se puede es decir CUÁNDO se fueron (eso exigiría el
   * historial de estados, que no es fiable), así que este reporte habla de
   * supervivencia hasta hoy, no de curva de abandono mes a mes.
   */
  async permanencia(sede?: string) {
    const fSede = sede ? Prisma.sql`WHERE s."branchId" = ${sede}` : Prisma.empty;

    const filas = await this.prisma.$queryRaw<{
      anio: string; ingresaron: number; activos: number; retirados: number; otros: number;
    }[]>`
      SELECT to_char(date_trunc('year', s."entryDate"), 'YYYY') anio,
             COUNT(*)::int ingresaron,
             COUNT(*) FILTER (WHERE s.status = 'ACTIVO')::int activos,
             COUNT(*) FILTER (WHERE s.status IN ('RETIRADO','DEPURADO'))::int retirados,
             COUNT(*) FILTER (WHERE s.status NOT IN ('ACTIVO','RETIRADO','DEPURADO'))::int otros
        FROM "Subscriber" s
        ${fSede}
       ${sede ? Prisma.raw('AND') : Prisma.raw('WHERE')} s."entryDate" IS NOT NULL
       GROUP BY 1 ORDER BY 1`;

    const cohortes = filas.map((r) => ({
      anio: r.anio,
      ingresaron: Number(r.ingresaron), activos: Number(r.activos),
      retirados: Number(r.retirados), otros: Number(r.otros),
      retencionPct: pct(Number(r.activos), Number(r.ingresaron)),
    }));

    const antiguedad = await this.prisma.$queryRaw<{ meses: number; n: number }[]>`
      SELECT WIDTH_BUCKET(EXTRACT(YEAR FROM AGE(CURRENT_DATE, s."entryDate")) * 12
                        + EXTRACT(MONTH FROM AGE(CURRENT_DATE, s."entryDate")), 0, 120, 10)::int meses,
             COUNT(*)::int n
        FROM "Subscriber" s
       WHERE s.status = 'ACTIVO' AND s."entryDate" IS NOT NULL
       ${sede ? Prisma.sql`AND s."branchId" = ${sede}` : Prisma.empty}
       GROUP BY 1 ORDER BY 1`;

    const media = await this.prisma.$queryRaw<{ meses: number }[]>`
      SELECT COALESCE(AVG(EXTRACT(YEAR FROM AGE(CURRENT_DATE, s."entryDate")) * 12
                        + EXTRACT(MONTH FROM AGE(CURRENT_DATE, s."entryDate"))), 0)::float meses
        FROM "Subscriber" s
       WHERE s.status = 'ACTIVO' AND s."entryDate" IS NOT NULL
       ${sede ? Prisma.sql`AND s."branchId" = ${sede}` : Prisma.empty}`;

    const sinFecha = await this.prisma.subscriber.count({ where: { entryDate: null } });

    return {
      sede: await this.nombreSede(sede),
      cohortes,
      resumen: {
        antiguedadMediaMeses: Math.round((media[0]?.meses ?? 0) * 10) / 10,
        cohortes: cohortes.length,
        sinFechaIngreso: sinFecha,
      },
      // Cada tramo son 12 meses (el bucket va de 0 a 120 en 10 escalones).
      antiguedad: antiguedad.map((a) => ({
        tramo: a.meses >= 11 ? 'Más de 10 años' : `${(a.meses - 1) * 12}–${a.meses * 12} meses`,
        clientes: Number(a.n),
      })),
      opciones: { sedes: await this.sedes() },
    };
  }
}
