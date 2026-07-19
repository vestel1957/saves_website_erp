import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';

export class EquipTransferDto {
  @IsString() fromWarehouseId!: string;
  @IsString() toWarehouseId!: string;
  @IsOptional() @IsString() observations?: string;
  @IsArray() @IsString({ each: true }) equipmentIds!: string[];
}
export class AssignPortDto {
  @IsString() @MinLength(1) subscriberId!: string;
}
export class RejectTransferDto {
  @IsOptional() @IsString() reason?: string;
}

/**
 * Pool de IP (legacy `ips_users_mk`). Los campos son los mismos que el formulario del
 * legacy (views/mikrotiks/ips_users.php): nombre, ip_local, ip_remota, tegnologia,
 * sede y perfiles. `defecto` no se manda aquí: se decide solo al crear y se cambia
 * con su propia ruta, igual que en el legacy.
 */
export class CreateIpPoolDto {
  @IsString() @MinLength(1) name!: string;
  @IsString() @MinLength(1) ipLocal!: string;
  @IsString() @MinLength(1) ipRemote!: string;
  @IsString() branchId!: string;
  @IsOptional() @IsString() tech?: string;
  /** Perfiles PPPoE separados por coma, como los guarda el legacy. */
  @IsOptional() @IsString() profiles?: string;
}

export class UpdateIpPoolDto {
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @IsOptional() @IsString() @MinLength(1) ipLocal?: string;
  @IsOptional() @IsString() @MinLength(1) ipRemote?: string;
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsString() tech?: string;
  @IsOptional() @IsString() profiles?: string;
}
export class CreateEquipmentDto {
  @IsString() warehouseId!: string;
  @IsOptional() @IsString() mac?: string;
  @IsOptional() @IsString() serial?: string;
  @IsOptional() @IsString() brand?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() observation?: string;
}
export class CreateVlanDto {
  @IsString() @MinLength(1) branchId!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(4094) vlan!: number;
  @IsString() @MinLength(1) detail!: string;
  @IsOptional() @IsString() olt?: string;
  @IsOptional() @Type(() => Number) @IsInt() tray?: number;
  @IsOptional() @Type(() => Number) @IsInt() oltPort?: number;
}
export class UpdateNapDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() vlanId?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() gpsLat?: string;
  @IsOptional() @IsString() gpsLng?: string;
}
export class AssignEquipmentSubDto {
  @IsString() @MinLength(1) subscriberId!: string;
  @IsOptional() @IsString() installType?: string;
  @IsOptional() @Type(() => Number) @IsInt() port?: number;
  @IsOptional() @Type(() => Number) @IsInt() vlan?: number;
  @IsOptional() @Type(() => Number) @IsInt() meters?: number;
  @IsOptional() @IsString() master?: string;
}
export class CreateNapDto {
  @IsString() @MinLength(1) name!: string;
  @IsString() @MinLength(1) branchId!: string;
  @IsOptional() @IsString() vlanId?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(256) portCount!: number;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() gpsLat?: string;
  @IsOptional() @IsString() gpsLng?: string;
}

function subName(s: { firstName: string | null; lastName1: string | null; companyName: string | null; fullName: string | null } | null): string | null {
  if (!s) return null;
  return (s.fullName?.trim()) || [s.firstName, s.lastName1].filter(Boolean).join(' ').trim() || s.companyName || null;
}

@Injectable()
export class NetworkWriteService {
  constructor(private readonly prisma: PrismaService) {}

  /** Transferencias de equipos (actas). */
  async transfers(params: { page?: number; pageSize?: number; search?: string; status?: string; warehouseId?: string }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));

    const and: Prisma.EquipmentTransferWhereInput[] = [];
    const q = params.search?.trim();
    if (q) {
      const ins = { contains: q, mode: 'insensitive' as const };
      and.push({ OR: [
        { fromWarehouseName: ins }, { toWarehouseName: ins },
        { requestedByName: ins }, { approvedByName: ins }, { receivedByName: ins },
        { observations: ins }, { fromWarehouse: ins }, { toWarehouse: ins },
      ] });
    }
    if (params.status?.trim()) and.push({ status: params.status.trim() });
    if (params.warehouseId?.trim()) {
      const wh = await this.prisma.equipmentWarehouse.findUnique({ where: { id: params.warehouseId.trim() } });
      if (wh) {
        const legacy = String(wh.legacyId ?? '');
        and.push({ OR: [
          { fromWarehouseId: wh.id }, { toWarehouseId: wh.id },
          { fromWarehouseName: wh.name }, { toWarehouseName: wh.name },
          ...(legacy ? [{ fromWarehouse: legacy }, { toWarehouse: legacy }] : []),
        ] });
      } else {
        // Bodega inexistente: no devolver nada en vez de ignorar el filtro.
        and.push({ id: '__none__' });
      }
    }
    const where: Prisma.EquipmentTransferWhereInput = and.length ? { AND: and } : {};

    const [rows, total] = await Promise.all([
      this.prisma.equipmentTransfer.findMany({ where, orderBy: { date: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: { _count: { select: { items: true } } } }),
      this.prisma.equipmentTransfer.count({ where }),
    ]);
    // Resolver nombres de bodega (fromWarehouse/toWarehouse legacy id string)
    const whs = await this.prisma.equipmentWarehouse.findMany();
    const byLegacy = new Map(whs.map((w) => [String(w.legacyId), w.name]));
    return {
      items: rows.map((t) => ({
        id: t.id, date: t.date,
        from: t.fromWarehouseName ?? byLegacy.get(t.fromWarehouse) ?? t.fromWarehouse,
        to: t.toWarehouseName ?? byLegacy.get(t.toWarehouse) ?? t.toWarehouse,
        observations: t.observations, status: t.status ?? 'Emitida', items: t._count.items,
        requestedBy: t.requestedByName, requestedAt: t.requestedAt,
        approvedBy: t.approvedByName, approvedAt: t.approvedAt,
        receivedBy: t.receivedByName, receivedAt: t.receivedAt,
      })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  async transferDetail(id: string) {
    const t = await this.prisma.equipmentTransfer.findUnique({ where: { id }, include: { items: { include: { equipment: true } } } });
    if (!t) throw new NotFoundException('Transferencia no encontrada');
    return {
      id: t.id, date: t.date, from: t.fromWarehouseName ?? t.fromWarehouse, to: t.toWarehouseName ?? t.toWarehouse,
      observations: t.observations, status: t.status ?? 'Emitida',
      requestedBy: t.requestedByName, requestedAt: t.requestedAt,
      approvedBy: t.approvedByName, approvedAt: t.approvedAt,
      receivedBy: t.receivedByName, receivedAt: t.receivedAt, rejectReason: t.rejectReason,
      items: t.items.map((it) => ({ id: it.id, code: it.equipment?.code, mac: it.equipment?.mac, serial: it.equipment?.serial, brand: it.equipment?.brand, status: it.equipment?.status })),
    };
  }

  /**
   * Solicita una transferencia de equipos. NO mueve el equipo: crea la solicitud
   * en estado "Pendiente" con la lista de equipos, a la espera de aprobación.
   */
  async createTransfer(dto: EquipTransferDto, user: AuthUser) {
    if (dto.fromWarehouseId === dto.toWarehouseId) throw new BadRequestException('Bodega origen y destino deben ser distintas');
    if (!dto.equipmentIds?.length) throw new BadRequestException('Selecciona al menos un equipo');
    const [from, to] = await Promise.all([
      this.prisma.equipmentWarehouse.findUnique({ where: { id: dto.fromWarehouseId } }),
      this.prisma.equipmentWarehouse.findUnique({ where: { id: dto.toWarehouseId } }),
    ]);
    if (!from || !to) throw new NotFoundException('Bodega no encontrada');

    return this.prisma.$transaction(async (tx) => {
      const t = await tx.equipmentTransfer.create({
        data: {
          date: new Date(), fromWarehouse: String(from.legacyId ?? ''), toWarehouse: String(to.legacyId ?? ''),
          fromWarehouseName: from.name, toWarehouseName: to.name, fromWarehouseId: from.id, toWarehouseId: to.id,
          observations: dto.observations ?? null, userId: 0, status: 'Pendiente',
          requestedById: user.id, requestedByName: user.name, requestedAt: new Date(),
        },
      });
      let count = 0;
      for (const eqId of dto.equipmentIds) {
        const eq = await tx.equipment.findUnique({ where: { id: eqId } });
        if (!eq || eq.warehouseId !== dto.fromWarehouseId) continue;
        await tx.equipmentTransferItem.create({ data: { transferId: t.id, equipmentId: eq.id, equipmentLegacy: eq.legacyId ?? 0 } });
        count++;
      }
      if (!count) throw new BadRequestException('Ningún equipo válido en la bodega origen');
      return { id: t.id, status: 'Pendiente', count };
    });
  }

  /**
   * Aprueba/despacha una solicitud pendiente: el equipo SALE de la bodega origen
   * y queda "En tránsito" (sin bodega) hasta que caja confirme la recepción.
   * Reservado al Jefe de bodega (inventario).
   */
  async approveTransfer(id: string, user: AuthUser) {
    const t = await this.prisma.equipmentTransfer.findUnique({ where: { id }, include: { items: true } });
    if (!t) throw new NotFoundException('Transferencia no encontrada');
    if (t.status !== 'Pendiente') throw new BadRequestException('La transferencia no está pendiente de aprobación');
    if (t.requestedById && t.requestedById === user.id) throw new BadRequestException('No puedes aprobar tu propia solicitud; debe aprobarla inventario');
    if (!t.toWarehouseId || !t.fromWarehouseId) throw new BadRequestException('La solicitud no tiene bodegas válidas (creada antes del flujo de aprobación)');

    return this.prisma.$transaction(async (tx) => {
      let dispatched = 0; const skipped: (number | undefined)[] = [];
      for (const it of t.items) {
        if (!it.equipmentId) { skipped.push(it.equipmentLegacy); continue; }
        const eq = await tx.equipment.findUnique({ where: { id: it.equipmentId } });
        // Revalida: el equipo debe seguir en la bodega origen al momento de despachar.
        if (!eq || eq.warehouseId !== t.fromWarehouseId) { skipped.push(eq?.code ?? it.equipmentLegacy); continue; }
        await tx.equipment.update({ where: { id: eq.id }, data: { warehouseId: null } }); // en tránsito
        dispatched++;
      }
      if (!dispatched) throw new BadRequestException('Ningún equipo sigue disponible en la bodega origen');
      await tx.equipmentTransfer.update({ where: { id }, data: { status: 'En tránsito', approvedById: user.id, approvedByName: user.name, approvedAt: new Date() } });
      return { id, status: 'En tránsito', dispatched, skipped: skipped.length };
    });
  }

  /**
   * Confirma la recepción de una transferencia "En tránsito": el equipo ENTRA a
   * la bodega destino. Reservado a caja (área caja) en la sede destino.
   */
  async receiveTransfer(id: string, user: AuthUser) {
    const t = await this.prisma.equipmentTransfer.findUnique({ where: { id }, include: { items: true } });
    if (!t) throw new NotFoundException('Transferencia no encontrada');
    if (t.status !== 'En tránsito') throw new BadRequestException('La transferencia no está en tránsito');
    if (!t.toWarehouseId) throw new BadRequestException('La transferencia no tiene bodega destino válida');

    return this.prisma.$transaction(async (tx) => {
      const to = await tx.equipmentWarehouse.findUnique({ where: { id: t.toWarehouseId! } });
      if (!to) throw new BadRequestException('La bodega destino ya no existe');
      let received = 0;
      for (const it of t.items) {
        if (!it.equipmentId) continue;
        await tx.equipment.update({ where: { id: it.equipmentId }, data: { warehouseId: to.id, warehouseLegacy: to.legacyId ?? 0 } });
        received++;
      }
      await tx.equipmentTransfer.update({ where: { id }, data: { status: 'Recibida', receivedById: user.id, receivedByName: user.name, receivedAt: new Date() } });
      return { id, status: 'Recibida', received };
    });
  }

  /** Rechaza una solicitud pendiente (no mueve equipos). Reservado a inventario. */
  async rejectTransfer(id: string, user: AuthUser, reason?: string) {
    const t = await this.prisma.equipmentTransfer.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Transferencia no encontrada');
    if (t.status !== 'Pendiente') throw new BadRequestException('Solo se puede rechazar una solicitud pendiente');
    await this.prisma.equipmentTransfer.update({
      where: { id },
      data: { status: 'Rechazada', approvedById: user.id, approvedByName: user.name, approvedAt: new Date(), rejectReason: reason?.trim() || null },
    });
    return { id, status: 'Rechazada' };
  }

  /** Bodegas de equipos con conteo. */
  async equipmentWarehouses() {
    const rows = await this.prisma.equipmentWarehouse.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { equipment: true } } } });
    return rows.map((w) => ({ id: w.id, name: w.name, description: w.description, equipment: w._count.equipment }));
  }

  /** Ingreso de equipo (alta). */
  async createEquipment(dto: CreateEquipmentDto, user: AuthUser) {
    const wh = await this.prisma.equipmentWarehouse.findUnique({ where: { id: dto.warehouseId } });
    if (!wh) throw new NotFoundException('Bodega no encontrada');
    const max = await this.prisma.equipment.aggregate({ _max: { code: true } });
    const code = (max._max.code ?? 999) + 1;
    const eq = await this.prisma.equipment.create({
      data: {
        code, supplierLegacy: 0, warehouseId: wh.id, warehouseLegacy: wh.legacyId ?? 0,
        mac: dto.mac ?? null, serial: dto.serial ?? null, brand: dto.brand ?? null,
        status: dto.status ?? 'Disponible', observation: dto.observation ?? null, arrival: new Date(),
      },
    });
    return { id: eq.id, code: eq.code };
  }

  /** Conexiones (puertos) de una sede. */
  async ports(params: { search?: string; status?: string; napId?: string; branchId?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
    // Filtros de alcance (sede/NAP/búsqueda) que aplican también al conteo de ocupación.
    const scope: Prisma.PortWhereInput = {};
    if (params.napId) scope.napId = params.napId;
    if (params.branchId) scope.nap = { is: { branchId: params.branchId } };
    const search = (params.search || '').trim();
    if (search) {
      scope.OR = [
        { nap: { is: { name: { contains: search, mode: 'insensitive' } } } },
        { subscriber: { is: { OR: [{ firstName: { contains: search, mode: 'insensitive' } }, { lastName1: { contains: search, mode: 'insensitive' } }] } } },
      ];
    }
    // El estado filtra la tabla, pero NO el conteo (así siempre se ve el split ocupados/libres del alcance).
    const where: Prisma.PortWhereInput = params.status ? { ...scope, status: params.status } : scope;
    const [rows, total, ocupados, libres] = await Promise.all([
      this.prisma.port.findMany({ where, orderBy: [{ napId: 'asc' }, { port: 'asc' }], skip: (page - 1) * pageSize, take: pageSize, include: { nap: true, subscriber: { select: { id: true, firstName: true, lastName1: true, companyName: true, fullName: true, abonado: true } } } }),
      this.prisma.port.count({ where }),
      this.prisma.port.count({ where: { ...scope, status: 'Ocupado' } }),
      this.prisma.port.count({ where: { ...scope, status: 'Disponible' } }),
    ]);
    return {
      items: rows.map((p) => ({
        id: p.id, port: p.port, status: p.status, nap: p.nap?.name ?? null,
        client: subName(p.subscriber), subscriberId: p.subscriber?.id ?? null, abonado: p.subscriber?.abonado ?? null, detail: p.detail,
      })),
      counts: { ocupados, libres, scope: ocupados + libres },
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  /** Lista slim de NAPs (id + nombre) para selects/combobox, opcionalmente por sede. */
  async napOptions(branchId?: string) {
    const where: Prisma.NapWhereInput = branchId ? { branchId } : {};
    const rows = await this.prisma.nap.findMany({ where, orderBy: { name: 'asc' }, select: { id: true, name: true } });
    return rows.map((n) => ({ id: n.id, name: n.name }));
  }

  async assignPort(id: string, dto: AssignPortDto) {
    const [port, sub] = await Promise.all([
      this.prisma.port.findUnique({ where: { id } }),
      this.prisma.subscriber.findUnique({ where: { id: dto.subscriberId }, select: { id: true, legacyId: true } }),
    ]);
    if (!port) throw new NotFoundException('Puerto no encontrado');
    if (!sub) throw new NotFoundException('Cliente no encontrado');
    await this.prisma.port.update({ where: { id }, data: { subscriberId: sub.id, assignedLegacy: sub.legacyId ?? 0, status: 'Ocupado' } });
    return { id, status: 'Ocupado' };
  }
  async freePort(id: string) {
    const port = await this.prisma.port.findUnique({ where: { id } });
    if (!port) throw new NotFoundException('Puerto no encontrado');
    await this.prisma.port.update({ where: { id }, data: { subscriberId: null, assignedLegacy: 0, status: 'Disponible' } });
    return { id, status: 'Disponible' };
  }

  /** Alta de caja NAP: crea la NAP y genera sus puertos (todos disponibles). */
  async createNap(dto: CreateNapDto) {
    const branch = await this.prisma.branch.findUnique({ where: { id: dto.branchId } });
    if (!branch) throw new NotFoundException('Sede no encontrada');
    let vlan: { id: string; legacyId: number; branchId: string | null } | null = null;
    if (dto.vlanId) {
      vlan = await this.prisma.vlan.findUnique({ where: { id: dto.vlanId }, select: { id: true, legacyId: true, branchId: true } });
      if (!vlan) throw new NotFoundException('VLAN no encontrada');
      if (vlan.branchId && vlan.branchId !== branch.id) throw new BadRequestException('La VLAN no pertenece a la sede seleccionada');
    }
    const name = dto.name.trim();
    const dup = await this.prisma.nap.findFirst({ where: { branchId: branch.id, name: { equals: name, mode: 'insensitive' } }, select: { id: true } });
    if (dup) throw new BadRequestException('Ya existe una NAP con ese nombre en la sede');

    return this.prisma.$transaction(async (tx) => {
      const [napMax, portMax] = await Promise.all([
        tx.nap.aggregate({ _max: { legacyId: true } }),
        tx.port.aggregate({ _max: { legacyId: true } }),
      ]);
      const legacyId = (napMax._max.legacyId ?? 0) + 1;
      const nap = await tx.nap.create({
        data: {
          legacyId, branchId: branch.id, sedeLegacy: branch.legacyId ?? 0,
          vlanId: vlan?.id ?? null, vlanLegacy: vlan?.legacyId ?? 0,
          name, portCount: dto.portCount, address: dto.address?.trim() ?? '',
          gpsLat: dto.gpsLat?.trim() || null, gpsLng: dto.gpsLng?.trim() || null,
        },
      });
      let pl = portMax._max.legacyId ?? 0;
      const ports = Array.from({ length: dto.portCount }, (_, i) => ({
        legacyId: ++pl, sedeLegacy: branch.legacyId ?? 0, vlanLegacy: vlan?.legacyId ?? 0,
        napId: nap.id, napLegacy: legacyId, port: i + 1, status: 'Disponible', assignedLegacy: 0, detail: '',
      }));
      await tx.port.createMany({ data: ports });
      return { id: nap.id, name: nap.name, ports: ports.length };
    });
  }

  // --- VLANs (CRUD) ---
  async createVlan(dto: CreateVlanDto) {
    const branch = await this.prisma.branch.findUnique({ where: { id: dto.branchId } });
    if (!branch) throw new NotFoundException('Sede no encontrada');
    const max = await this.prisma.vlan.aggregate({ _max: { legacyId: true } });
    const v = await this.prisma.vlan.create({
      data: {
        legacyId: (max._max.legacyId ?? 0) + 1, branchId: branch.id, sedeLegacy: branch.legacyId ?? 0,
        vlan: dto.vlan, detail: dto.detail.trim(), olt: dto.olt ?? null, tray: dto.tray ?? null, oltPort: dto.oltPort ?? null,
      },
    });
    return { id: v.id, vlan: v.vlan, detail: v.detail };
  }
  async updateVlan(id: string, dto: CreateVlanDto) {
    const v = await this.prisma.vlan.findUnique({ where: { id } });
    if (!v) throw new NotFoundException('VLAN no encontrada');
    const upd = await this.prisma.vlan.update({
      where: { id }, data: { vlan: dto.vlan, detail: dto.detail.trim(), olt: dto.olt ?? null, tray: dto.tray ?? null, oltPort: dto.oltPort ?? null },
    });
    return { id: upd.id, vlan: upd.vlan, detail: upd.detail };
  }
  async deleteVlan(id: string) {
    const naps = await this.prisma.nap.count({ where: { vlanId: id } });
    if (naps > 0) throw new BadRequestException(`No se puede eliminar: la VLAN tiene ${naps} NAP(s) asociada(s).`);
    await this.prisma.vlan.delete({ where: { id } });
    return { id, deleted: true };
  }

  // --- NAP editar / eliminar ---
  async updateNap(id: string, dto: UpdateNapDto) {
    const nap = await this.prisma.nap.findUnique({ where: { id } });
    if (!nap) throw new NotFoundException('NAP no encontrada');
    let vlanLegacy = nap.vlanLegacy;
    if (dto.vlanId !== undefined) {
      const v = dto.vlanId ? await this.prisma.vlan.findUnique({ where: { id: dto.vlanId }, select: { legacyId: true } }) : null;
      vlanLegacy = v?.legacyId ?? 0;
    }
    const upd = await this.prisma.nap.update({
      where: { id },
      data: {
        name: dto.name?.trim() ?? nap.name, address: dto.address?.trim() ?? nap.address,
        gpsLat: dto.gpsLat?.trim() ?? nap.gpsLat, gpsLng: dto.gpsLng?.trim() ?? nap.gpsLng,
        vlanId: dto.vlanId !== undefined ? (dto.vlanId || null) : undefined, vlanLegacy,
      },
    });
    return { id: upd.id, name: upd.name };
  }
  async deleteNap(id: string) {
    const used = await this.prisma.port.count({ where: { napId: id, status: { not: 'Disponible' } } });
    if (used > 0) throw new BadRequestException(`No se puede eliminar: la NAP tiene ${used} puerto(s) ocupado(s).`);
    await this.prisma.$transaction(async (tx) => {
      await tx.port.deleteMany({ where: { napId: id } });
      await tx.nap.delete({ where: { id } });
    });
    return { id, deleted: true };
  }

  // --- Asignar / desasignar equipo a cliente ---
  async assignEquipmentToSubscriber(equipmentId: string, dto: AssignEquipmentSubDto) {
    const eq = await this.prisma.equipment.findUnique({ where: { id: equipmentId } });
    if (!eq) throw new NotFoundException('Equipo no encontrado');
    const sub = await this.prisma.subscriber.findUnique({ where: { id: dto.subscriberId }, select: { id: true } });
    if (!sub) throw new NotFoundException('Cliente no encontrado');
    await this.prisma.equipment.update({
      where: { id: equipmentId },
      data: {
        subscriberId: dto.subscriberId, status: 'Asignado',
        installType: dto.installType ?? eq.installType, port: dto.port ?? eq.port,
        vlan: dto.vlan ?? eq.vlan, meters: dto.meters ?? eq.meters, master: dto.master ?? eq.master,
      },
    });
    return { id: equipmentId, subscriberId: dto.subscriberId, assigned: true };
  }
  async unassignEquipment(equipmentId: string) {
    const eq = await this.prisma.equipment.findUnique({ where: { id: equipmentId } });
    if (!eq) throw new NotFoundException('Equipo no encontrado');
    await this.prisma.equipment.update({ where: { id: equipmentId }, data: { subscriberId: null, status: 'Disponible' } });
    return { id: equipmentId, unassigned: true };
  }

  // ── Pools de IP (ips_users_mk) ──────────────────────────────────────────────
  // Paridad legacy `Mikrotiks::guardar_configuracion` (Mikrotiks.php:250-289) y
  // `Mikrotiks::set_default_ips_user` (:66-70). Nexus solo había migrado la lectura:
  // la pantalla mostraba los pools y no dejaba tocar ninguno.
  //
  // Se replica lo que el legacy hace, y SOLO eso:
  //   · crear, editar y marcar predeterminado,
  //   · el `defecto` es POR SEDE (uno solo por sede),
  //   · al crear el primer pool de una sede, queda predeterminado automáticamente.
  // NO se añade borrado: el legacy no lo tiene (verificado, no hay ningún DELETE
  // sobre `ips_users_mk`), y estos pools los referencian los perfiles PPPoE de los
  // abonados — borrar uno dejaría clientes apuntando a un pool inexistente.

  /** Normaliza la lista de perfiles al formato del legacy: separados por coma. */
  private normProfiles(raw?: string): string {
    return (raw ?? '')
      .split(/[,;\n]+/)
      .map((p) => p.trim())
      .filter(Boolean)
      .join(',');
  }

  private async resolveSede(branchId: string) {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { id: true, legacyId: true, name: true },
    });
    if (!branch) throw new NotFoundException('Sede no encontrada');
    if (branch.legacyId == null) throw new BadRequestException('La sede no tiene código legacy: no se puede asociar el pool');
    return branch;
  }

  async createIpPool(dto: CreateIpPoolDto) {
    const branch = await this.resolveSede(dto.branchId);
    const name = dto.name.trim();
    const dup = await this.prisma.ipUserMk.findFirst({
      where: { sedeLegacy: branch.legacyId!, name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });
    if (dup) throw new BadRequestException('Ya existe un pool con ese nombre en la sede');

    return this.prisma.$transaction(async (tx) => {
      // Paridad legacy (Mikrotiks.php:259-261): el primer pool de una sede queda
      // predeterminado solo. Si no, la sede se quedaría sin pool por defecto y el
      // aprovisionamiento no sabría cuál usar.
      const yaHay = await tx.ipUserMk.count({ where: { sedeLegacy: branch.legacyId! } });
      const max = await tx.ipUserMk.aggregate({ _max: { legacyId: true } });
      return tx.ipUserMk.create({
        data: {
          legacyId: (max._max.legacyId ?? 0) + 1,
          name,
          ipLocal: dto.ipLocal.trim(),
          ipRemote: dto.ipRemote.trim(),
          tech: (dto.tech ?? '').trim(),
          sedeLegacy: branch.legacyId!,
          isDefault: yaHay === 0,
          profiles: this.normProfiles(dto.profiles),
        },
      });
    });
  }

  async updateIpPool(id: string, dto: UpdateIpPoolDto) {
    const pool = await this.prisma.ipUserMk.findUnique({ where: { id } });
    if (!pool) throw new NotFoundException('Pool de IP no encontrado');

    let sedeLegacy = pool.sedeLegacy;
    if (dto.branchId) sedeLegacy = (await this.resolveSede(dto.branchId)).legacyId!;

    const name = dto.name?.trim() ?? pool.name;
    const dup = await this.prisma.ipUserMk.findFirst({
      where: { sedeLegacy, name: { equals: name, mode: 'insensitive' }, id: { not: id } },
      select: { id: true },
    });
    if (dup) throw new BadRequestException('Ya existe un pool con ese nombre en la sede');

    return this.prisma.ipUserMk.update({
      where: { id },
      data: {
        name,
        sedeLegacy,
        // `undefined` = no tocar; así un PATCH parcial no borra lo que no manda.
        ipLocal: dto.ipLocal?.trim(),
        ipRemote: dto.ipRemote?.trim(),
        tech: dto.tech?.trim(),
        profiles: dto.profiles === undefined ? undefined : this.normProfiles(dto.profiles),
      },
    });
  }

  /**
   * Marca el pool como predeterminado de SU sede. Paridad legacy
   * `set_default_ips_user`: primero limpia el de la sede, luego lo pone en este.
   * En una transacción — el legacy lo hacía en dos UPDATE sueltos y un fallo entre
   * ambos dejaba a la sede sin ningún predeterminado.
   */
  async setDefaultIpPool(id: string) {
    const pool = await this.prisma.ipUserMk.findUnique({ where: { id }, select: { id: true, sedeLegacy: true } });
    if (!pool) throw new NotFoundException('Pool de IP no encontrado');
    await this.prisma.$transaction([
      this.prisma.ipUserMk.updateMany({ where: { sedeLegacy: pool.sedeLegacy }, data: { isDefault: false } }),
      this.prisma.ipUserMk.update({ where: { id }, data: { isDefault: true } }),
    ]);
    return { id, isDefault: true };
  }
}
