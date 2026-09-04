import { BadRequestException, ForbiddenException, NotFoundException, UnauthorizedException } from '../core/http/errores';
import { Logger } from '../core/logger';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from './current-user.decorator';
import { hashPassword, isLegacyHash, signToken, verifyPassword } from './crypto.util';
import { normalizarCorreo } from './correo.util';
import { ROLE_AREA_BY_KEY, SUPERADMIN_PERMISSION, SCREENS, screenKey, ALL_PERMISSIONS } from './permissions.catalog';
import { PasswordOtpService } from '../common/signature/password-otp.service';
import { resolverSedes } from '../common/sede-scope';
import { csvSedesLegacy, sedesDeCsvLegacy } from './sedes-staff';

export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    // Llega por `SignatureModule`, que es global: `AuthModule` no lo puede
    // importar sin cerrar el ciclo con WhatsApp (ver el módulo de firma).
    private readonly passwordOtp: PasswordOtpService,
  ) {}

  private readonly logger = new Logger('Auth');

  /**
   * Registra un evento de acceso en la bitácora (entrada, fallo, o los pasos de
   * "olvidé mi contraseña"). Best-effort: no puede tumbar lo que está anotando.
   */
  private async auditLogin(
    action: 'LOGIN' | 'LOGIN_FAILED' | 'PASSWORD_FORGOT' | 'PASSWORD_FORGOT_UNKNOWN' | 'PASSWORD_FORGOT_RESET',
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
    // Alcance por sede resuelto una sola vez por petición y colgado de la sesión:
    // así lo tienen a mano tanto los filtros del backend (`sede-scope.ts` lo lee de
    // aquí en vez de volver a la BD) como la pantalla, que con esto sabe que NO debe
    // pintarle al usuario un selector de sedes que no puede usar.
    // El superusuario nunca queda acotado.
    const sedes = permissions.has(SUPERADMIN_PERMISSION)
      ? []
      : await resolverSedes(this.prisma, user, [...permissions]);

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      roles,
      permissions: [...permissions],
      sedes,
      // Cuál es SU caja (si tiene). Va en la sesión para que la pantalla pueda
      // ofrecerle abrir/mirar su caja sin preguntar por `/treasury/mi-caja` en cada
      // pantalla — y sobre todo a quien no es cajera pura (un superusuario que
      // atiende ventanilla), a quien hasta ahora no se le pintaba ese panel.
      caja: user.cajaLegacyId ?? null,
    };
  }

  /**
   * Cuenta por correo SIN distinguir mayúsculas. El legacy guardaba el correo tal
   * como lo tecleó cada quien ('DAVIDFUENTES752@GMAIL.COM' vs el mismo en minúsculas),
   * y comparar exacto partía a la misma persona en dos: no entraba con su correo de
   * siempre y su ficha la veía "sin cuenta", así que le creaban una segunda sin roles.
   * Si por lo viejo hubiera dos filas, manda la activa más antigua (la del legacy).
   */
  private cuentaPorCorreo(email: string) {
    return this.prisma.user.findFirst({
      where: { email: { equals: normalizarCorreo(email), mode: 'insensitive' } },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async login(email: string, password: string, meta?: { ip?: string }) {
    const user = await this.cuentaPorCorreo(email);
    if (!user || !user.isActive || !verifyPassword(password, user.passwordHash)) {
      // Auditar el intento fallido: con quién (si el correo existe) y desde dónde.
      // NUNCA se guarda la contraseña; sólo el correo tecleado. Best-effort: un
      // fallo al auditar no debe convertir un 401 en un 500.
      await this.auditLogin('LOGIN_FAILED', user?.id ?? null, meta?.ip, { email });
      throw new UnauthorizedException('Credenciales inválidas.');
    }
    await this.auditLogin('LOGIN', user.id, meta?.ip);
    // Hash migrado del legacy (Aauth sha256): la clave ya se validó, así que se
    // aprovecha para re-guardarla con scrypt+salt aleatorio. Best-effort.
    if (isLegacyHash(user.passwordHash)) {
      await this.prisma.user
        .update({ where: { id: user.id }, data: { passwordHash: hashPassword(password) } })
        .catch(() => undefined);
    }
    const resolved = await this.resolveUser(user.id);
    // Áreas de acceso (slug tras "area.") + flag superadmin, embebidos en el JWT
    // para que el middleware del edge pueda bloquear rutas por área sin consultar la BD.
    const perms = resolved?.permissions ?? [];
    const areas = perms.filter((p) => p.startsWith('area.')).map((p) => p.slice('area.'.length));
    const sa = perms.includes('system.admin');
    // El jefe de bodega no tiene área ninguna y aun así la API le abre las rutas de
    // equipos (`@OrPermission(INV_PERMISSIONS.ADMIN)`): viaja como claim propio para
    // que el edge pueda dejarlo pasar a su pantalla sin regalarle un área entera.
    const inv = perms.includes('inventory.admin');
    const token = signToken({ id: user.id, email: user.email, name: user.name }, { areas, sa, inv });
    return { token, user: resolved };
  }

  async createUser(input: { email: string; name: string; password: string; roleKeys?: string[]; sedesAccede?: number[] }) {
    // El correo es la llave con la que se entra Y con la que la ficha del empleado
    // encuentra su cuenta, así que se compara y se guarda normalizado: si no, el
    // mismo correo escrito en mayúsculas nacía como una cuenta aparte, sin roles.
    const email = normalizarCorreo(input.email);
    const exists = await this.cuentaPorCorreo(email);
    if (exists) throw new BadRequestException('Ya existe un usuario con ese correo.');

    const roles = input.roleKeys?.length
      ? await this.prisma.role.findMany({ where: { key: { in: input.roleKeys } } })
      : [];

    const sedes = await this.validarSedes(input.sedesAccede);
    const [user] = await this.prisma.$transaction([
      this.prisma.user.create({
        data: {
          email,
          name: input.name,
          passwordHash: hashPassword(input.password),
          sedesAccede: sedes,
          roles: { create: roles.map((r) => ({ roleId: r.id })) },
        },
        select: { id: true, email: true, name: true, isActive: true, createdAt: true },
      }),
      // Si la cuenta nace para un empleado que ya tiene ficha, su sede queda dicha
      // en los dos sitios desde el primer día (ver `reflejarSedesEnStaff`). Sólo
      // con sedes marcadas: al alta se dejan en blanco por omisión, y propagar ese
      // vacío le borraría a la ficha la sede que ya traía del legacy.
      ...(sedes.length ? [this.reflejarSedesEnStaff(email, sedes)] : []),
    ]);
    return user;
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

  /**
   * Refleja las sedes de la cuenta en la ficha del empleado (`Staff.sedeAccede`).
   *
   * La sede de una persona vive en dos columnas y sólo se escribía una: ver
   * `sedes-staff.ts`. Sin esto, mover a un técnico de sede le cambia lo que ÉL ve
   * pero no de qué sede ES, así que la cajera de su sede nueva no lo encuentra
   * para asignarle órdenes ni entregarle material.
   *
   * Se casa por correo sin distinguir mayúsculas —el mismo enganche Staff↔User que
   * usa la ficha— y con `updateMany`, que no se queja si el empleado no tiene ficha
   * (usuarios que no son personal) o si el correo no casa con ninguna.
   */
  private reflejarSedesEnStaff(email: string, sedes: number[]) {
    return this.prisma.staff.updateMany({
      where: { email: { equals: email, mode: 'insensitive' } },
      data: { sedeAccede: csvSedesLegacy(sedes) },
    });
  }

  /**
   * El camino inverso de `reflejarSedesEnStaff`: la ficha del empleado
   * (`StaffService.update`, PATCH /staff/:id) también puede editar la sede
   * directamente, y esa edición tiene que llegar igual a la cuenta de acceso — si
   * no, queda el mismo hueco que dejó sin ver a Cristhian Mahecha, sólo que en el
   * sentido contrario. `sedeAccede` llega ya en formato legacy ('-3-,-4-') porque
   * así lo guarda `Staff`.
   */
  reflejarSedesDesdeStaff(email: string, sedeAccedeCsv: string | null) {
    if (!email) return Promise.resolve();
    return this.prisma.user.updateMany({
      where: { email: { equals: email, mode: 'insensitive' } },
      data: { sedesAccede: sedesDeCsvLegacy(sedeAccedeCsv) },
    });
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

    const email = input.email ? normalizarCorreo(input.email) : '';
    if (email && email !== user.email) {
      const taken = await this.cuentaPorCorreo(email);
      if (taken && taken.id !== userId) throw new BadRequestException('Ya existe un usuario con ese correo.');
    }

    // `undefined` = no tocar; `[]` = quitar la restricción (ve todas las sedes).
    const sedes = input.sedesAccede === undefined ? undefined : await this.validarSedes(input.sedesAccede);

    const cambios: Prisma.PrismaPromise<unknown>[] = [
      this.prisma.user.update({
        where: { id: userId },
        data: { name: input.name?.trim() || undefined, email: email || undefined, sedesAccede: sedes },
      }),
    ];
    // En la misma transacción que la cuenta: si la ficha se quedara sin actualizar,
    // el empleado volvería a ser invisible para la cajera de su sede y nadie lo
    // sabría hasta que alguien lo echara en falta.
    if (sedes) cambios.push(this.reflejarSedesEnStaff(email || user.email, sedes));

    await this.prisma.$transaction(cambios);
    return this.listUsers();
  }

  /**
   * Restablece la contraseña de un usuario (la fija un administrador).
   *
   * Exige el código de 6 dígitos que le llega al WhatsApp DEL DUEÑO de la cuenta
   * (no al del administrador): así nadie se apropia de una cuenta ajena sin que
   * su titular lo sepa y lo autorice. `opts.otp: false` lo salta a propósito para
   * los flujos que no son una toma de control —crear la cuenta desde cero, donde
   * todavía no hay dueño a quien avisar—.
   */
  async resetPassword(userId: string, password: string, opts?: { code?: string | null; otp?: boolean }) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Usuario no encontrado.');

    const rastro =
      opts?.otp === false
        ? null
        : await this.passwordOtp.exigir({ id: user.id, name: user.name, email: user.email }, 'reset', opts?.code);

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: hashPassword(password) },
    });
    return { ok: true, rastro };
  }

  /** Manda el código para restablecerle la contraseña a este usuario. */
  async requestPasswordCode(userId: string, actor?: AuthUser) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true } });
    if (!user) throw new NotFoundException('Usuario no encontrado.');
    return this.passwordOtp.pedir(user, 'reset', actor?.name ?? actor?.email);
  }

  // ── "Olvidé mi contraseña" (sin sesión) ────────────────────────────────────
  //
  // Tres pasos desde la pantalla de ingreso: correo → código que llega al
  // WhatsApp vinculado a ese correo → contraseña nueva.
  //
  // La regla que ordena todo lo de abajo: **desde fuera, todos los correos se
  // comportan igual**. Ni la respuesta ni el mensaje de error dicen si la cuenta
  // existe, si está activa, si tiene WhatsApp o a qué número salió el código —
  // esta pantalla la ve cualquiera que llegue a la IP, y un "ese correo no
  // existe" le regala la lista de empleados a quien la esté tanteando. Por eso
  // tampoco se devuelve nunca el código en simulación: bastaría teclear el correo
  // de gerencia para leerlo. En simulación el código sale por el log del servidor.

  /** Mensaje único del paso 1: el mismo exista o no la cuenta. */
  private static readonly OLVIDO_ENVIADO =
    'Si ese correo tiene una cuenta con WhatsApp vinculado, le acabamos de mandar un código de 6 dígitos. ' +
    'Revisa el WhatsApp de ese celular.';

  /** Error único de los pasos 2 y 3: no distingue "no existe" de "no acertaste". */
  private static readonly OLVIDO_INVALIDO =
    'El código no es válido o ya venció. Pide uno nuevo desde el paso anterior.';

  /** Cuenta activa de ese correo, o null. Nunca se le cuenta a nadie cuál fue. */
  private cuentaDe(email: string) {
    return this.prisma.user.findFirst({
      where: { email: { equals: String(email ?? '').trim(), mode: 'insensitive' }, isActive: true },
      select: { id: true, name: true, email: true },
    });
  }

  /** ¿El canal puede entregar códigos? Lo consulta el login para no ofrecer un callejón sin salida. */
  forgotAvailability() {
    return this.passwordOtp.canalListo();
  }

  /**
   * Paso 1: manda el código al WhatsApp vinculado a ese correo.
   *
   * El envío NO se espera. La respuesta es la misma pase lo que pase —no dice si
   * la cuenta existe ni si el código salió—, así que esperar a que Kapso conteste
   * solo servía para dejar a alguien mirando un botón girando mientras el WhatsApp
   * ya iba en camino. Se responde de una y la pantalla pasa a pedir el código.
   */
  async forgotPassword(email: string, ip?: string) {
    const user = await this.cuentaDe(email);
    if (user) {
      void this.passwordOtp
        .pedirOlvido(user)
        .then(() => this.auditLogin('PASSWORD_FORGOT', user.id, ip, { email: user.email }))
        .catch((e: Error) => {
          // Sin teléfono, tope diario, reenvío demasiado pronto o WhatsApp caído:
          // se anota y se calla. Contarlo distinguiría este correo de los demás.
          this.logger.warn(`Recuperación de ${user.email}: no se pudo mandar el código — ${e.message}`);
        });
    } else {
      void this.auditLogin('PASSWORD_FORGOT_UNKNOWN', null, ip, { email: String(email ?? '').slice(0, 120) });
    }
    return { ok: true as const, message: AuthService.OLVIDO_ENVIADO };
  }

  /** Paso 2: ¿es ese el código? No lo gasta — la contraseña todavía no se ha escrito. */
  async forgotCheck(email: string, code: string) {
    const user = await this.cuentaDe(email);
    if (!user) throw new BadRequestException(AuthService.OLVIDO_INVALIDO);
    try {
      await this.passwordOtp.comprobarOlvido(user, code);
    } catch {
      throw new BadRequestException(AuthService.OLVIDO_INVALIDO);
    }
    return { ok: true as const };
  }

  /** Paso 3: gasta el código y escribe la contraseña nueva. */
  async forgotReset(email: string, code: string, password: string, ip?: string) {
    const user = await this.cuentaDe(email);
    if (!user) throw new BadRequestException(AuthService.OLVIDO_INVALIDO);

    let rastro: string;
    try {
      rastro = await this.passwordOtp.consumirOlvido(user, code);
    } catch {
      throw new BadRequestException(AuthService.OLVIDO_INVALIDO);
    }

    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: hashPassword(password) } });
    void this.auditLogin('PASSWORD_FORGOT_RESET', user.id, ip, { email: user.email, firma: rastro });
    this.logger.log(`Contraseña recuperada por ${user.email} desde la pantalla de ingreso.`);
    // Nota: las sesiones abiertas de esa cuenta siguen vivas hasta que venza su
    // token (12 h). Cerrarlas exigiría revocación, que hoy no existe.
    return { ok: true as const };
  }

  /** ¿Este cambio va a pedir código, y hay a dónde mandarlo? (lo consulta la pantalla). */
  async passwordPolicy(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true } });
    if (!user) throw new NotFoundException('Usuario no encontrado.');
    return this.passwordOtp.policy(user, 'reset');
  }
}
