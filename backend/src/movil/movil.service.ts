import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';

export class CreateMovilDto {
  @IsOptional() @IsString() name?: string;
}
export class UpdateMovilDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsIn(['Activa', 'Inactiva']) status?: string;
}
export class AddMemberDto {
  @IsString() @MinLength(1) employeeId!: string;
  @IsOptional() @IsString() role?: string;
}

const empName = (e: { firstName: string; lastName: string } | null) => (e ? `${e.firstName} ${e.lastName}`.trim() : null);

/**
 * Móviles / cuadrillas: agrupan técnicos para asignar órdenes y eventos de agenda
 * (porta `Moviles.php` del legacy). Una móvil tiene un nombre, estado y un conjunto
 * de técnicos (con rol opcional).
 */
@Injectable()
export class MovilService {
  constructor(private readonly prisma: PrismaService) {}

  async list(params: { search?: string; status?: string } = {}) {
    const where: any = {};
    if (params.status) where.status = params.status;
    const s = (params.search || '').trim();
    if (s) where.name = { contains: s, mode: 'insensitive' };
    const rows = await this.prisma.movil.findMany({
      where, orderBy: { createdAt: 'desc' },
      include: { members: { include: { employee: { select: { firstName: true, lastName: true } } } } },
    });
    return rows.map((m) => ({
      id: m.id, name: m.name, status: m.status, createdBy: m.createdByName, createdAt: m.createdAt,
      memberCount: m.members.length,
      members: m.members.map((mm) => empName(mm.employee)).filter(Boolean),
    }));
  }

  async detail(id: string) {
    const m = await this.prisma.movil.findUnique({
      where: { id },
      include: { members: { include: { employee: { select: { id: true, firstName: true, lastName: true, position: true } } } } },
    });
    if (!m) throw new NotFoundException('Móvil no encontrada');
    return {
      id: m.id, name: m.name, status: m.status, createdBy: m.createdByName, createdAt: m.createdAt,
      members: m.members.map((mm) => ({ id: mm.id, employeeId: mm.employeeId, name: empName(mm.employee), position: mm.employee?.position ?? null, role: mm.role })),
    };
  }

  create(dto: CreateMovilDto, user: AuthUser) {
    return this.prisma.movil.create({ data: { name: dto.name?.trim() || 'Nueva móvil', status: 'Activa', createdByName: user?.name ?? user?.email ?? null } });
  }

  async update(id: string, dto: UpdateMovilDto) {
    const m = await this.prisma.movil.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('Móvil no encontrada');
    return this.prisma.movil.update({ where: { id }, data: { name: dto.name?.trim() ?? m.name, status: dto.status ?? m.status } });
  }

  async remove(id: string) {
    const m = await this.prisma.movil.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('Móvil no encontrada');
    await this.prisma.movil.delete({ where: { id } }); // members se borran en cascada
    return { id, deleted: true };
  }

  async addMember(movilId: string, dto: AddMemberDto) {
    const [m, e] = await Promise.all([
      this.prisma.movil.findUnique({ where: { id: movilId }, select: { id: true } }),
      this.prisma.employee.findUnique({ where: { id: dto.employeeId }, select: { id: true } }),
    ]);
    if (!m) throw new NotFoundException('Móvil no encontrada');
    if (!e) throw new NotFoundException('Empleado no encontrado');
    const dup = await this.prisma.movilMember.findUnique({ where: { movilId_employeeId: { movilId, employeeId: dto.employeeId } } });
    if (dup) throw new BadRequestException('El técnico ya está en la móvil');
    await this.prisma.movilMember.create({ data: { movilId, employeeId: dto.employeeId, role: dto.role ?? null } });
    return { ok: true };
  }

  async removeMember(movilId: string, employeeId: string) {
    await this.prisma.movilMember.deleteMany({ where: { movilId, employeeId } });
    return { ok: true };
  }

  /** Técnicos disponibles para asignar (activos, opcionalmente excluyendo los ya en la móvil). */
  async availableEmployees(movilId?: string) {
    const inMovil = movilId
      ? new Set((await this.prisma.movilMember.findMany({ where: { movilId }, select: { employeeId: true } })).map((x) => x.employeeId))
      : new Set<string>();
    const emps = await this.prisma.employee.findMany({
      where: { status: 'ACTIVE' }, orderBy: [{ firstName: 'asc' }], select: { id: true, firstName: true, lastName: true, position: true },
    });
    return emps.filter((e) => !inMovil.has(e.id)).map((e) => ({ id: e.id, name: `${e.firstName} ${e.lastName}`.trim(), position: e.position }));
  }
}
