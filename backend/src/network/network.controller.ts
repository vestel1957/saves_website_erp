import type { Response } from 'express';
import { IsArray, IsIn, IsOptional, IsString, ArrayNotEmpty } from 'class-validator';
import { NetworkService } from './network.service';
import { NetworkWriteService, EquipTransferDto, AssignPortDto, AssignEquipmentSubDto, CreateEquipmentDto, CreateIpPoolDto, CreateNapDto, CreateVlanDto, ReceiveTransferDto, RejectTransferDto, SignTransferDto, UpdateIpPoolDto, UpdateNapDto } from './network-write.service';
import { MikrotikService } from './mikrotik.service';
import { INV_PERMISSIONS, APP_PERMISSIONS } from '../auth/permissions.catalog';
import { AuthUser } from '../auth/current-user.decorator';
import { ListNapsQueryDto } from './dto/naps.dto';
import { actaPdf } from '../common/pdf/pdf-docs';

export class BatchIdsDto {
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) ids!: string[];
}
export class MessageBatchDto {
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) ids!: string[];
  @IsString() message!: string;
}
export class RestoreBranchDto {
  @IsOptional() @IsArray() @IsString({ each: true }) statuses?: string[];
}
/** Qué firma se está pidiendo: la salida (sede origen) o la entrada (sede destino). */
export class TransferOtpDto {
  @IsIn(['salida', 'entrada']) paso!: 'salida' | 'entrada';
}

/** Red / ISP: Mikrotik, OLT/ONU, NAP, equipos (migrado de saves-vestel). */
export class NetworkController {
  constructor(
    private readonly network: NetworkService,
    private readonly write: NetworkWriteService,
    private readonly mikrotik: MikrotikService,
  ) {}

  // --- Corte / reconexión real contra el Mikrotik ---
  /** Modo de operación: live (real) o dry-run (simulación segura). */
  mikrotikMode() {
    return { live: this.mikrotik.isLive, mode: this.mikrotik.isLive ? 'LIVE' : 'DRY_RUN' };
  }
  cut(id: string, user: AuthUser) {
    return this.mikrotik.cut(id, user);
  }
  reconnect(id: string, user: AuthUser) {
    return this.mikrotik.reconnect(id, user);
  }
  provision(id: string, user: AuthUser) {
    return this.mikrotik.provision(id, user);
  }
  connection(id: string) {
    return this.mikrotik.liveStatus(id);
  }
  mikrotikHistory(id: string) {
    return this.mikrotik.history(id);
  }
  testMikrotik(id: string) {
    return this.mikrotik.testRouter(id);
  }
  cutBatch(dto: BatchIdsDto, user: AuthUser) {
    return this.mikrotik.cutBatch(dto.ids, user);
  }
  reconnectBatch(dto: BatchIdsDto, user: AuthUser) {
    return this.mikrotik.reconnectBatch(dto.ids, user);
  }
  messageBatch(dto: MessageBatchDto, user: AuthUser) {
    return this.mikrotik.messageBatch(dto.ids, dto.message, user);
  }

  // --- Escritura: transferencias de equipos y conexiones ---
  // Lectura de transferencias: además de técnicos/administración, la ve caja
  // (para recibir en su sede). Aprobar/despachar y recibir van gateados aparte.
  // El acotado por SEDE lo hace el servicio con el usuario (`bodega-scope.ts`): una
  // cajera solo ve las transferencias que tocan una bodega de sus sedes.
  
  transfers(user: AuthUser, page?: string, pageSize?: string, search?: string, status?: string, warehouseId?: string, sortBy?: string, sortDir?: string) { return this.write.transfers({ page: Number(page), pageSize: Number(pageSize), search, status, warehouseId, sortBy, sortDir }, user); }
  
  transferDetail(id: string, user: AuthUser) { return this.write.transferDetail(id, user); }
  /** El acta en PDF: la misma que se le manda por WhatsApp a quien debe firmarla. */
  
  async transferPdf(id: string, res: Response) {
    const d = await this.write.transferPdfData(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="acta-equipos-${d.numero}.pdf"`);
    actaPdf(res, d);
  }
  // Solicitar una transferencia: caja también (2026-07-30), pero solo dentro de SU
  // sede. Enviar de una sede a otra es del encargado de bodega, y eso lo revalida
  // `createTransfer` (no se puede expresar con un decorador: depende de las bodegas).
  
  createTransfer(dto: EquipTransferDto, user: AuthUser) { return this.write.createTransfer(dto, user); }
  // Aprobar/despachar y rechazar: reservado a inventario (Jefe de bodega,
  // inventory.admin). @RequireArea() vacío desactiva el AreaGuard de clase para
  // que el gateo lo haga PermissionsGuard por permiso (no por área).
  
  approveTransfer(id: string, user: AuthUser) { return this.write.approveTransfer(id, user); }
  
  rejectTransfer(id: string, dto: RejectTransferDto, user: AuthUser) { return this.write.rejectTransfer(id, user, dto.reason); }
  // --- Firma de la transferencia ENTRE SEDES (código al WhatsApp del firmante) ---
  // Quién puede firmar cada paso lo decide el servicio por la SEDE de la bodega, no
  // por área: la salida la firma la encargada de la sede origen y la entrada quien
  // recibe en destino, y las dos son cajeras. Por eso van con `area.caja`.
  
  pedirCodigo(id: string, dto: TransferOtpDto, user: AuthUser) {
    return this.write.pedirCodigoFirma(id, dto.paso, user);
  }
  
  firmarSalida(id: string, dto: SignTransferDto, user: AuthUser) {
    return this.write.firmarSalida(id, dto.code, user);
  }
  // Recepción en la sede destino: reservado a caja (área caja). Entre sedes exige el
  // código; dentro de la sede se recibe con un clic, como siempre.
  
  receiveTransfer(id: string, dto: ReceiveTransferDto, user: AuthUser) { return this.write.receiveTransfer(id, user, dto?.code); }

  ports(search?: string, status?: string, napId?: string, branchId?: string, page?: string, pageSize?: string, sortBy?: string, sortDir?: string) {
    return this.write.ports({ search, status, napId, branchId, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir });
  }
  napOptions(branchId?: string) { return this.write.napOptions(branchId); }
  assignPort(id: string, dto: AssignPortDto) { return this.write.assignPort(id, dto); }
  freePort(id: string) { return this.write.freePort(id); }

  // Las DOS únicas rutas del módulo de red que le quedan al técnico de campo: su
  // "bodega" (= él mismo) y los equipos que están a su nombre. Ver `ModuloRedGuard`.
  equipmentWarehouses(user?: AuthUser) { return this.write.equipmentWarehouses(user); }
  createEquipment(dto: CreateEquipmentDto, user: AuthUser) { return this.write.createEquipment(dto, user); }

  stats() { return this.network.stats(); }
  mikrotiks() { return this.network.mikrotiks(); }
  olts() { return this.network.olts(); }
  // Caja incluida: es el selector origen/destino del formulario de transferencia.
  // Va con el usuario porque a la cajera se le sirven SOLO las bodegas de sus sedes.
  
  warehouses(user: AuthUser) { return this.network.warehouses(user); }
  ipPools(search?: string) { return this.network.ipPools({ search }); }

  // Escritura de pools de IP. Paridad legacy `Mikrotiks::guardar_configuracion` +
  // `set_default_ips_user`. NO hay borrado: el legacy tampoco lo tiene.
  createIpPool(dto: CreateIpPoolDto) { return this.write.createIpPool(dto); }

  updateIpPool(id: string, dto: UpdateIpPoolDto) { return this.write.updateIpPool(id, dto); }

  /** Marca el pool como predeterminado de su sede (solo puede haber uno por sede). */
  setDefaultIpPool(id: string) { return this.write.setDefaultIpPool(id); }
  branches() { return this.network.branches(); }
  vlans(branchId?: string) { return this.network.vlans(branchId); }

  onus(search?: string, oltId?: string, page?: string, pageSize?: string) {
    return this.network.onus({ search, oltId, page: Number(page), pageSize: Number(pageSize) });
  }

  naps(q: ListNapsQueryDto) { return this.network.naps(q); }
  /** Barrios de las NAPs de una sede (opciones del filtro por dirección). */
  napAddresses(branchId?: string) { return this.network.napAddresses(branchId); }
  napById(id: string) { return this.network.napById(id); }
  createNap(dto: CreateNapDto) { return this.write.createNap(dto); }
  updateNap(id: string, dto: UpdateNapDto) { return this.write.updateNap(id, dto); }
  deleteNap(id: string) { return this.write.deleteNap(id); }

  // --- VLANs (CRUD) ---
  createVlan(dto: CreateVlanDto) { return this.write.createVlan(dto); }
  updateVlan(id: string, dto: CreateVlanDto) { return this.write.updateVlan(id, dto); }
  deleteVlan(id: string) { return this.write.deleteVlan(id); }

  // --- Asignar / desasignar equipo a cliente ---
  assignEquipment(id: string, dto: AssignEquipmentSubDto) { return this.write.assignEquipmentToSubscriber(id, dto); }
  unassignEquipment(id: string) { return this.write.unassignEquipment(id); }

  // --- Restaurar / sincronizar PPP masivo de una sede (recuperación ante formateo) ---
  restoreBranch(branchId: string, dto: RestoreBranchDto, user: AuthUser) {
    return this.mikrotik.restoreBranch(branchId, { statuses: dto.statuses }, user);
  }

  // Caja incluida (2026-07-30): el formulario de transferencia lista los equipos de
  // la bodega origen para escogerlos. La pantalla /red/equipos sigue siendo de
  // técnicos; esto es sólo la lectura que necesita el traslado.
  
  equipment(
    user: AuthUser,
    search?: string, status?: string, warehouseId?: string,
    assigned?: string, page?: string, pageSize?: string,
    sortBy?: string, sortDir?: string,
  ) {
    return this.network.equipment({ search, status, warehouseId, assigned, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir }, user);
  }
}
