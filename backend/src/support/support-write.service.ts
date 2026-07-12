import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsString, Min, MinLength, ValidateNested } from 'class-validator';
import { Prisma, TicketStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { MikrotikService } from '../network/mikrotik.service';

export const TICKET_PRIORITIES = ['Baja', 'Media', 'Alta', 'Urgente'] as const;

export class CreateTicketDto {
  @IsString() subscriberId!: string;
  @IsString() @MinLength(1) subject!: string;
  @IsString() @MinLength(1) type!: string; // detalle
  @IsOptional() @IsString() problem?: string;
  @IsOptional() @IsString() section?: string;
  @IsOptional() @IsString() assigned?: string;
  @IsOptional() @IsIn(TICKET_PRIORITIES) priority?: string;
}
export class PriorityDto {
  @IsIn(TICKET_PRIORITIES) priority!: string;
}
export class UpdateStatusDto {
  @IsIn(['PENDIENTE', 'REALIZANDO', 'RESUELTO', 'ANULADA']) status!: TicketStatus;
  @IsOptional() @IsString() finalDate?: string;
}
export class AssignDto {
  @IsOptional() @IsString() assigned?: string; // técnico
}
export class SignatureDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() cc?: string;
  @IsOptional() @IsString() rel?: string;
}
export class ThreadDto {
  @IsString() @MinLength(1) message!: string;
}
export class AttachDto {
  @IsOptional() @IsString() message?: string;
  @IsOptional() @IsString() lat?: string; // coordenadas del técnico (geo-etiquetado)
  @IsOptional() @IsString() lng?: string;
}

/** Asignación de equipo (CPE) al cliente desde la orden (porta legacy asig_equipo). */
export class AssignEquipmentDto {
  @IsString() @MinLength(1) mac!: string;
  @IsString() @MinLength(1) installType!: string; // t_instalacion (FTTH / EOC / ...)
  @IsOptional() @IsString() equipmentId?: string; // unidad de stock a asignar (si viene de inventario)
  @IsOptional() @Type(() => Number) @IsInt() port?: number;
  @IsOptional() @Type(() => Number) @IsInt() vlan?: number;
  @IsOptional() @Type(() => Number) @IsInt() nat?: number;
  @IsOptional() @IsString() master?: string;
  @IsOptional() @Type(() => Number) @IsInt() meters?: number;
  @IsOptional() @IsString() accessories?: string;
  @IsOptional() @IsString() serial?: string;
}

/** Un ítem de consumo de material. */
export class MaterialConsumeItemDto {
  @IsString() @MinLength(1) materialId!: string;
  @Type(() => Number) @IsInt() @Min(1) qty!: number;
}
/** Registro de material consumido en la orden (descuenta stock). */
export class ConsumeMaterialsDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => MaterialConsumeItemDto)
  items!: MaterialConsumeItemDto[];
}

const dateOnly = (s?: string) => { const d = s ? new Date(s) : new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); };

@Injectable()
export class SupportWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mikrotik: MikrotikService,
  ) {}

  /** Técnicos disponibles (Staff operativos). */
  async technicians() {
    const rows = await this.prisma.staff.findMany({
      where: { banned: false, OR: [{ role: 3 }, { areaLegacy: { in: [2, 3, 4] } }] },
      orderBy: { name: 'asc' }, select: { id: true, legacyId: true, name: true, username: true },
    });
    return rows.map((r) => ({ id: r.id, legacyId: r.legacyId, name: r.name, username: r.username }));
  }

  private async nextCode(tx: Prisma.TransactionClient): Promise<number> {
    const max = await tx.ticket.aggregate({ _max: { code: true } });
    return (max._max.code ?? 0) + 1;
  }

  /** Crear orden de servicio. */
  async createTicket(dto: CreateTicketDto, user: AuthUser) {
    const sub = await this.prisma.subscriber.findUnique({ where: { id: dto.subscriberId }, select: { id: true } });
    if (!sub) throw new NotFoundException('Cliente no encontrado');
    return this.prisma.$transaction(async (tx) => {
      const code = await this.nextCode(tx);
      const t = await tx.ticket.create({
        data: {
          code, subject: dto.subject, type: dto.type, created: dateOnly(), subscriberId: sub.id,
          col: user.name || user.email, status: 'PENDIENTE', priority: dto.priority ?? 'Media', problem: dto.problem ?? null,
          section: dto.section ?? null, assigned: dto.assigned ?? null,
        },
      });
      return { id: t.id, code: t.code };
    });
  }

  async updateStatus(id: string, dto: UpdateStatusDto, user?: AuthUser) {
    const t = await this.prisma.ticket.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Orden no encontrada');
    const data: Prisma.TicketUpdateInput = { status: dto.status };
    if (dto.status === 'RESUELTO') data.finalDate = dto.finalDate ? dateOnly(dto.finalDate) : dateOnly();
    await this.prisma.ticket.update({ where: { id }, data });

    // --- Cascada al resolver (porta la lógica de Tickets.php al cerrar "Resuelto") ---
    // Segura por diseño: la reconexión Mikrotik respeta su propio gate dry-run.
    const cascade: { reconnect?: any; statusSet?: string; note?: string } = {};
    if (dto.status === 'RESUELTO' && t.subscriberId) {
      const kind = (t.type || '').toLowerCase();
      const isReconnect = kind.includes('reconex') || kind.includes('activ');
      const isInstall = kind.includes('instalac');
      if (isReconnect) {
        try {
          cascade.reconnect = await this.mikrotik.reconnect(t.subscriberId, user);
          cascade.statusSet = 'ACTIVO'; // reconnect() ya deja el cliente ACTIVO
        } catch (e) {
          cascade.note = `No se pudo reconectar: ${(e as Error).message}`;
        }
        // Cargo de reconexión en la factura del mes corriente (gated).
        if (process.env.TICKET_CASCADE_BILLING === 'true') {
          (cascade as any).charge = await this.applyReconnectionCharge(t.subscriberId, kind);
        }
      } else if (isInstall) {
        // Instalación resuelta → cliente ACTIVO. (La 1ª factura se genera aparte
        // desde Facturación; no se auto-crea aquí para no inyectar cargos sin control.)
        await this.prisma.subscriber
          .update({ where: { id: t.subscriberId }, data: { status: 'ACTIVO', statusChangedAt: new Date() } })
          .catch(() => undefined);
        cascade.statusSet = 'ACTIVO';
        cascade.note = 'Instalación resuelta: cliente activado. Genera la primera factura desde Facturación.';
      }
    }
    return { id, status: dto.status, cascade };
  }

  /**
   * Inyecta el cargo de reconexión (producto del catálogo) en la factura del MES
   * CORRIENTE del cliente, y recalcula los totales. Guarda: solo mes actual (fiel
   * a Tickets.php, que evita ensuciar facturas de periodos viejos ya pagados).
   */
  private async applyReconnectionCharge(subscriberId: string, ticketKind: string) {
    // Producto según el tipo de orden.
    let name = 'Reconexion';
    if (ticketKind.includes('televi')) name = 'Reconexión Television';
    else if (ticketKind.includes('combo')) name = 'Reconexion Combo';
    else if (ticketKind.includes('internet') || ticketKind.includes('reconex')) name = 'Reconexión Internet';
    const material = await this.prisma.material.findFirst({
      where: { name: { contains: name.split(' ')[0], mode: 'insensitive' } },
      orderBy: { name: 'asc' },
    });
    const price = material ? Number(material.price) : 0;
    if (price <= 0) return { applied: false, note: 'sin producto de reconexión con precio' };

    // Factura del mes corriente.
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const invoice = await this.prisma.subInvoice.findFirst({
      where: { subscriberId, invoiceDate: { gte: monthStart, lt: monthEnd } },
      orderBy: { invoiceDate: 'desc' },
    });
    if (!invoice) return { applied: false, note: 'sin factura del mes corriente' };

    await this.prisma.$transaction(async (tx) => {
      await tx.subInvoiceItem.create({
        data: {
          invoiceId: invoice.id, productId: 0, productName: material?.name ?? name,
          description: material?.name ?? name, qty: 1, price, taxRate: 0,
          subtotal: price, taxTotal: 0, discountTotal: 0,
        },
      });
      const newTotal = Number(invoice.total) + price;
      const paid = Number(invoice.paidAmount);
      await tx.subInvoice.update({
        where: { id: invoice.id },
        data: {
          subtotal: { increment: price }, total: { increment: price },
          itemsCount: { increment: 1 },
          status: paid <= 0 ? 'DUE' : paid < newTotal ? 'PARTIAL' : 'PAID',
        },
      });
    });
    return { applied: true, invoiceTid: invoice.tid, product: material?.name ?? name, amount: price };
  }

  async assign(id: string, dto: AssignDto) {
    const t = await this.prisma.ticket.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Orden no encontrada');
    await this.prisma.ticket.update({ where: { id }, data: { assigned: dto.assigned ?? null } });
    return { id, assigned: dto.assigned ?? null };
  }

  async setPriority(id: string, dto: PriorityDto) {
    const t = await this.prisma.ticket.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Orden no encontrada');
    await this.prisma.ticket.update({ where: { id }, data: { priority: dto.priority } });
    return { id, priority: dto.priority };
  }

  async saveSignature(id: string, dto: SignatureDto) {
    const t = await this.prisma.ticket.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Orden no encontrada');
    await this.prisma.ticket.update({ where: { id }, data: { signatureName: dto.name, signatureCc: dto.cc ?? null, signatureRel: dto.rel ?? null } });
    return { id, signed: true };
  }

  async addThread(id: string, dto: ThreadDto, user: AuthUser) {
    const t = await this.prisma.ticket.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Orden no encontrada');
    if (t.code == null) throw new BadRequestException('La orden no tiene número');
    await this.prisma.ticketThread.create({
      data: { ticketCode: t.code, message: dto.message, subscriberId: t.subscriberId, employeeId: 0, date: new Date() },
    });
    return { ok: true };
  }

  /** Agrega una entrada al hilo con una foto adjunta (evidencia) y, si el dispositivo la dio, su geolocalización. */
  async addAttachment(id: string, file: { filename: string; originalname: string }, dto: AttachDto) {
    const t = await this.prisma.ticket.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Orden no encontrada');
    if (t.code == null) throw new BadRequestException('La orden no tiene número');
    const th = await this.prisma.ticketThread.create({
      data: {
        ticketCode: t.code, message: dto.message?.trim() || null, subscriberId: t.subscriberId,
        employeeId: 0, date: new Date(),
        attach: file.filename, attachName: file.originalname,
        geoLat: dto.lat?.trim() || null, geoLng: dto.lng?.trim() || null,
      },
    });
    return { ok: true, id: th.id };
  }

  /** Registra una nota automática en el hilo de la orden (para dejar traza de acciones). */
  private async noteOnThread(ticketCode: number | null, subscriberId: string | null, message: string) {
    if (ticketCode == null) return;
    await this.prisma.ticketThread
      .create({ data: { ticketCode, message, subscriberId, employeeId: 0, date: new Date() } })
      .catch(() => undefined);
  }

  /** Equipos disponibles en stock (sin cliente asignado) para el selector del modal. */
  async availableEquipment(search?: string) {
    const where: Prisma.EquipmentWhereInput = { subscriberId: null };
    const s = search?.trim();
    if (s) where.OR = [{ mac: { contains: s, mode: 'insensitive' } }, { serial: { contains: s, mode: 'insensitive' } }];
    const rows = await this.prisma.equipment.findMany({
      where, orderBy: { code: 'asc' }, take: 30,
      select: { id: true, code: true, mac: true, serial: true, brand: true, installType: true, status: true, warehouse: { select: { name: true } } },
    });
    return rows.map((e) => ({ id: e.id, code: e.code, mac: e.mac, serial: e.serial, brand: e.brand, installType: e.installType, status: e.status, warehouse: e.warehouse?.name ?? null }));
  }

  /** Materiales con stock para el selector del modal de consumo. */
  async searchMaterials(search?: string) {
    const where: Prisma.MaterialWhereInput = { qty: { gt: 0 } };
    const s = search?.trim();
    if (s) where.OR = [{ name: { contains: s, mode: 'insensitive' } }, { code: { contains: s, mode: 'insensitive' } }];
    const rows = await this.prisma.material.findMany({
      where, orderBy: { name: 'asc' }, take: 30,
      select: { id: true, name: true, code: true, price: true, qty: true, warehouseId: true, warehouse: { select: { title: true } } },
    });
    return rows.map((m) => ({ id: m.id, name: m.name, code: m.code, price: Number(m.price), qty: m.qty, warehouseId: m.warehouseId, warehouse: m.warehouse?.title ?? null }));
  }

  /**
   * Asigna un equipo (CPE) al cliente de la orden. Si `equipmentId` viene de stock,
   * lo saca del inventario (subscriberId + status "Asignado"); si no, crea la unidad.
   * Fiel al legacy asig_equipo: valida que la MAC no esté ya en uso por otro cliente.
   */
  async assignEquipment(id: string, dto: AssignEquipmentDto, user: AuthUser) {
    const t = await this.prisma.ticket.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Orden no encontrada');
    if (!t.subscriberId) throw new BadRequestException('La orden no tiene cliente asociado');
    const mac = dto.mac.trim();

    // La MAC no puede estar asignada a OTRO cliente.
    const clash = await this.prisma.equipment.findFirst({
      where: { mac: { equals: mac, mode: 'insensitive' }, subscriberId: { not: null, notIn: [t.subscriberId] } },
      select: { id: true },
    });
    if (clash) throw new BadRequestException('Esa MAC ya está asignada a otro cliente');

    const data = {
      subscriberId: t.subscriberId, mac, installType: dto.installType,
      port: dto.port ?? null, vlan: dto.vlan ?? null, nat: dto.nat ?? null,
      master: dto.master?.trim() || null, meters: dto.meters ?? null,
      accessories: dto.accessories?.trim() || null, serial: dto.serial?.trim() || null,
      status: 'Asignado', endDate: dateOnly(),
    };

    let equipmentId: string;
    if (dto.equipmentId) {
      const eq = await this.prisma.equipment.findUnique({ where: { id: dto.equipmentId }, select: { id: true, subscriberId: true } });
      if (!eq) throw new NotFoundException('Equipo de stock no encontrado');
      if (eq.subscriberId && eq.subscriberId !== t.subscriberId) throw new BadRequestException('Ese equipo ya está asignado');
      await this.prisma.equipment.update({ where: { id: eq.id }, data });
      equipmentId = eq.id;
    } else {
      const max = await this.prisma.equipment.aggregate({ _max: { code: true } });
      const created = await this.prisma.equipment.create({
        data: { ...data, code: (max._max.code ?? 0) + 1, warehouseLegacy: 0, supplierLegacy: 0, arrival: dateOnly() },
      });
      equipmentId = created.id;
    }

    // Reflejar la MAC principal en el cliente (como el legacy: customers.macequipo).
    await this.prisma.subscriber.update({ where: { id: t.subscriberId }, data: { macEquipo: mac } }).catch(() => undefined);

    const extra = [dto.installType, dto.port != null ? `PN:${dto.port}` : '', dto.nat != null ? `N:${dto.nat}` : '', dto.vlan != null ? `V:${dto.vlan}` : '', dto.meters != null ? `${dto.meters}m` : ''].filter(Boolean).join(' ');
    await this.noteOnThread(t.code, t.subscriberId, `Equipo asignado: ${mac}${extra ? ` · ${extra}` : ''} (${user.name || user.email})`);
    return { ok: true, equipmentId, mac };
  }

  /**
   * Registra material consumido en la orden y descuenta stock (Material.qty).
   * Transaccional: valida stock suficiente de cada ítem antes de descontar.
   */
  async consumeMaterials(id: string, dto: ConsumeMaterialsDto, user: AuthUser) {
    const t = await this.prisma.ticket.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Orden no encontrada');
    if (!dto.items?.length) throw new BadRequestException('Agrega al menos un material');

    const created = await this.prisma.$transaction(async (tx) => {
      const out: { name: string; qty: number }[] = [];
      for (const it of dto.items) {
        const m = await tx.material.findUnique({
          where: { id: it.materialId },
          select: { id: true, name: true, price: true, qty: true, warehouseId: true, warehouse: { select: { title: true } } },
        });
        if (!m) throw new NotFoundException('Material no encontrado');
        if (m.qty < it.qty) throw new BadRequestException(`Stock insuficiente de "${m.name}" (disponible ${m.qty})`);
        await tx.material.update({ where: { id: m.id }, data: { qty: { decrement: it.qty } } });
        await tx.ticketMaterial.create({
          data: {
            ticketId: t.id, materialId: m.id, materialName: m.name, qty: it.qty, price: m.price,
            warehouseId: m.warehouseId, warehouseName: m.warehouse?.title ?? null, employeeName: user.name || user.email,
          },
        });
        out.push({ name: m.name, qty: it.qty });
      }
      return out;
    });

    await this.noteOnThread(t.code, t.subscriberId, `Material consumido: ${created.map((c) => `${c.qty}× ${c.name}`).join(', ')} (${user.name || user.email})`);
    return { ok: true, items: created };
  }
}
