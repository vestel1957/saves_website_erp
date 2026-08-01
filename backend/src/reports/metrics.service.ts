import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * La memoria histórica de la empresa.
 *
 * El ERP sabe cómo están las cosas HOY, pero no cómo estaban en enero. Eso salió a la
 * luz cuando se pidió "cuántos usuarios activos teníamos a principio de año" y no
 * había forma honesta de contestarlo: el log de cambios de estado no registra todos
 * los cambios (12% de desfase medido) y reconstruir desde ahí da una cifra falsa con
 * pinta de exacta.
 *
 * Aquí no se deduce nada: cada noche se fotografía el estado y se guarda
 * (`fotoDelDia`). Y para el pasado se rellena SOLO lo que tiene una fuente fiable
 * (`rellenarHistorico`), dejando fuera lo que no — que un hueco se vea es el punto.
 */

/** Catálogo de métricas. La clave es estable: se guarda en BD y se consulta por ella. */
export const METRICAS = {
  // Estado de la base — foto diaria. NO reconstruible hacia atrás.
  ABONADOS_TOTAL: 'abonados.total',
  ABONADOS_ACTIVOS: 'abonados.activos',
  ABONADOS_CORTADOS: 'abonados.cortados',
  ABONADOS_CARTERA: 'abonados.cartera',
  ABONADOS_RETIRADOS: 'abonados.retirados',
  CARTERA_TOTAL: 'cartera.total',
  CARTERA_FACTURAS: 'cartera.facturas',
  CARTERA_MORA_90: 'cartera.mora90',
  // Flujo del día — SÍ reconstruible: sus fuentes llevan fecha propia y fiable.
  RECAUDO: 'recaudo.total',
  RECAUDO_MOVIMIENTOS: 'recaudo.movimientos',
  FACTURADO: 'facturacion.monto',
  FACTURAS: 'facturacion.facturas',
  ALTAS: 'clientes.altas',
  ORDENES: 'ordenes.creadas',
  // Mensual: un conteo DISTINTO no se puede sumar día a día.
  BASE_FACTURABLE: 'facturacion.abonados',
} as const;

/** Las que solo existen desde que empezó a correr el cron. Se declaran para poder avisar. */
export const NO_RECONSTRUIBLES: string[] = [
  METRICAS.ABONADOS_TOTAL, METRICAS.ABONADOS_ACTIVOS, METRICAS.ABONADOS_CORTADOS,
  METRICAS.ABONADOS_CARTERA, METRICAS.ABONADOS_RETIRADOS,
  METRICAS.CARTERA_TOTAL, METRICAS.CARTERA_FACTURAS, METRICAS.CARTERA_MORA_90,
];

/** Etiqueta legible de cada métrica, para reportes y chat. */
export const ETIQUETA: Record<string, string> = {
  [METRICAS.ABONADOS_TOTAL]: 'Abonados en total',
  [METRICAS.ABONADOS_ACTIVOS]: 'Abonados activos',
  [METRICAS.ABONADOS_CORTADOS]: 'Abonados cortados',
  [METRICAS.ABONADOS_CARTERA]: 'Abonados en cartera',
  [METRICAS.ABONADOS_RETIRADOS]: 'Abonados retirados',
  [METRICAS.CARTERA_TOTAL]: 'Cartera',
  [METRICAS.CARTERA_FACTURAS]: 'Facturas en mora',
  [METRICAS.CARTERA_MORA_90]: 'Cartera a más de 90 días',
  [METRICAS.RECAUDO]: 'Recaudo',
  [METRICAS.RECAUDO_MOVIMIENTOS]: 'Movimientos de recaudo',
  [METRICAS.FACTURADO]: 'Facturado',
  [METRICAS.FACTURAS]: 'Facturas emitidas',
  [METRICAS.ALTAS]: 'Altas de clientes',
  [METRICAS.ORDENES]: 'Órdenes creadas',
  [METRICAS.BASE_FACTURABLE]: 'Base facturable (abonados con factura)',
};

/**
 * Métricas que NO se pueden SUMAR a lo largo del tiempo.
 *
 * Son de dos clases y por el mismo motivo de fondo: cada punto ya es un total, no un
 * trozo. Los ESTADOS (cuántos abonados hay hoy) porque sumar la foto de cada día da
 * el número de abonados multiplicado por los días; y la BASE FACTURABLE porque es un
 * conteo de abonados DISTINTOS por mes — el mismo cliente aparece en enero y en
 * febrero, así que sumar los meses lo cuenta dos veces. En un rango, el valor de
 * estas métricas es el del ÚLTIMO periodo medido, nunca la suma.
 *
 * Lo destapó el PDF de tendencias: titulaba "Total del periodo: 37.084" para una
 * base facturable que en realidad nunca pasó de 5.368.
 */
export const NO_SUMABLES: string[] = [
  METRICAS.ABONADOS_TOTAL, METRICAS.ABONADOS_ACTIVOS, METRICAS.ABONADOS_CORTADOS,
  METRICAS.ABONADOS_CARTERA, METRICAS.ABONADOS_RETIRADOS,
  METRICAS.CARTERA_TOTAL, METRICAS.CARTERA_FACTURAS, METRICAS.CARTERA_MORA_90,
  METRICAS.BASE_FACTURABLE,
];

/** Métricas que son plata (para formatearlas como tal). */
export const ES_DINERO = new Set<string>([
  METRICAS.CARTERA_TOTAL, METRICAS.CARTERA_MORA_90, METRICAS.RECAUDO, METRICAS.FACTURADO,
]);

const iso = (d: Date) => d.toISOString().slice(0, 10);
/** Día UTC a partir de 'YYYY-MM-DD' — la columna es `date`, sin hora. */
const dia = (s: string) => new Date(`${s}T00:00:00.000Z`);

export type Punto = { fecha: string; valor: number };

@Injectable()
export class MetricsService {
  private readonly logger = new Logger('Metrics');

  constructor(private readonly prisma: PrismaService) {}

  // ── Escritura ───────────────────────────────────────────────────────────────

  /** Guarda (o pisa) un punto. Idempotente: repetir la foto de un día no duplica. */
  private async guardar(
    fecha: Date, metrica: string, valor: number, sede = '', periodo: 'D' | 'M' = 'D',
  ): Promise<void> {
    await this.prisma.metricPoint.upsert({
      where: { fecha_periodo_metrica_sede: { fecha, periodo, metrica, sede } },
      create: { fecha, periodo, metrica, sede, valor },
      update: { valor },
    });
  }

  /**
   * Fotografía un día completo: el estado de la base a esa fecha y el flujo de ese día.
   *
   * Se llama con la fecha de AYER desde el cron nocturno (el día ya cerrado), y sin
   * argumento fotografía hoy. Ojo con el matiz: el ESTADO siempre es el de este
   * instante —no se puede fotografiar el pasado—, así que pedirle una fecha vieja solo
   * tiene sentido para el FLUJO. Por eso `rellenarHistorico` no llama a esto.
   */
  async fotoDelDia(fechaISO?: string): Promise<{ fecha: string; metricas: number }> {
    const f = fechaISO ?? iso(new Date());
    const fecha = dia(f);
    const desde = new Date(`${f}T00:00:00.000Z`);
    const hasta = new Date(`${f}T23:59:59.999Z`);

    const [porEstado, cartera, aging, recaudo, facturado, altas, ordenes, sedes] = await Promise.all([
      this.prisma.subscriber.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.subInvoice.aggregate({
        _sum: { total: true, paidAmount: true }, _count: { _all: true },
        where: { status: { in: ['DUE', 'PARTIAL'] } },
      }),
      this.prisma.$queryRaw<{ d90: number }[]>`
        SELECT COALESCE(SUM(total - "paidAmount"), 0)::float d90 FROM "SubInvoice"
         WHERE status IN ('DUE','PARTIAL') AND (CURRENT_DATE - "dueDate") > 90`,
      this.prisma.transaction.aggregate({
        _sum: { credit: true }, _count: { _all: true },
        where: { status: 'VIGENTE', type: 'INCOME', date: { gte: desde, lte: hasta } },
      }),
      this.prisma.subInvoice.aggregate({
        _sum: { total: true }, _count: { _all: true },
        where: { invoiceDate: { gte: desde, lte: hasta }, status: { not: 'CANCELED' } },
      }),
      this.prisma.subscriber.count({ where: { entryDate: { gte: desde, lte: hasta } } }),
      this.prisma.ticket.count({ where: { created: { gte: desde, lte: hasta } } }),
      this.prisma.branch.findMany({ select: { id: true } }),
    ]);

    const estado = (s: string) => porEstado.find((r) => r.status === s)?._count._all ?? 0;
    const puntos: [string, number][] = [
      [METRICAS.ABONADOS_TOTAL, porEstado.reduce((a, r) => a + r._count._all, 0)],
      [METRICAS.ABONADOS_ACTIVOS, estado('ACTIVO')],
      [METRICAS.ABONADOS_CORTADOS, estado('CORTADO')],
      [METRICAS.ABONADOS_CARTERA, estado('CARTERA')],
      [METRICAS.ABONADOS_RETIRADOS, estado('RETIRADO')],
      [METRICAS.CARTERA_TOTAL, Number(cartera._sum.total ?? 0) - Number(cartera._sum.paidAmount ?? 0)],
      [METRICAS.CARTERA_FACTURAS, cartera._count._all],
      [METRICAS.CARTERA_MORA_90, Number(aging[0]?.d90 ?? 0)],
      [METRICAS.RECAUDO, Number(recaudo._sum.credit ?? 0)],
      [METRICAS.RECAUDO_MOVIMIENTOS, recaudo._count._all],
      [METRICAS.FACTURADO, Number(facturado._sum.total ?? 0)],
      [METRICAS.FACTURAS, facturado._count._all],
      [METRICAS.ALTAS, altas],
      [METRICAS.ORDENES, ordenes],
    ];
    for (const [m, v] of puntos) await this.guardar(fecha, m, v);

    // Y lo mismo por sede: sin esto solo se puede comparar la empresa entera, y la
    // pregunta real casi siempre es "¿cómo viene Villanueva contra el año pasado?".
    for (const s of sedes) {
      const [act, cart, rec, ord, alt] = await Promise.all([
        this.prisma.subscriber.count({ where: { branchId: s.id, status: 'ACTIVO' } }),
        this.prisma.subInvoice.aggregate({
          _sum: { total: true, paidAmount: true },
          where: { status: { in: ['DUE', 'PARTIAL'] }, subscriber: { branchId: s.id } },
        }),
        this.prisma.transaction.aggregate({
          _sum: { credit: true },
          where: { status: 'VIGENTE', type: 'INCOME', date: { gte: desde, lte: hasta }, subscriber: { branchId: s.id } },
        }),
        this.prisma.ticket.count({ where: { created: { gte: desde, lte: hasta }, subscriber: { branchId: s.id } } }),
        this.prisma.subscriber.count({ where: { branchId: s.id, entryDate: { gte: desde, lte: hasta } } }),
      ]);
      await this.guardar(fecha, METRICAS.ABONADOS_ACTIVOS, act, s.id);
      await this.guardar(fecha, METRICAS.CARTERA_TOTAL, Number(cart._sum.total ?? 0) - Number(cart._sum.paidAmount ?? 0), s.id);
      await this.guardar(fecha, METRICAS.RECAUDO, Number(rec._sum.credit ?? 0), s.id);
      await this.guardar(fecha, METRICAS.ORDENES, ord, s.id);
      await this.guardar(fecha, METRICAS.ALTAS, alt, s.id);
    }

    return { fecha: f, metricas: puntos.length + sedes.length * 5 };
  }

  /**
   * Rellena el pasado con lo que SÍ tiene fuente fiable.
   *
   * Lo que se rellena y por qué se puede: recaudo y facturación salen de documentos
   * con fecha propia y auditada (es plata); las altas, de `Subscriber.entryDate`; las
   * órdenes, de `Ticket.created`. Ninguna depende del log de estados.
   *
   * Lo que NO se rellena: todo lo de `NO_RECONSTRUIBLES` (cuántos activos, cortados o
   * en cartera había ese día). Se deja el hueco a propósito. Meter ahí la
   * reconstrucción del log —que va 12% desviada— sería sembrar de números falsos la
   * tabla que después nadie va a volver a cuestionar.
   */
  async rellenarHistorico(desdeISO: string, hastaISO?: string): Promise<{ dias: number; meses: number; puntos: number }> {
    const desde = dia(desdeISO);
    const hasta = hastaISO ? dia(hastaISO) : dia(iso(new Date()));
    let puntos = 0;

    const sedes = await this.prisma.branch.findMany({ select: { id: true } });

    /** Vuelca el resultado de una consulta agrupada por día en la tabla. */
    const volcar = async (filas: { f: Date; v: number }[], metrica: string, sede = '') => {
      for (const r of filas) {
        if (!r.f) continue;
        await this.guardar(dia(iso(new Date(r.f))), metrica, Number(r.v) || 0, sede);
        puntos++;
      }
    };

    // ── Consolidado de la empresa ──
    await volcar(await this.prisma.$queryRaw<{ f: Date; v: number }[]>`
      SELECT date AS f, COALESCE(SUM(credit),0)::float v FROM "Transaction"
       WHERE status='VIGENTE' AND type='INCOME' AND date BETWEEN ${desde} AND ${hasta}
       GROUP BY date`, METRICAS.RECAUDO);
    await volcar(await this.prisma.$queryRaw<{ f: Date; v: number }[]>`
      SELECT date AS f, COUNT(*)::float v FROM "Transaction"
       WHERE status='VIGENTE' AND type='INCOME' AND date BETWEEN ${desde} AND ${hasta}
       GROUP BY date`, METRICAS.RECAUDO_MOVIMIENTOS);
    await volcar(await this.prisma.$queryRaw<{ f: Date; v: number }[]>`
      SELECT "invoiceDate" AS f, COALESCE(SUM(total),0)::float v FROM "SubInvoice"
       WHERE status <> 'CANCELED' AND "invoiceDate" BETWEEN ${desde} AND ${hasta}
       GROUP BY "invoiceDate"`, METRICAS.FACTURADO);
    await volcar(await this.prisma.$queryRaw<{ f: Date; v: number }[]>`
      SELECT "invoiceDate" AS f, COUNT(*)::float v FROM "SubInvoice"
       WHERE status <> 'CANCELED' AND "invoiceDate" BETWEEN ${desde} AND ${hasta}
       GROUP BY "invoiceDate"`, METRICAS.FACTURAS);
    await volcar(await this.prisma.$queryRaw<{ f: Date; v: number }[]>`
      SELECT "entryDate" AS f, COUNT(*)::float v FROM "Subscriber"
       WHERE "entryDate" BETWEEN ${desde} AND ${hasta} GROUP BY "entryDate"`, METRICAS.ALTAS);
    await volcar(await this.prisma.$queryRaw<{ f: Date; v: number }[]>`
      SELECT created AS f, COUNT(*)::float v FROM "Ticket"
       WHERE created BETWEEN ${desde} AND ${hasta} GROUP BY created`, METRICAS.ORDENES);

    // ── Por sede ──
    for (const s of sedes) {
      await volcar(await this.prisma.$queryRaw<{ f: Date; v: number }[]>`
        SELECT t.date AS f, COALESCE(SUM(t.credit),0)::float v FROM "Transaction" t
          JOIN "Subscriber" sb ON sb.id = t."subscriberId"
         WHERE t.status='VIGENTE' AND t.type='INCOME' AND sb."branchId" = ${s.id}
           AND t.date BETWEEN ${desde} AND ${hasta} GROUP BY t.date`, METRICAS.RECAUDO, s.id);
      await volcar(await this.prisma.$queryRaw<{ f: Date; v: number }[]>`
        SELECT k.created AS f, COUNT(*)::float v FROM "Ticket" k
          JOIN "Subscriber" sb ON sb.id = k."subscriberId"
         WHERE sb."branchId" = ${s.id} AND k.created BETWEEN ${desde} AND ${hasta}
         GROUP BY k.created`, METRICAS.ORDENES, s.id);
      await volcar(await this.prisma.$queryRaw<{ f: Date; v: number }[]>`
        SELECT sb."entryDate" AS f, COUNT(*)::float v FROM "Subscriber" sb
         WHERE sb."branchId" = ${s.id} AND sb."entryDate" BETWEEN ${desde} AND ${hasta}
         GROUP BY sb."entryDate"`, METRICAS.ALTAS, s.id);
    }

    // ── Base facturable, mensual ──
    // Es un conteo DISTINTO de abonados: no se puede sumar día a día, así que va con
    // periodo 'M' en el primer día del mes. Es la serie que sí contesta "cuántos
    // teníamos en enero" con una fuente fiable.
    const mensual = await this.prisma.$queryRaw<{ f: Date; v: number }[]>`
      SELECT date_trunc('month', "invoiceDate")::date AS f,
             COUNT(DISTINCT "subscriberId")::float v
        FROM "SubInvoice"
       WHERE status <> 'CANCELED' AND "invoiceDate" BETWEEN ${desde} AND ${hasta}
       GROUP BY 1`;
    let meses = 0;
    for (const r of mensual) {
      await this.guardar(dia(iso(new Date(r.f))), METRICAS.BASE_FACTURABLE, Number(r.v) || 0, '', 'M');
      meses++; puntos++;
    }

    const dias = Math.round((hasta.getTime() - desde.getTime()) / 86400_000) + 1;
    this.logger.log(`Histórico rellenado: ${puntos} puntos (${dias} días, ${meses} meses) desde ${desdeISO}.`);
    return { dias, meses, puntos };
  }

  // ── Lectura ─────────────────────────────────────────────────────────────────

  /** Serie de una métrica entre dos fechas. Agrupa por día o por mes. */
  async serie(
    metrica: string, desdeISO: string, hastaISO: string,
    opts: { sede?: string; agrupar?: 'dia' | 'mes' } = {},
  ): Promise<Punto[]> {
    const sede = opts.sede ?? '';
    const periodo = metrica === METRICAS.BASE_FACTURABLE ? 'M' : 'D';
    const filas = await this.prisma.metricPoint.findMany({
      where: { metrica, sede, periodo, fecha: { gte: dia(desdeISO), lte: dia(hastaISO) } },
      orderBy: { fecha: 'asc' },
      select: { fecha: true, valor: true },
    });
    if (opts.agrupar !== 'mes' || periodo === 'M') {
      return filas.map((f) => ({ fecha: iso(f.fecha), valor: f.valor }));
    }
    // Agrupar por mes: los flujos se SUMAN, los estados se toman del último día del
    // mes (sumar "cuántos activos había" cada día daría un número sin sentido).
    const esEstado = NO_SUMABLES.includes(metrica);
    const porMes = new Map<string, number>();
    for (const f of filas) {
      const k = iso(f.fecha).slice(0, 7);
      porMes.set(k, esEstado ? f.valor : (porMes.get(k) ?? 0) + f.valor);
    }
    return [...porMes.entries()].map(([k, valor]) => ({ fecha: `${k}-01`, valor }));
  }

  /**
   * Compara dos periodos de una métrica y devuelve la variación.
   *
   * Si a alguno de los dos lados le faltan datos se dice explícitamente: comparar
   * contra un periodo sin fotos daría una caída del 100% que no ocurrió.
   */
  async comparar(
    metrica: string,
    a: { desde: string; hasta: string },
    b: { desde: string; hasta: string },
    sede?: string,
  ) {
    const [sa, sb] = await Promise.all([
      this.serie(metrica, a.desde, a.hasta, { sede }),
      this.serie(metrica, b.desde, b.hasta, { sede }),
    ]);
    const esEstado = NO_SUMABLES.includes(metrica);
    // Un estado no se suma: el valor del periodo es el del último día medido.
    const valor = (s: Punto[]) => (esEstado ? (s.at(-1)?.valor ?? null) : s.reduce((x, p) => x + p.valor, 0));
    const va = sa.length ? valor(sa) : null;
    const vb = sb.length ? valor(sb) : null;
    const variacion = va != null && vb != null && va !== 0 ? Math.round(((vb - va) / va) * 1000) / 10 : null;

    return {
      metrica, etiqueta: ETIQUETA[metrica] ?? metrica, esDinero: ES_DINERO.has(metrica),
      a: { ...a, valor: va, dias: sa.length },
      b: { ...b, valor: vb, dias: sb.length },
      diferencia: va != null && vb != null ? vb - va : null,
      variacionPct: variacion,
      // El aviso viaja con el dato: quien lo lea no tiene por qué saber desde cuándo
      // hay fotos, y una comparación contra un vacío parece una caída real.
      aviso: this.avisoDeCobertura(metrica, sa.length, sb.length),
    };
  }

  private avisoDeCobertura(metrica: string, na: number, nb: number): string | null {
    if (na && nb) return null;
    const cual = !na && !nb ? 'los dos periodos' : !na ? 'el primer periodo' : 'el segundo periodo';
    if (NO_RECONSTRUIBLES.includes(metrica)) {
      // Decir "no hay dato" y callarse deja al que pregunta igual de lejos de su
      // respuesta. La base facturable SÍ tiene histórico fiable desde 2022 y contesta
      // la misma pregunta de fondo ("¿cuántos clientes teníamos?"), así que se ofrece
      // en el mismo mensaje.
      return `No hay datos de ${cual}: "${ETIQUETA[metrica] ?? metrica}" es una foto diaria y solo existe desde que se empezó a medir. ` +
        'El pasado NO se puede reconstruir para esta métrica (el historial de estados del ERP no es fiable). ' +
        `PERO la pregunta sí se puede contestar con "${ETIQUETA[METRICAS.BASE_FACTURABLE]}" (${METRICAS.BASE_FACTURABLE}), ` +
        'que mide cuántos abonados se facturaron en el mes, tiene histórico fiable desde 2022 y es la mejor medida disponible ' +
        'de "cuántos clientes teníamos". Vuelve a intentarlo con esa métrica y explica la diferencia al responder.';
    }
    return `No hay datos de ${cual} para "${ETIQUETA[metrica] ?? metrica}".`;
  }

  /** Desde cuándo hay datos de cada métrica. Es la "hoja de cobertura" del histórico. */
  async cobertura() {
    const filas = await this.prisma.$queryRaw<{ metrica: string; desde: Date; hasta: Date; n: number }[]>`
      SELECT metrica, MIN(fecha) desde, MAX(fecha) hasta, COUNT(*)::int n
        FROM "MetricPoint" WHERE sede = '' GROUP BY metrica ORDER BY metrica`;
    return filas.map((f) => ({
      metrica: f.metrica,
      etiqueta: ETIQUETA[f.metrica] ?? f.metrica,
      desde: iso(f.desde), hasta: iso(f.hasta), puntos: Number(f.n),
      reconstruible: !NO_RECONSTRUIBLES.includes(f.metrica),
    }));
  }
}
