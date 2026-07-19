import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { StaffService, CreateStaffDto, UpdateStaffDto, SetStaffPermissionsDto, SetStaffRolesDto, CreateStaffAccountDto, SetStaffAccountActiveDto, ResetStaffPasswordDto } from './staff.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

/** Empleados / RRHH (migrado de saves-vestel). */
@Controller('staff')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('administracion', 'gerencia')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get('stats') stats() { return this.staff.stats(); }
  @Get('areas') areas() { return this.staff.areas(); }
  /** Catálogo de roles disponibles para el selector de la ficha. */
  @Get('role-catalog') roleCatalog() { return this.staff.roleCatalog(); }
  @Get()
  list(@Query('search') search?: string, @Query('role') role?: string, @Query('areaId') areaId?: string, @Query('status') status?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.staff.list({ search, role, areaId, status, page: Number(page), pageSize: Number(pageSize) });
  }
  @Get(':id') detail(@Param('id') id: string) { return this.staff.detail(id); }
  @Post() create(@Body() dto: CreateStaffDto) { return this.staff.create(dto); }
  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateStaffDto, @CurrentUser() actor: AuthUser) { return this.staff.update(id, dto, actor); }

  /** Permisos del empleado (vista): cualquiera con acceso al área los consulta. */
  @Get(':id/permissions') permissions(@Param('id') id: string) { return this.staff.permissions(id); }

  /** Editar los permisos del empleado: EXCLUSIVO del superusuario (system.admin). */
  @Patch(':id/permissions')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.SYSTEM_ADMIN)
  setPermissions(@Param('id') id: string, @Body() dto: SetStaffPermissionsDto, @CurrentUser() actor: AuthUser) {
    return this.staff.setPermissions(id, dto.granted, actor);
  }

  /** Cambiar los roles del empleado: EXCLUSIVO del superusuario (system.admin). */
  @Patch(':id/roles')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.SYSTEM_ADMIN)
  setRoles(@Param('id') id: string, @Body() dto: SetStaffRolesDto, @CurrentUser() actor: AuthUser) {
    return this.staff.setRoles(id, dto.roleKeys, actor);
  }

  /** Crear la cuenta de acceso del empleado: EXCLUSIVO del superusuario. */
  @Post(':id/account')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.SYSTEM_ADMIN)
  createAccount(@Param('id') id: string, @Body() dto: CreateStaffAccountDto, @CurrentUser() actor: AuthUser) {
    return this.staff.createAccount(id, dto, actor);
  }

  /** Habilitar/inhabilitar el acceso: EXCLUSIVO del superusuario. */
  @Patch(':id/account/active')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.SYSTEM_ADMIN)
  setAccountActive(@Param('id') id: string, @Body() dto: SetStaffAccountActiveDto, @CurrentUser() actor: AuthUser) {
    return this.staff.setAccountActive(id, dto.isActive, actor);
  }

  /** Restablecer la contraseña del empleado: EXCLUSIVO del superusuario. */
  @Post(':id/account/password')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(APP_PERMISSIONS.SYSTEM_ADMIN)
  resetPassword(@Param('id') id: string, @Body() dto: ResetStaffPasswordDto, @CurrentUser() actor: AuthUser) {
    return this.staff.resetAccountPassword(id, dto.password, actor);
  }

  /** Bitácora de cambios de acceso del empleado (consulta por el área). */
  @Get(':id/audit') audit(@Param('id') id: string) { return this.staff.accessAudit(id); }
}
