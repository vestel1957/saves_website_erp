import { Logger } from '../../core/logger';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { orden } from '../pagination-params';
import { describir, desglosar, NOMBRE_PENDIENTE, type Referencia, type RefTipo } from './bitacora-descripcion';

export interface AuditRecord {
  userId?: string;
  action: string;
  entity: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  ipAddress?: string;
}

/**
 * Writes immutable audit rows. Append-only — entries are never updated/deleted.
 * Shared across modules (inventory, SST, …) via the global AuditModule.
 */
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Lista paginada de la bitácora (para el visor en Sistemas). */
  /** Columnas ordenables del registro de actividad. */
  private static readonly ORDEN_LISTA = {
    createdAt: 'createdAt', userName: 'user.name', action: 'action',
    entity: 'entity', ipAddress: 'ipAddress',
  };

  /**
   * Peticiones que no cuentan como "algo que hizo un funcionario": el ping de GPS
   * de la app del técnico (5.000+ filas), los cron de alertas y las comprobaciones
   * de pantalla. Se siguen GUARDANDO (la bitácora es append-only y nada se pierde),
   * pero se ocultan salvo que se pidan con `ruido=1`; si no, entierran lo demás.
   */
  private static readonly RUIDO = [
    'POST /geo/ping', 'POST /geo/route', 'POST /inventory/alerts/run',
    'POST /inventory/alerts/read-all', 'POST /notifications/read-all',
    'POST /subscribers/check-duplicates', 'POST /promotions/audience',
  ];

  async list(params: { search?: string; entity?: string; userId?: string; from?: string; to?: string; page?: number; pageSize?: number; sortBy?: string; sortDir?: string; ruido?: string }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 30));
    const where: Prisma.AuditLogWhereInput = {};
    if (params.entity) where.entity = { contains: params.entity };
    if (params.userId) where.userId = params.userId;
    // Se busca por ruta Y por funcionario: en la pantalla lo que se lee es la frase
    // y el nombre, así que buscar sólo por `action` dejaba fuera lo más natural.
    if (params.search) {
      where.OR = [
        { action: { contains: params.search, mode: 'insensitive' } },
        { entity: { contains: params.search, mode: 'insensitive' } },
        { user: { name: { contains: params.search, mode: 'insensitive' } } },
        { user: { email: { contains: params.search, mode: 'insensitive' } } },
      ];
    }
    if (params.ruido !== '1') {
      where.NOT = AuditService.RUIDO.map((a) => ({ action: { startsWith: a } }));
    }
    if (params.from || params.to) {
      where.createdAt = {};
      if (params.from) where.createdAt.gte = new Date(params.from);
      if (params.to) where.createdAt.lte = new Date(`${params.to}T23:59:59`);
    }
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where, orderBy: orden(params, AuditService.ORDEN_LISTA, { createdAt: 'desc' }), skip: (page - 1) * pageSize, take: pageSize,
        include: { user: { select: { name: true, email: true } } },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    // La bitácora guarda la petición cruda; lo que se lista es la traducción a
    // castellano (ver bitacora-descripcion.ts) más el registro al que apunta, con
    // su nombre ya resuelto: "quién hizo qué, y sobre quién".
    const descripciones = rows.map((r) => describir({ action: r.action, entity: r.entity, entityId: r.entityId, after: r.after, before: r.before }));
    // A resolver: el registro afectado de cada fila + los nombres que las frases
    // dejaron marcados (el técnico de un agendamiento, las bodegas de un traspaso).
    const pendientes: Referencia[] = descripciones.map((d) => d.ref).filter(Boolean) as Referencia[];
    for (const d of descripciones) {
      for (const [, tipo, id] of d.frase.matchAll(NOMBRE_PENDIENTE)) pendientes.push({ tipo: tipo as RefTipo, id });
    }
    const nombres = await this.resolverReferencias(pendientes);
    const rellenar = (frase: string) =>
      frase.replace(NOMBRE_PENDIENTE, (_m, tipo, id, respaldo) => nombres.get(`${tipo}:${id}`)?.etiqueta ?? respaldo);

    return {
      items: rows.map((r, i) => {
        const d = descripciones[i];
        const objeto = d.ref ? nombres.get(`${d.ref.tipo}:${d.ref.id}`) ?? null : null;
        return {
          id: r.id, action: r.action, entity: r.entity, entityId: r.entityId,
          descripcion: rellenar(d.frase),
          objeto, // { etiqueta, ruta } del registro afectado, o null
          detalle: desglosar(r.after),
          userName: r.user?.name ?? null, userEmail: r.user?.email ?? null,
          ipAddress: r.ipAddress, createdAt: r.createdAt,
        };
      }),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  /**
   * Resuelve en lote los registros a los que apuntan las filas de una página:
   * nombre visible + ruta del frontend para poder ir allí. Una consulta por tipo
   * (nunca una por fila) y sin romperse si el registro ya no existe.
   */
  private async resolverReferencias(refs: Referencia[]) {
    const mapa = new Map<string, { etiqueta: string; ruta: string | null }>();
    if (!refs.length) return mapa;

    const porTipo = new Map<RefTipo, string[]>();
    for (const ref of refs) {
      const ids = porTipo.get(ref.tipo) ?? [];
      if (!ids.includes(ref.id)) ids.push(ref.id);
      porTipo.set(ref.tipo, ids);
    }
    const ids = (t: RefTipo) => porTipo.get(t) ?? [];
    const poner = (t: RefTipo, id: string, etiqueta: string, ruta: string | null) => mapa.set(`${t}:${id}`, { etiqueta, ruta });

    await Promise.all([
      ids('abonado').length && this.prisma.subscriber.findMany({
        where: { id: { in: ids('abonado') } },
        select: { id: true, abonado: true, fullName: true, firstName: true, lastName1: true, lastName2: true, companyName: true },
      }).then((rs) => rs.forEach((s) => {
        // `fullName`/`companyName` vienen vacíos en la mayoría de los importados, y
        // '' no lo atrapa `??`: hay que quedarse con el primero que tenga algo.
        const nombre = [s.fullName, s.companyName, [s.firstName, s.lastName1, s.lastName2].filter(Boolean).join(' ')]
          .map((x) => (x ?? '').trim()).find(Boolean) ?? '';
        poner('abonado', s.id, `${nombre || 'Abonado'} (#${s.abonado})`, `/clientes/${s.id}`);
      })),
      ids('orden').length && this.prisma.ticket.findMany({
        where: { id: { in: ids('orden') } }, select: { id: true, code: true, type: true },
      }).then((rs) => rs.forEach((t) => poner('orden', t.id, `Orden ${t.code ? `#${t.code}` : ''} ${t.type ?? ''}`.replace(/\s+/g, ' ').trim(), `/soporte/${t.id}`))),
      ids('factura').length && this.prisma.subInvoice.findMany({
        where: { id: { in: ids('factura') } }, select: { id: true, tid: true, subscriber: { select: { fullName: true } } },
      }).then((rs) => rs.forEach((f) => poner('factura', f.id, `Factura #${f.tid}${f.subscriber?.fullName ? ` — ${f.subscriber.fullName}` : ''}`, `/facturacion/${f.id}`))),
      ids('empleado').length && this.prisma.staff.findMany({
        where: { id: { in: ids('empleado') } }, select: { id: true, name: true },
      }).then((rs) => rs.forEach((e) => poner('empleado', e.id, e.name, `/configuracion/empleados/${e.id}`))),
      ids('plan').length && this.prisma.plan.findMany({
        where: { id: { in: ids('plan') } }, select: { id: true, name: true },
      }).then((rs) => rs.forEach((x) => poner('plan', x.id, x.name, '/configuracion/planes'))),
      ids('material').length && this.prisma.material.findMany({
        where: { id: { in: ids('material') } }, select: { id: true, name: true },
      }).then((rs) => rs.forEach((x) => poner('material', x.id, x.name, '/inventario'))),
      ids('bodega-material').length && this.prisma.materialWarehouse.findMany({
        where: { id: { in: ids('bodega-material') } }, select: { id: true, title: true },
      }).then((rs) => rs.forEach((x) => poner('bodega-material', x.id, x.title, `/inventario/bodegas/${x.id}`))),
      ids('tarea').length && this.prisma.todoTask.findMany({
        where: { id: { in: ids('tarea') } }, select: { id: true, name: true },
      }).then((rs) => rs.forEach((x) => poner('tarea', x.id, x.name ?? 'Tarea', '/tareas'))),
      ids('movimiento').length && this.prisma.transaction.findMany({
        where: { id: { in: ids('movimiento') } }, select: { id: true, note: true, debit: true, credit: true, payerName: true },
      }).then((rs) => rs.forEach((x) => poner('movimiento', x.id, x.note?.trim() || x.payerName?.trim() || 'Movimiento de caja', '/tesoreria'))),
      ids('promocion').length && this.prisma.promotion.findMany({
        where: { id: { in: ids('promocion') } }, select: { id: true, name: true },
      }).then((rs) => rs.forEach((x) => poner('promocion', x.id, x.name, '/configuracion/promociones'))),
      ids('compra').length && this.prisma.supplyOrder.findMany({
        where: { id: { in: ids('compra') } }, select: { id: true, tid: true },
      }).then((rs) => rs.forEach((x) => poner('compra', x.id, `Orden de compra #${x.tid}`, `/ordenes/${x.id}`))),
      ids('acta').length && this.prisma.materialActa.findMany({
        where: { id: { in: ids('acta') } }, select: { id: true, legacyId: true },
      }).then((rs) => rs.forEach((x) => poner('acta', x.id, `Acta ${x.legacyId ? `#${x.legacyId}` : ''}`.trim(), `/inventario/actas/${x.id}`))),
    ].filter(Boolean) as Promise<unknown>[]);

    return mapa;
  }

  async record(r: AuditRecord) {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: r.userId,
          action: r.action,
          entity: r.entity,
          entityId: r.entityId,
          before: (r.before as Prisma.InputJsonValue) ?? undefined,
          after: (r.after as Prisma.InputJsonValue) ?? undefined,
          ipAddress: r.ipAddress,
        },
      });
    } catch (e) {
      // Auditing must never break the business operation.
      this.logger.warn(`No se pudo registrar auditoría: ${(e as Error).message}`);
    }
  }

}
