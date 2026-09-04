import { NotFoundException } from '../core/http/errores';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { megasDePlan } from '../playhub/playhub.service';

/** El mismo mínimo de Megas del guard de PlayHub, para marcar el reporte. */
const MIN_MEGAS_REPORTE = Number(process.env.PLAYHUB_MIN_MEGAS ?? 100);

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
  };

  async playhub(params: { search?: string; page?: number; pageSize?: number; sortBy?: string; sortDir?: string }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 30));
    const busca = (params.search || '').trim();
    const like = `%${busca}%`;

    const col = ExtrasService.ORDEN_PLAYHUB[params.sortBy ?? ''] ?? 'nombre';
    const dir = (params.sortDir ?? '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    // `col` y `dir` salen de una lista blanca: no hay interpolación de nada del usuario.
    const orderBy = Prisma.raw(`${col} ${dir} NULLS LAST`);

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
               MAX(ps."syncedAt") AS ultima_sync
          FROM "PlayhubSubscription" ps
         GROUP BY ps."subscriberId",
                  CASE WHEN ps."subscriberId" IS NULL THEN COALESCE(ps."externalName", ps."nameS") END
      ),
      f AS (
        SELECT g.sid,
               COALESCE(NULLIF(btrim(COALESCE(s."fullName", concat_ws(' ', s."firstName", s."lastName1"))), ''), g.externo) AS nombre,
               COALESCE(s."pppUsername", g.name_s) AS name_s,
               s."docNumber" AS documento, s.abonado, b.name AS sede,
               g.apps, g.total, g.ultima_sync,
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

    const filas = await this.prisma.$queryRaw<
      {
        sid: string | null; nombre: string | null; name_s: string | null; documento: string | null;
        abonado: number | null; sede: string | null; apps: string | null; total: bigint;
        ultima_sync: Date | null; plan_internet: string | null; plan_tv: string | null; grupos: bigint;
      }[]
    >`
      ${CTE}
      SELECT f.*, COUNT(*) OVER() AS grupos
        FROM f
       WHERE ${busca ? Prisma.sql`(f.nombre ILIKE ${like} OR f.name_s ILIKE ${like} OR f.documento ILIKE ${like} OR f.apps ILIKE ${like} OR f.sede ILIKE ${like})` : Prisma.sql`TRUE`}
       ORDER BY ${orderBy}
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;

    // Resumen por producto: sólo suscripciones de verdad (fuera el "solo cuenta").
    const porProducto = await this.prisma.playhubSubscription.groupBy({
      by: ['productName'],
      where: { AND: [{ productId: { not: null } }, { productId: { not: '' } }] },
      _count: { _all: true },
      orderBy: { _count: { productName: 'desc' } },
      take: 8,
    });

    // Totales del REPORTE ENTERO (no de la página): son el titular del legacy —
    // cuántas apps hay en uso y cuántas las tiene alguien que no cumple la regla.
    const todos = await this.prisma.$queryRaw<{ sid: string | null; total: bigint; plan_internet: string | null }[]>`
      ${CTE}
      SELECT f.sid, f.total, f.plan_internet FROM f WHERE f.total > 0`;
    const apps = todos.reduce((n, r) => n + Number(r.total), 0);
    const appsNoElegibles = todos
      .filter((r) => !r.sid || megasDePlan(r.plan_internet) < MIN_MEGAS_REPORTE)
      .reduce((n, r) => n + Number(r.total), 0);

    const total = Number(filas[0]?.grupos ?? 0);
    const items = filas.map((r) => {
      const megas = megasDePlan(r.plan_internet);
      return {
        id: r.sid ?? `ext:${r.name_s ?? r.nombre ?? ''}`,
        subscriberId: r.sid, subscriberName: r.nombre, abonado: r.abonado, docNumber: r.documento,
        nameS: r.name_s, sede: r.sede,
        apps: r.apps ? r.apps.split(' · ') : [],
        total: Number(r.total),
        syncedAt: r.ultima_sync,
        planInternet: r.plan_internet && r.plan_internet !== 'no' ? r.plan_internet : null,
        planTv: r.plan_tv && r.plan_tv !== 'no' ? r.plan_tv : null,
        megas,
        // Cuenta externa (sin cliente en la base) = sin plan que mirar: no elegible.
        elegible: !!r.sid && megas >= MIN_MEGAS_REPORTE,
      };
    });

    return {
      items, total, page, pageSize, pages: Math.ceil(total / pageSize),
      apps, appsNoElegibles, minMegas: MIN_MEGAS_REPORTE,
      byProduct: porProducto.map((b) => ({ product: b.productName ?? '—', count: b._count._all })),
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
