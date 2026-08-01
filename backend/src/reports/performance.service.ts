import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { tiposDeCampo, tiposDeRevisita } from '../support/field-work.policy';

/**
 * Rendimiento de los técnicos de campo.
 *
 * Tres decisiones que explican todo lo demás:
 *
 * 1. Solo cuenta el TRABAJO DE CAMPO (ver field-work.policy.ts). El 81% de las
 *    órdenes son cortes y reconexiones automáticas; incluirlas convierte el
 *    tablero en un ranking de quién ejecuta más cortes desde un escritorio.
 *
 * 2. Se agrupa por `assignedStaffId`, no por el texto `assigned`. Agrupar por un
 *    string libre es agrupar por las erratas de quien escribió.
 *
 * 3. La métrica que manda es la RE-VISITA, no el volumen. Cerrar muchas órdenes
 *    rápido y mal no es rendimiento; que el cliente no vuelva a llamar, sí. El
 *    volumen se muestra como contexto, nunca como el número que ordena la lista.
 *
 * Nada aquí califica a una persona con una nota. Devuelve hechos y la mediana
 * del equipo para poder leerlos; la conversación con el técnico la tiene un jefe,
 * no un tablero.
 */

/** Días dentro de los cuales una queja del mismo cliente se atribuye al trabajo anterior. */
const VENTANA_REVISITA_DIAS = 15;
/**
 * La ventana va al SQL como literal, no como parámetro: `date + $1` no tiene
 * operador cuando el driver manda el número como bigint. Es una constante del
 * módulo, no entrada del usuario, así que interpolarla no abre ninguna puerta.
 */
const VENTANA_SQL = Prisma.raw(String(VENTANA_REVISITA_DIAS));

/**
 * Mínimo de órdenes cerradas para que los porcentajes signifiquen algo. Con 3
 * órdenes, una re-visita es el 33% y no dice nada del técnico.
 */
const MUESTRA_MINIMA = 5;

/**
 * Días tras los cuales una orden abierta se considera vencida. No es un SLA
 * pactado con nadie: es el umbral a partir del cual vale la pena preguntar.
 */
const DIAS_VENCIMIENTO = 7;
const VENCIMIENTO_SQL = Prisma.raw(String(DIAS_VENCIMIENTO));

type FilaCruda = {
  staff_id: string;
  nombre: string;
  asignadas: number;
  cerradas: number;
  anuladas: number;
  abiertas: number;
  revisitas: number;
  con_evidencia: number;
  con_firma: number;
  ciclo_horas: number | null;
  ciclo_medidas: number;
  geo_ok: number;
  geo_fuera: number;
  vencidas: number;
  antiguedad_dias: number | null;
};

export type TecnicoRendimiento = {
  staffId: string;
  nombre: string;
  /** Órdenes de campo asignadas en el periodo. */
  asignadas: number;
  cerradas: number;
  anuladas: number;
  /** Asignadas en el periodo que siguen sin cerrar. */
  abiertas: number;
  revisitas: number;
  /** % de órdenes cerradas que trajeron una queja del mismo cliente en 15 días. */
  revisitaPct: number | null;
  /** Horas promedio entre la asignación y el cierre. Null mientras no haya sellos reales. */
  cicloHoras: number | null;
  cicloMedidas: number;
  evidenciaPct: number | null;
  firmaPct: number | null;
  geoOk: number;
  geoFuera: number;
  /** Abiertas cuya fecha de creación ya pasó el plazo. */
  vencidas: number;
  /** Antigüedad promedio, en días, de lo que este técnico tiene sin cerrar. */
  antiguedadDias: number | null;
  /** false = tiene tan pocas órdenes que sus porcentajes no son interpretables. */
  muestraSuficiente: boolean;
};

/** Recortes opcionales del universo medido. */
export type FiltrosTecnicos = {
  /** `Branch.id` — se cruza por el abonado de la orden, que es quien tiene sede. */
  sede?: string;
  /** Un tipo de orden de campo concreto. */
  tipo?: string;
  prioridad?: string;
};

const pct = (parte: number, total: number): number | null =>
  total > 0 ? Math.round((1000 * parte) / total) / 10 : null;

/** Mediana de una lista, ignorando los nulos. Con lista vacía, null. */
export function mediana(valores: (number | null)[]): number | null {
  const v = valores.filter((n): n is number => n != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  const med = v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  return Math.round(med * 10) / 10;
}

@Injectable()
export class PerformanceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tipos de orden que cuentan como campo, resueltos contra el catálogo real de
   * la base. Se calculan aquí (y no en SQL) para que la lista viaje como
   * `type = ANY(...)` y Postgres pueda usar el índice de `type`.
   */
  private async tiposCampo(): Promise<{ campo: string[]; revisita: string[] }> {
    const [tipos, ajuste] = await Promise.all([
      this.prisma.ticket.findMany({ distinct: ['type'], select: { type: true } }),
      this.prisma.appSetting.findUnique({ where: { key: 'tickets.fieldTypes' } }),
    ]);
    const todos = tipos.map((t) => t.type).filter(Boolean);
    const campo = tiposDeCampo(todos, ajuste?.value);
    return { campo, revisita: tiposDeRevisita(todos) };
  }

  /**
   * Valores que pueden ir en los filtros. Se derivan de lo que existe de verdad
   * (sedes con abonados, tipos de campo del catálogo), no de una lista fija que
   * se desactualiza sola.
   */
  private async opciones(campo: string[]) {
    const [sedes, prioridades] = await Promise.all([
      this.prisma.branch.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.prisma.ticket.findMany({ distinct: ['priority'], select: { priority: true }, orderBy: { priority: 'asc' } }),
    ]);
    return {
      sedes: sedes.map((b) => ({ id: b.id, nombre: b.name })),
      tipos: [...campo].sort(),
      prioridades: prioridades.map((p) => p.priority).filter(Boolean),
    };
  }

  /**
   * Tablero por técnico para un periodo.
   *
   * `from`/`to` son fechas ISO (YYYY-MM-DD). Sin ellas toma los últimos 90 días,
   * que es el horizonte en que una conversación de desempeño todavía es útil.
   *
   * Los filtros (`sede`, `tipo`, `prioridad`) recortan el universo ANTES de
   * calcular todo, incluida la mediana del equipo. Es lo correcto: si se está
   * mirando solo Yopal, la referencia tiene que ser Yopal, no la empresa entera.
   */
  async tecnicos(from?: string, to?: string, filtros: FiltrosTecnicos = {}) {
    const hasta = to ? new Date(`${to}T23:59:59.999Z`) : new Date();
    const desde = from ? new Date(`${from}T00:00:00.000Z`) : new Date(hasta.getTime() - 90 * 86400_000);
    const { campo, revisita } = await this.tiposCampo();

    // Un tipo pedido que no sea de campo devuelve vacío en vez de colarse: el
    // tablero no mide cortes ni aunque se los pidan por la query.
    const tipos = filtros.tipo ? campo.filter((t) => t === filtros.tipo) : campo;

    if (!tipos.length) {
      return { desde, hasta, tiposCampo: campo, filtros, equipo: null, tecnicos: [], sinAtribuir: 0, opciones: await this.opciones(campo) };
    }

    // Fragmentos opcionales. Prisma.empty deja la consulta idéntica a la de
    // antes cuando no hay filtro, así que el plan de ejecución no cambia.
    const fSede = filtros.sede
      ? Prisma.sql`AND EXISTS (SELECT 1 FROM "Subscriber" sb WHERE sb.id = t."subscriberId" AND sb."branchId" = ${filtros.sede})`
      : Prisma.empty;
    const fPrioridad = filtros.prioridad ? Prisma.sql`AND t.priority = ${filtros.prioridad}` : Prisma.empty;

    const filas = await this.prisma.$queryRaw<FilaCruda[]>`
      WITH campo AS (
        SELECT t.id, t.code, t."assignedStaffId", t."subscriberId", t.status,
               t.created, t."assignedAt", t."resolvedAt",
               t."signatureName", t."closeGeoOk"
          FROM "Ticket" t
         WHERE t.type = ANY(${tipos})
           AND t."assignedStaffId" IS NOT NULL
           AND t.created >= ${desde} AND t.created <= ${hasta}
           ${fSede}
           ${fPrioridad}
      ),
      -- Una queja del mismo abonado dentro de la ventana. Se busca sobre la tabla
      -- completa y no sobre la CTE: la queja puede caer después del periodo que
      -- se está mirando, y si no se cuenta, el técnico sale mejor de lo que fue.
      revisitas AS (
        SELECT c.id, c."assignedStaffId",
               EXISTS (
                 SELECT 1 FROM "Ticket" n
                  WHERE n.type = ANY(${revisita})
                    AND n."subscriberId" = c."subscriberId"
                    AND n.id <> c.id
                    AND n.status <> 'ANULADA'
                    AND n.created > c.created
                    AND n.created <= c.created + ${VENTANA_SQL}
               ) AS volvio
          FROM campo c
         WHERE c.status = 'RESUELTO' AND c."subscriberId" IS NOT NULL
      ),
      evidencia AS (
        SELECT c.id, c."assignedStaffId",
               EXISTS (
                 SELECT 1 FROM "TicketThread" th
                  WHERE th."ticketCode" = c.code AND th.attach IS NOT NULL
               ) AS tiene_foto
          FROM campo c
         WHERE c.status = 'RESUELTO'
      )
      SELECT s.id                                                          AS staff_id,
             s.name                                                        AS nombre,
             COUNT(c.id)::int                                              AS asignadas,
             COUNT(c.id) FILTER (WHERE c.status = 'RESUELTO')::int          AS cerradas,
             COUNT(c.id) FILTER (WHERE c.status = 'ANULADA')::int           AS anuladas,
             COUNT(c.id) FILTER (WHERE c.status IN ('PENDIENTE','REALIZANDO'))::int AS abiertas,
             COALESCE(SUM(CASE WHEN r.volvio THEN 1 ELSE 0 END), 0)::int    AS revisitas,
             COALESCE(SUM(CASE WHEN e.tiene_foto THEN 1 ELSE 0 END), 0)::int AS con_evidencia,
             COUNT(c.id) FILTER (WHERE c.status = 'RESUELTO' AND c."signatureName" IS NOT NULL)::int AS con_firma,
             -- Solo promedia lo que tiene los DOS sellos reales del flujo vivo.
             -- El histórico no los tiene y por eso queda fuera, en vez de
             -- inventar un ciclo con fechas a medianoche.
             ROUND(AVG(EXTRACT(EPOCH FROM (c."resolvedAt" - c."assignedAt")) / 3600.0)
                   FILTER (WHERE c."resolvedAt" IS NOT NULL AND c."assignedAt" IS NOT NULL
                             AND c."resolvedAt" >= c."assignedAt")::numeric, 1)::float8 AS ciclo_horas,
             COUNT(c.id) FILTER (WHERE c."resolvedAt" IS NOT NULL AND c."assignedAt" IS NOT NULL
                                   AND c."resolvedAt" >= c."assignedAt")::int AS ciclo_medidas,
             COUNT(c.id) FILTER (WHERE c."closeGeoOk" IS TRUE)::int          AS geo_ok,
             COUNT(c.id) FILTER (WHERE c."closeGeoOk" IS FALSE)::int         AS geo_fuera,
             -- Lo que sigue abierto pasado el plazo. Una orden vieja sin cerrar
             -- no aparece en ninguna métrica de calidad (nunca se cerró), y es
             -- justo lo que un jefe necesita ver.
             COUNT(c.id) FILTER (WHERE c.status IN ('PENDIENTE','REALIZANDO')
                                   AND c.created < CURRENT_DATE - ${VENCIMIENTO_SQL})::int AS vencidas,
             ROUND(AVG(CURRENT_DATE - c.created)
                   FILTER (WHERE c.status IN ('PENDIENTE','REALIZANDO'))::numeric, 1)::float8 AS antiguedad_dias
        FROM campo c
        -- Solo funcionarios activos: a un ex-empleado no se le mide el rendimiento
        -- ni se le compara con el equipo de hoy. Lo que trabajó queda en sus órdenes.
        JOIN "Staff" s      ON s.id = c."assignedStaffId" AND NOT s.banned
        LEFT JOIN revisitas r ON r.id = c.id
        LEFT JOIN evidencia e ON e.id = c.id
       GROUP BY s.id, s.name
       ORDER BY COUNT(c.id) DESC`;

    // Órdenes de campo del periodo que nadie tiene asignadas. No es un detalle:
    // es la parte del trabajo que el tablero NO puede evaluar, y se muestra para
    // que nadie lea la lista como si fuera todo lo que pasó.
    const sinAtribuir = await this.prisma.ticket.count({
      where: {
        type: { in: tipos },
        assignedStaffId: null,
        created: { gte: desde, lte: hasta },
        ...(filtros.sede ? { subscriber: { branchId: filtros.sede } } : {}),
        ...(filtros.prioridad ? { priority: filtros.prioridad } : {}),
      },
    });

    const tecnicos: TecnicoRendimiento[] = filas.map((f) => ({
      staffId: f.staff_id,
      nombre: f.nombre,
      asignadas: f.asignadas,
      cerradas: f.cerradas,
      anuladas: f.anuladas,
      abiertas: f.abiertas,
      revisitas: f.revisitas,
      revisitaPct: pct(f.revisitas, f.cerradas),
      cicloHoras: f.ciclo_horas,
      cicloMedidas: f.ciclo_medidas,
      evidenciaPct: pct(f.con_evidencia, f.cerradas),
      firmaPct: pct(f.con_firma, f.cerradas),
      geoOk: f.geo_ok,
      geoFuera: f.geo_fuera,
      vencidas: f.vencidas,
      antiguedadDias: f.antiguedad_dias,
      muestraSuficiente: f.cerradas >= MUESTRA_MINIMA,
    }));

    // La mediana se calcula SOLO con quienes tienen muestra suficiente: si entra
    // el que cerró dos órdenes, la referencia del equipo la fija el ruido.
    const base = tecnicos.filter((t) => t.muestraSuficiente);
    const equipo = {
      tecnicos: tecnicos.length,
      conMuestra: base.length,
      cerradas: tecnicos.reduce((s, t) => s + t.cerradas, 0),
      revisitas: tecnicos.reduce((s, t) => s + t.revisitas, 0),
      revisitaPct: pct(
        base.reduce((s, t) => s + t.revisitas, 0),
        base.reduce((s, t) => s + t.cerradas, 0),
      ),
      medianaRevisita: mediana(base.map((t) => t.revisitaPct)),
      medianaCiclo: mediana(base.map((t) => t.cicloHoras)),
      medianaEvidencia: mediana(base.map((t) => t.evidenciaPct)),
      abiertas: tecnicos.reduce((s, t) => s + t.abiertas, 0),
      vencidas: tecnicos.reduce((s, t) => s + t.vencidas, 0),
      ventanaRevisitaDias: VENTANA_REVISITA_DIAS,
      muestraMinima: MUESTRA_MINIMA,
      diasVencimiento: DIAS_VENCIMIENTO,
    };

    return {
      desde, hasta, tiposCampo: campo, filtros, equipo, tecnicos, sinAtribuir,
      opciones: await this.opciones(campo),
    };
  }

  /**
   * Detalle de un técnico: sus métricas más las órdenes que sí trajeron queja,
   * que es lo único accionable — un porcentaje no se puede revisar, una orden sí.
   */
  async tecnico(staffId: string, from?: string, to?: string, filtros: FiltrosTecnicos = {}) {
    const tablero = await this.tecnicos(from, to, filtros);
    const resumen = tablero.tecnicos.find((t) => t.staffId === staffId) ?? null;
    const { campo, revisita } = await this.tiposCampo();
    const vacio = { desde: tablero.desde, hasta: tablero.hasta, equipo: tablero.equipo, resumen, casos: [], porTipo: [] };
    // Sin tipos de campo no hay nada que buscar, y sin tipos de queja el LATERAL
    // no puede cruzar contra nada: en ambos casos la respuesta honesta es vacía.
    if (!campo.length || !revisita.length) return vacio;

    // Desglose por tipo de trabajo. Es lo que convierte "15% de re-visita" en
    // algo accionable: casi siempre el problema no es el técnico entero, es UN
    // tipo de trabajo suyo (p. ej. bien en revisiones, mal en instalaciones).
    const porTipo = await this.prisma.$queryRaw<
      { tipo: string; cerradas: number; revisitas: number }[]
    >`
      SELECT c.type AS tipo,
             COUNT(*)::int AS cerradas,
             COUNT(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM "Ticket" n
                WHERE n.type = ANY(${revisita})
                  AND n."subscriberId" = c."subscriberId"
                  AND n.id <> c.id AND n.status <> 'ANULADA'
                  AND n.created > c.created
                  AND n.created <= c.created + ${VENTANA_SQL}
             ))::int AS revisitas
        FROM "Ticket" c
       WHERE c."assignedStaffId" = ${staffId}
         AND c.type = ANY(${campo})
         AND c.status = 'RESUELTO'
         AND c.created >= ${tablero.desde} AND c.created <= ${tablero.hasta}
       GROUP BY c.type
       ORDER BY COUNT(*) DESC`;

    const casos = await this.prisma.$queryRaw<
      { id: string; code: number | null; type: string; created: Date; abonado: string | null; cliente: string | null; queja: string | null; queja_fecha: Date | null }[]
    >`
      SELECT c.id, c.code, c.type, c.created,
             sub.abonado,
             -- Igual que en topDeudores: fullName está lleno en 7 de 21.828
             -- abonados y companyName es cadena vacía (no NULL) en el resto, así
             -- que leerlo a secas dejaba la columna Cliente en "Abonado 54395" para
             -- casi todos. El nombre real vive en firstName/lastName1.
             COALESCE(
               NULLIF(TRIM(sub."fullName"), ''),
               NULLIF(TRIM(CONCAT(sub."firstName", ' ', sub."lastName1")), ''),
               NULLIF(TRIM(sub."companyName"), '')
             ) AS cliente,
             n.type AS queja, n.created AS queja_fecha
        FROM "Ticket" c
        JOIN LATERAL (
          SELECT n.type, n.created FROM "Ticket" n
           WHERE n.type = ANY(${revisita})
             AND n."subscriberId" = c."subscriberId"
             AND n.id <> c.id AND n.status <> 'ANULADA'
             AND n.created > c.created
             AND n.created <= c.created + ${VENTANA_SQL}
           ORDER BY n.created ASC LIMIT 1
        ) n ON TRUE
        LEFT JOIN "Subscriber" sub ON sub.id = c."subscriberId"
       WHERE c."assignedStaffId" = ${staffId}
         AND c.type = ANY(${campo})
         AND c.status = 'RESUELTO'
         AND c.created >= ${tablero.desde} AND c.created <= ${tablero.hasta}
       ORDER BY c.created DESC
       LIMIT 100`;

    return {
      desde: tablero.desde,
      hasta: tablero.hasta,
      equipo: tablero.equipo,
      resumen,
      porTipo: porTipo.map((r) => ({
        tipo: r.tipo,
        cerradas: r.cerradas,
        revisitas: r.revisitas,
        revisitaPct: pct(r.revisitas, r.cerradas),
      })),
      casos: casos.map((c) => ({
        id: c.id,
        code: c.code,
        tipo: c.type,
        fecha: c.created,
        abonado: c.abonado,
        cliente: c.cliente,
        queja: c.queja,
        quejaFecha: c.queja_fecha,
      })),
    };
  }
}
