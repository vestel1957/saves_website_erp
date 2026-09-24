/**
 * Rutas de inventory — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en InventoryController, que ya no lleva decoradores.
 *
 * Endpoints: 28
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirArea, usuarioDe } from '../core/auth/instancias';
import { ficheroDe, subirUno } from '../core/http/uploads';
import { InventoryController, TRASPASOS } from './inventory.controller';
import { inventoryAlertsService, inventoryService } from '../core/contenedor';
import { BadRequestException } from '../core/http/errores';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { InventoryService } from './inventory.service';
import { InventoryAlertsService } from './alerts.service';
import { CreateMaterialDto, ReceiveActaDto, SimpleCatalogDto, TransferDto, UpdateMaterialDto, WarehouseDto } from './dto/inventory.dto';
import { actaPdf } from '../common/pdf/pdf-docs';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const inventory = new InventoryController(inventoryService, inventoryAlertsService);

export const inventoryRouter = crearRouter();
inventoryRouter.get(
  '/actas',
  autenticar,
  exigirArea(...TRASPASOS),
  manejar((req) => inventory.actas(req.query.page as string, req.query.pageSize as string, req.query.search as string, req.query.status as string, req.query.sortBy as string, req.query.sortDir as string, usuarioDe(req))),
);

inventoryRouter.get(
  '/actas/:id',
  autenticar,
  exigirArea(...TRASPASOS),
  manejar((req) => inventory.actaDetail(req.params.id, usuarioDe(req))),
);

inventoryRouter.post(
  '/actas/:id/items/:itemId/receive',
  autenticar,
  exigirArea(...TRASPASOS),
  manejar((req) => inventory.receiveActaItem(req.params.id, req.params.itemId, usuarioDe(req))),
);

inventoryRouter.post(
  '/actas/:id/otp',
  autenticar,
  exigirArea(...TRASPASOS),
  manejar((req) => inventory.actaOtp(req.params.id, usuarioDe(req))),
);

inventoryRouter.get(
  '/actas/:id/pdf',
  autenticar,
  exigirArea(...TRASPASOS),
  manejar((req, res) => inventory.actaPdf(req.params.id, res)),
);

inventoryRouter.post(
  '/actas/:id/receive',
  autenticar,
  exigirArea(...TRASPASOS),
  manejar((req) => inventory.receiveActa(req.params.id, validar(ReceiveActaDto, req.body), usuarioDe(req))),
);

inventoryRouter.post(
  '/actas/:id/send',
  autenticar,
  exigirArea(...TRASPASOS),
  manejar((req) => inventory.sendActa(req.params.id, usuarioDe(req))),
);

inventoryRouter.get(
  '/alerts',
  autenticar,
  exigirArea('administracion', 'tecnicos', 'caja'),
  manejar((req) => inventory.alerts()),
);

inventoryRouter.post(
  '/alerts/read-all',
  autenticar,
  exigirArea('administracion', 'tecnicos', 'caja'),
  manejar((req) => inventory.readAllAlerts()),
);

inventoryRouter.post(
  '/alerts/run',
  autenticar,
  exigirArea('administracion', 'tecnicos', 'caja'),
  manejar((req) => inventory.runAlerts()),
);

inventoryRouter.get(
  '/branches',
  autenticar,
  exigirArea('administracion', 'tecnicos', 'caja'),
  manejar((req) => inventory.branches()),
);

inventoryRouter.get(
  '/categories',
  autenticar,
  exigirArea('administracion', 'tecnicos', 'caja'),
  manejar((req) => inventory.categories()),
);

inventoryRouter.post(
  '/categories',
  autenticar,
  exigirArea('administracion', 'tecnicos', 'caja'),
  manejar((req) => inventory.createCategory(validar(SimpleCatalogDto, req.body))),
);

inventoryRouter.delete(
  '/categories/:id',
  autenticar,
  exigirArea('administracion', 'tecnicos', 'caja'),
  manejar((req) => inventory.deleteCategory(req.params.id)),
);

inventoryRouter.patch(
  '/categories/:id',
  autenticar,
  exigirArea('administracion', 'tecnicos', 'caja'),
  manejar((req) => inventory.updateCategory(req.params.id, validar(SimpleCatalogDto, req.body))),
);

inventoryRouter.get(
  '/materials',
  autenticar,
  exigirArea(...TRASPASOS),
  manejar((req) => inventory.materials(req.query.search as string, req.query.categoryId as string, req.query.warehouseId as string, req.query.lowStock as string, req.query.onlyConsumable as string, req.query.page as string, req.query.pageSize as string, req.query.sortBy as string, req.query.sortDir as string, usuarioDe(req))),
);

inventoryRouter.post(
  '/materials',
  autenticar,
  exigirArea('administracion', 'tecnicos', 'caja'),
  manejar((req) => inventory.createMaterial(validar(CreateMaterialDto, req.body), usuarioDe(req))),
);

inventoryRouter.post(
  '/materials/import',
  autenticar,
  exigirArea('administracion', 'tecnicos', 'caja'),
  subirUno('file', {
    storage: memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => cb(null, /spreadsheet|excel|\.xlsx$/.test(file.mimetype) || file.originalname.toLowerCase().endsWith('.xlsx')),
  }),
  manejar((req) => inventory.importMaterials(ficheroDe(req))),
);

inventoryRouter.delete(
  '/materials/:id',
  autenticar,
  exigirArea('administracion', 'tecnicos', 'caja'),
  manejar((req) => inventory.deleteMaterial(req.params.id, usuarioDe(req))),
);

inventoryRouter.get(
  '/materials/:id',
  autenticar,
  exigirArea('administracion', 'tecnicos', 'caja'),
  manejar((req) => inventory.materialDetail(req.params.id, usuarioDe(req))),
);

inventoryRouter.patch(
  '/materials/:id',
  autenticar,
  exigirArea('administracion', 'tecnicos', 'caja'),
  manejar((req) => inventory.updateMaterial(req.params.id, validar(UpdateMaterialDto, req.body), usuarioDe(req))),
);

inventoryRouter.get(
  '/stats',
  autenticar,
  exigirArea('administracion', 'tecnicos', 'caja'),
  manejar((req) => inventory.stats(usuarioDe(req))),
);

inventoryRouter.post(
  '/transfer',
  autenticar,
  exigirArea(...TRASPASOS),
  manejar((req) => inventory.transfer(validar(TransferDto, req.body), usuarioDe(req))),
);

inventoryRouter.get(
  '/transfer/context',
  autenticar,
  exigirArea(...TRASPASOS),
  manejar((req) => inventory.transferContext(usuarioDe(req))),
);

inventoryRouter.get(
  '/warehouses',
  autenticar,
  exigirArea(...TRASPASOS),
  manejar((req) => inventory.warehouses(usuarioDe(req))),
);

inventoryRouter.post(
  '/warehouses',
  autenticar,
  exigirArea('administracion', 'tecnicos', 'caja'),
  manejar((req) => inventory.createWarehouse(validar(WarehouseDto, req.body), usuarioDe(req))),
);

inventoryRouter.delete(
  '/warehouses/:id',
  autenticar,
  exigirArea('administracion', 'tecnicos', 'caja'),
  manejar((req) => inventory.deleteWarehouse(req.params.id, usuarioDe(req))),
);

inventoryRouter.patch(
  '/warehouses/:id',
  autenticar,
  exigirArea('administracion', 'tecnicos', 'caja'),
  manejar((req) => inventory.updateWarehouse(req.params.id, validar(WarehouseDto, req.body), usuarioDe(req))),
);
