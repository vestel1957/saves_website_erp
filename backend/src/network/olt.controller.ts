import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Allow, IsOptional, IsString } from 'class-validator';
import { OltService } from './olt.service';
import { OltPlanProfileService } from './olt-plan-profile.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequireArea } from '../auth/require-area.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { ModuloRedGuard } from './modulo-red.guard';

// Campos numéricos que llegan como número o string desde el front → @Allow()
// para que el ValidationPipe (whitelist) no los descarte; el service los castea.
class OnusQueryDto {
  @Allow() frame?: number | string;
  @Allow() slot!: number | string;
  @Allow() port!: number | string;
}
class SlotDto {
  @Allow() frame?: number | string;
  @Allow() slot!: number | string;
  /** Salta la caché del resumen de slot (recorre los 16 puertos de verdad). */
  @Allow() refresh?: boolean;
}
class ProvisionDto {
  @Allow() frame?: number | string;
  @Allow() slot!: number | string;
  @Allow() port!: number | string;
  @Allow() ont_id?: number | string;
  @IsString() sn!: string;
  @Allow() lineprofile!: number | string;
  @Allow() srvprofile!: number | string;
  @IsOptional() @IsString() desc?: string;
  @Allow() vlan?: number | string;
  @Allow() gemport?: number | string;
  @Allow() user_vlan?: number | string;
  /** Índices de traffic-table: `inbound`/RX = bajada del abonado, `outbound`/TX = subida. */
  @Allow() traffic_in?: number | string;
  @Allow() traffic_out?: number | string;
}
class OnuActionDto {
  @Allow() frame?: number | string;
  @Allow() slot!: number | string;
  @Allow() port!: number | string;
  @Allow() ont_id!: number | string;
  @IsOptional() @IsString() sn?: string;
  /** Al eliminar: quita antes los service-ports que bloquean el borrado. */
  @Allow() force?: boolean;
}
class LinkDto {
  @IsOptional() @IsString() subscriberId?: string | null;
}
class OnuDescDto {
  @Allow() frame?: number | string;
  @Allow() slot!: number | string;
  @Allow() port!: number | string;
  @Allow() ont_id!: number | string;
  @IsOptional() @IsString() sn?: string;
  @IsOptional() @IsString() desc?: string;
}
class CatvStateDto {
  @IsString() sn!: string;
}
class CatvSetDto {
  @IsString() sn!: string;
  @Allow() catvPort?: number | string;
  @Allow() enable!: boolean;
}
/** Velocidad (y overrides) que le corresponde a un plan en una OLT. */
class PlanOltProfileDto {
  @IsString() planId!: string;
  /** null/vacío = default para TODAS las OLTs; concreto = override de esa OLT. */
  @IsOptional() @IsString() oltId?: string | null;
  @Allow() trafficIn?: number | string | null;
  @Allow() trafficOut?: number | string | null;
  @Allow() lineprofile?: number | string | null;
  @Allow() srvprofile?: number | string | null;
  @Allow() vlan?: number | string | null;
  @Allow() gemport?: number | string | null;
  @Allow() userVlan?: number | string | null;
}
/** Varias velocidades de golpe: lo que se confirma tras deducir de la planta. */
class PlanOltProfileLoteDto {
  @IsOptional() @IsString() oltId?: string | null;
  @Allow() filas!: { planId: string; trafficIn?: number | null; trafficOut?: number | null }[];
}
class OltUpsertDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() brand?: string;
  @IsOptional() @IsString() ip?: string;
  @Allow() port?: string | number;
  @IsOptional() @IsString() tech?: string;
  @Allow() sedeLegacy?: number | string;
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsString() username?: string;
  @IsOptional() @IsString() password?: string;
  @Allow() defaultLineProfile?: number | string;
  @Allow() defaultSrvProfile?: number | string;
  @Allow() defaultVlan?: number | string;
  @Allow() defaultGemport?: number | string;
  @Allow() defaultUserVlan?: number | string;
}

/** Gestión OLT — clon SmartOLT (control total de ONUs por SSH). */
@Controller('network/olt')
@UseGuards(JwtAuthGuard, AreaGuard, PermissionsGuard, ModuloRedGuard)
@RequireArea('tecnicos', 'administracion')
export class OltController {
  constructor(
    private readonly olt: OltService,
    private readonly planProfiles: OltPlanProfileService,
  ) {}

  // --- Velocidad por plan (PlanOltProfile) ---
  // Va ANTES de las rutas `:id/...` por claridad: es configuración del catálogo,
  // no una operación contra un equipo concreto.
  /** Tablero de mapeo plan → traffic-tables, con candidatas sugeridas por las megas del nombre. */
  @Get('plan-profiles') planProfilesList(@Query('oltId') oltId?: string) {
    return this.planProfiles.tablero(oltId || null);
  }
  @RequirePermissions(APP_PERMISSIONS.NETWORK_OLT_MANAGE)
  @Post('plan-profiles') planProfileSave(@Body() dto: PlanOltProfileDto) {
    return this.planProfiles.guardar(dto as any);
  }
  @RequirePermissions(APP_PERMISSIONS.NETWORK_OLT_MANAGE)
  @Delete('plan-profiles/:planId') planProfileDelete(@Param('planId') planId: string, @Query('oltId') oltId?: string) {
    return this.planProfiles.borrar(planId, oltId || null);
  }
  /**
   * Deduce el mapeo mirando con qué velocidad están funcionando ya los abonados
   * de cada plan. Es una lectura larga (un comando por puerto PON con abonados).
   */
  @Get('plan-profiles/deducir') planProfilesDeducir(@Query('oltId') oltId: string) {
    return this.planProfiles.deducirDePlanta(oltId);
  }
  /** Guarda de una vez las propuestas que el operador confirmó. */
  @RequirePermissions(APP_PERMISSIONS.NETWORK_OLT_MANAGE)
  @Post('plan-profiles/lote') planProfilesLote(@Body() dto: PlanOltProfileLoteDto) {
    return this.planProfiles.guardarLote(dto.oltId || null, dto.filas ?? []);
  }

  // --- Modo / inventario / dashboard (lectura BD) ---
  @Get('mode') mode() { return this.olt.mode(); }
  @Get('dashboard') dashboard() { return this.olt.dashboard(); }
  @Get('inventory')
  inventory(
    @Query('search') search?: string, @Query('oltId') oltId?: string,
    @Query('estado') estado?: string, @Query('senal') senal?: string, @Query('cliente') cliente?: string,
    @Query('page') page?: string, @Query('pageSize') pageSize?: string,
    @Query('sortBy') sortBy?: string, @Query('sortDir') sortDir?: string,
  ) {
    return this.olt.inventory({ search, oltId, estado, senal, cliente, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir });
  }
  /** Historial de acciones (autenticaciones, borrados…): solo administración y superadmin. */
  @RequirePermissions(APP_PERMISSIONS.AREA_ADMINISTRACION)
  @Get('history') history(@Query('oltId') oltId?: string, @Query('limit') limit?: string) {
    return this.olt.history(oltId, Number(limit) || 100);
  }
  @Get('subscribers') subscribers(@Query('q') q: string) { return this.olt.searchSubscribers(q); }
  @Post('onus/:onuId/link') link(@Param('onuId') onuId: string, @Body() dto: LinkDto, @CurrentUser() user: AuthUser) {
    return this.olt.linkCustomer(onuId, dto.subscriberId ?? null, user);
  }

  // --- CRUD de OLTs ---
  @Get('olts') olts() { return this.olt.listOlts(); }
  @Post('olts') create(@Body() dto: OltUpsertDto, @CurrentUser() user: AuthUser) { return this.olt.createOlt(dto, user); }
  @RequirePermissions(APP_PERMISSIONS.NETWORK_OLT_MANAGE)
  @Patch('olts/:id') update(@Param('id') id: string, @Body() dto: OltUpsertDto, @CurrentUser() user: AuthUser) { return this.olt.updateOlt(id, dto, user); }
  @Delete('olts/:id') remove(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.olt.deleteOlt(id, user); }
  @Post('olts/:id/default') setDefault(@Param('id') id: string) { return this.olt.setDefault(id); }

  // --- Lecturas en vivo (SSH) ---
  // `refresh=1` salta la caché (10 min) de las lecturas que casi no cambian.
  @Post(':id/test') test(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.olt.testConnection(id, user); }
  @Get(':id/system') system(@Param('id') id: string, @Query('refresh') refresh?: string) { return this.olt.systemInfo(id, refresh === '1'); }
  @Get(':id/boards') boards(@Param('id') id: string, @Query('frame') frame?: string, @Query('refresh') refresh?: string) { return this.olt.boards(id, Number(frame) || 0, refresh === '1'); }
  @Get(':id/autofind') autofind(@Param('id') id: string) { return this.olt.autofind(id); }
  @Get(':id/profiles') profiles(@Param('id') id: string, @Query('refresh') refresh?: string) { return this.olt.profiles(id, refresh === '1'); }
  @Get(':id/traffic-tables') trafficTables(@Param('id') id: string, @Query('refresh') refresh?: string) { return this.olt.trafficTables(id, refresh === '1'); }
  @Get(':id/sugerencia') sugerencia(
    @Param('id') id: string,
    @Query('frame') frame?: string,
    @Query('slot') slot?: string,
    @Query('port') port?: string,
    @Query('model') model?: string,
  ) {
    return this.olt.sugerencia(id, Number(frame) || 0, Number(slot), Number(port), model);
  }
  @Post(':id/onus') onus(@Param('id') id: string, @Body() dto: OnusQueryDto) {
    return this.olt.onus(id, Number(dto.frame) || 0, Number(dto.slot), Number(dto.port));
  }
  @Post(':id/slot-summary') slotSummary(@Param('id') id: string, @Body() dto: SlotDto) {
    return this.olt.slotSummary(id, Number(dto.frame) || 0, Number(dto.slot), dto.refresh === true);
  }
  @Post(':id/onu/detail') detail(@Param('id') id: string, @Body() dto: OnuActionDto) {
    return this.olt.ontDetail(id, Number(dto.frame) || 0, Number(dto.slot), Number(dto.port), Number(dto.ont_id));
  }
  /** Señal óptica en vivo; el front la pide en segundo plano tras el detalle. */
  @Post(':id/onu/optical') optical(@Param('id') id: string, @Body() dto: OnuActionDto) {
    return this.olt.ontOptical(id, Number(dto.frame) || 0, Number(dto.slot), Number(dto.port), Number(dto.ont_id));
  }
  @Post(':id/onu/find') find(@Param('id') id: string, @Body('sn') sn: string) { return this.olt.findBySn(id, sn); }
  /** Estado del puerto CATV (RF) de una ONT por SN — palanca de TV de las ONTs sin TR-069. */
  @Post(':id/onu/catv-state') catvState(@Param('id') id: string, @Body() dto: CatvStateDto) {
    return this.olt.catvState(id, dto.sn);
  }

  // --- Escrituras (GATE dry-run) ---
  @RequirePermissions(APP_PERMISSIONS.NETWORK_OLT_MANAGE)
  @Post(':id/onu/provision') provision(@Param('id') id: string, @Body() dto: ProvisionDto, @CurrentUser() user: AuthUser) {
    return this.olt.provision(id, dto, user);
  }
  @RequirePermissions(APP_PERMISSIONS.NETWORK_OLT_MANAGE)
  @Post(':id/onu/desc') setDesc(@Param('id') id: string, @Body() dto: OnuDescDto, @CurrentUser() user: AuthUser) {
    return this.olt.setDescription(id, dto, user);
  }
  /** Corta/activa la salida CATV de una ONT por OMCI (ONTs combo sin TR-069). */
  @RequirePermissions(APP_PERMISSIONS.NETWORK_OLT_MANAGE)
  @Post(':id/onu/catv') setCatv(@Param('id') id: string, @Body() dto: CatvSetDto, @CurrentUser() user: AuthUser) {
    return this.olt.setCatv(id, { sn: dto.sn, catvPort: dto.catvPort, enable: dto.enable === true }, user);
  }
  /** Auto-vincula ONUs↔abonados por la descripción sincronizada de la OLT. */
  @RequirePermissions(APP_PERMISSIONS.NETWORK_OLT_MANAGE)
  @Post('auto-link') autoLink(@Body('oltId') oltId: string | undefined, @CurrentUser() user: AuthUser) {
    return this.olt.autoLinkOnus(oltId || undefined, user);
  }
  @RequirePermissions(APP_PERMISSIONS.NETWORK_OLT_MANAGE)
  @Post(':id/onu/reboot') reboot(@Param('id') id: string, @Body() dto: OnuActionDto, @CurrentUser() user: AuthUser) {
    return this.olt.reboot(id, dto, user);
  }
  @RequirePermissions(APP_PERMISSIONS.NETWORK_OLT_MANAGE)
  @Post(':id/onu/delete') deleteOnu(@Param('id') id: string, @Body() dto: OnuActionDto, @CurrentUser() user: AuthUser) {
    return this.olt.remove(id, dto, user);
  }

  // --- Inventario: sincronizar un slot ---
  @Post(':id/sync') sync(@Param('id') id: string, @Body() dto: SlotDto, @CurrentUser() user: AuthUser) {
    return this.olt.syncSlot(id, Number(dto.frame) || 0, Number(dto.slot), user);
  }
}
