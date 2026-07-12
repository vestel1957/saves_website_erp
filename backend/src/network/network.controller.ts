import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { IsArray, IsOptional, IsString, ArrayNotEmpty } from 'class-validator';
import { NetworkService } from './network.service';
import { NetworkWriteService, EquipTransferDto, AssignPortDto, AssignEquipmentSubDto, CreateEquipmentDto, CreateNapDto, CreateVlanDto, RejectTransferDto, UpdateNapDto } from './network-write.service';
import { MikrotikService } from './mikrotik.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequireArea } from '../auth/require-area.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { INV_PERMISSIONS, APP_PERMISSIONS } from '../auth/permissions.catalog';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

class BatchIdsDto {
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) ids!: string[];
}
class MessageBatchDto {
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) ids!: string[];
  @IsString() message!: string;
}
class RestoreBranchDto {
  @IsOptional() @IsArray() @IsString({ each: true }) statuses?: string[];
}

/** Red / ISP: Mikrotik, OLT/ONU, NAP, equipos (migrado de saves-vestel). */
@Controller('network')
@UseGuards(JwtAuthGuard, AreaGuard, PermissionsGuard)
@RequireArea('tecnicos', 'administracion')
export class NetworkController {
  constructor(
    private readonly network: NetworkService,
    private readonly write: NetworkWriteService,
    private readonly mikrotik: MikrotikService,
  ) {}

  // --- Corte / reconexión real contra el Mikrotik ---
  /** Modo de operación: live (real) o dry-run (simulación segura). */
  @Get('mikrotik/mode') mikrotikMode() {
    return { live: this.mikrotik.isLive, mode: this.mikrotik.isLive ? 'LIVE' : 'DRY_RUN' };
  }
  @Post('subscribers/:id/cut') cut(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.mikrotik.cut(id, user);
  }
  @Post('subscribers/:id/reconnect') reconnect(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.mikrotik.reconnect(id, user);
  }
  @Post('subscribers/:id/provision') provision(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.mikrotik.provision(id, user);
  }
  @Get('subscribers/:id/connection') connection(@Param('id') id: string) {
    return this.mikrotik.liveStatus(id);
  }
  @Get('subscribers/:id/mikrotik-history') mikrotikHistory(@Param('id') id: string) {
    return this.mikrotik.history(id);
  }
  @Post('mikrotiks/:id/test') testMikrotik(@Param('id') id: string) {
    return this.mikrotik.testRouter(id);
  }
  @Post('cut-batch') cutBatch(@Body() dto: BatchIdsDto, @CurrentUser() user: AuthUser) {
    return this.mikrotik.cutBatch(dto.ids, user);
  }
  @Post('reconnect-batch') reconnectBatch(@Body() dto: BatchIdsDto, @CurrentUser() user: AuthUser) {
    return this.mikrotik.reconnectBatch(dto.ids, user);
  }
  @Post('message-batch') messageBatch(@Body() dto: MessageBatchDto, @CurrentUser() user: AuthUser) {
    return this.mikrotik.messageBatch(dto.ids, dto.message, user);
  }

  // --- Escritura: transferencias de equipos y conexiones ---
  // Lectura de transferencias: además de técnicos/administración, la ve caja
  // (para recibir en su sede). Aprobar/despachar y recibir van gateados aparte.
  @Get('transfers') @RequireArea('tecnicos', 'administracion', 'caja')
  transfers(@Query('page') page?: string, @Query('pageSize') pageSize?: string, @Query('search') search?: string, @Query('status') status?: string, @Query('warehouseId') warehouseId?: string) { return this.write.transfers({ page: Number(page), pageSize: Number(pageSize), search, status, warehouseId }); }
  @Get('transfers/:id') @RequireArea('tecnicos', 'administracion', 'caja')
  transferDetail(@Param('id') id: string) { return this.write.transferDetail(id); }
  @Post('transfers') createTransfer(@Body() dto: EquipTransferDto, @CurrentUser() user: AuthUser) { return this.write.createTransfer(dto, user); }
  // Aprobar/despachar y rechazar: reservado a inventario (Jefe de bodega,
  // inventory.admin). @RequireArea() vacío desactiva el AreaGuard de clase para
  // que el gateo lo haga PermissionsGuard por permiso (no por área).
  @Post('transfers/:id/approve') @RequireArea() @RequirePermissions(INV_PERMISSIONS.ADMIN)
  approveTransfer(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.write.approveTransfer(id, user); }
  @Post('transfers/:id/reject') @RequireArea() @RequirePermissions(INV_PERMISSIONS.ADMIN)
  rejectTransfer(@Param('id') id: string, @Body() dto: RejectTransferDto, @CurrentUser() user: AuthUser) { return this.write.rejectTransfer(id, user, dto.reason); }
  // Recepción en la sede destino: reservado a caja (área caja).
  @Post('transfers/:id/receive') @RequireArea() @RequirePermissions(APP_PERMISSIONS.AREA_CAJA)
  receiveTransfer(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.write.receiveTransfer(id, user); }

  @Get('ports')
  ports(@Query('search') search?: string, @Query('status') status?: string, @Query('napId') napId?: string, @Query('branchId') branchId?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.write.ports({ search, status, napId, branchId, page: Number(page), pageSize: Number(pageSize) });
  }
  @Get('nap-options') napOptions(@Query('branchId') branchId?: string) { return this.write.napOptions(branchId); }
  @Post('ports/:id/assign') assignPort(@Param('id') id: string, @Body() dto: AssignPortDto) { return this.write.assignPort(id, dto); }
  @Post('ports/:id/free') freePort(@Param('id') id: string) { return this.write.freePort(id); }

  @Get('equipment-warehouses') equipmentWarehouses() { return this.write.equipmentWarehouses(); }
  @Post('equipment') createEquipment(@Body() dto: CreateEquipmentDto, @CurrentUser() user: AuthUser) { return this.write.createEquipment(dto, user); }

  @Get('stats') stats() { return this.network.stats(); }
  @Get('mikrotiks') mikrotiks() { return this.network.mikrotiks(); }
  @Get('olts') olts() { return this.network.olts(); }
  @Get('warehouses') warehouses() { return this.network.warehouses(); }
  @Get('ip-pools') ipPools(@Query('search') search?: string) { return this.network.ipPools({ search }); }
  @Get('branches') branches() { return this.network.branches(); }
  @Get('vlans') vlans(@Query('branchId') branchId?: string) { return this.network.vlans(branchId); }

  @Get('onus')
  onus(@Query('search') search?: string, @Query('oltId') oltId?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.network.onus({ search, oltId, page: Number(page), pageSize: Number(pageSize) });
  }

  @Get('naps')
  naps(@Query('search') search?: string, @Query('branchId') branchId?: string, @Query('sort') sort?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.network.naps({ search, branchId, sort, page: Number(page), pageSize: Number(pageSize) });
  }
  @Get('naps/:id') napById(@Param('id') id: string) { return this.network.napById(id); }
  @Post('naps') createNap(@Body() dto: CreateNapDto) { return this.write.createNap(dto); }
  @Patch('naps/:id') updateNap(@Param('id') id: string, @Body() dto: UpdateNapDto) { return this.write.updateNap(id, dto); }
  @Delete('naps/:id') deleteNap(@Param('id') id: string) { return this.write.deleteNap(id); }

  // --- VLANs (CRUD) ---
  @Post('vlans') createVlan(@Body() dto: CreateVlanDto) { return this.write.createVlan(dto); }
  @Patch('vlans/:id') updateVlan(@Param('id') id: string, @Body() dto: CreateVlanDto) { return this.write.updateVlan(id, dto); }
  @Delete('vlans/:id') deleteVlan(@Param('id') id: string) { return this.write.deleteVlan(id); }

  // --- Asignar / desasignar equipo a cliente ---
  @Post('equipment/:id/assign') assignEquipment(@Param('id') id: string, @Body() dto: AssignEquipmentSubDto) { return this.write.assignEquipmentToSubscriber(id, dto); }
  @Post('equipment/:id/unassign') unassignEquipment(@Param('id') id: string) { return this.write.unassignEquipment(id); }

  // --- Restaurar / sincronizar PPP masivo de una sede (recuperación ante formateo) ---
  @Post('mikrotik/restore-branch/:branchId')
  restoreBranch(@Param('branchId') branchId: string, @Body() dto: RestoreBranchDto, @CurrentUser() user: AuthUser) {
    return this.mikrotik.restoreBranch(branchId, { statuses: dto.statuses }, user);
  }

  @Get('equipment')
  equipment(
    @Query('search') search?: string, @Query('status') status?: string, @Query('warehouseId') warehouseId?: string,
    @Query('assigned') assigned?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string,
  ) {
    return this.network.equipment({ search, status, warehouseId, assigned, page: Number(page), pageSize: Number(pageSize) });
  }
}
