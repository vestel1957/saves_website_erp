import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ALL_SCOPES, ApiKeysService, CreateApiKeyDto } from './api-keys.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

/**
 * Gestión de claves de la API pública. Exige `system.admin` (superusuario), NO sólo
 * el área `sistemas`: una clave concede lectura de TODO el padrón con PII y facturación
 * a un tercero fuera de la red, con `ignoreLimits`/`rateLimit:0` incluidos. Un técnico
 * de sistemas —que no tiene permiso sobre clientes ni facturación— no debe poder
 * acuñarse ese acceso. Sólo el superadmin.
 */
@Controller('admin/api-keys')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('system.admin')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get('scopes') scopes() { return { scopes: ALL_SCOPES }; }
  @Get() list() { return this.keys.list(); }

  @Post() create(@Body() dto: CreateApiKeyDto, @CurrentUser() u?: AuthUser) {
    return this.keys.create(dto, u?.name ?? u?.email);
  }

  @Patch(':id') toggle(@Param('id') id: string, @Body() body: { active?: boolean }) {
    return this.keys.setActive(id, !!body?.active);
  }

  @Post(':id/revoke') revoke(@Param('id') id: string) { return this.keys.revoke(id); }
}
