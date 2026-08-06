import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ForgotCheckDto, ForgotPasswordDto, ForgotResetDto } from './dto/forgot-password.dto';
import { SetRolesDto } from './dto/set-roles.dto';
import { SetScreensDto } from './dto/set-screens.dto';
import { SetActiveDto } from './dto/set-active.dto';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto';
import { APP_PERMISSIONS, ALL_PERMISSIONS } from './permissions.catalog';
import { AuthUser } from './current-user.decorator';

export class AuthController {
  constructor(private readonly auth: AuthService) {}

  login(dto: LoginDto, ip: string) {
    return this.auth.login(dto.email, dto.password, { ip });
  }

  /** Stateless logout — tokens are short-lived; the client drops its cookie. */
  logout() {
    return { ok: true };
  }

  // -- "Olvidé mi contraseña": tres pasos, SIN sesión ------------------------
  //
  // Rutas abiertas: las ve cualquiera que llegue a la IP. Van con el mismo
  // `LoginThrottleGuard` que el login (10 intentos por IP cada 5 min) y comparten
  // su contador a propósito — quien tantea correos aquí es el mismo que tantea
  // claves allá. El servicio responde igual exista o no la cuenta.

  /** ¿El canal de WhatsApp puede entregar códigos? El login lo pregunta antes de ofrecerlo. */
  forgotAvailability() {
    return this.auth.forgotAvailability();
  }

  /** Paso 1: manda el código al WhatsApp vinculado a ese correo. */
  forgotPassword(dto: ForgotPasswordDto, ip: string) {
    return this.auth.forgotPassword(dto.email, ip);
  }

  /** Paso 2: comprueba el código sin gastarlo (aún falta escribir la contraseña). */
  forgotCheck(dto: ForgotCheckDto) {
    return this.auth.forgotCheck(dto.email, dto.code);
  }

  /** Paso 3: gasta el código y escribe la contraseña nueva. */
  forgotReset(dto: ForgotResetDto, ip: string) {
    return this.auth.forgotReset(dto.email, dto.code, dto.password, ip);
  }

  me(user: AuthUser) {
    return user;
  }

  permissions() {
    return ALL_PERMISSIONS;
  }

  // -- user & role administration (system.users.manage / superadmin) ---------

  listUsers() {
    return this.auth.listUsers();
  }

  /**
   * Lista mínima (id + nombre + email) para poblar selectores: responsable de
   * bodega, vincular empleado, etc. Solo requiere sesión — no expone roles ni
   * estado, así que no necesita `system.users.manage`.
   */
  userOptions() {
    return this.auth.listUserOptions();
  }

  /**
   * Sedes disponibles para el selector de "acceso por sede" al crear/editar un
   * usuario. Va aquí y no en `/config/branches` porque aquél exige área `sistemas`,
   * mientras que esta pantalla la usa quien administra usuarios.
   */
  listBranches() {
    return this.auth.listBranches();
  }

  createUser(dto: CreateUserDto) {
    return this.auth.createUser(dto);
  }

  updateUser(id: string, dto: UpdateUserDto) {
    return this.auth.updateUser(id, dto);
  }

  /**
   * ¿Restablecer la contraseña de este usuario va a pedir código, y hay a dónde
   * mandarlo? La pantalla lo consulta al abrir el diálogo para no ofrecer un
   * botón que sabe que va a fallar.
   */
  passwordPolicy(id: string) {
    return this.auth.passwordPolicy(id);
  }

  /** Manda el código de 6 dígitos al WhatsApp DEL DUEÑO de la cuenta. */
  requestPasswordCode(id: string, actor: AuthUser) {
    return this.auth.requestPasswordCode(id, actor);
  }

  resetPassword(id: string, dto: ResetPasswordDto) {
    return this.auth.resetPassword(id, dto.password, { code: dto.code });
  }

  setRoles(id: string, dto: SetRolesDto, actor: AuthUser) {
    return this.auth.setUserRoles(id, dto.roleKeys, actor);
  }

  setActive(id: string, dto: SetActiveDto) {
    return this.auth.setUserActive(id, dto.isActive);
  }

  listRoles() {
    return this.auth.listRoles();
  }

  // -- Constructor de roles (plantillas de permisos) — SOLO superadmin ---------
  // Gestionar plantillas afecta a muchos usuarios y puede conceder acceso total,
  // así que se restringe a `system.admin` (más fuerte que `system.users.manage`).

  createRole(dto: CreateRoleDto) {
    return this.auth.createRole(dto);
  }

  updateRole(id: string, dto: UpdateRoleDto) {
    return this.auth.updateRole(id, dto);
  }

  deleteRole(id: string) {
    return this.auth.deleteRole(id);
  }

  // ── Accesos por pantalla (módulo/submódulo) por empleado ──────────────────

  /** Árbol de pantallas (módulos → submódulos) para el editor de accesos. */
  screenTree() {
    return this.auth.getScreenTree();
  }

  /** Acceso a pantallas de un usuario (baseline del rol, efectivo, overrides). */
  userAccess(id: string) {
    return this.auth.getUserAccess(id);
  }

  /** Fija las pantallas que ve un empleado (calcula overrides vs. su rol). */
  setScreens(id: string, dto: SetScreensDto) {
    return this.auth.setUserScreens(id, dto.screens);
  }
}
