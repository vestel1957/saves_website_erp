import { BadRequestException, NotFoundException, UnauthorizedException } from '../core/http/errores';
import { Prisma } from '@prisma/client';
import { existsSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { AuthUser } from './current-user.decorator';
import { hashPassword, verifyPassword } from './crypto.util';
import { ALL_PERMISSIONS, SUPERADMIN_PERMISSION } from './permissions.catalog';
import { UpdateProfileDto } from './dto/profile.dto';
import { PasswordOtpService } from '../common/signature/password-otp.service';

/** Carpeta de las fotos de perfil. Las del legacy se copian aquí con su mismo nombre. */
export const FOTOS_ROOT = join(process.cwd(), 'uploads', 'staff', 'photos');

/**
 * "Mi perfil": lo que cada usuario puede ver y cambiar de sí mismo.
 *
 * Vive aparte de `StaffService` por una razón de acceso, no de orden: `/staff`
 * está cerrado al área administración/gerencia, así que un técnico o una cajera
 * no pueden usarlo ni para leer su propia ficha. Estos endpoints sólo piden
 * sesión y trabajan SIEMPRE contra el usuario del token — nunca reciben un id.
 *
 * El vínculo cuenta ↔ empleado es por correo (mismo criterio que la ficha de
 * empleado). Hoy casan 115 de 127 cuentas; las que no (usuarios demo y de
 * servicio) ven su perfil sin la parte de datos personales, no un error.
 */
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    // Global (`SignatureModule`): AuthModule no lo puede importar sin cerrar el
    // ciclo con WhatsApp.
    private readonly passwordOtp: PasswordOtpService,
  ) {}

  /** Empleado vinculado a la cuenta, por correo (insensible a mayúsculas). */
  private staffDe(email: string) {
    return this.prisma.staff.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      include: { area: true },
    });
  }

  /**
   * Nombre de archivo de foto que aceptamos tocar en disco.
   *
   * `Staff.picture` trae valores heredados del legacy que nadie validó al
   * importarlos; sin esto, un valor como `../../.env` convertiría el endpoint de
   * la foto en una lectura arbitraria de ficheros.
   */
  private static fotoSegura(nombre: string | null | undefined): string | null {
    if (!nombre) return null;
    const limpio = basename(nombre.trim());
    if (!limpio || limpio === 'example.png') return null; // marcador del legacy = sin foto
    return /^[A-Za-z0-9._-]+$/.test(limpio) ? limpio : null;
  }

  /** Ruta absoluta de la foto del usuario, o null si no tiene / ya no está en disco. */
  async rutaFoto(user: AuthUser): Promise<string | null> {
    const staff = await this.staffDe(user.email);
    const archivo = ProfileService.fotoSegura(staff?.picture);
    if (!archivo) return null;
    const abs = join(FOTOS_ROOT, archivo);
    return existsSync(abs) ? abs : null;
  }

  /** Perfil completo del usuario del token: cuenta + datos personales + accesos. */
  async get(user: AuthUser) {
    const [cuenta, staff] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: user.id },
        select: { id: true, email: true, name: true, isActive: true, createdAt: true, whatsappPhone: true, sedesAccede: true, cajaLegacyId: true },
      }),
      this.staffDe(user.email),
    ]);
    if (!cuenta) throw new NotFoundException('La cuenta ya no existe.');

    const roles = await this.prisma.userRole.findMany({
      where: { userId: user.id },
      include: { role: { select: { key: true, name: true, description: true } } },
    });

    // Permisos efectivos ya resueltos por el guard (rol ∪ ALLOW − DENY): aquí
    // sólo se agrupan con su etiqueta para poder pintarlos.
    const concedidos = new Set(user.permissions);
    const grupos = new Map<string, { group: string; items: { key: string; label: string }[] }>();
    for (const p of ALL_PERMISSIONS) {
      if (!concedidos.has(p.key)) continue;
      let g = grupos.get(p.group);
      if (!g) { g = { group: p.group, items: [] }; grupos.set(p.group, g); }
      g.items.push({ key: p.key, label: p.label });
    }

    // Lista vacía de sedes = SIN restricción (ve todas), no "ninguna".
    const sedes = cuenta.sedesAccede.length
      ? await this.prisma.branch.findMany({ where: { legacyId: { in: cuenta.sedesAccede } }, select: { legacyId: true, name: true } })
      : [];
    const caja = cuenta.cajaLegacyId != null
      ? await this.prisma.cashAccount.findFirst({ where: { legacyId: cuenta.cajaLegacyId }, select: { holder: true } })
      : null;

    return {
      account: {
        id: cuenta.id,
        email: cuenta.email,
        name: cuenta.name,
        isActive: cuenta.isActive,
        createdAt: cuenta.createdAt,
        whatsappPhone: cuenta.whatsappPhone,
      },
      /** null = la cuenta no tiene empleado vinculado por correo. */
      staff: staff
        ? {
            id: staff.id,
            name: staff.name,
            docNumber: staff.docNumber,
            phone: staff.phone,
            phoneAlt: staff.phoneAlt,
            address: staff.address,
            city: staff.city,
            region: staff.region,
            country: staff.country,
            rh: staff.rh,
            eps: staff.eps,
            pension: staff.pension,
            // Sólo lectura: los fija RRHH desde la ficha del empleado.
            area: staff.area?.name ?? null,
            entryDate: staff.entryDate,
            lastLogin: staff.lastLogin,
          }
        : null,
      hasPhoto: (await this.rutaFoto(user)) != null,
      access: {
        isSuperadmin: concedidos.has(SUPERADMIN_PERMISSION),
        roles: roles.map((r) => ({ key: r.role.key, name: r.role.name, description: r.role.description })),
        permissionCount: concedidos.size,
        groups: [...grupos.values()],
        /** Vacío = acceso a TODAS las sedes. */
        sedes,
        caja: caja?.holder ?? null,
      },
    };
  }

  /** Últimos accesos de la propia cuenta (bitácora de login). */
  async logins(user: AuthUser) {
    const rows = await this.prisma.auditLog.findMany({
      where: { userId: user.id, entity: 'Auth', action: { in: ['LOGIN', 'LOGIN_FAILED'] } },
      orderBy: { createdAt: 'desc' },
      take: 15,
      select: { id: true, action: true, ipAddress: true, createdAt: true },
    });
    return rows;
  }

  /** Actualiza los datos personales propios. Exige empleado vinculado. */
  async update(user: AuthUser, dto: UpdateProfileDto) {
    const staff = await this.staffDe(user.email);
    if (!staff) {
      throw new BadRequestException(
        'Tu cuenta no tiene una ficha de empleado vinculada, así que no hay datos personales que editar. Pídele a sistemas que la vincule por correo.',
      );
    }

    // Cadena vacía = el usuario borró el campo → NULL. `undefined` = no se tocó.
    const str = (v: string | undefined) => (v === undefined ? undefined : v.trim() === '' ? null : v.trim());

    const data: Prisma.StaffUpdateInput = {
      docNumber: str(dto.docNumber), phone: str(dto.phone), phoneAlt: str(dto.phoneAlt),
      address: str(dto.address), city: str(dto.city), region: str(dto.region), country: str(dto.country),
      rh: str(dto.rh), eps: str(dto.eps), pension: str(dto.pension),
    };
    const nombre = dto.name?.trim();
    if (dto.name !== undefined) {
      if (!nombre) throw new BadRequestException('El nombre no puede quedar vacío.');
      data.name = nombre;
    }

    await this.prisma.staff.update({ where: { id: staff.id }, data });
    // El nombre vive en dos sitios (la ficha y la cuenta) y el que se ve en el
    // menú es el de la cuenta: cambiar sólo uno deja el perfil diciendo una cosa
    // y el sidebar otra.
    if (nombre && nombre !== user.name) {
      await this.prisma.user.update({ where: { id: user.id }, data: { name: nombre } });
    }

    void this.audit.record({
      userId: user.id, action: 'profile.update', entity: 'Staff', entityId: staff.id,
      before: { name: staff.name, phone: staff.phone, address: staff.address, city: staff.city },
      after: { name: nombre ?? staff.name, phone: dto.phone, address: dto.address, city: dto.city },
    });

    return this.get({ ...user, name: nombre ?? user.name });
  }

  /**
   * Cambia la propia contraseña verificando la actual (como `user/updatepassword`
   * del legacy) y el código de 6 dígitos que llega al WhatsApp.
   *
   * El código es lo que hace que una sesión abierta y sin bloquear no baste para
   * quedarse con la cuenta: quien no tenga el celular del dueño en la mano se
   * queda en la contraseña vieja.
   */
  async changePassword(user: AuthUser, currentPassword: string, newPassword: string, code?: string | null) {
    const cuenta = await this.prisma.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } });
    if (!cuenta) throw new NotFoundException('La cuenta ya no existe.');
    if (!verifyPassword(currentPassword, cuenta.passwordHash)) {
      // 401 y no 400: es un fallo de credenciales, y así el front lo puede
      // distinguir del "la nueva no cumple las reglas".
      throw new UnauthorizedException('La contraseña actual no es correcta.');
    }
    if (currentPassword === newPassword) {
      throw new BadRequestException('La contraseña nueva debe ser distinta de la actual.');
    }
    // Después de la contraseña actual: si se equivocó al teclearla, el código
    // sigue vivo para el siguiente intento en vez de quemarse por nada.
    const rastro = await this.passwordOtp.exigir({ id: user.id, name: user.name, email: user.email }, 'propia', code);

    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: hashPassword(newPassword) } });
    void this.audit.record({
      userId: user.id, action: 'profile.password', entity: 'User', entityId: user.id,
      after: rastro ? { firma: rastro } : undefined,
    });
    return { ok: true };
  }

  /** Manda a mi WhatsApp el código para cambiar mi contraseña. */
  requestPasswordCode(user: AuthUser) {
    return this.passwordOtp.pedir({ id: user.id, name: user.name, email: user.email }, 'propia');
  }

  /** ¿Cambiar mi contraseña va a pedir código, y hay a dónde mandarlo? */
  passwordPolicy(user: AuthUser) {
    return this.passwordOtp.policy({ id: user.id, name: user.name, email: user.email }, 'propia');
  }

  /** Registra la foto recién subida y borra la anterior del disco. */
  async setPhoto(user: AuthUser, archivo: { filename: string; path: string }) {
    const staff = await this.staffDe(user.email);
    if (!staff) {
      try { unlinkSync(archivo.path); } catch { /* noop */ }
      throw new BadRequestException('Tu cuenta no tiene una ficha de empleado vinculada; no hay dónde guardar la foto.');
    }
    const anterior = ProfileService.fotoSegura(staff.picture);
    await this.prisma.staff.update({ where: { id: staff.id }, data: { picture: archivo.filename } });
    if (anterior && anterior !== archivo.filename) {
      try { unlinkSync(join(FOTOS_ROOT, anterior)); } catch { /* ya no estaba */ }
    }
    void this.audit.record({ userId: user.id, action: 'profile.photo', entity: 'Staff', entityId: staff.id });
    return { ok: true };
  }

  /** Quita la foto de perfil (vuelve a las iniciales). */
  async deletePhoto(user: AuthUser) {
    const staff = await this.staffDe(user.email);
    if (!staff) throw new BadRequestException('Tu cuenta no tiene una ficha de empleado vinculada.');
    const actual = ProfileService.fotoSegura(staff.picture);
    await this.prisma.staff.update({ where: { id: staff.id }, data: { picture: null } });
    if (actual) {
      try { unlinkSync(join(FOTOS_ROOT, actual)); } catch { /* ya no estaba */ }
    }
    void this.audit.record({ userId: user.id, action: 'profile.photo.delete', entity: 'Staff', entityId: staff.id });
    return { ok: true };
  }
}
