import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ALL_SCOPES, ApiKeysService, CreateApiKeyDto } from './api-keys.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

/** Gestión de claves de la API pública (área sistemas). */
@Controller('admin/api-keys')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('sistemas')
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
