import { NotFoundException } from '../core/http/errores';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { megasDePlan } from '../playhub/playhub.service';
import { AuthUser } from '../auth/current-user.decorator';
import { sedesDe } from '../common/sede-scope';

/** El mismo mínimo de Megas del guard de PlayHub, para marcar el reporte. */
const MIN_MEGAS_REPORTE = Number(process.env.PLAYHUB_MIN_MEGAS ?? 100);

/** Clave de la sede en los filtros para las cuentas que no son de un cliente. */
const SIN_SEDE = '__sin_sede__';

function subName(s: { firstName: string | null; lastName1: string | null; companyName: string | null; fullName: string | null } | null): string | null {
  if (!s) return null;
  return (s.fullName?.trim()) || [s.firstName, s.lastName1].filter(Boolean).join(' ').trim() || s.companyName || null;
}

export class ExtrasService {
  constructor(private prisma: PrismaService) {}

  // --- PlayHub / IPTV ---
  /**
   * Reporte "Clientes PlayHub": UNA FILA POR CLIENTE, con sus apps, como el
   * listado del legacy (`Customers_model::playhub_listar_clientes`) y no una fila
   * por suscripción. Dos razones: el conteo que importa es el de cuentas, y la
   * tabla local guarda además filas "solo cuenta" (productId vacío) para los que
   * tienen cuenta en PlayHub sin ninguna suscripción — sueltas se leían como
   * suscripciones a "—".
   *
   * Se listan TODAS las cuentas, también las que no cumplen el mínimo de Megas:
   * es un reporte de USO, y las no elegibles son justo lo que hay que limpiar,
   * así que se marcan (`elegible: false`) en vez de esconderlas.
   */
  private static readonly ORDEN_PLAYHUB: Record<string, string> = {
    cliente: 'nombre', nameS: 'name_s', apps: 'total', total: 'total', syncedAt: 'ultima_sync',
    // Ordenar por plan es ordenar por MEGAS, no por el texto: "100 Megas F-26"
    // antes que "50 Megas F" es alfabéticamente correcto y de lo más inútil.
    plan: 'megas',
  };

  /** Orden con el que se enseñan los niveles; lo que no esté va detrás, alfabético. */
  private static readonly ORDEN_NIVEL = ['Servicio', 'Premium', 'Premium plus', 'Diamante'];

  /**
   * Nivel de un producto de PlayHub, sacado de su nombre: los diez productos
   * ("01 Servicio premium a elegir", "02 Servicios premium plus a elegir", …) son
   * en realidad dos datos, la CANTIDAD de apps y el NIVEL. Filtrar por el nombre
   * entero obliga a elegir cantidad y nivel a la vez, que no es lo que se pregunta.
   */
  private static nivelDeProducto(nombre?: string | null): string {
    const t = (nombre ?? '').trim();
    if (!t || t === '—') return 'Sin nombre';
    const nivel = t.replace(/^\d+\s+Servicios?\s*/i, '').replace(/\s*a\s+elegir\s*$/i, '').trim();
    // Sin nivel en el nombre ("01 Servicio a elegir") es el básico.
    if (!nivel) return 'Servicio';
    return nivel.charAt(0).toUpperCase() + nivel.slice(1).toLowerCase();
  }

  private static valorDeOrden(
    r: { subscriberName: string | null; nameS: string | null; total: number; syncedAt: Date | null; megas: number },
    col: string,
  ): string | number | Date | null {
    if (col === 'name_s') return r.nameS;
    if (col === 'total') return r.total;
    if (col === 'ultima_sync') return r.syncedAt;
    if (col === 'megas') return r.megas;
    return r.subscriberName;
  }

  async playhub(
    user: AuthUser | undefined,
    params: {
      search?: string; page?: number; pageSize?: number; sortBy?: string; sortDir?: string;
      /** '' = todas · 'cumple' · 'limpiar' · 'solo' (ver `estadoDe`). */
      estado?: string;
      /** Megas del plan, como número ('300') o '0' para "sin plan". */
      megas?: string[];
      nivel?: string[];
      sede?: string[];
    },
  ) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 30));
    const busca = (params.search || '').trim();
    const like = `%${busca}%`;

    // Alcance por sede: la cajera trabaja PlayHub sólo sobre SU sede, así que el
    // reporte (y sus totales) se recortan igual que el resto de listados. `null` =
    // sin límite. Se filtra por `Branch.legacyId`, que es lo que guarda `sedesAccede`.
    const sedes = await sedesDe(this.prisma, user);
    const filtroSede = sedes ? Prisma.sql`f.sede_legacy IN (${Prisma.join(sedes)})` : Prisma.sql`TRUE`;

    const col = ExtrasService.ORDEN_PLAYHUB[params.sortBy ?? ''] ?? 'nombre';
    const desc = (params.sortDir ?? '').toLowerCase() === 'desc';

    // El grupo es el cliente: sus filas de la tabla local colapsan en una, y el
    // plan sale de su última factura (misma fuente que la ficha).
    const CTE = Prisma.sql`
      WITH g AS (
        SELECT ps."subscriberId" AS sid,
               MAX(ps."nameS") AS name_s,
               MAX(COALESCE(ps."externalName", ps."nameS")) AS externo,
               string_agg(
                 CASE WHEN COALESCE(ps."productId", '') <> ''
                      THEN COALESCE(ps."productName", ps."productId") || ' (' || ps."productId" || ')' END,
                 ' · ' ORDER BY ps."productId") AS apps,
               COUNT(*) FILTER (WHERE COALESCE(ps."productId", '') <> '') AS total,
               array_agg(DISTINCT COALESCE(ps."productName", '—'))
                 FILTER (WHERE COALESCE(ps."productId", '') <> '') AS productos,
               MAX(ps."syncedAt") AS ultima_sync
          FROM "PlayhubSubscription" ps
         GROUP BY ps."subscriberId",
                  CASE WHEN ps."subscriberId" IS NULL THEN COALESCE(ps."externalName", ps."nameS") END
      ),
      f AS (
        SELECT g.sid,
               COALESCE(NULLIF(btrim(COALESCE(s."fullName", concat_ws(' ', s."firstName", s."lastName1"))), ''), g.externo) AS nombre,
               COALESCE(s."pppUsername", g.name_s) AS name_s,
               s."docNumber" AS documento, s.abonado, b.name AS sede, b."legacyId" AS sede_legacy,
               g.apps, g.total, g.productos, g.ultima_sync,
               i."serviceCombo" AS plan_internet, i."serviceTv" AS plan_tv
          FROM g
          LEFT JOIN "Subscriber" s ON s.id = g.sid
          LEFT JOIN "Branch" b ON b.id = s."branchId"
          LEFT JOIN LATERAL (
            SELECT si."serviceCombo", si."serviceTv"
              FROM "SubInvoice" si
             WHERE si."subscriberId" = g.sid
             ORDER BY si."invoiceDate" DESC NULLS LAST, si.tid DESC
             LIMIT 1
          ) i ON TRUE
      )`;

    const filtroBusca = busca
      ? Prisma.sql`(f.nombre ILIKE ${like} OR f.name_s ILIKE ${like} OR f.documento ILIKE ${like} OR f.apps ILIKE ${like} OR f.sede ILIKE ${like})`
      : Prisma.sql`TRUE`;

    // Se traen TODAS las cuentas del alcance (hoy ~130: una por cliente con
    // PlayHub) y el resto —filtros, conteos de cada filtro, orden y página— se
    // resuelve aquí. Antes hacían falta hasta cuatro consultas para lo mismo
    // (la página, el resumen por producto, los totales y el "de cuántas"), y los
    // conteos por faceta habrían sumado una más cada uno. Lo que NO se puede
    // mover fuera del SQL es el alcance por sede y la búsqueda: esos deciden qué
    // se trae.
    const filas = await this.prisma.$queryRaw<
      {
        sid: string | null; nombre: string | null; name_s: string | null; documento: string | null;
        abonado: number | null; sede: string | null; sede_legacy: number | null; apps: string | null;
        productos: string[] | null; total: bigint;
        ultima_sync: Date | null; plan_internet: string | null; plan_tv: string | null;
      }[]
    >`
      ${CTE}
      SELECT f.* FROM f WHERE ${filtroSede} AND ${filtroBusca}`;

    const todas = filas.map((r) => {
      const megas = megasDePlan(r.plan_internet);
      const total = Number(r.total);
      // Cuenta externa (sin cliente en la base) = sin plan que mirar: no elegible.
      const elegible = !!r.sid && megas >= MIN_MEGAS_REPORTE;
      return {
        id: r.sid ?? `ext:${r.name_s ?? r.nombre ?? ''}`,
        subscriberId: r.sid, subscriberName: r.nombre, abonado: r.abonado, docNumber: r.documento,
        nameS: r.name_s, sede: r.sede,
        apps: r.apps ? r.apps.split(' · ') : [],
        total,
        syncedAt: r.ultima_sync,
        planInternet: r.plan_internet && r.plan_internet !== 'no' ? r.plan_internet : null,
        planTv: r.plan_tv && r.plan_tv !== 'no' ? r.plan_tv : null,
        megas, elegible,
        // Los tres primeros son las CLAVES de los filtros; `niveles` va también a
        // la tabla porque es lo que se filtró.
        estado: total === 0 ? 'solo' : elegible ? 'cumple' : 'limpiar',
        megasKey: String(megas),
        sedeKey: r.sede ?? SIN_SEDE,
        niveles: [...new Set((r.productos ?? []).map((p) => ExtrasService.nivelDeProducto(p)))],
      };
    });

    const estado = params.estado ?? '';
    const megasSel = params.megas ?? [];
    const nivelSel = params.nivel ?? [];
    const sedeSel = params.sede ?? [];
    /**
     * Los filtros se combinan: Y entre filtros, O dentro de uno. `salvo` deja
     * fuera un filtro para poder contar SUS opciones con los demás puestos — sin
     * eso, marcar "300 Megas" dejaría su propia opción en 300 y las otras en cero.
     */
    const pasa = (r: (typeof todas)[number], salvo?: string) =>
      (salvo === 'estado' || !estado || r.estado === estado) &&
      (salvo === 'megas' || !megasSel.length || megasSel.includes(r.megasKey)) &&
      (salvo === 'nivel' || !nivelSel.length || r.niveles.some((n) => nivelSel.includes(n))) &&
      (salvo === 'sede' || !sedeSel.length || sedeSel.includes(r.sedeKey));

    const cuentaEstado = (v: string) => todas.filter((r) => pasa(r, 'estado') && (!v || r.estado === v)).length;
    const facetas = {
      estado: {
        todas: cuentaEstado(''), cumple: cuentaEstado('cumple'),
        limpiar: cuentaEstado('limpiar'), solo: cuentaEstado('solo'),
      },
      // El plan se filtra por MEGAS y no por el nombre: las mismas 300 Megas están
      // escritas de cuatro formas ("300 Megas F-26", "300 Megas ST", "300Megas26F",
      // "300Megas26F-S"), y por nombre serían cuatro casillas para una sola pregunta.
      megas: [...new Set(todas.map((r) => r.megasKey))]
        .sort((a, b) => Number(b) - Number(a))
        .map((v) => ({
          value: v,
          label: v === '0' ? 'Sin plan' : `${v} Megas`,
          count: todas.filter((r) => pasa(r, 'megas') && r.megasKey === v).length,
          bajo: Number(v) < MIN_MEGAS_REPORTE,
        })),
      nivel: [...new Set(todas.flatMap((r) => r.niveles))]
        .sort((a, b) => {
          const ia = ExtrasService.ORDEN_NIVEL.indexOf(a);
          const ib = ExtrasService.ORDEN_NIVEL.indexOf(b);
          return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, 'es');
        })
        .map((v) => ({
          value: v, label: v,
          count: todas.filter((r) => pasa(r, 'nivel') && r.niveles.includes(v)).length,
        })),
      sede: [...new Set(todas.map((r) => r.sedeKey))]
        .sort((a, b) => (a === SIN_SEDE ? 1 : b === SIN_SEDE ? -1 : a.localeCompare(b, 'es')))
        .map((v) => ({
          value: v,
          label: v === SIN_SEDE ? 'Sin cliente (externas)' : v,
          count: todas.filter((r) => pasa(r, 'sede') && r.sedeKey === v).length,
        })),
    };

    // Titular del legacy: cuántas apps hay en uso y cuántas las tiene alguien que
    // no cumple la regla. Es del reporte entero, no de lo filtrado.
    const conApps = todas.filter((r) => r.total > 0);
    const apps = conApps.reduce((n, r) => n + r.total, 0);
    const appsNoElegibles = conApps.filter((r) => !r.elegible).reduce((n, r) => n + r.total, 0);

    const filtradas = todas.filter((r) => pasa(r));
    const total = filtradas.length;
    const items = [...filtradas]
      .sort((a, b) => {
        const va = ExtrasService.valorDeOrden(a, col);
        const vb = ExtrasService.valorDeOrden(b, col);
        // Los vacíos van siempre al final, como el `NULLS LAST` del SQL anterior.
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        const c = typeof va === 'string' && typeof vb === 'string'
          ? va.localeCompare(vb, 'es', { sensitivity: 'base' })
          : Number(va) - Number(vb);
        return desc ? -c : c;
      })
      .slice((page - 1) * pageSize, page * pageSize);

    return {
      items, total, cuentas: todas.length, page, pageSize, pages: Math.ceil(total / pageSize),
      apps, appsNoElegibles, minMegas: MIN_MEGAS_REPORTE, facetas,
    };
  }

  // --- Mensajería interna ---
  async messages(params: { search?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 30));
    const where: Prisma.InternalMessageWhereInput = {};
    const s = (params.search || '').trim();
    if (s) where.OR = [{ campaignName: { contains: s, mode: 'insensitive' } }, { body: { contains: s, mode: 'insensitive' } }];
    const [rows, total] = await Promise.all([
      this.prisma.internalMessage.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.internalMessage.count({ where }),
    ]);
    return { items: rows, total, page, pageSize, pages: Math.ceil(total / pageSize) };
  }

  // --- Gestor documental ---
  async documents() {
    const [folders, docs] = await Promise.all([
      this.prisma.docFolder.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.document.findMany({ orderBy: { createdAt: 'desc' } }),
    ]);
    return {
      folders: folders.map((f) => ({ id: f.id, name: f.name, count: docs.filter((d) => d.folderId === f.id).length })),
      documents: docs.map((d) => ({
        id: d.id, title: d.title, fileName: d.fileName, folderId: d.folderId,
        docDate: d.docDate, downloadable: !!d.storedName, createdAt: d.createdAt,
      })),
    };
  }

  async createDocument(data: { title: string; fileName: string; storedName: string; folderId?: string }) {
    return this.prisma.document.create({ data: { title: data.title, fileName: data.fileName, storedName: data.storedName, folderId: data.folderId ?? null } });
  }

  async getDocument(id: string) {
    const d = await this.prisma.document.findUnique({ where: { id } });
    if (!d) throw new NotFoundException('Documento no encontrado');
    return d;
  }

  async createFolder(name: string) {
    return this.prisma.docFolder.create({ data: { name } });
  }
}
