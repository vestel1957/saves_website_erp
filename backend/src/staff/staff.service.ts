import { BadRequestException, ForbiddenException, NotFoundException } from '../core/http/errores';
import { AFILIADORES, rangoBogota } from './afiliadores';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsDateString, IsInt, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { orden } from '../common/pagination-params';
import { PrismaService } from '../prisma/prisma.service';
import { ALL_PERMISSIONS, SUPERADMIN_PERMISSION } from '../auth/permissions.catalog';
import { AuthService } from '../auth/auth.service';
import { AuthUser } from '../auth/current-user.decorator';
import { normalizarCorreo } from '../auth/correo.util';
import { sedesDeCsvLegacy } from '../auth/sedes-staff';
import { AuditService } from '../common/audit/audit.service';
import { num } from '../common/money';
import { CARGO_TECNICO, cargoLegacy } from './cargos-legacy';
import { olvidarNombres } from './nombre-tecnico';

export class CreateStaffDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() docNumber?: string;
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
/**
 * Edición parcial del empleado: todos los campos son opcionales (semántica PATCH).
 * No hereda de CreateStaffDto porque allí `name` es obligatorio y forzaría a
 * reenviar el objeto completo en cada edición.
 */
export class UpdateStaffDto {
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @IsOptional() @IsString() docNumber?: string;
  @IsOptional() @IsString() email?: string;
  // `null` explícito = borrar el dato. `undefined` (campo ausente) = no tocarlo.
  @IsOptional() @IsInt() role?: number | null;
  @IsOptional() @IsString() areaId?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() phoneAlt?: string;
  @IsOptional() @IsString() eps?: string;
  @IsOptional() @IsString() pension?: string;
  @IsOptional() @IsString() rh?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() region?: string;
  @IsOptional() @IsDateString() entryDate?: string | null;
  @IsOptional() @IsString() sedeAccede?: string;
}

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

/** Habilitar / inhabilitar al funcionario entero (deja de verse en todo el sistema). */
export class SetStaffBannedDto {
  @IsBoolean() banned!: boolean;
}

/** Restablecer la contraseña del empleado. */
export class ResetStaffPasswordDto {
  @IsOptional() @IsString() @MinLength(6) password?: string;
  /** Los 6 dígitos que le llegaron por WhatsApp al propio empleado. */
  @IsOptional() @IsString() @Matches(/^\s*\d(\s*\d){5}\s*$/, { message: 'El código son 6 dígitos.' }) code?: string;
}

/**
 * Los funcionarios inhabilitados no existen para el sistema: no salen en la lista
 * de empleados, ni en los selectores, ni en los reportes, ni en el chatbot. La
 * ficha sigue ahí (por id) para poder volver a habilitarlos, nada más.
 */
export const ACTIVOS = { banned: false } as const;

/** Contraseña temporal legible (se muestra una sola vez al superusuario). */
function genTempPassword(): string {
  const b = randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
  return `Vst-${b.slice(0, 8)}`;
}

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

  /**
   * Resumen del personal. Cuenta SOLO a los funcionarios activos: los
   * inhabilitados (ex-empleados que quedaron del legacy) no se cuentan ni se
   * listan en ninguna parte, así que sumarlos aquí haría que el encabezado no
   * cuadrara nunca con la tabla de abajo.
   */
  async stats() {
    const [total, byRole, tecnicos] = await Promise.all([
      this.prisma.staff.count({ where: ACTIVOS }),
      this.prisma.staff.groupBy({ by: ['role'], where: ACTIVOS, _count: { _all: true } }),
      // Técnicos POR CARGO. Antes contaba `areaLegacy in (2,3,4)`, que son las
      // áreas Operativa + Comercial + Sistemas: la tarjeta decía "Técnicos: 91"
      // sobre 115 empleados, metiendo cajeras y sistemas en la cuenta.
      this.prisma.staff.count({ where: { ...ACTIVOS, role: CARGO_TECNICO } }),
    ]);
    const roles: Record<string, number> = {};
    for (const r of byRole) roles[cargoLegacy(r.role) ?? `Rol ${r.role}`] = r._count._all;
    return { total, activos: total, tecnicos, roles };
  }

  /** Columnas ordenables de la tabla de empleados. */
  private static readonly ORDEN_LISTA = {
    name: 'name',
    docNumber: 'docNumber',
    // En la fila se ve la etiqueta del cargo, pero `role` es el número legacy y
    // las etiquetas van en ese mismo orden jerárquico, así que coincide.
    role: 'role',
    area: 'area.name',
    phone: 'phone',
  };

  /**
   * Lista de empleados. Devuelve SIEMPRE solo a los activos; `verInhabilitados`
   * es la única puerta para volver a verlos y el controlador solo se la abre al
   * superusuario, que es quien puede rehabilitarlos.
   */
  async list(params: { search?: string; role?: string; areaId?: string; verInhabilitados?: boolean; page?: number; pageSize?: number; sortBy?: string; sortDir?: string }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 25));
    const where: Prisma.StaffWhereInput = params.verInhabilitados ? { banned: true } : { ...ACTIVOS };
    if (params.role) where.role = Number(params.role);
    if (params.areaId) where.areaId = params.areaId;
    const search = (params.search || '').trim();
    if (search) where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { docNumber: { contains: search } }];
    const [rows, total] = await Promise.all([
      this.prisma.staff.findMany({ where, orderBy: orden(params, StaffService.ORDEN_LISTA, [{ role: 'desc' }, { name: 'asc' }]), skip: (page - 1) * pageSize, take: pageSize, include: { area: true } }),
      this.prisma.staff.count({ where }),
    ]);
    return {
      items: rows.map((e) => ({
        id: e.id, name: e.name, docNumber: e.docNumber, email: e.email,
        role: e.role, roleLabel: cargoLegacy(e.role), area: e.area?.name ?? null,
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
      id: e.id, legacyId: e.legacyId, name: e.name, docNumber: e.docNumber, email: e.email,
      role: e.role, roleLabel: cargoLegacy(e.role), area: e.area?.name ?? null, areaId: e.areaId,
      entryDate: e.entryDate, rh: e.rh, eps: e.eps, pension: e.pension,
      address: e.address, city: e.city, region: e.region, phone: e.phone, phoneAlt: e.phoneAlt,
      banned: e.banned, lastLogin: e.lastLogin, sedeAccede: e.sedeAccede, picture: e.picture, activity,
    };
  }

  areas() { return this.prisma.staffArea.findMany({ orderBy: { name: 'asc' } }); }

  /**
   * Alta de empleado.
   *
   * El `username` se genera aquí y NO se pide en el formulario. No es un capricho
   * heredado: media plataforma ata a la persona por ese texto —la bodega personal
   * del técnico (`MaterialWarehouse.technicianRef`), los equipos a su nombre
   * (`Equipment.assignedRaw`), el técnico de las órdenes viejas (`Ticket.assigned`)
   * y la lista de quién puede recibir un traspaso—, porque en el legacy era la
   * única llave que había. Un empleado creado aquí nacía sin él y quedaba invisible
   * para todo eso: entraba al sistema, veía su agenda... y no podía gastar material
   * ni tener un equipo asignado (le pasó al primer técnico dado de alta en nexus).
   */
  async create(dto: CreateStaffDto) {
    return this.prisma.staff.create({ data: {
      name: dto.name, docNumber: dto.docNumber ?? null, email: dto.email ?? null,
      username: await this.usernameLibre(dto.name),
      role: dto.role ?? 2, areaId: dto.areaId ?? null, phone: dto.phone ?? null, eps: dto.eps ?? null, pension: dto.pension ?? null,
      rh: dto.rh ?? null, address: dto.address ?? null, city: dto.city ?? null,
    } });
  }

  /**
   * Un `username` con el estilo del legacy ('DarwinVillamizar'): primer nombre y
   * último apellido pegados, sin tildes ni espacios. Si ya existe se numera, porque
   * la columna no es única en la base y dos homónimos compartiéndolo se robarían la
   * bodega y los equipos el uno al otro.
   */
  private async usernameLibre(nombre: string): Promise<string> {
    const partes = nombre
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z ]/g, ' ')
      .split(/\s+/).filter(Boolean);
    const cap = (w: string) => w[0].toUpperCase() + w.slice(1).toLowerCase();
    const elegidas = partes.length > 1 ? [partes[0], partes[partes.length - 1]] : partes;
    const raiz = elegidas.length ? elegidas.map(cap).join('') : `Empleado${Date.now()}`;
    const parecidos = await this.prisma.staff.findMany({
      where: { username: { startsWith: raiz, mode: 'insensitive' } },
      select: { username: true },
    });
    const usados = new Set(parecidos.map((s) => (s.username ?? '').trim().toLowerCase()));
    if (!usados.has(raiz.toLowerCase())) return raiz;
    for (let n = 2; ; n++) if (!usados.has(`${raiz}${n}`.toLowerCase())) return `${raiz}${n}`;
  }
  /**
   * Edición parcial del empleado. Los campos ausentes en el DTO llegan como
   * `undefined` y Prisma los deja intactos; para borrar un dato se envía cadena
   * vacía, que se normaliza a NULL.
   */
  async update(id: string, dto: UpdateStaffDto, actor?: AuthUser) {
    const before = await this.prisma.staff.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Empleado no encontrado');

    // Cadena vacía = el usuario borró el campo → NULL. `undefined` = no se tocó.
    const str = (v: string | undefined) => (v === undefined ? undefined : v.trim() === '' ? null : v.trim());

    const data: Prisma.StaffUpdateInput = {
      docNumber: str(dto.docNumber), email: str(dto.email),
      phone: str(dto.phone), phoneAlt: str(dto.phoneAlt), eps: str(dto.eps), pension: str(dto.pension),
      rh: str(dto.rh), address: str(dto.address), city: str(dto.city), region: str(dto.region),
      sedeAccede: str(dto.sedeAccede), role: dto.role,
    };
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('El nombre no puede quedar vacío');
      data.name = name;
    }
    if (dto.entryDate !== undefined) data.entryDate = dto.entryDate ? new Date(dto.entryDate) : null;
    // `areaId` es relación en Prisma: hay que conectarla o desconectarla, no asignarla.
    if (dto.areaId !== undefined) data.area = dto.areaId ? { connect: { id: dto.areaId } } : { disconnect: true };

    const after = await this.prisma.staff.update({ where: { id }, data });
    // Las órdenes viejas muestran al técnico traduciendo el username al nombre:
    // si acaban de corregirle el nombre, esa traducción ya está vieja.
    olvidarNombres();
    // Esta pantalla también puede tocar la sede directamente (no sólo la de
    // Usuarios): que llegue igual a la cuenta de acceso, o el mismo hueco que dejó
    // sin ver a Cristhian Mahecha reaparece al revés (ver `auth/sedes-staff.ts`).
    if (dto.sedeAccede !== undefined && after.email) {
      void this.auth.reflejarSedesDesdeStaff(after.email, after.sedeAccede);
    }
    void this.audit.record({
      userId: actor?.id, action: 'staff.update', entity: 'staff', entityId: id,
      before: { name: before.name, docNumber: before.docNumber, email: before.email, role: before.role, areaId: before.areaId },
      after: { name: after.name, docNumber: after.docNumber, email: after.email, role: after.role, areaId: after.areaId },
    });
    return after;
  }

  // ── Afiliados ────────────────────────────────────────────────────────────

  /**
   * Funcionarios que afilian (lista nominal de `AFILIADORES`) y cuántos clientes han traído (en el
   * rango, si se da). Es la lista de /afiliados.
   */
  async afiliadosResumen(from?: string, to?: string) {
    const rango = rangoBogota(from, to);
    const activos = await this.prisma.staff.findMany({
      where: AFILIADORES,
      select: { id: true, name: true, role: true, area: { select: { name: true } } },
      orderBy: { name: 'asc' },
    });

    const [enRango, total, ultimo] = await Promise.all([
      this.prisma.subscriber.groupBy({
        by: ['affiliateStaffId'],
        where: { affiliateStaffId: { not: null }, ...(rango ? { affiliateAt: rango } : {}) },
        _count: { _all: true },
      }),
      this.prisma.subscriber.groupBy({ by: ['affiliateStaffId'], where: { affiliateStaffId: { not: null } }, _count: { _all: true } }),
      this.prisma.subscriber.groupBy({ by: ['affiliateStaffId'], where: { affiliateStaffId: { not: null } }, _max: { affiliateAt: true } }),
    ]);
    const n = (filas: { affiliateStaffId: string | null; _count: { _all: number } }[], id: string) =>
      filas.find((f) => f.affiliateStaffId === id)?._count._all ?? 0;

    const funcionarios = activos.map((s) => ({
      id: s.id,
      nombre: s.name,
      cargo: cargoLegacy(s.role),
      area: s.area?.name ?? null,
      clientes: n(enRango, s.id),
      clientesTotal: n(total, s.id),
      ultimaAfiliacion: ultimo.find((f) => f.affiliateStaffId === s.id)?._max.affiliateAt ?? null,
    }));
    return { funcionarios, totalClientes: funcionarios.reduce((a, f) => a + f.clientes, 0) };
  }

  /** Los clientes que trajo un funcionario, con la fecha y hora exactas del alta. */
  async afiliadosDe(staffId: string, from?: string, to?: string) {
    const s = await this.prisma.staff.findUnique({ where: { id: staffId }, select: { id: true, name: true, banned: true } });
    if (!s) throw new NotFoundException('Empleado no encontrado');
    const rango = rangoBogota(from, to);
    const filas = await this.prisma.subscriber.findMany({
      where: { affiliateStaffId: staffId, ...(rango ? { affiliateAt: rango } : {}) },
      orderBy: { affiliateAt: 'desc' },
      select: {
        id: true, abonado: true, fullName: true, docNumber: true, phone1: true, status: true,
        affiliateAt: true, affiliateBy: true, branch: { select: { name: true } },
      },
    });
    return {
      funcionario: { id: s.id, nombre: s.name, inhabilitado: s.banned },
      total: filas.length,
      activos: filas.filter((c) => c.status === 'ACTIVO').length,
      clientes: filas.map((c) => ({
        id: c.id, abonado: c.abonado, nombre: c.fullName, documento: c.docNumber, celular: c.phone1,
        estado: c.status, sede: c.branch?.name ?? null,
        fecha: c.affiliateAt, registradoPor: c.affiliateBy,
      })),
    };
  }

  // ── Permisos del empleado ────────────────────────────────────────────────
  // El empleado (Staff) se vincula con su cuenta del sistema (User) por correo.
  // Es el User quien lleva los roles y los permisos efectivos; aquí los exponemos
  // para verlos desde la ficha del empleado. Editarlos queda restringido al
  // superusuario (ver StaffController).

  /** Usuario del sistema vinculado al empleado (por correo), con roles y overrides. */
  /** Resuelve `legacyId -> nombre` de las sedes indicadas, conservando el orden. */
  private async nombresDeSedes(legacyIds: number[]): Promise<{ legacyId: number; name: string }[]> {
    if (!legacyIds.length) return [];
    const filas = await this.prisma.branch.findMany({
      where: { legacyId: { in: legacyIds } },
      select: { legacyId: true, name: true },
    });
    const porId = new Map(filas.map((b) => [b.legacyId, b.name]));
    // Si una sede se hubiera borrado, se muestra el id en vez de desaparecer sin más.
    return legacyIds.map((id) => ({ legacyId: id, name: porId.get(id) ?? `Sede ${id}` }));
  }

  private async linkedUser(staffId: string) {
    const e = await this.prisma.staff.findUnique({ where: { id: staffId } });
    if (!e) throw new NotFoundException('Empleado no encontrado');
    // Sin distinguir mayúsculas: el correo del legacy viene como lo tecleó cada quien
    // y comparándolo exacto la ficha decía "sin cuenta" a quien sí la tenía (y le
    // creaban una segunda, sin roles). Ver `normalizarCorreo`.
    const user = e.email
      ? await this.prisma.user.findFirst({
          where: { email: { equals: normalizarCorreo(e.email), mode: 'insensitive' } },
          orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
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
      // Sedes a las que accede la cuenta vinculada. Lista vacía = sin restricción
      // (ve todas), que es la semántica que aplica `treasury/caja-scope.ts`.
      sedesAccede: user?.sedesAccede ?? [],
      // Los nombres viajan resueltos: la ficha en modo lectura la abre gente sin
      // permiso para administrar usuarios, que no podría consultar /auth/branches.
      sedesAccedeDetalle: await this.nombresDeSedes(user?.sedesAccede ?? []),
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
    // La ficha puede traer sede de antes (importada del legacy o puesta a mano): si
    // la cuenta nueva no la hereda, nace sin restricción y ve todas las sedes hasta
    // que alguien se la marque a mano en Usuarios (ver `auth/sedes-staff.ts`).
    const sedesAccede = sedesDeCsvLegacy(staff.sedeAccede);
    await this.auth.createUser({ email, name: staff.name, password: tempPassword, roleKeys: dto.roleKeys ?? [], sedesAccede });
    this.logAccess(staffId, 'Creó el acceso al sistema', actor, { email, roleKeys: dto.roleKeys ?? [] });

    const perms = await this.permissions(staffId);
    return { ...perms, tempPassword };
  }

  /**
   * Inhabilita o vuelve a habilitar al funcionario (solo superusuario).
   *
   * Inhabilitar lo saca de TODO: de la lista de empleados, de los selectores de
   * técnico, de los reportes y del chatbot. La ficha no se borra —se llega por su
   * enlace, o desde "Ver inhabilitados"— porque su trabajo pasado cuelga de ella.
   *
   * Arrastra la cuenta de acceso: quien ya no trabaja aquí no entra al sistema, y
   * al rehabilitarlo se le devuelve el acceso. Si esa cuenta fuera la del último
   * superadministrador activo, `setUserActive` se planta y aquí no se inhabilita a
   * nadie: mejor un error que dejar el sistema sin dueño.
   */
  async setBanned(staffId: string, banned: boolean, actor?: AuthUser) {
    const staff = await this.prisma.staff.findUnique({ where: { id: staffId } });
    if (!staff) throw new NotFoundException('Empleado no encontrado');
    if (staff.banned === banned) return this.detail(staffId);

    const user = staff.email
      ? await this.prisma.user.findFirst({
          where: { email: { equals: normalizarCorreo(staff.email), mode: 'insensitive' } },
          orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
        })
      : null;
    if (user && user.isActive === banned) await this.auth.setUserActive(user.id, !banned);

    await this.prisma.staff.update({ where: { id: staffId }, data: { banned } });
    olvidarNombres();
    this.logAccess(staffId, banned ? 'Inhabilitó al funcionario' : 'Habilitó al funcionario', actor, {
      cuenta: user ? (banned ? 'inhabilitada' : 'habilitada') : 'sin cuenta',
    });
    return this.detail(staffId);
  }

  /** Habilita / inhabilita el acceso del empleado (solo superusuario). */
  async setAccountActive(staffId: string, isActive: boolean, actor?: AuthUser) {
    const { user } = await this.linkedUser(staffId);
    if (!user) throw new BadRequestException('El empleado no tiene una cuenta del sistema.');
    await this.auth.setUserActive(user.id, isActive);
    this.logAccess(staffId, isActive ? 'Habilitó el acceso' : 'Inhabilitó el acceso', actor);
    return this.permissions(staffId);
  }

  /**
   * Restablece la contraseña del empleado; devuelve la temporal (solo superusuario).
   *
   * Pide el código de 6 dígitos que le llega al WhatsApp DEL EMPLEADO: el
   * superusuario no puede apoderarse de una cuenta ajena sin que su dueño lo
   * autorice dictándole el código (lo verifica `AuthService.resetPassword`).
   */
  async resetAccountPassword(staffId: string, dto: ResetStaffPasswordDto, actor?: AuthUser) {
    const { user } = await this.linkedUser(staffId);
    if (!user) throw new BadRequestException('El empleado no tiene una cuenta del sistema.');
    const tempPassword = dto.password?.trim() || genTempPassword();
    const { rastro } = await this.auth.resetPassword(user.id, tempPassword, { code: dto.code });
    this.logAccess(staffId, 'Restableció la contraseña', actor, rastro ? { firma: rastro } : undefined);
    const perms = await this.permissions(staffId);
    return { ...perms, tempPassword };
  }

  /** Manda el código al WhatsApp del empleado para poder restablecerle la contraseña. */
  async requestAccountPasswordCode(staffId: string, actor?: AuthUser) {
    const { user } = await this.linkedUser(staffId);
    if (!user) throw new BadRequestException('El empleado no tiene una cuenta del sistema.');
    return this.auth.requestPasswordCode(user.id, actor);
  }

  /** ¿Restablecerle la contraseña va a pedir código, y hay a dónde mandarlo? */
  async accountPasswordPolicy(staffId: string) {
    const { user } = await this.linkedUser(staffId);
    if (!user) throw new BadRequestException('El empleado no tiene una cuenta del sistema.');
    return this.auth.passwordPolicy(user.id);
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
