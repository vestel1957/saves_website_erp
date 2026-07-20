import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Allow, IsBoolean, IsOptional, IsString } from 'class-validator';
import { MikrotikAdminService } from './mikrotik-admin.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequireArea } from '../auth/require-area.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

class RouterUpsertDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() ip?: string;
  @Allow() port?: string | number;
  @IsOptional() @IsString() tech?: string;
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsString() username?: string;
  @IsOptional() @IsString() password?: string;
}
class ToggleSecretDto {
  @IsString() name!: string;
  @IsBoolean() disabled!: boolean;
}
class KickDto {
  @IsString() name!: string;
}

/**
 * Gestión de routers MikroTik — clon de `Mikrotiks.php` (conectar y configurar).
 * Espejo de OltController: CRUD + validación + lecturas/escrituras en vivo (dry-run).
 */
@Controller('network/mikrotik')
@UseGuards(JwtAuthGuard, AreaGuard, PermissionsGuard)
@RequireArea('tecnicos', 'administracion')
export class MikrotikController {
  constructor(private readonly mk: MikrotikAdminService) {}

  // --- Modo / opciones ---
  @Get('mode') mode() { return this.mk.mode(); }
  @Get('branches') branches() { return this.mk.branches(); }

  // --- CRUD de routers ---
  @Get('routers') routers() { return this.mk.listRouters(); }
  @RequirePermissions(APP_PERMISSIONS.NETWORK_ROUTERS_MANAGE)
  @Post('routers') create(@Body() dto: RouterUpsertDto, @CurrentUser() user: AuthUser) { return this.mk.createRouter(dto, user); }
  @RequirePermissions(APP_PERMISSIONS.NETWORK_ROUTERS_MANAGE)
  @Patch('routers/:id') update(@Param('id') id: string, @Body() dto: RouterUpsertDto, @CurrentUser() user: AuthUser) { return this.mk.updateRouter(id, dto, user); }
  @Delete('routers/:id') remove(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.mk.deleteRouter(id, user); }
  @Post('routers/:id/default') setDefault(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.mk.setDefault(id, user); }

  // --- Validación / lecturas en vivo ---
  @Post(':id/test') test(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.mk.testRouter(id, user); }
  @Get(':id/system') system(@Param('id') id: string) { return this.mk.systemInfo(id); }
  @Get(':id/summary') summary(@Param('id') id: string) { return this.mk.summary(id); }
  @Get(':id/secrets') secrets(@Param('id') id: string, @Query('search') search?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.mk.secrets(id, { search, page: Number(page), pageSize: Number(pageSize) });
  }
  @Get(':id/active') active(@Param('id') id: string) { return this.mk.active(id); }
  @Get(':id/ips') ips(@Param('id') id: string) { return this.mk.ips(id); }
  @Get(':id/profiles') profiles(@Param('id') id: string) { return this.mk.profiles(id); }
  @Get(':id/history') history(@Param('id') id: string, @Query('limit') limit?: string) { return this.mk.history(id, Number(limit) || 100); }

  // --- Escrituras (GATE dry-run) ---
  @RequirePermissions(APP_PERMISSIONS.NETWORK_ROUTERS_MANAGE)
  @Post(':id/secret/toggle') toggleSecret(@Param('id') id: string, @Body() dto: ToggleSecretDto, @CurrentUser() user: AuthUser) {
    return this.mk.toggleSecret(id, dto.name, dto.disabled, user);
  }
  @RequirePermissions(APP_PERMISSIONS.NETWORK_ROUTERS_MANAGE)
  @Post(':id/active/kick') kick(@Param('id') id: string, @Body() dto: KickDto, @CurrentUser() user: AuthUser) {
    return this.mk.kickActive(id, dto.name, user);
  }
}
