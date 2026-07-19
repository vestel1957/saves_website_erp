import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
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
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  /** Stateless logout — tokens are short-lived; the client drops its cookie. */
  @Post('logout')
  logout() {
    return { ok: true };
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

  @Post('users/:id/password')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.USERS_MANAGE)
  resetPassword(@Param('id') id: string, @Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(id, dto.password);
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
