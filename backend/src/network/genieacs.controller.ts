import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ArrayNotEmpty, Allow, IsArray, IsOptional, IsString } from 'class-validator';
import { GenieacsService } from './genieacs.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

class ServerUpsertDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() nbiUrl?: string;
  @IsOptional() @IsString() username?: string;
  @IsOptional() @IsString() password?: string;
  @Allow() sedeLegacy?: number | string;
}
class BatchDto {
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) ids!: string[];
  @IsOptional() @IsString() serverId?: string;
}
class RefreshDto {
  @IsString() deviceId!: string;
  @IsOptional() @IsString() objectName?: string;
  @IsOptional() @IsString() serverId?: string;
}

/** Integración GenieACS / TR-069 — cortes masivos de TV vía NBI (tag + provision). */
@Controller('network/genieacs')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('tecnicos', 'administracion')
export class GenieacsController {
  constructor(private readonly acs: GenieacsService) {}

  // --- Modo / lecturas ---
  @Get('mode') mode() { return this.acs.mode(); }
  @Get('dashboard') dashboard(@Query('serverId') serverId?: string) { return this.acs.dashboard(serverId); }
  @Get('inventory')
  inventory(
    @Query('serverId') serverId?: string, @Query('search') search?: string,
    @Query('model') model?: string, @Query('estado') estado?: string,
    @Query('page') page?: string, @Query('pageSize') pageSize?: string,
  ) {
    return this.acs.inventory({ serverId, search, model, estado, page: Number(page), pageSize: Number(pageSize) });
  }
  @Get('history') history(@Query('serverId') serverId?: string, @Query('limit') limit?: string) {
    return this.acs.history(serverId, Number(limit) || 100);
  }

  // --- CRUD de servidores ---
  @Get('servers') servers() { return this.acs.listServers(); }
  @Post('servers') create(@Body() dto: ServerUpsertDto, @CurrentUser() user: AuthUser) { return this.acs.createServer(dto, user); }
  @Patch('servers/:id') update(@Param('id') id: string, @Body() dto: ServerUpsertDto, @CurrentUser() user: AuthUser) { return this.acs.updateServer(id, dto, user); }
  @Delete('servers/:id') remove(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.acs.deleteServer(id, user); }
  @Post('servers/:id/default') setDefault(@Param('id') id: string) { return this.acs.setDefault(id); }
  @Post('servers/:id/test') test(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.acs.testConnection(id, user); }

  // --- Escrituras (GATE dry-run) ---
  @Post('cut-tv') cutTv(@Body() dto: BatchDto, @CurrentUser() user: AuthUser) { return this.acs.cutTv(dto.ids, user, dto.serverId); }
  @Post('restore-tv') restoreTv(@Body() dto: BatchDto, @CurrentUser() user: AuthUser) { return this.acs.restoreTv(dto.ids, user, dto.serverId); }
  @Post('refresh') refresh(@Body() dto: RefreshDto, @CurrentUser() user: AuthUser) { return this.acs.refresh(dto.deviceId, dto.objectName ?? '', dto.serverId, user); }
  @Post('install-provision') install(@Body('serverId') serverId?: string, @CurrentUser() user?: AuthUser) { return this.acs.installProvision(serverId, user); }
}
