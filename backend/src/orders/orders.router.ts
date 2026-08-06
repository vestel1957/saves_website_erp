/**
 * Rutas de orders — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en OrdersController, que ya no lleva decoradores.
 *
 * Endpoints: 29
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirArea, exigirPermisos, usuarioDe } from '../core/auth/instancias';
import { ficheroDe, subirUno } from '../core/http/uploads';
import { OrdersController, ALLOWED_EXT, MAX_FILE_BYTES, UPLOAD_ROOT } from './orders.controller';
import { ordersService } from '../core/contenedor';
import { BadRequestException } from '../core/http/errores';
import { diskStorage } from 'multer';
import type { Response } from 'express';
import { createReadStream, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as ExcelJS from 'exceljs';
import { OrdersService } from './orders.service';
import { AddNoteDto, ApproveOrderDto, CancelOrderDto, CategoryNameDto, CreateOrderDto, CreateSupplierDto, PayOrderDto, ReceiveOrderDto, UpdateOrderDto } from './dto/orders.dto';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';
import { purchaseOrderPdf } from '../common/pdf/pdf-docs';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const orders = new OrdersController(ordersService);

export const ordersRouter = crearRouter();
ordersRouter.get(
  '/',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => orders.list(req.query.kind as string, req.query.status as string, req.query.search as string, req.query.category as string, req.query.branch as string, req.query.supplier as string, req.query.minTotal as string, req.query.maxTotal as string, req.query.from as string, req.query.to as string, req.query.page as string, req.query.pageSize as string, req.query.sortBy as string, req.query.sortDir as string)),
);

ordersRouter.post(
  '/',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => orders.create(validar(CreateOrderDto, req.body), usuarioDe(req))),
);

ordersRouter.delete(
  '/:id',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => orders.remove(req.params.id)),
);

ordersRouter.get(
  '/:id',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => orders.detail(req.params.id)),
);

ordersRouter.patch(
  '/:id',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => orders.update(req.params.id, validar(UpdateOrderDto, req.body), usuarioDe(req))),
);

ordersRouter.post(
  '/:id/approve',
  autenticar,
  exigirArea('administracion'),
  exigirPermisos(APP_PERMISSIONS.PURCHASES_APPROVE),
  manejar((req) => orders.approve(req.params.id, validar(ApproveOrderDto, req.body), usuarioDe(req))),
);

ordersRouter.post(
  '/:id/approve/otp',
  autenticar,
  exigirArea('administracion'),
  exigirPermisos(APP_PERMISSIONS.PURCHASES_APPROVE),
  manejar((req) => orders.approveOtp(req.params.id, usuarioDe(req))),
);

ordersRouter.post(
  '/:id/cancel',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => orders.cancel(req.params.id, validar(CancelOrderDto, req.body), usuarioDe(req))),
);

ordersRouter.post(
  '/:id/files',
  autenticar,
  exigirArea('administracion'),
  subirUno('file', {
      storage: diskStorage({
        destination: (req, _file, cb) => {
          const dir = join(UPLOAD_ROOT, (req.params as { id: string }).id);
          mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`),
      }),
      limits: { fileSize: MAX_FILE_BYTES },
      fileFilter: (_req, file, cb) => {
        const ok = ALLOWED_EXT.has(extname(file.originalname).toLowerCase());
        cb(ok ? null : new BadRequestException('Tipo de archivo no permitido'), ok);
      },
    }),
  manejar((req) => orders.upload(req.params.id, ficheroDe(req), usuarioDe(req))),
);

ordersRouter.delete(
  '/:id/files/:fileId',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => orders.deleteFile(req.params.id, req.params.fileId, usuarioDe(req))),
);

ordersRouter.get(
  '/:id/files/:fileId/download',
  autenticar,
  exigirArea('administracion'),
  manejar((req, res) => orders.download(req.params.id, req.params.fileId, res)),
);

ordersRouter.post(
  '/:id/finalize',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => orders.finalize(req.params.id, usuarioDe(req))),
);

ordersRouter.post(
  '/:id/notes',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => orders.addNote(req.params.id, validar(AddNoteDto, req.body), usuarioDe(req))),
);

ordersRouter.delete(
  '/:id/notes/:noteId',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => orders.removeNote(req.params.id, req.params.noteId)),
);

ordersRouter.post(
  '/:id/pay',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => orders.pay(req.params.id, validar(PayOrderDto, req.body), usuarioDe(req))),
);

ordersRouter.get(
  '/:id/pdf',
  autenticar,
  exigirArea('administracion'),
  manejar((req, res) => orders.pdf(req.params.id, res)),
);

ordersRouter.post(
  '/:id/receive',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => orders.receive(req.params.id, validar(ReceiveOrderDto, req.body), usuarioDe(req))),
);

ordersRouter.get(
  '/branches',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => orders.branches()),
);

ordersRouter.get(
  '/categories',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => orders.categories()),
);

ordersRouter.post(
  '/categories',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => orders.createCategory(validar(CategoryNameDto, req.body))),
);

ordersRouter.delete(
  '/categories/:id',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => orders.deleteCategory(req.params.id)),
);

ordersRouter.patch(
  '/categories/:id',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => orders.updateCategory(req.params.id, validar(CategoryNameDto, req.body))),
);

ordersRouter.get(
  '/export.xlsx',
  autenticar,
  exigirArea('administracion'),
  manejar((req, res) => orders.exportXlsx(res, req.query.kind as string, req.query.status as string, req.query.search as string, req.query.category as string, req.query.branch as string, req.query.supplier as string, req.query.from as string, req.query.to as string)),
);

ordersRouter.get(
  '/stats',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => orders.stats()),
);

ordersRouter.get(
  '/suppliers',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => orders.suppliers(req.query.category as string, req.query.search as string, req.query.page as string, req.query.pageSize as string, req.query.sortBy as string, req.query.sortDir as string)),
);

ordersRouter.post(
  '/suppliers',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => orders.createSupplier(validar(CreateSupplierDto, req.body))),
);

ordersRouter.delete(
  '/suppliers/:id',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => orders.deleteSupplier(req.params.id)),
);

ordersRouter.patch(
  '/suppliers/:id',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => orders.updateSupplier(req.params.id, validar(CreateSupplierDto, req.body))),
);

ordersRouter.get(
  '/suppliers/:id/statement',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => orders.supplierStatement(req.params.id)),
);
