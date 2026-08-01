import { Body, Controller, Delete, Get, Ip, Param, Patch, Post, UseGuards } from '@nestjs/common';
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
import { JwtAuthGuard } from './jwt-auth.guard';
import { PermissionsGuard } from './permissions.guard';
import { LoginThrottleGuard } from './login-throttle.guard';
import { RequirePermissions } from './require-permissions.decorator';
import { APP_PERMISSIONS, ALL_PERMISSIONS } from './permissions.catalog';
import { CurrentUser, AuthUser } from './current-user.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @UseGuards(LoginThrottleGuard)
  login(@Body() dto: LoginDto, @Ip() ip: string) {
    return this.auth.login(dto.email, dto.password, { ip });
  }

  /** Stateless logout — tokens are short-lived; the client drops its cookie. */
  @Post('logout')
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
  @Get('password/forgot/available')
  forgotAvailability() {
    return this.auth.forgotAvailability();
  }

  /** Paso 1: manda el código al WhatsApp vinculado a ese correo. */
  @Post('password/forgot')
  @UseGuards(LoginThrottleGuard)
  forgotPassword(@Body() dto: ForgotPasswordDto, @Ip() ip: string) {
    return this.auth.forgotPassword(dto.email, ip);
  }

  /** Paso 2: comprueba el código sin gastarlo (aún falta escribir la contraseña). */
  @Post('password/forgot/check')
  @UseGuards(LoginThrottleGuard)
  forgotCheck(@Body() dto: ForgotCheckDto) {
    return this.auth.forgotCheck(dto.email, dto.code);
  }

  /** Paso 3: gasta el código y escribe la contraseña nueva. */
  @Post('password/forgot/reset')
  @UseGuards(LoginThrottleGuard)
  forgotReset(@Body() dto: ForgotResetDto, @Ip() ip: string) {
    return this.auth.forgotReset(dto.email, dto.code, dto.password, ip);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  @Get('permissions')
  @UseGuards(JwtAuthGuard)
  permissions() {
    return ALL_PERMISSIONS;
  }

  // -- user & role administration (system.users.manage / superadmin) ---------

  @Get('users')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.USERS_MANAGE)
  listUsers() {
    return this.auth.listUsers();
  }

  /**
   * Lista mínima (id + nombre + email) para poblar selectores: responsable de
   * bodega, vincular empleado, etc. Solo requiere sesión — no expone roles ni
   * estado, así que no necesita `system.users.manage`.
   */
  @Get('users/options')
  @UseGuards(JwtAuthGuard)
  userOptions() {
    return this.auth.listUserOptions();
  }

  /**
   * Sedes disponibles para el selector de "acceso por sede" al crear/editar un
   * usuario. Va aquí y no en `/config/branches` porque aquél exige área `sistemas`,
   * mientras que esta pantalla la usa quien administra usuarios.
   */
  @Get('branches')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.USERS_MANAGE)
  listBranches() {
    return this.auth.listBranches();
  }

  @Post('users')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.USERS_MANAGE)
  createUser(@Body() dto: CreateUserDto) {
    return this.auth.createUser(dto);
  }

  @Patch('users/:id')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.USERS_MANAGE)
  updateUser(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.auth.updateUser(id, dto);
  }

  /**
   * ¿Restablecer la contraseña de este usuario va a pedir código, y hay a dónde
   * mandarlo? La pantalla lo consulta al abrir el diálogo para no ofrecer un
   * botón que sabe que va a fallar.
   */
  @Get('users/:id/password/policy')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.USERS_MANAGE)
  passwordPolicy(@Param('id') id: string) {
    return this.auth.passwordPolicy(id);
  }

  /** Manda el código de 6 dígitos al WhatsApp DEL DUEÑO de la cuenta. */
  @Post('users/:id/password/code')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.USERS_MANAGE)
  requestPasswordCode(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.auth.requestPasswordCode(id, actor);
  }

  @Post('users/:id/password')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.USERS_MANAGE)
  resetPassword(@Param('id') id: string, @Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(id, dto.password, { code: dto.code });
  }

  @Patch('users/:id/roles')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.USERS_MANAGE)
  setRoles(@Param('id') id: string, @Body() dto: SetRolesDto, @CurrentUser() actor: AuthUser) {
    return this.auth.setUserRoles(id, dto.roleKeys, actor);
  }

  @Patch('users/:id/active')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.USERS_MANAGE)
  setActive(@Param('id') id: string, @Body() dto: SetActiveDto) {
    return this.auth.setUserActive(id, dto.isActive);
  }

  @Get('roles')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.USERS_MANAGE)
  listRoles() {
    return this.auth.listRoles();
  }

  // -- Constructor de roles (plantillas de permisos) — SOLO superadmin ---------
  // Gestionar plantillas afecta a muchos usuarios y puede conceder acceso total,
  // así que se restringe a `system.admin` (más fuerte que `system.users.manage`).

  @Post('roles')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.SYSTEM_ADMIN)
  createRole(@Body() dto: CreateRoleDto) {
    return this.auth.createRole(dto);
  }

  @Patch('roles/:id')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.SYSTEM_ADMIN)
  updateRole(@Param('id') id: string, @Body() dto: UpdateRoleDto) {
    return this.auth.updateRole(id, dto);
  }

  @Delete('roles/:id')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.SYSTEM_ADMIN)
  deleteRole(@Param('id') id: string) {
    return this.auth.deleteRole(id);
  }

  // ── Accesos por pantalla (módulo/submódulo) por empleado ──────────────────

  /** Árbol de pantallas (módulos → submódulos) para el editor de accesos. */
  @Get('screens')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.USERS_MANAGE)
  screenTree() {
    return this.auth.getScreenTree();
  }

  /** Acceso a pantallas de un usuario (baseline del rol, efectivo, overrides). */
  @Get('users/:id/access')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.USERS_MANAGE)
  userAccess(@Param('id') id: string) {
    return this.auth.getUserAccess(id);
  }

  /** Fija las pantallas que ve un empleado (calcula overrides vs. su rol). */
  @Patch('users/:id/screens')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.USERS_MANAGE)
  setScreens(@Param('id') id: string, @Body() dto: SetScreensDto) {
    return this.auth.setUserScreens(id, dto.screens);
  }
}
