import { NotFoundException } from '../core/http/errores';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { orden } from '../common/pagination-params';
import { AuthUser } from '../auth/current-user.decorator';
import { sedesDeUsuario } from './bodega-scope';
import { clavesDe, esTecnicoDeCampo, fichaDelUsuario } from '../common/tecnico-scope';

function subName(s: {
  firstName: string | null; secondName: string | null; lastName1: string | null;
  lastName2: string | null; companyName: string | null; fullName: string | null;
} | null): string | null {
  if (!s) return null;
  if (s.fullName && s.fullName.trim()) return s.fullName.trim();
  const p = [s.firstName, s.secondName, s.lastName1, s.lastName2].map((x) => (x || '').trim()).filter(Boolean).join(' ');
  return p || (s.companyName || '').trim() || null;
}
const SUB = { firstName: true, secondName: true, lastName1: true, lastName2: true, companyName: true, fullName: true, id: true, abonado: true } as const;

export class NetworkService {
  constructor(private readonly prisma: PrismaService) {}

  async stats() {
    const [mk, olt, onu, nap, port, portsUsed, equip, equipAssigned] = await Promise.all([
      this.prisma.mikrotik.count(),
      this.prisma.olt.count(),
      this.prisma.oltOnu.count(),
      this.prisma.nap.count(),
      this.prisma.port.count(),
      this.prisma.port.count({ where: { subscriberId: { not: null } } }),
      this.prisma.equipment.count(),
      this.prisma.equipment.count({ where: { subscriberId: { not: null } } }),
    ]);
    return { mikrotiks: mk, olts: olt, onus: onu, naps: nap, ports: port, portsUsed, portsFree: port - portsUsed, equipment: equip, equipAssigned };
  }

  async mikrotiks() {
    const rows = await this.prisma.mikrotik.findMany({ orderBy: { name: 'asc' }, include: { branch: { select: { name: true } } } });
    return rows.map((m) => ({ id: m.id, name: m.name, ip: m.ip, port: m.port, tech: m.tech, branch: m.branch?.name ?? null, online: m.online, isDefault: m.isDefault }));
  }

  async olts() {
    const rows = await this.prisma.olt.findMany({ orderBy: { name: 'asc' }, include: { branch: { select: { name: true } }, _count: { select: { onus: true } } } });
    return rows.map((o) => ({ id: o.id, name: o.name, brand: o.brand, ip: o.ip, tech: o.tech, branch: o.branch?.name ?? null, online: o.online, onus: o._count.onus }));
  }

  async onus(params: { search?: string; oltId?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
    const where: Prisma.OltOnuWhereInput = {};
    if (params.oltId) where.oltId = params.oltId;
    if (params.search?.trim()) {
      const s = params.search.trim();
      where.OR = [{ sn: { contains: s, mode: 'insensitive' } }, { clientName: { contains: s, mode: 'insensitive' } }, { description: { contains: s, mode: 'insensitive' } }];
    }
    const [rows, total] = await Promise.all([
      this.prisma.oltOnu.findMany({ where, orderBy: { legacyId: 'asc' }, skip: (page - 1) * pageSize, take: pageSize, include: { olt: { select: { name: true } }, subscriber: { select: SUB } } }),
      this.prisma.oltOnu.count({ where }),
    ]);
    return {
      items: rows.map((o) => ({ id: o.id, olt: o.olt?.name ?? null, sn: o.sn, slot: o.slot, port: o.port, ontId: o.ontId, runState: o.runState, rxPower: o.rxPower, syncState: o.syncState, client: subName(o.subscriber) ?? o.clientName, subscriberId: o.subscriber?.id ?? null, lastSync: o.lastSync })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  /**
   * Columnas ordenables de la tabla de NAPs. `ports` muestra "registrados /
   * totales": se ordena por los registrados, que es el dato que se mira para
   * ver cuánto queda libre.
   */
  private static readonly ORDEN_NAPS = {
    name: 'name',
    vlan: (dir: 'asc' | 'desc') => [{ vlan: { vlan: dir } }, { name: 'asc' as const }],
    addr: 'address',
    ports: (dir: 'asc' | 'desc') => ({ ports: { _count: dir } }),
  };

  async naps(params: { search?: string; branchId?: string; sort?: string; page?: number; pageSize?: number; sortBy?: string; sortDir?: string }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
    const where: Prisma.NapWhereInput = {};
    if (params.branchId) where.branchId = params.branchId;
    if (params.search?.trim()) where.name = { contains: params.search.trim(), mode: 'insensitive' };
    // Orden: por VLAN (con NAPs sin VLAN al final) o alfabético por nombre (por defecto).
    // `sort=vlan` es el conmutador viejo de la pantalla; la cabecera manda
    // `sortBy`/`sortDir` y tiene prioridad si viene.
    const porDefecto: Prisma.NapOrderByWithRelationInput[] =
      params.sort === 'vlan' ? [{ vlan: { vlan: 'asc' } }, { name: 'asc' }] : [{ name: 'asc' }];
    const orderBy = orden(params, NetworkService.ORDEN_NAPS, porDefecto);
    const [rows, total] = await Promise.all([
      this.prisma.nap.findMany({ where, orderBy, skip: (page - 1) * pageSize, take: pageSize, include: { branch: { select: { name: true } }, vlan: { select: { vlan: true } }, _count: { select: { ports: true } } } }),
      this.prisma.nap.count({ where }),
    ]);
    return {
      items: rows.map((n) => this.mapNap(n)),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  private mapNap(n: { id: string; name: string; branch: { name: string } | null; vlan: { vlan: number } | null; portCount: number; _count: { ports: number }; address: string; gpsLat: string | null; gpsLng: string | null }) {
    return { id: n.id, name: n.name, branch: n.branch?.name ?? null, vlan: n.vlan?.vlan ?? null, portCount: n.portCount, portsRegistered: n._count.ports, address: n.address, gps: n.gpsLat && n.gpsLng ? { lat: n.gpsLat, lng: n.gpsLng } : null };
  }

  /** Una NAP por id (para la vista de detalle). */
  async napById(id: string) {
    const n = await this.prisma.nap.findUnique({ where: { id }, include: { branch: { select: { name: true } }, vlan: { select: { vlan: true } }, _count: { select: { ports: true } } } });
    if (!n) throw new NotFoundException('NAP no encontrada');
    return this.mapNap(n);
  }

  /** VLANs (opcionalmente filtradas por sede) para selects de alta de NAP. */
  vlans(branchId?: string) {
    const where: Prisma.VlanWhereInput = branchId ? { branchId } : {};
    return this.prisma.vlan.findMany({ where, orderBy: { vlan: 'asc' }, select: { id: true, vlan: true, detail: true } });
  }

  /** Sedes con su número de cajas NAP (para la vista de red, sin depender de otros módulos). */
  async branches() {
    const rows = await this.prisma.branch.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, _count: { select: { naps: true } } } });
    return rows.map((b) => ({ id: b.id, name: b.name, naps: b._count.naps }));
  }

  /**
   * Columnas ordenables del inventario de equipos. `acs` (si está en GenieACS)
   * se muestra como sí/no a partir de `genieacsId`: ordenar por ese campo
   * agrupa igual, que es lo que se busca.
   */
  private static readonly ORDEN_EQUIPOS = {
    code: 'code', brand: 'brand', mac: 'mac', serial: 'serial',
    wh: 'warehouse.name', status: 'status', acs: 'genieacsId',
    client: (dir: 'asc' | 'desc') => [
      { subscriber: { firstName: dir } }, { subscriber: { lastName1: dir } },
    ],
  };

  async equipment(params: { search?: string; status?: string; warehouseId?: string; assigned?: string; page?: number; pageSize?: number; sortBy?: string; sortDir?: string }, user?: AuthUser) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
    const where: Prisma.EquipmentWhereInput = {};
    if (params.status) where.status = params.status;
    if (params.warehouseId) where.warehouseId = params.warehouseId;
    // Una cajera solo ve el equipo que está en las bodegas de sus sedes (es lo que
    // puede escoger para un traslado). Si pide otra bodega, se le ignora el filtro
    // en vez de servírsela.
    const sedes = user ? await sedesDeUsuario(this.prisma, user) : null;
    if (sedes !== null) {
      const suyas = await this.prisma.equipmentWarehouse.findMany({
        where: { branchLegacy: { in: sedes } }, select: { id: true },
      });
      const ids = suyas.map((w) => w.id);
      where.warehouseId = params.warehouseId && ids.includes(params.warehouseId) ? params.warehouseId : { in: ids };
    }
    // Un técnico de campo ve SOLO los equipos que están a su nombre (2026-07-31), no
    // los de su bodega ni los de su sede. La bodega que pida en la query se ignora:
    // su "bodega" es él mismo (ver `equipmentWarehouses`). Sin ficha de empleado no
    // hay forma de saber cuáles son suyos, y entonces no ve ninguno.
    if (esTecnicoDeCampo(user)) {
      const ficha = await fichaDelUsuario(this.prisma, user!);
      const claves = ficha ? clavesDe(ficha) : [];
      delete where.warehouseId;
      where.assignedRaw = claves.length ? { in: claves, mode: 'insensitive' } : '—sin-ficha-de-empleado—';
    }
    if (params.assigned === 'yes') where.subscriberId = { not: null };
    if (params.assigned === 'no') where.subscriberId = null;
    if (params.search?.trim()) {
      const s = params.search.trim();
      const n = Number(s);
      where.OR = [{ mac: { contains: s, mode: 'insensitive' } }, { serial: { contains: s, mode: 'insensitive' } }, { brand: { contains: s, mode: 'insensitive' } }, ...(Number.isFinite(n) ? [{ code: n }] : [])];
    }
    const [rows, total] = await Promise.all([
      this.prisma.equipment.findMany({ where, orderBy: orden(params, NetworkService.ORDEN_EQUIPOS, { code: 'desc' }), skip: (page - 1) * pageSize, take: pageSize, include: { warehouse: { select: { name: true } }, subscriber: { select: SUB } } }),
      this.prisma.equipment.count({ where }),
    ]);
    return {
      items: rows.map((e) => ({ id: e.id, code: e.code, mac: e.mac, serial: e.serial, brand: e.brand, status: e.status, warehouse: e.warehouse?.name ?? null, client: subName(e.subscriber), subscriberId: e.subscriber?.id ?? null, installType: e.installType, genieacs: !!e.genieacsId })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  /**
   * Bodegas de equipos para los selectores. Cada una dice de qué sede es, porque
   * mover equipo de una sede a otra no lo puede hacer cualquiera (lo revalida
   * `createTransfer`) y la pantalla tiene que poder avisarlo antes de intentarlo.
   *
   * A una cajera se le devuelven SOLO las de sus sedes: es la encargada de su sede,
   * no del inventario de las demás.
   */
  async warehouses(user?: AuthUser) {
    const sedes = user ? await sedesDeUsuario(this.prisma, user) : null;
    const where = sedes === null ? {} : { branchLegacy: { in: sedes } };
    const [rows, branches] = await Promise.all([
      this.prisma.equipmentWarehouse.findMany({
        where, orderBy: { name: 'asc' },
        select: { id: true, name: true, branchLegacy: true },
      }),
      this.prisma.branch.findMany({ select: { legacyId: true, name: true } }),
    ]);
    const sede = new Map(branches.map((b) => [b.legacyId, b.name]));
    return rows.map((w) => ({
      ...w,
      branchName: w.branchLegacy != null ? sede.get(w.branchLegacy) ?? null : null,
    }));
  }

  /** Pools de IP por Mikrotik (IpUserMk): pool local/remoto y perfiles. */
  async ipPools(params: { search?: string }) {
    const where: Prisma.IpUserMkWhereInput = {};
    if (params.search?.trim()) {
      const s = params.search.trim();
      where.OR = [
        { name: { contains: s, mode: 'insensitive' } },
        { ipLocal: { contains: s, mode: 'insensitive' } },
        { ipRemote: { contains: s, mode: 'insensitive' } },
        { tech: { contains: s, mode: 'insensitive' } },
      ];
    }
    const rows = await this.prisma.ipUserMk.findMany({ where, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
    const branches = await this.prisma.branch.findMany({ select: { id: true, legacyId: true, name: true } });
    const branchByLegacy = new Map(branches.map((b) => [b.legacyId, b]));
    return rows.map((r) => {
      const b = branchByLegacy.get(r.sedeLegacy);
      return {
        id: r.id, name: r.name, ipLocal: r.ipLocal, ipRemote: r.ipRemote,
        tech: r.tech, isDefault: r.isDefault, profiles: r.profiles,
        branch: b?.name ?? null,
        // El id de la sede además del nombre: sin él, el formulario de edición no
        // puede preseleccionarla (el nombre no es una llave).
        branchId: b?.id ?? null,
        sedeLegacy: r.sedeLegacy,
      };
    });
  }
}
