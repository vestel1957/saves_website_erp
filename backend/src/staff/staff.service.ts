import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsInt, IsOptional, IsString, MinLength } from 'class-validator';
import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ALL_PERMISSIONS, SUPERADMIN_PERMISSION } from '../auth/permissions.catalog';
import { AuthService } from '../auth/auth.service';
import { AuthUser } from '../auth/current-user.decorator';
import { AuditService } from '../common/audit/audit.service';

const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? 0 : Number(d));
const ROLE_LABEL: Record<number, string> = { 2: 'Cajero', 3: 'Técnico', 4: 'Administrativo', 5: 'Administrador' };

export class CreateStaffDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() docNumber?: string;
  @IsOptional() @IsString() username?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsInt() role?: number;
  @IsOptional() @IsString() areaId?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() eps?: string;
  @IsOptional() @IsString() pension?: string;
  @IsOptional() @IsString() rh?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() city?: string;
}
export class UpdateStaffDto extends CreateStaffDto {}

/** Conjunto de permisos que el empleado debe tener (solo el superusuario lo fija). */
export class SetStaffPermissionsDto {
  @IsArray() @IsString({ each: true }) granted!: string[];
}

/** Roles que el superusuario asigna al empleado. */
export class SetStaffRolesDto {
  @IsArray() @IsString({ each: true }) roleKeys!: string[];
}

/** Alta de cuenta de acceso para un empleado sin usuario. */
export class CreateStaffAccountDto {
  @IsOptional() @IsString() @MinLength(6) password?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) roleKeys?: string[];
}

/** Habilitar / inhabilitar el acceso del empleado. */
export class SetStaffAccountActiveDto {
  @IsBoolean() isActive!: boolean;
}

/** Restablecer la contraseña del empleado. */
export class ResetStaffPasswordDto {
  @IsOptional() @IsString() @MinLength(6) password?: string;
}

/** Contraseña temporal legible (se muestra una sola vez al superusuario). */
function genTempPassword(): string {
  const b = randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
  return `Vst-${b.slice(0, 8)}`;
}

@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  /** Registra un evento de acceso del empleado en la bitácora (entity `staff-access`). */
  private logAccess(staffId: string, action: string, actor?: AuthUser, after?: unknown) {
    void this.audit.record({ userId: actor?.id, action, entity: 'staff-access', entityId: staffId, after });
  }

  async stats() {
    const [total, byRole, byArea, banned] = await Promise.all([
      this.prisma.staff.count(),
      this.prisma.staff.groupBy({ by: ['role'], _count: { _all: true } }),
      this.prisma.staff.count({ where: { areaLegacy: { in: [2, 3, 4] } } }), // técnicos/operativos
      this.prisma.staff.count({ where: { banned: true } }),
    ]);
    const roles: Record<string, number> = {};
    for (const r of byRole) roles[ROLE_LABEL[r.role ?? 0] ?? `Rol ${r.role}`] = r._count._all;
    return { total, activos: total - banned, inhabilitados: banned, tecnicos: byArea, roles };
  }

  async list(params: { search?: string; role?: string; areaId?: string; status?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
    const where: Prisma.StaffWhereInput = {};
    if (params.role) where.role = Number(params.role);
    if (params.areaId) where.areaId = params.areaId;
    if (params.status === 'active') where.banned = false;
    else if (params.status === 'banned') where.banned = true;
    const search = (params.search || '').trim();
    if (search) where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { username: { contains: search, mode: 'insensitive' } }, { docNumber: { contains: search } }];
    const [rows, total] = await Promise.all([
      this.prisma.staff.findMany({ where, orderBy: [{ role: 'desc' }, { name: 'asc' }], skip: (page - 1) * pageSize, take: pageSize, include: { area: true } }),
      this.prisma.staff.count({ where }),
    ]);
    return {
      items: rows.map((e) => ({
        id: e.id, name: e.name, docNumber: e.docNumber, username: e.username, email: e.email,
        role: e.role, roleLabel: ROLE_LABEL[e.role ?? 0] ?? null, area: e.area?.name ?? null,
        phone: e.phone, banned: e.banned, lastLogin: e.lastLogin,
      })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  async detail(id: string) {
    const e = await this.prisma.staff.findUnique({ where: { id }, include: { area: true } });
    if (!e) throw new NotFoundException('Empleado no encontrado');
    // Actividad: transacciones y facturas emitidas por este empleado (eid = legacyId)
    let activity = { transactions: 0, income: 0, invoices: 0 };
    if (e.legacyId != null) {
      const [tx, inv] = await Promise.all([
        this.prisma.transaction.aggregate({ _count: { _all: true }, _sum: { credit: true }, where: { issuerUserId: e.legacyId, status: 'VIGENTE' } }),
        this.prisma.subInvoice.count({ where: { issuerUserId: e.legacyId } }),
      ]);
      activity = { transactions: tx._count._all, income: num(tx._sum.credit), invoices: inv };
    }
    return {
      id: e.id, legacyId: e.legacyId, name: e.name, docNumber: e.docNumber, username: e.username, email: e.email,
      role: e.role, roleLabel: ROLE_LABEL[e.role ?? 0] ?? null, area: e.area?.name ?? null,
      entryDate: e.entryDate, rh: e.rh, eps: e.eps, pension: e.pension,
      address: e.address, city: e.city, region: e.region, phone: e.phone, phoneAlt: e.phoneAlt,
      banned: e.banned, lastLogin: e.lastLogin, sedeAccede: e.sedeAccede, picture: e.picture, activity,
    };
  }

  areas() { return this.prisma.staffArea.findMany({ orderBy: { name: 'asc' } }); }

  create(dto: CreateStaffDto) {
    return this.prisma.staff.create({ data: {
      name: dto.name, docNumber: dto.docNumber ?? null, username: dto.username ?? null, email: dto.email ?? null,
      role: dto.role ?? 2, areaId: dto.areaId ?? null, phone: dto.phone ?? null, eps: dto.eps ?? null, pension: dto.pension ?? null,
      rh: dto.rh ?? null, address: dto.address ?? null, city: dto.city ?? null,
    } });
  }
  async update(id: string, dto: UpdateStaffDto) {
    const e = await this.prisma.staff.findUnique({ where: { id } });
    if (!e) throw new NotFoundException('Empleado no encontrado');
    return this.prisma.staff.update({ where: { id }, data: {
      name: dto.name, docNumber: dto.docNumber, username: dto.username, email: dto.email, role: dto.role,
      areaId: dto.areaId, phone: dto.phone, eps: dto.eps, pension: dto.pension, rh: dto.rh, address: dto.address, city: dto.city,
    } });
  }

  // ── Permisos del empleado ────────────────────────────────────────────────
  // El empleado (Staff) se vincula con su cuenta del sistema (User) por correo.
  // Es el User quien lleva los roles y los permisos efectivos; aquí los exponemos
  // para verlos desde la ficha del empleado. Editarlos queda restringido al
  // superusuario (ver StaffController).

  /** Usuario del sistema vinculado al empleado (por correo), con roles y overrides. */
  private async linkedUser(staffId: string) {
    const e = await this.prisma.staff.findUnique({ where: { id: staffId } });
    if (!e) throw new NotFoundException('Empleado no encontrado');
    const user = e.email
      ? await this.prisma.user.findUnique({
          where: { email: e.email },
          include: {
            roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
            permissionOverrides: { include: { permission: true } },
          },
        })
      : null;
    return { staff: e, user };
  }

  /**
   * Matriz de permisos del empleado: roles, y todo el catálogo agrupado marcando
   * cuáles concede (efectivo = permisos del rol ∪ overrides ALLOW − overrides DENY).
   */
  async permissions(staffId: string) {
    const { staff, user } = await this.linkedUser(staffId);

    const roleKeys = new Set<string>();
    const roles: { key: string; name: string }[] = [];
    const overrides = new Map<string, string>();
    if (user) {
      for (const ur of user.roles) {
        roles.push({ key: ur.role.key, name: ur.role.name });
        for (const rp of ur.role.permissions) roleKeys.add(rp.permission.key);
      }
      for (const ov of user.permissionOverrides) overrides.set(ov.permission.key, ov.effect);
    }

    const groupsMap = new Map<string, { group: string; items: any[] }>();
    for (const p of ALL_PERMISSIONS) {
      const inRole = roleKeys.has(p.key);
      const effect = overrides.get(p.key) ?? null; // 'ALLOW' | 'DENY' | null
      const effective = effect === 'DENY' ? false : effect === 'ALLOW' ? true : inRole;
      let g = groupsMap.get(p.group);
      if (!g) { g = { group: p.group, items: [] }; groupsMap.set(p.group, g); }
      g.items.push({ key: p.key, label: p.label, inRole, effect, effective });
    }

    return {
      linked: !!user,
      userId: user?.id ?? null,
      userActive: user?.isActive ?? null,
      isSuperadmin: roleKeys.has(SUPERADMIN_PERMISSION),
      hasEmail: !!staff.email,
      account: user
        ? { email: user.email, name: user.name, isActive: user.isActive, createdAt: user.createdAt, lastLogin: staff.lastLogin ?? null }
        : null,
      roles,
      groups: [...groupsMap.values()],
    };
  }

  /**
   * Fija los permisos efectivos del empleado (solo superusuario). Calcula los
   * overrides contra el baseline del rol: concede algo que el rol NO da ⇒ ALLOW;
   * quita algo que el rol SÍ da ⇒ DENY; si coincide con el rol ⇒ sin override.
   * Mismo patrón que `setUserScreens`, pero sobre TODO el catálogo de permisos.
   */
  async setPermissions(staffId: string, granted: string[], actor?: AuthUser) {
    const { staff, user } = await this.linkedUser(staffId);
    if (!user) {
      throw new BadRequestException(
        staff.email
          ? 'El empleado no tiene una cuenta del sistema vinculada a su correo.'
          : 'El empleado no tiene correo, así que no tiene acceso al sistema para asignarle permisos.',
      );
    }

    const allKeys = ALL_PERMISSIONS.map((p) => p.key);
    const desired = new Set(granted.filter((k) => allKeys.includes(k)));

    const roleKeys = new Set<string>();
    for (const ur of user.roles) for (const rp of ur.role.permissions) roleKeys.add(rp.permission.key);

    // Salvaguarda: no dejar el sistema sin ningún superadministrador activo.
    const hadAdmin = roleKeys.has(SUPERADMIN_PERMISSION)
      ? !(user.permissionOverrides.find((o) => o.permission.key === SUPERADMIN_PERMISSION)?.effect === 'DENY')
      : user.permissionOverrides.find((o) => o.permission.key === SUPERADMIN_PERMISSION)?.effect === 'ALLOW';
    if (hadAdmin && !desired.has(SUPERADMIN_PERMISSION)) {
      const others = await this.prisma.user.count({
        where: {
          id: { not: user.id },
          isActive: true,
          roles: { some: { role: { permissions: { some: { permission: { key: SUPERADMIN_PERMISSION } } } } } },
        },
      });
      if (others === 0) {
        throw new ForbiddenException('No puedes quitar el acceso de superadministrador al último que queda en el sistema.');
      }
    }

    const perms = await this.prisma.permission.findMany({ where: { key: { in: allKeys } } });
    const idByKey = new Map(perms.map((p) => [p.key, p.id]));

    const rows: { userId: string; permissionId: string; effect: string }[] = [];
    for (const key of allKeys) {
      const pid = idByKey.get(key);
      if (!pid) continue;
      const want = desired.has(key);
      const inRole = roleKeys.has(key);
      if (want && !inRole) rows.push({ userId: user.id, permissionId: pid, effect: 'ALLOW' });
      else if (!want && inRole) rows.push({ userId: user.id, permissionId: pid, effect: 'DENY' });
    }

    await this.prisma.$transaction([
      this.prisma.userPermission.deleteMany({ where: { userId: user.id, permissionId: { in: perms.map((p) => p.id) } } }),
      this.prisma.userPermission.createMany({ data: rows, skipDuplicates: true }),
    ]);
    this.logAccess(staffId, 'Actualizó los permisos', actor, { activos: desired.size, overrides: rows.length });
    return this.permissions(staffId);
  }

  // ── Roles del empleado ───────────────────────────────────────────────────

  /** Catálogo de roles disponibles (con área, nº de permisos y sus llaves), para el selector. */
  async roleCatalog() {
    const roles = await this.auth.listRoles();
    return roles.map((r: any) => ({
      key: r.key,
      name: r.name,
      description: r.description ?? null,
      area: r.area,
      permissionCount: r.permissions?.length ?? 0,
      permissionKeys: (r.permissions ?? []).map((rp: any) => rp.permission.key),
    }));
  }

  /**
   * Fija los roles del empleado (solo superusuario). Reutiliza AuthService, que
   * ya trae la anti-escalada y la protección del último superadmin.
   */
  async setRoles(staffId: string, roleKeys: string[], actor?: AuthUser) {
    const { staff, user } = await this.linkedUser(staffId);
    if (!user) {
      throw new BadRequestException(
        staff.email
          ? 'El empleado no tiene una cuenta del sistema vinculada a su correo.'
          : 'El empleado no tiene correo, así que no tiene acceso al sistema para asignarle roles.',
      );
    }
    await this.auth.setUserRoles(user.id, roleKeys, actor);
    this.logAccess(staffId, 'Actualizó los roles', actor, { roleKeys });
    return this.permissions(staffId);
  }

  // ── Cuenta de acceso del empleado ────────────────────────────────────────

  /**
   * Crea la cuenta de acceso (login) del empleado y la vincula por correo.
   * Solo superusuario. Devuelve la contraseña temporal para mostrarla una vez.
   */
  async createAccount(staffId: string, dto: CreateStaffAccountDto, actor?: AuthUser) {
    const { staff, user } = await this.linkedUser(staffId);
    if (user) throw new BadRequestException('El empleado ya tiene una cuenta del sistema.');
    const email = staff.email?.trim();
    if (!email) throw new BadRequestException('El empleado no tiene correo. Agrégale un correo antes de crear el acceso.');

    const tempPassword = dto.password?.trim() || genTempPassword();
    await this.auth.createUser({ email, name: staff.name, password: tempPassword, roleKeys: dto.roleKeys ?? [] });
    this.logAccess(staffId, 'Creó el acceso al sistema', actor, { email, roleKeys: dto.roleKeys ?? [] });

    const perms = await this.permissions(staffId);
    return { ...perms, tempPassword };
  }

  /** Habilita / inhabilita el acceso del empleado (solo superusuario). */
  async setAccountActive(staffId: string, isActive: boolean, actor?: AuthUser) {
    const { user } = await this.linkedUser(staffId);
    if (!user) throw new BadRequestException('El empleado no tiene una cuenta del sistema.');
    await this.auth.setUserActive(user.id, isActive);
    this.logAccess(staffId, isActive ? 'Habilitó el acceso' : 'Inhabilitó el acceso', actor);
    return this.permissions(staffId);
  }

  /** Restablece la contraseña del empleado; devuelve la temporal (solo superusuario). */
  async resetAccountPassword(staffId: string, password: string | undefined, actor?: AuthUser) {
    const { user } = await this.linkedUser(staffId);
    if (!user) throw new BadRequestException('El empleado no tiene una cuenta del sistema.');
    const tempPassword = password?.trim() || genTempPassword();
    await this.auth.resetPassword(user.id, tempPassword);
    this.logAccess(staffId, 'Restableció la contraseña', actor);
    const perms = await this.permissions(staffId);
    return { ...perms, tempPassword };
  }

  /** Bitácora de cambios de acceso de este empleado (roles, permisos, cuenta). */
  async accessAudit(staffId: string) {
    const rows = await this.prisma.auditLog.findMany({
      where: { entity: 'staff-access', entityId: staffId },
      orderBy: { createdAt: 'desc' },
      take: 30,
      include: { user: { select: { name: true, email: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      detail: r.after ?? null,
      actorName: r.user?.name ?? null,
      actorEmail: r.user?.email ?? null,
      createdAt: r.createdAt,
    }));
  }
}
