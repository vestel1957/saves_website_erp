/**
 * Rutas de network — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en NetworkController, que ya no lleva decoradores.
 *
 * Endpoints: 49
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar, validarQuery } from '../core/http/validar';
import { autenticar, exigirArea, exigirAreaCon, exigirPermisos, moduloRed, abiertoAlTecnico, usuarioDe } from '../core/auth/instancias';
import { NetworkController, BatchIdsDto, MessageBatchDto, RestoreBranchDto, TransferOtpDto } from './network.controller';
import { mikrotikService, networkService, networkWriteService } from '../core/contenedor';
import type { Response } from 'express';
import { IsArray, IsIn, IsOptional, IsString, ArrayNotEmpty } from 'class-validator';
import { NetworkService } from './network.service';
import { NetworkWriteService, EquipTransferDto, AssignPortDto, AssignEquipmentSubDto, CreateEquipmentDto, CreateIpPoolDto, CreateNapDto, CreateVlanDto, ReceiveTransferDto, RejectTransferDto, SignTransferDto, UpdateIpPoolDto, UpdateNapDto } from './network-write.service';
import { MikrotikService } from './mikrotik.service';
import { INV_PERMISSIONS, APP_PERMISSIONS } from '../auth/permissions.catalog';
import { ListNapsQueryDto } from './dto/naps.dto';
import { actaPdf } from '../common/pdf/pdf-docs';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const network = new NetworkController(networkService, networkWriteService, mikrotikService);

export const networkRouter = crearRouter();
networkRouter.get(
  '/branches',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.branches()),
);

networkRouter.post(
  '/cut-batch',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  exigirPermisos(APP_PERMISSIONS.NETWORK_CUT),
  moduloRed,
  manejar((req) => network.cutBatch(validar(BatchIdsDto, req.body), usuarioDe(req))),
);

networkRouter.get(
  '/equipment',
  autenticar,
  exigirAreaCon({ areas: ['tecnicos', 'administracion', 'caja'], orPermission: [INV_PERMISSIONS.ADMIN] }),
  abiertoAlTecnico,
  manejar((req) => network.equipment(usuarioDe(req), req.query.search as string, req.query.status as string, req.query.warehouseId as string, req.query.assigned as string, req.query.page as string, req.query.pageSize as string, req.query.sortBy as string, req.query.sortDir as string)),
);

networkRouter.post(
  '/equipment',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.createEquipment(validar(CreateEquipmentDto, req.body), usuarioDe(req))),
);

networkRouter.post(
  '/equipment/:id/assign',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.assignEquipment(req.params.id, validar(AssignEquipmentSubDto, req.body))),
);

networkRouter.post(
  '/equipment/:id/unassign',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.unassignEquipment(req.params.id)),
);

networkRouter.get(
  '/equipment-warehouses',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  abiertoAlTecnico,
  manejar((req) => network.equipmentWarehouses(usuarioDe(req))),
);

networkRouter.get(
  '/ip-pools',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.ipPools(req.query.search as string)),
);

networkRouter.post(
  '/ip-pools',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.createIpPool(validar(CreateIpPoolDto, req.body))),
);

networkRouter.patch(
  '/ip-pools/:id',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.updateIpPool(req.params.id, validar(UpdateIpPoolDto, req.body))),
);

networkRouter.put(
  '/ip-pools/:id/default',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.setDefaultIpPool(req.params.id)),
);

networkRouter.post(
  '/message-batch',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.messageBatch(validar(MessageBatchDto, req.body), usuarioDe(req))),
);

networkRouter.get(
  '/mikrotik/mode',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.mikrotikMode()),
);

networkRouter.post(
  '/mikrotik/restore-branch/:branchId',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.restoreBranch(req.params.branchId, validar(RestoreBranchDto, req.body), usuarioDe(req))),
);

networkRouter.get(
  '/mikrotiks',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.mikrotiks()),
);

networkRouter.post(
  '/mikrotiks/:id/test',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.testMikrotik(req.params.id)),
);

networkRouter.get(
  '/nap-addresses',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.napAddresses(req.query.branchId as string)),
);

networkRouter.get(
  '/nap-options',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.napOptions(req.query.branchId as string)),
);

networkRouter.get(
  '/naps',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.naps(validarQuery(ListNapsQueryDto, req.query))),
);

networkRouter.post(
  '/naps',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.createNap(validar(CreateNapDto, req.body))),
);

networkRouter.delete(
  '/naps/:id',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.deleteNap(req.params.id)),
);

networkRouter.get(
  '/naps/:id',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.napById(req.params.id)),
);

networkRouter.patch(
  '/naps/:id',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.updateNap(req.params.id, validar(UpdateNapDto, req.body))),
);

networkRouter.get(
  '/olts',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.olts()),
);

networkRouter.get(
  '/onus',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.onus(req.query.search as string, req.query.oltId as string, req.query.page as string, req.query.pageSize as string)),
);

networkRouter.get(
  '/ports',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.ports(req.query.search as string, req.query.status as string, req.query.napId as string, req.query.branchId as string, req.query.page as string, req.query.pageSize as string, req.query.sortBy as string, req.query.sortDir as string)),
);

networkRouter.post(
  '/ports/:id/assign',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.assignPort(req.params.id, validar(AssignPortDto, req.body))),
);

networkRouter.post(
  '/ports/:id/free',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.freePort(req.params.id)),
);

networkRouter.post(
  '/reconnect-batch',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  exigirPermisos(APP_PERMISSIONS.NETWORK_RECONNECT),
  moduloRed,
  manejar((req) => network.reconnectBatch(validar(BatchIdsDto, req.body), usuarioDe(req))),
);

networkRouter.get(
  '/stats',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.stats()),
);

networkRouter.get(
  '/subscribers/:id/connection',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  moduloRed,
  manejar((req) => network.connection(req.params.id)),
);

networkRouter.post(
  '/subscribers/:id/cut',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  exigirPermisos(APP_PERMISSIONS.NETWORK_CUT),
  moduloRed,
  manejar((req) => network.cut(req.params.id, usuarioDe(req))),
);

networkRouter.get(
  '/subscribers/:id/mikrotik-history',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.mikrotikHistory(req.params.id)),
);

networkRouter.post(
  '/subscribers/:id/provision',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.provision(req.params.id, usuarioDe(req))),
);

networkRouter.post(
  '/subscribers/:id/reconnect',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  exigirPermisos(APP_PERMISSIONS.NETWORK_RECONNECT),
  moduloRed,
  manejar((req) => network.reconnect(req.params.id, usuarioDe(req))),
);

networkRouter.get(
  '/transfers',
  autenticar,
  exigirAreaCon({ areas: ['tecnicos', 'administracion', 'caja'], orPermission: [INV_PERMISSIONS.ADMIN] }),
  moduloRed,
  manejar((req) => network.transfers(usuarioDe(req), req.query.page as string, req.query.pageSize as string, req.query.search as string, req.query.status as string, req.query.warehouseId as string, req.query.sortBy as string, req.query.sortDir as string)),
);

networkRouter.post(
  '/transfers',
  autenticar,
  exigirAreaCon({ areas: ['tecnicos', 'administracion', 'caja'], orPermission: [INV_PERMISSIONS.ADMIN] }),
  moduloRed,
  manejar((req) => network.createTransfer(validar(EquipTransferDto, req.body), usuarioDe(req))),
);

networkRouter.get(
  '/transfers/:id',
  autenticar,
  exigirAreaCon({ areas: ['tecnicos', 'administracion', 'caja'], orPermission: [INV_PERMISSIONS.ADMIN] }),
  moduloRed,
  manejar((req) => network.transferDetail(req.params.id, usuarioDe(req))),
);

networkRouter.post(
  '/transfers/:id/approve',
  autenticar,
  exigirPermisos(INV_PERMISSIONS.ADMIN),
  moduloRed,
  manejar((req) => network.approveTransfer(req.params.id, usuarioDe(req))),
);

networkRouter.post(
  '/transfers/:id/otp',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.AREA_CAJA),
  moduloRed,
  manejar((req) => network.pedirCodigo(req.params.id, validar(TransferOtpDto, req.body), usuarioDe(req))),
);

networkRouter.get(
  '/transfers/:id/pdf',
  autenticar,
  exigirAreaCon({ areas: ['tecnicos', 'administracion', 'caja'], orPermission: [INV_PERMISSIONS.ADMIN] }),
  moduloRed,
  manejar((req, res) => network.transferPdf(req.params.id, res)),
);

networkRouter.post(
  '/transfers/:id/receive',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.AREA_CAJA),
  moduloRed,
  manejar((req) => network.receiveTransfer(req.params.id, validar(ReceiveTransferDto, req.body), usuarioDe(req))),
);

networkRouter.post(
  '/transfers/:id/reject',
  autenticar,
  exigirPermisos(INV_PERMISSIONS.ADMIN),
  moduloRed,
  manejar((req) => network.rejectTransfer(req.params.id, validar(RejectTransferDto, req.body), usuarioDe(req))),
);

networkRouter.post(
  '/transfers/:id/sign-out',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.AREA_CAJA),
  moduloRed,
  manejar((req) => network.firmarSalida(req.params.id, validar(SignTransferDto, req.body), usuarioDe(req))),
);

networkRouter.get(
  '/vlans',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.vlans(req.query.branchId as string)),
);

networkRouter.post(
  '/vlans',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.createVlan(validar(CreateVlanDto, req.body))),
);

networkRouter.delete(
  '/vlans/:id',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.deleteVlan(req.params.id)),
);

networkRouter.patch(
  '/vlans/:id',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => network.updateVlan(req.params.id, validar(CreateVlanDto, req.body))),
);

networkRouter.get(
  '/warehouses',
  autenticar,
  exigirAreaCon({ areas: ['tecnicos', 'administracion', 'caja'], orPermission: [INV_PERMISSIONS.ADMIN] }),
  moduloRed,
  manejar((req) => network.warehouses(usuarioDe(req))),
);
