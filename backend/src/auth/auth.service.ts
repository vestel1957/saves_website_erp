import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from './current-user.decorator';
import { hashPassword, signToken, verifyPassword } from './crypto.util';
import { ROLE_AREA_BY_KEY, SUPERADMIN_PERMISSION, SCREENS, screenKey, ALL_PERMISSIONS } from './permissions.catalog';

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  /** Registra un evento de login (éxito o fallo) en la bitácora. Best-effort. */
  private async auditLogin(
    action: 'LOGIN' | 'LOGIN_FAILED',
    userId: string | null,
    ip?: string,
    after?: Prisma.InputJsonValue,
  ) {
    try {
      await this.prisma.auditLog.create({
        data: { action, entity: 'Auth', userId, ipAddress: ip ?? null, after: after ?? Prisma.JsonNull },
      });
    } catch {
      /* la auditoría no puede tumbar el login */
    }
  }

  /** Loads a user and flattens their role permissions into req.user. */
  async resolveUser(userId: string): Promise<AuthUser | null> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isActive: true },
      include: {
        roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
        permissionOverrides: { include: { permission: true } },
      },
    });
    if (!user) return null;

    // Permisos efectivos = (unión de los roles) ∪ overrides ALLOW − overrides DENY.
    const permissions = new Set<string>();
    const roles: string[] = [];
    for (const ur of user.roles) {
      roles.push(ur.role.name);
      for (const rp of ur.role.permissions) permissions.add(rp.permission.key);
    }
    for (const ov of user.permissionOverrides) {
      if (ov.effect === 'DENY') permissions.delete(ov.permission.key);
      else permissions.add(ov.permission.key);
    }
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      roles,
      permissions: [...permissions],
    };
  }

  async login(email: string, password: string, meta?: { ip?: string }) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive || !verifyPassword(password, user.passwordHash)) {
      // Auditar el intento fallido: con quién (si el correo existe) y desde dónde.
      // NUNCA se guarda la contraseña; sólo el correo tecleado. Best-effort: un
      // fallo al auditar no debe convertir un 401 en un 500.
      await this.auditLogin('LOGIN_FAILED', user?.id ?? null, meta?.ip, { email });
      throw new UnauthorizedException('Credenciales inválidas.');
    }
    await this.auditLogin('LOGIN', user.id, meta?.ip);
    const resolved = await this.resolveUser(user.id);
    // Áreas de acceso (slug tras "area.") + flag superadmin, embebidos en el JWT
    // para que el middleware del edge pueda bloquear rutas por área sin consultar la BD.
    const perms = resolved?.permissions ?? [];
    const areas = perms.filter((p) => p.startsWith('area.')).map((p) => p.slice('area.'.length));
    const sa = perms.includes('system.admin');
    const token = signToken({ id: user.id, email: user.email, name: user.name }, { areas, sa });
    return { token, user: resolved };
  }

  async createUser(input: { email: string; name: string; password: string; roleKeys?: string[]; sedesAccede?: number[] }) {
    const exists = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (exists) throw new BadRequestException('Ya existe un usuario con ese correo.');

    const roles = input.roleKeys?.length
      ? await this.prisma.role.findMany({ where: { key: { in: input.roleKeys } } })
      : [];

    return this.prisma.user.create({
      data: {
        email: input.email,
        name: input.name,
        passwordHash: hashPassword(input.password),
        sedesAccede: await this.validarSedes(input.sedesAccede),
        roles: { create: roles.map((r) => ({ roleId: r.id })) },
      },
      select: { id: true, email: true, name: true, isActive: true, createdAt: true },
    });
  }

  /**
   * Sedes a las que el usuario tiene acceso, validadas contra `Branch.legacyId`.
   *
   * Semántica (la misma que aplica `caja-scope.ts`): **lista vacía = SIN restricción**,
   * o sea ve todas las sedes. No es "ninguna sede". Es importante que la UI lo diga,
   * porque lo intuitivo sería lo contrario.
   *
   * Se validan los ids para no guardar sedes inexistentes: un número que no
   * corresponde a ninguna sede dejaría al usuario sin acceso a nada y sin pista de
   * por qué.
   */
  private async validarSedes(sedes: number[] | undefined): Promise<number[]> {
    if (!sedes?.length) return [];
    const unicas = [...new Set(sedes)];
    const existen = await this.prisma.branch.findMany({
      where: { legacyId: { in: unicas } },
      select: { legacyId: true },
    });
    const validas = new Set(existen.map((b) => b.legacyId));
    const desconocidas = unicas.filter((s) => !validas.has(s));
    if (desconocidas.length) {
      throw new BadRequestException(`No existe la sede: ${desconocidas.join(', ')}.`);
    }
    return unicas.sort((a, b) => a - b);
  }

  /** Sedes disponibles, para el selector de acceso por sede. */
  listBranches() {
    return this.prisma.branch.findMany({
      select: { legacyId: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  listUsers() {
    return this.prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        isActive: true,
        createdAt: true,
        sedesAccede: true,
        roles: { include: { role: { select: { key: true, name: true } } } },
      },
      orderBy: { name: 'asc' },
    });
  }

  /** Lista mínima para selectores (id + nombre + email), solo usuarios activos. */
  listUserOptions() {
    return this.prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
    });
  }

  async listRoles() {
    const roles = await this.prisma.role.findMany({
      include: {
        permissions: { include: { permission: true } },
        _count: { select: { users: true } },
      },
      orderBy: { name: 'asc' },
    });
    return roles.map((r) => ({
      ...r,
      // Los roles del catálogo derivan su grupo; los personalizados usan su columna `area`.
      area: ROLE_AREA_BY_KEY[r.key] ?? r.area ?? 'Personalizados',
      // `system` = rol del catálogo (sembrado): solo lectura, se clona pero no se edita/borra.
      system: r.key in ROLE_AREA_BY_KEY,
    }));
  }

  /** Un rol del catálogo (sembrado) es de solo lectura; los creados en la UI no. */
  private isSystemRole(key: string): boolean {
    return key in ROLE_AREA_BY_KEY;
  }

  /** Valida que las llaves de permiso existan en el catálogo; devuelve la lista limpia. */
  private validatePermissionKeys(keys: string[]): string[] {
    const catalog = new Set(ALL_PERMISSIONS.map((p) => p.key));
    const clean = [...new Set(keys)].filter((k) => catalog.has(k));
    const unknown = keys.filter((k) => !catalog.has(k));
    if (unknown.length) throw new BadRequestException(`Permisos desconocidos: ${unknown.slice(0, 5).join(', ')}`);
    return clean;
  }

  /** Genera una key única a partir del nombre (para roles creados en la UI). */
  private async uniqueRoleKey(name: string): Promise<string> {
    const slug = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'rol';
    const base = `custom-${slug}`;
    let key = base;
    for (let i = 2; await this.prisma.role.findUnique({ where: { key } }); i++) key = `${base}-${i}`;
    return key;
  }

  /** Aplica el set de permisos a un rol (reemplaza por completo sus RolePermission). */
  private async setRolePermissions(roleId: string, permissionKeys: string[]) {
    const perms = await this.prisma.permission.findMany({ where: { key: { in: permissionKeys } }, select: { id: true } });
    await this.prisma.$transaction([
      this.prisma.rolePermission.deleteMany({ where: { roleId } }),
      this.prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId, permissionId: p.id })), skipDuplicates: true }),
    ]);
  }

  /**
   * Crea un rol personalizado (plantilla de permisos). Solo superadmin (gate en
   * el controller). Anti-escalada: valida que las llaves existan en el catálogo.
   */
  async createRole(dto: { name: string; description?: string; area?: string; permissions: string[] }) {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('El nombre del rol es obligatorio.');
    const permissions = this.validatePermissionKeys(dto.permissions ?? []);
    if (!permissions.length) throw new BadRequestException('Selecciona al menos un permiso.');
    const key = await this.uniqueRoleKey(name);
    const role = await this.prisma.role.create({
      data: { key, name, description: dto.description?.trim() || null, area: dto.area?.trim() || 'Personalizados' },
    });
    await this.setRolePermissions(role.id, permissions);
    return this.listRoles();
  }

  /** Edita un rol PERSONALIZADO (nombre, descripción, grupo y permisos). */
  async updateRole(id: string, dto: { name?: string; description?: string; area?: string; permissions?: string[] }) {
    const role = await this.prisma.role.findUnique({ where: { id } });
    if (!role) throw new NotFoundException('Rol no encontrado.');
    if (this.isSystemRole(role.key)) {
      throw new ForbiddenException('Los roles del sistema son de solo lectura. Clónalo para personalizarlo.');
    }
    const data: { name?: string; description?: string | null; area?: string } = {};
    if (dto.name != null) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('El nombre del rol es obligatorio.');
      data.name = name;
    }
    if (dto.description !== undefined) data.description = dto.description?.trim() || null;
    if (dto.area != null) data.area = dto.area.trim() || 'Personalizados';
    if (Object.keys(data).length) await this.prisma.role.update({ where: { id }, data });
    if (dto.permissions) {
      const permissions = this.validatePermissionKeys(dto.permissions);
      if (!permissions.length) throw new BadRequestException('El rol debe tener al menos un permiso.');
      await this.setRolePermissions(id, permissions);
    }
    return this.listRoles();
  }

  /** Elimina un rol PERSONALIZADO sin usuarios asignados. */
  async deleteRole(id: string) {
    const role = await this.prisma.role.findUnique({ where: { id }, include: { _count: { select: { users: true } } } });
    if (!role) throw new NotFoundException('Rol no encontrado.');
    if (this.isSystemRole(role.key)) throw new ForbiddenException('No se pueden eliminar los roles del sistema.');
    if (role._count.users > 0) {
      throw new BadRequestException(`Este rol está asignado a ${role._count.users} usuario(s). Reasígnalos antes de eliminarlo.`);
    }
    await this.prisma.role.delete({ where: { id } });
    return this.listRoles();
  }

  /** True si alguno de estos roles (por key) concede el permiso de superadmin. */
  private async roleKeysGrantAdmin(roleKeys: string[]): Promise<boolean> {
    if (!roleKeys.length) return false;
    const count = await this.prisma.role.count({
      where: {
        key: { in: roleKeys },
        permissions: { some: { permission: { key: SUPERADMIN_PERMISSION } } },
      },
    });
    return count > 0;
  }

  /** True si el usuario ya tiene (vía sus roles) el permiso de superadmin. */
  private async userIsAdmin(userId: string): Promise<boolean> {
    const count = await this.prisma.user.count({
      where: {
        id: userId,
        roles: { some: { role: { permissions: { some: { permission: { key: SUPERADMIN_PERMISSION } } } } } },
      },
    });
    return count > 0;
  }

  /**
   * Anti-escalada: solo un superadmin puede otorgar un conjunto de roles que
   * conceda `system.admin`. Lo usan tanto la edición de roles como la creación
   * de acceso de empleados (que también asigna roles).
   */
  async assertRolesAssignable(roleKeys: string[], actor?: AuthUser) {
    const actorIsAdmin = actor?.permissions?.includes(SUPERADMIN_PERMISSION) ?? false;
    if (!actorIsAdmin && (await this.roleKeysGrantAdmin(roleKeys))) {
      throw new ForbiddenException('Solo un superadministrador puede otorgar acceso total (system.admin).');
    }
  }

  /** Cantidad de OTROS superadmins activos (para no dejar el sistema sin ninguno). */
  private async otherActiveAdminCount(excludeUserId: string): Promise<number> {
    return this.prisma.user.count({
      where: {
        isActive: true,
        NOT: { id: excludeUserId },
        roles: { some: { role: { permissions: { some: { permission: { key: SUPERADMIN_PERMISSION } } } } } },
      },
    });
  }

  /**
   * Reemplaza por completo los roles de un usuario, con dos blindajes:
   *  1. Anti-escalada: solo un superadmin puede otorgar un rol que conceda
   *     `system.admin` (impide que RRHH o un admin acotado se auto-eleven).
   *  2. Último admin: no permite quitar el superadmin al último que queda.
   */
  async setUserRoles(userId: string, roleKeys: string[], actor?: AuthUser) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Usuario no encontrado.');

    await this.assertRolesAssignable(roleKeys, actor);
    const newGrantsAdmin = await this.roleKeysGrantAdmin(roleKeys);

    const currentlyAdmin = await this.userIsAdmin(userId);
    if (currentlyAdmin && !newGrantsAdmin) {
      const others = await this.otherActiveAdminCount(userId);
      if (others === 0) {
        throw new ForbiddenException(
          'No puedes quitar el superadministrador al último que queda. Asigna ese rol a otra cuenta primero.',
        );
      }
    }

    const roles = roleKeys.length
      ? await this.prisma.role.findMany({ where: { key: { in: roleKeys } } })
      : [];

    await this.prisma.$transaction([
      this.prisma.userRole.deleteMany({ where: { userId } }),
      this.prisma.userRole.createMany({
        data: roles.map((r) => ({ userId, roleId: r.id })),
        skipDuplicates: true,
      }),
    ]);
    return this.listUsers();
  }

  // ── Acceso por pantalla (módulo/submódulo) por empleado ──────────────────

  /** Árbol de pantallas agrupadas por módulo, para el editor de accesos. */
  getScreenTree() {
    const modules: { module: string; screens: { key: string; label: string; href: string }[] }[] = [];
    for (const s of SCREENS) {
      let m = modules.find((x) => x.module === s.module);
      if (!m) { m = { module: s.module, screens: [] }; modules.push(m); }
      m.screens.push({ key: screenKey(s.href), label: s.label, href: s.href });
    }
    return modules;
  }

  /** Llaves de pantalla que los ROLES del usuario ya conceden (baseline). */
  private async roleScreenKeys(userId: string): Promise<Set<string>> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } },
    });
    const allScreens = new Set(SCREENS.map((s) => screenKey(s.href)));
    const isAdmin = (u?.roles ?? []).some((ur) =>
      ur.role.permissions.some((rp) => rp.permission.key === SUPERADMIN_PERMISSION),
    );
    if (isAdmin) return new Set(allScreens); // superadmin ⇒ todas las pantallas
    const set = new Set<string>();
    for (const ur of u?.roles ?? [])
      for (const rp of ur.role.permissions)
        if (allScreens.has(rp.permission.key)) set.add(rp.permission.key);
    return set;
  }

  /** Acceso a pantallas de un usuario: baseline del rol, efectivo y overrides. */
  async getUserAccess(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Usuario no encontrado.');
    const roleScreens = await this.roleScreenKeys(userId);
    const allScreens = new Set(SCREENS.map((s) => screenKey(s.href)));
    const overrides = (await this.prisma.userPermission.findMany({ where: { userId }, include: { permission: true } }))
      .filter((o) => allScreens.has(o.permission.key));
    const effective = new Set(roleScreens);
    for (const o of overrides) {
      if (o.effect === 'DENY') effective.delete(o.permission.key);
      else effective.add(o.permission.key);
    }
    return {
      roleScreens: [...roleScreens],
      effective: [...effective],
      overrides: overrides.map((o) => ({ key: o.permission.key, effect: o.effect })),
    };
  }

  /**
   * Fija las pantallas que un empleado debe ver. Calcula overrides contra el
   * baseline del rol: pide algo que el rol NO da ⇒ ALLOW; le quita algo que el
   * rol SÍ da ⇒ DENY; si coincide con el rol ⇒ sin override. Solo toca overrides
   * de pantallas (no altera otros permisos del usuario).
   */
  async setUserScreens(userId: string, desired: string[]) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Usuario no encontrado.');

    const allScreenKeys = SCREENS.map((s) => screenKey(s.href));
    const desiredSet = new Set(desired.filter((k) => allScreenKeys.includes(k)));
    const roleScreens = await this.roleScreenKeys(userId);

    const perms = await this.prisma.permission.findMany({ where: { key: { in: allScreenKeys } } });
    const idByKey = new Map(perms.map((p) => [p.key, p.id]));

    const overrides: { userId: string; permissionId: string; effect: string }[] = [];
    for (const key of allScreenKeys) {
      const pid = idByKey.get(key);
      if (!pid) continue;
      const want = desiredSet.has(key);
      const inRole = roleScreens.has(key);
      if (want && !inRole) overrides.push({ userId, permissionId: pid, effect: 'ALLOW' });
      else if (!want && inRole) overrides.push({ userId, permissionId: pid, effect: 'DENY' });
    }

    await this.prisma.$transaction([
      this.prisma.userPermission.deleteMany({ where: { userId, permissionId: { in: perms.map((p) => p.id) } } }),
      this.prisma.userPermission.createMany({ data: overrides, skipDuplicates: true }),
    ]);
    return this.getUserAccess(userId);
  }

  /** Enables/disables a user without deleting it (preserves audit history). */
  async setUserActive(userId: string, isActive: boolean) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Usuario no encontrado.');

    // No dejar el sistema sin ningún superadmin activo.
    if (!isActive && (await this.userIsAdmin(userId))) {
      const others = await this.otherActiveAdminCount(userId);
      if (others === 0) {
        throw new ForbiddenException(
          'No puedes desactivar al último superadministrador activo del sistema.',
        );
      }
    }

    await this.prisma.user.update({ where: { id: userId }, data: { isActive } });
    return this.listUsers();
  }

  /** Edita los datos básicos del usuario (nombre y/o correo), validando unicidad. */
  async updateUser(userId: string, input: { name?: string; email?: string; sedesAccede?: number[] }) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Usuario no encontrado.');

    const email = input.email?.trim();
    if (email && email !== user.email) {
      const taken = await this.prisma.user.findUnique({ where: { email } });
      if (taken) throw new BadRequestException('Ya existe un usuario con ese correo.');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        name: input.name?.trim() || undefined,
        email: email || undefined,
        // `undefined` = no tocar; `[]` = quitar la restricción (ve todas las sedes).
        sedesAccede: input.sedesAccede === undefined ? undefined : await this.validarSedes(input.sedesAccede),
      },
    });
    return this.listUsers();
  }

  /** Restablece la contraseña de un usuario (la fija un administrador). */
  async resetPassword(userId: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Usuario no encontrado.');
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: hashPassword(password) },
    });
    return { ok: true };
  }
}
