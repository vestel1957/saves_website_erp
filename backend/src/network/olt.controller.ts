import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Allow, IsOptional, IsString } from 'class-validator';
import { OltService } from './olt.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

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
}
class OnuActionDto {
  @Allow() frame?: number | string;
  @Allow() slot!: number | string;
  @Allow() port!: number | string;
  @Allow() ont_id!: number | string;
  @IsOptional() @IsString() sn?: string;
}
class LinkDto {
  @IsOptional() @IsString() subscriberId?: string | null;
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
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('tecnicos', 'administracion')
export class OltController {
  constructor(private readonly olt: OltService) {}

  // --- Modo / inventario / dashboard (lectura BD) ---
  @Get('mode') mode() { return this.olt.mode(); }
  @Get('dashboard') dashboard() { return this.olt.dashboard(); }
  @Get('inventory')
  inventory(
    @Query('search') search?: string, @Query('oltId') oltId?: string,
    @Query('estado') estado?: string, @Query('senal') senal?: string, @Query('cliente') cliente?: string,
    @Query('page') page?: string, @Query('pageSize') pageSize?: string,
  ) {
    return this.olt.inventory({ search, oltId, estado, senal, cliente, page: Number(page), pageSize: Number(pageSize) });
  }
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
  @Patch('olts/:id') update(@Param('id') id: string, @Body() dto: OltUpsertDto, @CurrentUser() user: AuthUser) { return this.olt.updateOlt(id, dto, user); }
  @Delete('olts/:id') remove(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.olt.deleteOlt(id, user); }
  @Post('olts/:id/default') setDefault(@Param('id') id: string) { return this.olt.setDefault(id); }

  // --- Lecturas en vivo (SSH) ---
  @Post(':id/test') test(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.olt.testConnection(id, user); }
  @Get(':id/system') system(@Param('id') id: string) { return this.olt.systemInfo(id); }
  @Get(':id/boards') boards(@Param('id') id: string, @Query('frame') frame?: string) { return this.olt.boards(id, Number(frame) || 0); }
  @Get(':id/autofind') autofind(@Param('id') id: string) { return this.olt.autofind(id); }
  @Get(':id/profiles') profiles(@Param('id') id: string) { return this.olt.profiles(id); }
  @Post(':id/onus') onus(@Param('id') id: string, @Body() dto: OnusQueryDto) {
    return this.olt.onus(id, Number(dto.frame) || 0, Number(dto.slot), Number(dto.port));
  }
  @Post(':id/slot-summary') slotSummary(@Param('id') id: string, @Body() dto: SlotDto) {
    return this.olt.slotSummary(id, Number(dto.frame) || 0, Number(dto.slot));
  }
  @Post(':id/onu/detail') detail(@Param('id') id: string, @Body() dto: OnuActionDto) {
    return this.olt.ontDetail(id, Number(dto.frame) || 0, Number(dto.slot), Number(dto.port), Number(dto.ont_id));
  }
  @Post(':id/onu/find') find(@Param('id') id: string, @Body('sn') sn: string) { return this.olt.findBySn(id, sn); }

  // --- Escrituras (GATE dry-run) ---
  @Post(':id/onu/provision') provision(@Param('id') id: string, @Body() dto: ProvisionDto, @CurrentUser() user: AuthUser) {
    return this.olt.provision(id, dto, user);
  }
  @Post(':id/onu/reboot') reboot(@Param('id') id: string, @Body() dto: OnuActionDto, @CurrentUser() user: AuthUser) {
    return this.olt.reboot(id, dto, user);
  }
  @Post(':id/onu/delete') deleteOnu(@Param('id') id: string, @Body() dto: OnuActionDto, @CurrentUser() user: AuthUser) {
    return this.olt.remove(id, dto, user);
  }

  // --- Inventario: sincronizar un slot ---
  @Post(':id/sync') sync(@Param('id') id: string, @Body() dto: SlotDto, @CurrentUser() user: AuthUser) {
    return this.olt.syncSlot(id, Number(dto.frame) || 0, Number(dto.slot), user);
  }
}
