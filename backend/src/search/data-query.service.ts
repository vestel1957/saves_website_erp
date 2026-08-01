import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CATALOGO, type Entidad } from './data-catalog';
import { SUPERADMIN_PERMISSION } from '../auth/permissions.catalog';

/**
 * Motor de consultas sobre el catálogo de datos.
 *
 * El modelo describe QUÉ quiere saber (entidad, filtros, agrupación, métrica) y este
 * servicio lo traduce a SQL. La regla que lo hace seguro es una sola y no se negocia:
 * **del modelo solo se aceptan CLAVES del catálogo y VALORES**. Las claves se buscan
 * en los diccionarios de `data-catalog.ts` y, si no existen, la consulta se rechaza
 * con la lista de las que sí; los valores viajan siempre parametrizados. Ni un solo
 * fragmento de SQL sale de una cadena que haya escrito el modelo.
 *
 * Los tres cierres que evitan que una pregunta tumbe la base:
 *  · RBAC por entidad, con la misma semántica OR del AreaGuard.
 *  · Tope duro de filas devueltas (el modelo no puede subirlo).
 *  · Sin agrupación NO se devuelven registros sueltos, solo el agregado: "dame todos
 *    los abonados" son 21.829 filas que ni caben en un WhatsApp ni le sirven a nadie.
 */

/** Lo que el modelo puede pedir. Todo se valida contra el catálogo. */
export type Consulta = {
  entidad: string;
  /** { campo: valor } · { campo: {desde, hasta} } para fechas y números. */
  filtros?: Record<string, unknown>;
  /** Dimensiones por las que partir el resultado. Máximo 2. */
  agrupar?: string[];
  /** Cifras a calcular. Por defecto, "cantidad". */
  metricas?: string[];
  /** Cuántas filas devolver como mucho. */
  limite?: number;
  /** Métrica por la que ordenar (desc). Por defecto la primera. */
  ordenar?: string;
};

export type ResultadoConsulta = {
  ok: boolean;
  error?: string;
  entidad?: string;
  etiqueta?: string;
  /** Descripción en español de lo que se consultó, para que el usuario lo verifique. */
  interpretado?: string;
  columnas?: { clave: string; etiqueta: string; dinero?: boolean }[];
  filas?: Record<string, string | number | null>[];
  total?: number;
  /** true = se alcanzó el tope y hay más filas sin mostrar. */
  recortado?: boolean;
};

const TOPE_FILAS = 50;
const MAX_GRUPOS = 2;

@Injectable()
export class DataQueryService {
  private readonly logger = new Logger('DataQuery');

  constructor(private readonly prisma: PrismaService) {}

  /** ¿Qué entidades puede consultar este usuario? (misma OR que el AreaGuard). */
  entidadesPara(permisos: string[]): { clave: string; etiqueta: string; descripcion: string }[] {
    const superadmin = permisos.includes(SUPERADMIN_PERMISSION);
    return Object.entries(CATALOGO)
      .filter(([, e]) => superadmin || !e.areas.length || e.areas.some((a) => permisos.includes(a)))
      .map(([clave, e]) => ({ clave, etiqueta: e.etiqueta, descripcion: e.descripcion }));
  }

  /**
   * Ficha de una entidad: qué se puede filtrar, agrupar y calcular.
   *
   * Va aparte de la consulta a propósito: meter esto en la descripción de la
   * herramienta costaría miles de tokens EN CADA llamada, y es justo el problema que
   * este motor viene a resolver. Así el modelo lo pide solo cuando le hace falta.
   */
  ficha(entidad: string, permisos: string[]): ResultadoConsulta & { detalle?: unknown } {
    const e = this.resolver(entidad, permisos);
    if (typeof e === 'string') return { ok: false, error: e };
    return {
      ok: true, entidad, etiqueta: e.etiqueta,
      detalle: {
        descripcion: e.descripcion,
        filtros: Object.fromEntries(Object.entries(e.filtros).map(([k, f]) => [k,
          { tipo: f.tipo, descripcion: f.descripcion, ...(f.valores ? { valores: f.valores } : {}) }])),
        agrupar_por: Object.fromEntries(Object.entries(e.grupos).map(([k, g]) => [k, g.descripcion])),
        metricas: Object.fromEntries(Object.entries(e.metricas).map(([k, m]) => [k, m.descripcion])),
      },
    };
  }

  /** Entidad válida y permitida, o el mensaje de error que se le devuelve al modelo. */
  private resolver(entidad: string, permisos: string[]): Entidad | string {
    const e = CATALOGO[entidad];
    if (!e) {
      return `No existe la entidad "${entidad}". Las que hay: ${Object.keys(CATALOGO).join(', ')}.`;
    }
    const superadmin = permisos.includes(SUPERADMIN_PERMISSION);
    if (!superadmin && e.areas.length && !e.areas.some((a) => permisos.includes(a))) {
      return `PERMISO_DENEGADO: este usuario no tiene acceso a "${e.etiqueta}".`;
    }
    return e;
  }

  async consultar(q: Consulta, permisos: string[]): Promise<ResultadoConsulta> {
    const e = this.resolver(q.entidad, permisos);
    if (typeof e === 'string') return { ok: false, error: e };

    // ── Filtros ──
    const condiciones: Prisma.Sql[] = e.base ? [e.base] : [];
    const explicacion: string[] = [];
    for (const [clave, valor] of Object.entries(q.filtros ?? {})) {
      if (valor == null || valor === '') continue;
      const campo = e.filtros[clave];
      if (!campo) {
        return { ok: false, error: `"${clave}" no se puede filtrar en ${e.etiqueta}. Se puede filtrar por: ${Object.keys(e.filtros).join(', ')}.` };
      }
      const cond = this.condicion(campo.sql, campo.tipo, valor, campo.valores);
      if (typeof cond === 'string') return { ok: false, error: `Filtro "${clave}": ${cond}` };
      condiciones.push(cond.sql);
      explicacion.push(`${clave} ${cond.texto}`);
    }

    // ── Agrupación ──
    const grupos = (q.agrupar ?? []).slice(0, MAX_GRUPOS);
    for (const g of grupos) {
      if (!e.grupos[g]) {
        return { ok: false, error: `No se puede agrupar por "${g}" en ${e.etiqueta}. Se puede agrupar por: ${Object.keys(e.grupos).join(', ')}.` };
      }
    }

    // ── Métricas ──
    const metricas = (q.metricas?.length ? q.metricas : ['cantidad']).filter((m, i, a) => a.indexOf(m) === i);
    for (const m of metricas) {
      if (!e.metricas[m]) {
        return { ok: false, error: `"${m}" no es una cifra de ${e.etiqueta}. Se puede calcular: ${Object.keys(e.metricas).join(', ')}.` };
      }
    }

    // ── SQL ──
    const where = condiciones.length
      ? Prisma.sql`WHERE ${Prisma.join(condiciones, ' AND ')}`
      : Prisma.empty;
    const selGrupos = grupos.map((g, i) => Prisma.sql`${e.grupos[g].sql} AS "g${Prisma.raw(String(i))}"`);
    const selMetricas = metricas.map((m, i) => Prisma.sql`COALESCE(${e.metricas[m].sql}, 0)::float AS "m${Prisma.raw(String(i))}"`);
    const select = Prisma.join([...selGrupos, ...selMetricas], ', ');
    const groupBy = grupos.length
      ? Prisma.sql`GROUP BY ${Prisma.join(grupos.map((g) => e.grupos[g].sql), ', ')}`
      : Prisma.empty;
    const orden = metricas.indexOf(q.ordenar && metricas.includes(q.ordenar) ? q.ordenar : metricas[0]);
    const orderBy = grupos.length ? Prisma.sql`ORDER BY "m${Prisma.raw(String(orden))}" DESC` : Prisma.empty;
    const limite = Math.min(TOPE_FILAS, Math.max(1, Number(q.limite) || TOPE_FILAS));
    // Se pide una fila de más para saber si hay que avisar de que quedó recortado.
    const limitSql = grupos.length ? Prisma.sql`LIMIT ${limite + 1}` : Prisma.empty;

    const sql = Prisma.sql`SELECT ${select} FROM ${e.from} ${where} ${groupBy} ${orderBy} ${limitSql}`;

    let filas: any[];
    try {
      filas = await this.prisma.$queryRaw<any[]>(sql);
    } catch (err) {
      // Un fallo aquí es un error de catálogo, no del usuario: se registra entero y
      // al modelo se le da algo accionable en vez de un volcado de Postgres.
      this.logger.error(`Consulta fallida (${q.entidad}): ${(err as Error).message}`);
      return { ok: false, error: 'La consulta no se pudo ejecutar. Prueba con menos agrupaciones o un filtro distinto.' };
    }

    const recortado = grupos.length > 0 && filas.length > limite;
    if (recortado) filas = filas.slice(0, limite);

    const columnas = [
      ...grupos.map((g) => ({ clave: g, etiqueta: e.grupos[g].descripcion })),
      ...metricas.map((m) => ({ clave: m, etiqueta: e.metricas[m].descripcion, dinero: !!e.metricas[m].dinero })),
    ];
    const salida = filas.map((f) => {
      const o: Record<string, string | number | null> = {};
      grupos.forEach((g, i) => { o[g] = f[`g${i}`] ?? null; });
      metricas.forEach((m, i) => { o[m] = Number(f[`m${i}`]) || 0; });
      return o;
    });

    return {
      ok: true,
      entidad: q.entidad,
      etiqueta: e.etiqueta,
      interpretado: [
        e.etiqueta,
        explicacion.length ? `con ${explicacion.join(', ')}` : 'sin filtros',
        grupos.length ? `agrupado por ${grupos.join(' y ')}` : '(total general)',
        `calculando ${metricas.join(', ')}`,
      ].join(' · '),
      columnas,
      filas: salida,
      total: salida.length,
      recortado,
    };
  }

  /**
   * Construye la condición de un filtro. Devuelve el SQL parametrizado y su
   * explicación en español, o un mensaje de error si el valor no encaja con el tipo.
   */
  private condicion(
    col: Prisma.Sql, tipo: string, valor: unknown, valores?: string[],
  ): { sql: Prisma.Sql; texto: string } | string {
    // Rango { desde, hasta } — vale para fechas y números.
    if (valor && typeof valor === 'object' && !Array.isArray(valor)) {
      const v = valor as { desde?: unknown; hasta?: unknown };
      const partes: Prisma.Sql[] = [];
      const txt: string[] = [];
      if (v.desde != null && v.desde !== '') {
        partes.push(tipo === 'fecha' ? Prisma.sql`${col} >= ${String(v.desde)}::date` : Prisma.sql`${col} >= ${Number(v.desde)}`);
        txt.push(`desde ${v.desde}`);
      }
      if (v.hasta != null && v.hasta !== '') {
        partes.push(tipo === 'fecha' ? Prisma.sql`${col} <= ${String(v.hasta)}::date` : Prisma.sql`${col} <= ${Number(v.hasta)}`);
        txt.push(`hasta ${v.hasta}`);
      }
      if (!partes.length) return 'el rango vino vacío.';
      return { sql: Prisma.sql`(${Prisma.join(partes, ' AND ')})`, texto: txt.join(' ') };
    }

    // Lista de valores → IN.
    if (Array.isArray(valor)) {
      if (!valor.length) return 'la lista vino vacía.';
      const vals = valor.map((x) => String(x));
      if (valores) {
        const malo = vals.find((x) => !valores.includes(x));
        if (malo) return `"${malo}" no es válido. Valores: ${valores.join(', ')}.`;
      }
      return { sql: Prisma.sql`${col} IN (${Prisma.join(vals.map((v) => Prisma.sql`${v}`), ', ')})`, texto: `en (${vals.join(', ')})` };
    }

    if (tipo === 'bool') {
      const b = valor === true || String(valor).toLowerCase() === 'true';
      return { sql: Prisma.sql`${col} = ${b}`, texto: b ? 'sí' : 'no' };
    }
    if (tipo === 'numero') {
      const n = Number(valor);
      if (!Number.isFinite(n)) return `"${valor}" no es un número.`;
      return { sql: Prisma.sql`${col} = ${n}`, texto: `= ${n}` };
    }
    if (tipo === 'fecha') {
      const s = String(valor);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return `"${s}" no es una fecha YYYY-MM-DD. Para un rango usa {desde, hasta}.`;
      return { sql: Prisma.sql`${col} = ${s}::date`, texto: `= ${s}` };
    }
    if (tipo === 'enum') {
      const s = String(valor);
      if (valores && !valores.includes(s)) return `"${s}" no es válido. Valores: ${valores.join(', ')}.`;
      return { sql: Prisma.sql`${col} = ${s}`, texto: `= ${s}` };
    }
    // Texto: parcial y sin distinguir mayúsculas, que es como pregunta la gente
    // ("villanueva", "VILLANUEVA", "villanue"). NO se ignoran las tildes: eso pide la
    // extensión `unaccent` de Postgres, que no está instalada en este servidor y no
    // se añade desde aquí — instalar una extensión es una decisión de base de datos.
    const s = String(valor);
    return { sql: Prisma.sql`${col} ILIKE ${`%${s}%`}`, texto: `contiene "${s}"` };
  }
}
