import { Prisma } from '@prisma/client';
import type { OnModuleInit } from '../core/ciclo-vida';
import { PrismaService } from '../prisma/prisma.service';
import { num } from '../common/money';
import { AuthUser } from '../auth/current-user.decorator';
import { BadRequestException, ForbiddenException } from '../core/http/errores';
import { sedesDe, whereSedePorSuscriptor, whereSedeSuscriptor } from '../common/sede-scope';

/** El día de HOY en Colombia, como 'YYYY-MM-DD' (el servidor no corre en esa zona). */
function hoyColombia(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
}

/** Primer día del mes de HOY en Colombia, como 'YYYY-MM-DD'. */
function inicioDeMes(): string {
  return `${hoyColombia().slice(0, 7)}-01`;
}

/** Una fecha 'YYYY-MM-DD' como Date de medianoche UTC — que es como Postgres guarda un `date`. */
function comoFecha(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

const ES_YMD = /^\d{4}-\d{2}-\d{2}$/;

export type Rango = { desde: string; hasta: string; granularidad: 'dia' | 'mes' };

type Punto = { month: string; income: number; expense: number };

/**
 * Completa con ceros los tramos sin un solo movimiento.
 *
 * El GROUP BY sólo devuelve los días (o meses) que tuvieron caja: sin rellenar, la
 * gráfica une dos puntos lejanos como si fueran consecutivos y un domingo cerrado se
 * ve igual que un día normal. Se rellena aquí y no con `generate_series` porque el
 * LEFT JOIN contra Transaction (498k filas) multiplicaba por diez el coste.
 */
function rellenarSerie(rango: Rango, filas: { m: string; income: number; expense: number }[]): Punto[] {
  const porClave = new Map(filas.map((r) => [r.m, r]));
  const puntos: Punto[] = [];
  const fin = comoFecha(rango.hasta);
  const cursor = comoFecha(rango.desde);
  if (rango.granularidad === 'mes') cursor.setUTCDate(1);
  // Tope de seguridad: ni con rangos absurdos se dibujan más de 400 puntos.
  while (cursor <= fin && puntos.length < 400) {
    const iso = cursor.toISOString().slice(0, 10);
    const clave = rango.granularidad === 'dia' ? iso : iso.slice(0, 7);
    const hit = porClave.get(clave);
    puntos.push({ month: clave, income: hit?.income ?? 0, expense: hit?.expense ?? 0 });
    if (rango.granularidad === 'dia') cursor.setUTCDate(cursor.getUTCDate() + 1);
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return puntos;
}

/**
 * Normaliza el rango que llega por la query.
 *
 * Por defecto, el MES EN CURSO: el panel abría con los totales históricos ("facturado
 * desde siempre"), que no dicen nada de cómo va el negocio hoy. Lo que no venga o no
 * tenga forma de fecha se ignora en silencio y se cae al mes; una fecha mal escrita en
 * la URL no debe tumbar el panel de gerencia.
 */
export function normalizarRango(from?: string, to?: string): Rango {
  let desde = from && ES_YMD.test(from) ? from : inicioDeMes();
  let hasta = to && ES_YMD.test(to) ? to : hoyColombia();
  if (desde > hasta) [desde, hasta] = [hasta, desde];
  // La serie se corta por día en rangos cortos (un mes se vería como un solo punto) y
  // por mes en cuanto el rango pasa de ~3 meses, para no dibujar 400 puntos.
  const dias = Math.round((comoFecha(hasta).getTime() - comoFecha(desde).getTime()) / 86_400_000);
  return { desde, hasta, granularidad: dias <= 92 ? 'dia' : 'mes' };
}

/**
 * Sedes que hay que consultar: cruce entre lo que el usuario PUEDE ver y lo que PIDE.
 *
 * `null` = sin filtro (todas), la misma convención de `sede-scope.ts`: así quien
 * consulta no añade condición ninguna al `where` en vez de meter un `IN` con las siete
 * sedes, que sólo estorbaría a los índices.
 *
 * Pedir una sede nunca AMPLÍA el alcance (igual que en tesorería): si el usuario está
 * acotado y pregunta por otra, es un 403 y no un panel vacío — que se distinga "no
 * tienes acceso" de "esa sede no facturó nada".
 */
function filtroDeSede(permitidas: number[] | null, existentes: number[], sede?: string): number[] | null {
  const pedida = sede != null && String(sede).trim() !== '' ? Number(sede) : null;
  if (pedida == null || !Number.isFinite(pedida) || pedida <= 0) return permitidas;
  if (permitidas && !permitidas.includes(pedida)) throw new ForbiddenException('No tienes acceso a esa sede.');
  // Una sede que no existe da un panel entero a cero, que se lee como "esta sede no
  // vendió nada" en vez de como el error que es.
  if (!existentes.includes(pedida)) throw new BadRequestException('Esa sede no existe.');
  return [pedida];
}

/** Clave de caché de un alcance de sedes ('todas' cuando no hay filtro). */
function claveSede(sedes: number[] | null): string {
  return sedes ? [...sedes].sort((a, b) => a - b).join(',') : 'todas';
}

/** `IN (...)` sobre una lista de números, o `FALSE` si está vacía (un `IN ()` no es SQL). */
function enLista(columna: Prisma.Sql, valores: number[]): Prisma.Sql {
  if (!valores.length) return Prisma.sql`FALSE`;
  return Prisma.sql`${columna} IN (${Prisma.join(valores)})`;
}

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
  //
  // Hay TRES cachés porque hay tres naturalezas de dato:
  //  · stock   — foto de HOY (base de abonados, cartera, red, inventario). No depende
  //              del rango, así que se calcula UNA vez por sede y se reparte a todos
  //              los rangos. Es además la parte cara (recorre toda SubInvoice).
  //  · periodo — lo que pasó ENTRE dos fechas (facturado, recaudo, órdenes). Se cachea
  //              por rango, con tope de entradas para que nadie llene la memoria
  //              paseando el selector de fechas.
  //  · sedes   — el catálogo para el desplegable. Cambia una vez cada varios años.
  //
  // Las tres llevan la SEDE en la clave: el mismo rango mirado desde Yopal y desde
  // Villanueva son dos respuestas distintas, y servir la de otra sede no sería sólo
  // un número raro — sería enseñar datos de una sede que quizá no le tocan.
  private stock = new Map<string, Caché<Awaited<ReturnType<DashboardService['computeStock']>>>>();
  private periodo = new Map<string, Caché<Awaited<ReturnType<DashboardService['computePeriodo']>>>>();
  private sedes = new Map<string, Caché<{ id: number; nombre: string }[]>>();
  private refrescando = new Map<string, Promise<unknown>>();
  private static readonly TTL_MS = Number(process.env.DASHBOARD_TTL_MS) || 60_000;
  // 7 sedes + "todas": el tope es por rango de fechas, multiplicado por sede.
  private static readonly MAX_STOCK = 8;
  private static readonly MAX_RANGOS = 32;

  async summary(from?: string, to?: string, sede?: string, user?: AuthUser) {
    const rango = normalizarRango(from, to);
    // Lo que el usuario puede ver (null = todas) y, dentro de eso, lo que pide.
    const permitidas = await sedesDe(this.prisma, user);
    // El catálogo va PRIMERO (es una consulta minúscula y cacheada) porque es contra él
    // contra lo que se valida la sede pedida.
    const catalogo = await this.sedesCacheado(permitidas);
    const sedes = filtroDeSede(permitidas, catalogo.map((b) => b.id), sede);
    const [stock, periodo] = await Promise.all([
      this.stockCacheado(sedes),
      this.periodoCacheado(rango, sedes, permitidas),
    ]);
    return {
      rango,
      // Qué sede está mirando (null = todas), para que la pantalla no tenga que
      // adivinar si su filtro se aplicó.
      sede: sedes && sedes.length === 1 ? sedes[0] : null,
      sedes: catalogo,
      ...stock,
      ...periodo,
    };
  }

  /**
   * Caché con stale-while-revalidate: devuelve lo último bueno al instante y, si ya
   * está viejo, dispara UN refresco en segundo plano (los demás lectores siguen
   * comiendo del valor anterior en vez de encolarse contra la misma consulta cara).
   */
  private async cacheado<T>(
    caché: Map<string, Caché<T>>,
    clave: string,
    calcular: () => Promise<T>,
    max: number,
    ttl = DashboardService.TTL_MS,
  ): Promise<T> {
    const hit = caché.get(clave);
    if (hit) {
      if (Date.now() - hit.at > ttl && !this.refrescando.has(clave)) {
        this.refrescando.set(
          clave,
          calcular()
            .then((data) => { caché.set(clave, { data, at: Date.now() }); })
            .catch(() => { /* se conserva el valor anterior si falla el refresco */ })
            .finally(() => { this.refrescando.delete(clave); }),
        );
      }
      return hit.data;
    }
    const data = await calcular();
    caché.set(clave, { data, at: Date.now() });
    // Se descarta la entrada más vieja (Map conserva el orden de inserción).
    while (caché.size > max) {
      const primera = caché.keys().next().value as string;
      caché.delete(primera);
    }
    return data;
  }

  private stockCacheado(sedes: number[] | null) {
    const clave = `stock|${claveSede(sedes)}`;
    return this.cacheado(this.stock, clave, () => this.computeStock(sedes), DashboardService.MAX_STOCK);
  }

  private periodoCacheado(rango: Rango, sedes: number[] | null, permitidas: number[] | null) {
    // `permitidas` entra en la clave porque el ranking por sede NO se filtra (ver
    // `computePeriodo`): dos usuarios con distinto alcance no pueden compartirlo.
    const clave = `periodo|${rango.desde}|${rango.hasta}|${claveSede(sedes)}|${claveSede(permitidas)}`;
    return this.cacheado(this.periodo, clave, () => this.computePeriodo(rango, sedes, permitidas), DashboardService.MAX_RANGOS);
  }

  /** Catálogo del desplegable de sedes, ya acotado a las del usuario. */
  private sedesCacheado(permitidas: number[] | null) {
    const clave = `sedes|${claveSede(permitidas)}`;
    return this.cacheado(this.sedes, clave, async () => {
      const filas = await this.prisma.branch.findMany({
        where: permitidas ? { legacyId: { in: permitidas } } : {},
        select: { legacyId: true, name: true },
        orderBy: { name: 'asc' },
      });
      return filas.map((b) => ({ id: b.legacyId, nombre: b.name }));
    }, DashboardService.MAX_STOCK, 10 * 60_000);
  }

  /**
   * Foto de HOY: no depende del rango elegido (la UI lo etiqueta como "a hoy").
   *
   * `sedes` (null = todas) acota TODO lo que sabe de qué sede es. El enganche siempre
   * es el mismo: `Subscriber.branchId -> Branch.legacyId`, porque la sede que traen a
   * pelo las otras tablas es de fiar a medias (`SubInvoice.branchRef` es texto del
   * legacy, con mayúsculas y espacios sueltos: "monterrey", "Yopal ").
   */
  private async computeStock(sedes: number[] | null) {
    const deSede = whereSedeSuscriptor(sedes);
    const deSedeFactura = whereSedePorSuscriptor(sedes);
    // En SQL crudo el filtro se añade como JOIN contra Branch: cuesta lo mismo que un
    // IN y evita arrastrar la lista de ids por medio `where`.
    const joinSedeFactura = sedes
      ? Prisma.sql`JOIN "Subscriber" s2 ON s2.id = i."subscriberId" JOIN "Branch" b2 ON b2.id = s2."branchId" AND ${enLista(Prisma.sql`b2."legacyId"`, sedes)}`
      : Prisma.empty;
    const joinSedeDeudor = sedes
      ? Prisma.sql`JOIN "Branch" b ON b.id = s."branchId" AND ${enLista(Prisma.sql`b."legacyId"`, sedes)}`
      : Prisma.empty;
    // El material es lo único que NO se puede repartir bien por sede: el legacy sólo
    // guarda `branchRef` y casi todo va con 0 (bodega central). Filtrado da lo que esa
    // sede tiene aparte, no su consumo — vale para no enseñar de más, no como cifra.
    const filtroMaterial = sedes ? Prisma.sql`AND ${enLista(Prisma.sql`"branchRef"`, sedes)}` : Prisma.empty;

    const [subsTotal, subsActive, cartera, aging, equip, ports, invValue, topDebt, clientStatus] = await Promise.all([
      this.prisma.subscriber.count({ where: deSede }),
      this.prisma.subscriber.count({ where: { status: 'ACTIVO', ...deSede } }),
      this.prisma.subInvoice.aggregate({ _sum: { total: true, paidAmount: true }, _count: { _all: true }, where: { status: { in: ['DUE', 'PARTIAL'] }, ...deSedeFactura } }),
      this.prisma.$queryRaw<{ corriente: number; d30: number; d60: number; d90: number }[]>`
        SELECT COALESCE(SUM(bal) FILTER (WHERE d <= 30),0)::float corriente,
               COALESCE(SUM(bal) FILTER (WHERE d BETWEEN 31 AND 60),0)::float d30,
               COALESCE(SUM(bal) FILTER (WHERE d BETWEEN 61 AND 90),0)::float d60,
               COALESCE(SUM(bal) FILTER (WHERE d > 90),0)::float d90
        FROM (SELECT (i.total-i."paidAmount") bal, (CURRENT_DATE-i."dueDate") d FROM "SubInvoice" i ${joinSedeFactura} WHERE i.status IN ('DUE','PARTIAL')) t`,
      // La sede del equipo es la de su bodega (`EquipmentWarehouse.branchLegacy`), y la
      // del puerto la trae él mismo (`Port.sedeLegacy`).
      this.prisma.equipment.count({ where: sedes ? { warehouse: { branchLegacy: { in: sedes } } } : {} }),
      this.prisma.port.groupBy({ by: ['status'], _count: { _all: true }, where: sedes ? { sedeLegacy: { in: sedes } } : {} }),
      this.prisma.$queryRaw<{ v: number }[]>`SELECT COALESCE(SUM(price*qty),0)::float v FROM "Material" WHERE qty < 100000 ${filtroMaterial}`,
      this.prisma.$queryRaw<{ id: string; name: string; bal: number }[]>`
        SELECT s.id, COALESCE(NULLIF(TRIM(s."fullName"),''), TRIM(CONCAT(s."firstName",' ',s."lastName1")), s."companyName",'—') name,
               SUM(i.total - i."paidAmount")::float bal
        FROM "SubInvoice" i JOIN "Subscriber" s ON s.id = i."subscriberId" ${joinSedeDeudor}
        WHERE i.status IN ('DUE','PARTIAL') GROUP BY s.id, name ORDER BY bal DESC LIMIT 8`,
      this.prisma.subscriber.groupBy({ by: ['status'], _count: { _all: true }, where: deSede }),
    ]);

    const estadoClientes: Record<string, number> = {};
    for (const r of clientStatus) estadoClientes[r.status ?? '—'] = r._count._all;
    const portMap: Record<string, number> = {};
    for (const r of ports) portMap[r.status] = r._count._all;
    const ag = aging[0] ?? { corriente: 0, d30: 0, d60: 0, d90: 0 };

    return {
      clientes: { total: subsTotal, activos: subsActive },
      cartera: {
        total: num(cartera._sum.total) - num(cartera._sum.paidAmount), facturas: cartera._count._all,
        aging: { corriente: ag.corriente, d31_60: ag.d30, d61_90: ag.d60, d90: ag.d90 },
      },
      red: { equipos: equip, puertosUsados: portMap['Ocupado'] ?? 0, puertosLibres: portMap['Disponible'] ?? 0 },
      inventario: { valor: invValue[0]?.v ?? 0 },
      topDeudores: topDebt.map((r) => ({ id: r.id, name: (r.name || '—').trim(), balance: r.bal })),
      estadoClientes,
    };
  }

  /**
   * Lo ocurrido ENTRE las dos fechas del rango.
   *
   * En SQL crudo las fechas van como texto con `::date`: atar un Date de JS contra una
   * columna `date` la convierte a la zona de la sesión (Europe/Berlin) y el rango se
   * corre un día. Con Prisma tipado no pasa, porque conoce el tipo de la columna.
   *
   * `sedes` es el filtro elegido y `permitidas` el alcance del usuario. Se distinguen
   * por el ranking "facturación por sede", que se calcula SIEMPRE sobre `permitidas`:
   * al elegir una sede el resto del panel se acota, pero la comparativa entre sedes
   * sigue entera — un panel que al filtrar deja una sola barra al 100% no compara nada.
   */
  private async computePeriodo(rango: Rango, sedes: number[] | null, permitidas: number[] | null) {
    const { desde, hasta, granularidad } = rango;
    const enRango = { gte: comoFecha(desde), lte: comoFecha(hasta) };
    const unidad = granularidad === 'dia' ? 'day' : 'month';
    const formato = granularidad === 'dia' ? 'YYYY-MM-DD' : 'YYYY-MM';
    const deSede = whereSedePorSuscriptor(sedes);

    // La caja y la compra no cuelgan de un abonado, así que su sede se traduce antes:
    //  · el movimiento la hereda de SU CAJA (`CashAccount.branchLegacy`, 0 = banco),
    //    igual que el filtro de /tesoreria. OJO: al filtrar por sede el recaudo deja
    //    fuera los BANCOS, que son de toda la empresa (ahí entra lo del portal de pagos).
    //  · la orden de compra guarda el NOMBRE de la sede en `branchRef` ("Yopal").
    const [cajasDeSede, nombresDeSede] = await Promise.all([
      sedes
        ? this.prisma.cashAccount.findMany({ where: { branchLegacy: { in: sedes } }, select: { legacyId: true } })
          .then((cs) => cs.map((c) => c.legacyId).filter((id): id is number => id != null))
        : Promise.resolve(null),
      sedes
        ? this.prisma.branch.findMany({ where: { legacyId: { in: sedes } }, select: { name: true } }).then((bs) => bs.map((b) => b.name))
        : Promise.resolve(null),
    ]);
    const deCaja = cajasDeSede ? { cashAccountId: { in: cajasDeSede } } : {};
    const filtroCaja = cajasDeSede ? Prisma.sql`AND ${enLista(Prisma.sql`"cashAccountId"`, cajasDeSede)}` : Prisma.empty;
    // Acotado, el JOIN con Branch tiene que ser INTERNO: con un LEFT, los abonados de
    // otras sedes no desaparecerían — caerían todos juntos en la fila "Sin sede".
    const joinSedeRanking = permitidas
      ? Prisma.sql`JOIN "Branch" b ON b.id = s."branchId" AND ${enLista(Prisma.sql`b."legacyId"`, permitidas)}`
      : Prisma.sql`LEFT JOIN "Branch" b ON b.id = s."branchId"`;

    const [facturado, byInvStatus, ingreso, egreso, supportByStatus, ordersAgg, series, topTypes, nuevos, ventasSede] = await Promise.all([
      // Lo FACTURADO excluye las anuladas. El sync marca CANCELED las facturas que el
      // legacy borró (2.847 solo en agosto, 197 M COP): contarlas inflaba el panel un
      // 57% contra el legacy, y descuadraba contra /reportes, que sí las filtra.
      this.prisma.subInvoice.aggregate({ _sum: { total: true }, _count: { _all: true }, where: { invoiceDate: enRango, status: { not: 'CANCELED' }, ...deSede } }),
      // El desglose por estado sí las cuenta: ahí son un dato, no un total de plata.
      this.prisma.subInvoice.groupBy({ by: ['status'], _count: { _all: true }, where: { invoiceDate: enRango, ...deSede } }),
      // Ingresos y egresos POR TIPO, igual que la pantalla de Tesorería. Antes se
      // sumaba todo el credit/debit vigente, que mete también las dos patas de cada
      // TRANSFER: el panel enseñaba un recaudo inflado que no cuadraba ni con su
      // propia gráfica (que sí filtra por tipo) ni con /tesoreria.
      this.prisma.transaction.aggregate({ _sum: { credit: true }, where: { status: 'VIGENTE', type: 'INCOME', date: enRango, ...deCaja } }),
      this.prisma.transaction.aggregate({ _sum: { debit: true }, where: { status: 'VIGENTE', type: 'EXPENSE', date: enRango, ...deCaja } }),
      this.prisma.ticket.groupBy({ by: ['status'], _count: { _all: true }, where: { created: enRango, ...deSede } }),
      this.prisma.supplyOrder.aggregate({ _sum: { total: true }, _count: { _all: true }, where: { orderDate: enRango, ...(nombresDeSede ? { branchRef: { in: nombresDeSede } } : {}) } }),
      this.prisma.$queryRaw<{ m: string; income: number; expense: number }[]>`
        SELECT to_char(date_trunc(${unidad}::text, "date"), ${formato}::text) m,
               COALESCE(SUM(credit) FILTER (WHERE type='INCOME'),0)::float income,
               COALESCE(SUM(debit) FILTER (WHERE type='EXPENSE'),0)::float expense
        FROM "Transaction"
        WHERE status='VIGENTE' AND "date" BETWEEN ${desde}::date AND ${hasta}::date ${filtroCaja}
        GROUP BY 1 ORDER BY 1`,
      this.prisma.ticket.groupBy({ by: ['type'], _count: { _all: true }, where: { created: enRango, ...deSede }, orderBy: { _count: { type: 'desc' } }, take: 8 }),
      this.prisma.subscriber.count({ where: { entryDate: enRango, ...whereSedeSuscriptor(sedes) } }),
      // El ranking va sobre TODAS las sedes del usuario (ver el comentario de arriba).
      this.prisma.$queryRaw<{ sede: string; legacy: number | null; total: number; abonados: number }[]>`
        SELECT COALESCE(b.name,'Sin sede') sede, b."legacyId" legacy, COALESCE(SUM(i.total),0)::float total, COUNT(DISTINCT s.id)::int abonados
        FROM "SubInvoice" i
        JOIN "Subscriber" s ON s.id = i."subscriberId"
        ${joinSedeRanking}
        WHERE i.status <> 'CANCELED' AND i."invoiceDate" BETWEEN ${desde}::date AND ${hasta}::date
        GROUP BY b.name, b."legacyId" ORDER BY total DESC LIMIT 8`,
    ]);

    const invStatus: Record<string, number> = {};
    for (const r of byInvStatus) invStatus[r.status] = r._count._all;
    const supStatus: Record<string, number> = {};
    for (const r of supportByStatus) supStatus[r.status] = r._count._all;

    return {
      nuevosAbonados: nuevos,
      facturacion: {
        total: num(facturado._sum.total), facturas: facturado._count._all,
        pagadas: invStatus['PAID'] ?? 0, pendientes: (invStatus['DUE'] ?? 0) + (invStatus['PARTIAL'] ?? 0),
      },
      tesoreria: { ingresos: num(ingreso._sum.credit), egresos: num(egreso._sum.debit), balance: num(ingreso._sum.credit) - num(egreso._sum.debit) },
      soporte: {
        pendientes: (supStatus['PENDIENTE'] ?? 0) + (supStatus['REALIZANDO'] ?? 0),
        resueltas: supStatus['RESUELTO'] ?? 0,
        total: Object.values(supStatus).reduce((a, b) => a + b, 0),
      },
      compras: { total: ordersAgg._count._all, monto: num(ordersAgg._sum.total) },
      serieMensual: rellenarSerie(rango, series),
      ordenesPorTipo: topTypes.map((t) => ({ type: t.type, count: t._count._all })),
      // `id` = `Branch.legacyId`, para que la pantalla resalte la sede filtrada.
      ventasPorSede: ventasSede.map((r) => ({ id: r.legacy ?? null, sede: r.sede, total: Number(r.total), abonados: Number(r.abonados) })),
    };
  }
}

type Caché<T> = { data: T; at: number };
