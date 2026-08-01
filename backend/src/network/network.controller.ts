import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { IsArray, IsIn, IsOptional, IsString, ArrayNotEmpty } from 'class-validator';
import { NetworkService } from './network.service';
import { NetworkWriteService, EquipTransferDto, AssignPortDto, AssignEquipmentSubDto, CreateEquipmentDto, CreateIpPoolDto, CreateNapDto, CreateVlanDto, ReceiveTransferDto, RejectTransferDto, SignTransferDto, UpdateIpPoolDto, UpdateNapDto } from './network-write.service';
import { MikrotikService } from './mikrotik.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { OrPermission, RequireArea } from '../auth/require-area.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { INV_PERMISSIONS, APP_PERMISSIONS } from '../auth/permissions.catalog';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { actaPdf } from '../common/pdf/pdf-docs';
import { AbiertoAlTecnico, ModuloRedGuard } from './modulo-red.guard';

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
/** Qué firma se está pidiendo: la salida (sede origen) o la entrada (sede destino). */
class TransferOtpDto {
  @IsIn(['salida', 'entrada']) paso!: 'salida' | 'entrada';
}

/** Red / ISP: Mikrotik, OLT/ONU, NAP, equipos (migrado de saves-vestel). */
@Controller('network')
@UseGuards(JwtAuthGuard, AreaGuard, PermissionsGuard, ModuloRedGuard)
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
  @RequirePermissions(APP_PERMISSIONS.NETWORK_CUT)
  @Post('subscribers/:id/cut') cut(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.mikrotik.cut(id, user);
  }
  @RequirePermissions(APP_PERMISSIONS.NETWORK_RECONNECT)
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
  @RequirePermissions(APP_PERMISSIONS.NETWORK_CUT)
  @Post('cut-batch') cutBatch(@Body() dto: BatchIdsDto, @CurrentUser() user: AuthUser) {
    return this.mikrotik.cutBatch(dto.ids, user);
  }
  @RequirePermissions(APP_PERMISSIONS.NETWORK_RECONNECT)
  @Post('reconnect-batch') reconnectBatch(@Body() dto: BatchIdsDto, @CurrentUser() user: AuthUser) {
    return this.mikrotik.reconnectBatch(dto.ids, user);
  }
  @Post('message-batch') messageBatch(@Body() dto: MessageBatchDto, @CurrentUser() user: AuthUser) {
    return this.mikrotik.messageBatch(dto.ids, dto.message, user);
  }

  // --- Escritura: transferencias de equipos y conexiones ---
  // Lectura de transferencias: además de técnicos/administración, la ve caja
  // (para recibir en su sede). Aprobar/despachar y recibir van gateados aparte.
  // El acotado por SEDE lo hace el servicio con el usuario (`bodega-scope.ts`): una
  // cajera solo ve las transferencias que tocan una bodega de sus sedes.
  @Get('transfers') @RequireArea('tecnicos', 'administracion', 'caja') @OrPermission(INV_PERMISSIONS.ADMIN)
  transfers(@CurrentUser() user: AuthUser, @Query('page') page?: string, @Query('pageSize') pageSize?: string, @Query('search') search?: string, @Query('status') status?: string, @Query('warehouseId') warehouseId?: string, @Query('sortBy') sortBy?: string, @Query('sortDir') sortDir?: string) { return this.write.transfers({ page: Number(page), pageSize: Number(pageSize), search, status, warehouseId, sortBy, sortDir }, user); }
  @Get('transfers/:id') @RequireArea('tecnicos', 'administracion', 'caja') @OrPermission(INV_PERMISSIONS.ADMIN)
  transferDetail(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.write.transferDetail(id, user); }
  /** El acta en PDF: la misma que se le manda por WhatsApp a quien debe firmarla. */
  @Get('transfers/:id/pdf') @RequireArea('tecnicos', 'administracion', 'caja') @OrPermission(INV_PERMISSIONS.ADMIN)
  async transferPdf(@Param('id') id: string, @Res() res: Response) {
    const d = await this.write.transferPdfData(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="acta-equipos-${d.numero}.pdf"`);
    actaPdf(res, d);
  }
  // Solicitar una transferencia: caja también (2026-07-30), pero solo dentro de SU
  // sede. Enviar de una sede a otra es del encargado de bodega, y eso lo revalida
  // `createTransfer` (no se puede expresar con un decorador: depende de las bodegas).
  @Post('transfers') @RequireArea('tecnicos', 'administracion', 'caja') @OrPermission(INV_PERMISSIONS.ADMIN)
  createTransfer(@Body() dto: EquipTransferDto, @CurrentUser() user: AuthUser) { return this.write.createTransfer(dto, user); }
  // Aprobar/despachar y rechazar: reservado a inventario (Jefe de bodega,
  // inventory.admin). @RequireArea() vacío desactiva el AreaGuard de clase para
  // que el gateo lo haga PermissionsGuard por permiso (no por área).
  @Post('transfers/:id/approve') @RequireArea() @RequirePermissions(INV_PERMISSIONS.ADMIN)
  approveTransfer(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.write.approveTransfer(id, user); }
  @Post('transfers/:id/reject') @RequireArea() @RequirePermissions(INV_PERMISSIONS.ADMIN)
  rejectTransfer(@Param('id') id: string, @Body() dto: RejectTransferDto, @CurrentUser() user: AuthUser) { return this.write.rejectTransfer(id, user, dto.reason); }
  // --- Firma de la transferencia ENTRE SEDES (código al WhatsApp del firmante) ---
  // Quién puede firmar cada paso lo decide el servicio por la SEDE de la bodega, no
  // por área: la salida la firma la encargada de la sede origen y la entrada quien
  // recibe en destino, y las dos son cajeras. Por eso van con `area.caja`.
  @Post('transfers/:id/otp') @RequireArea() @RequirePermissions(APP_PERMISSIONS.AREA_CAJA)
  pedirCodigo(@Param('id') id: string, @Body() dto: TransferOtpDto, @CurrentUser() user: AuthUser) {
    return this.write.pedirCodigoFirma(id, dto.paso, user);
  }
  @Post('transfers/:id/sign-out') @RequireArea() @RequirePermissions(APP_PERMISSIONS.AREA_CAJA)
  firmarSalida(@Param('id') id: string, @Body() dto: SignTransferDto, @CurrentUser() user: AuthUser) {
    return this.write.firmarSalida(id, dto.code, user);
  }
  // Recepción en la sede destino: reservado a caja (área caja). Entre sedes exige el
  // código; dentro de la sede se recibe con un clic, como siempre.
  @Post('transfers/:id/receive') @RequireArea() @RequirePermissions(APP_PERMISSIONS.AREA_CAJA)
  receiveTransfer(@Param('id') id: string, @Body() dto: ReceiveTransferDto, @CurrentUser() user: AuthUser) { return this.write.receiveTransfer(id, user, dto?.code); }

  @Get('ports')
  ports(@Query('search') search?: string, @Query('status') status?: string, @Query('napId') napId?: string, @Query('branchId') branchId?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string, @Query('sortBy') sortBy?: string, @Query('sortDir') sortDir?: string) {
    return this.write.ports({ search, status, napId, branchId, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir });
  }
  @Get('nap-options') napOptions(@Query('branchId') branchId?: string) { return this.write.napOptions(branchId); }
  @Post('ports/:id/assign') assignPort(@Param('id') id: string, @Body() dto: AssignPortDto) { return this.write.assignPort(id, dto); }
  @Post('ports/:id/free') freePort(@Param('id') id: string) { return this.write.freePort(id); }

  // Las DOS únicas rutas del módulo de red que le quedan al técnico de campo: su
  // "bodega" (= él mismo) y los equipos que están a su nombre. Ver `ModuloRedGuard`.
  @Get('equipment-warehouses') @AbiertoAlTecnico() equipmentWarehouses(@CurrentUser() user?: AuthUser) { return this.write.equipmentWarehouses(user); }
  @Post('equipment') createEquipment(@Body() dto: CreateEquipmentDto, @CurrentUser() user: AuthUser) { return this.write.createEquipment(dto, user); }

  @Get('stats') stats() { return this.network.stats(); }
  @Get('mikrotiks') mikrotiks() { return this.network.mikrotiks(); }
  @Get('olts') olts() { return this.network.olts(); }
  // Caja incluida: es el selector origen/destino del formulario de transferencia.
  // Va con el usuario porque a la cajera se le sirven SOLO las bodegas de sus sedes.
  @Get('warehouses') @RequireArea('tecnicos', 'administracion', 'caja') @OrPermission(INV_PERMISSIONS.ADMIN)
  warehouses(@CurrentUser() user: AuthUser) { return this.network.warehouses(user); }
  @Get('ip-pools') ipPools(@Query('search') search?: string) { return this.network.ipPools({ search }); }

  // Escritura de pools de IP. Paridad legacy `Mikrotiks::guardar_configuracion` +
  // `set_default_ips_user`. NO hay borrado: el legacy tampoco lo tiene.
  @Post('ip-pools')
  createIpPool(@Body() dto: CreateIpPoolDto) { return this.write.createIpPool(dto); }

  @Patch('ip-pools/:id')
  updateIpPool(@Param('id') id: string, @Body() dto: UpdateIpPoolDto) { return this.write.updateIpPool(id, dto); }

  /** Marca el pool como predeterminado de su sede (solo puede haber uno por sede). */
  @Put('ip-pools/:id/default')
  setDefaultIpPool(@Param('id') id: string) { return this.write.setDefaultIpPool(id); }
  @Get('branches') branches() { return this.network.branches(); }
  @Get('vlans') vlans(@Query('branchId') branchId?: string) { return this.network.vlans(branchId); }

  @Get('onus')
  onus(@Query('search') search?: string, @Query('oltId') oltId?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.network.onus({ search, oltId, page: Number(page), pageSize: Number(pageSize) });
  }

  @Get('naps')
  naps(@Query('search') search?: string, @Query('branchId') branchId?: string, @Query('sort') sort?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string, @Query('sortBy') sortBy?: string, @Query('sortDir') sortDir?: string) {
    return this.network.naps({ search, branchId, sort, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir });
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

  // Caja incluida (2026-07-30): el formulario de transferencia lista los equipos de
  // la bodega origen para escogerlos. La pantalla /red/equipos sigue siendo de
  // técnicos; esto es sólo la lectura que necesita el traslado.
  @Get('equipment') @AbiertoAlTecnico() @RequireArea('tecnicos', 'administracion', 'caja') @OrPermission(INV_PERMISSIONS.ADMIN)
  equipment(
    @CurrentUser() user: AuthUser,
    @Query('search') search?: string, @Query('status') status?: string, @Query('warehouseId') warehouseId?: string,
    @Query('assigned') assigned?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string,
    @Query('sortBy') sortBy?: string, @Query('sortDir') sortDir?: string,
  ) {
    return this.network.equipment({ search, status, warehouseId, assigned, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir }, user);
  }
}
