/**
 * Rutas de subscribers — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en SubscribersController, que ya no lleva decoradores.
 *
 * Endpoints: 52
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirArea, exigirPermisos, usuarioDe } from '../core/auth/instancias';
import { ficheroDe, subirUno } from '../core/http/uploads';
import { SubscribersController, ALLOWED_EXT, EXT_CARTA_RETIRO, EXT_FOTO_VIVIENDA, EXT_HUELLA, MAX_FILE_BYTES, UPLOAD_ROOT } from './subscribers.controller';
import { altaClienteService, contractsService, subscriberFilesService, subscriberGeoService, subscriberNotesService, subscribersService } from '../core/contenedor';
import { BadRequestException, NotFoundException } from '../core/http/errores';
import * as ExcelJS from 'exceljs';
import { diskStorage } from 'multer';
import type { Response } from 'express';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SubscribersService } from './subscribers.service';
import { SubscriberGeoService } from './subscriber-geo.service';
import { SubscriberFilesService } from './subscriber-files.service';
import { KIND_CARTA_RETIRO, KIND_VIVIENDA, normalizarTipoArchivo } from './subscriber-file-kinds';
import { SubscriberNotesService } from './subscriber-notes.service';
import { AltaClienteService } from './alta.service';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';
import { esTecnicoDeCampo } from '../common/tecnico-scope';
import { ForbiddenException } from '../core/http/errores';
import { UpdateSubscriberDto, AddNoteDto, UpdateInvoiceDto, CreateSubscriberDto, CheckDuplicatesDto, ChangeStatusDto, ChangeServiceStatusDto, ReturnEquipmentDto } from './dto/update-subscriber.dto';
import { AssignPlanDto, AssignPlansDto, SetPuntosDto } from '../plans/dto/plan.dto';
import { ApplyBundleDto } from '../plans/dto/bundle.dto';
import { BulkFilterDto, BulkMessageDto } from './dto/bulk.dto';
import { pazYSalvoPdf, statementPdf } from './subscriber-pdf';
import { ContractsService } from '../contracts/contracts.service';
import { renderContratoLegacy } from '../contracts/contrato-legacy.render';
import { FirmaDto } from '../contracts/dto/clausula.dto';
import { extensionDeAdjunto } from '../common/uploads';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const subscribers = new SubscribersController(subscribersService, subscriberGeoService, subscriberFilesService, subscriberNotesService, contractsService, altaClienteService);

export const subscribersRouter = crearRouter();
subscribersRouter.get(
  '/',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.list(req.query.search as string, req.query.status as string, req.query.branchId as string, req.query.page as string, req.query.pageSize as string, req.query.withPlan as string, req.query.servicio as string, req.query.planId as string, req.query.tecnologia as string, req.query.cuenta as string, req.query.deuda as string, req.query.sortBy as string, req.query.sortDir as string, usuarioDe(req))),
);

subscribersRouter.post(
  '/',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.create(validar(CreateSubscriberDto, req.body), usuarioDe(req))),
);

subscribersRouter.get(
  '/afiliaciones',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.afiliaciones()),
);

subscribersRouter.get(
  '/afiliadores',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.afiliadores()),
);

subscribersRouter.get(
  '/branches',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.branches(usuarioDe(req))),
);

subscribersRouter.get(
  '/branches-stats',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.branchesStats(usuarioDe(req))),
);

// Sólo lee: los ids del filtro, para que la pantalla parta el lote en tandas.
subscribersRouter.post(
  '/bulk/ids',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.bulkIds(validar(BulkFilterDto, req.body), usuarioDe(req))),
);

subscribersRouter.post(
  '/bulk/cut',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  exigirPermisos(APP_PERMISSIONS.NETWORK_CUT),
  manejar((req) => subscribers.bulkCut(validar(BulkFilterDto, req.body), usuarioDe(req))),
);

subscribersRouter.post(
  '/bulk/message',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.bulkMessage(validar(BulkMessageDto, req.body), usuarioDe(req))),
);

subscribersRouter.post(
  '/bulk/reconnect',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  exigirPermisos(APP_PERMISSIONS.NETWORK_RECONNECT),
  manejar((req) => subscribers.bulkReconnect(validar(BulkFilterDto, req.body), usuarioDe(req))),
);

subscribersRouter.post(
  '/bulk/tv-cut',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  exigirPermisos(APP_PERMISSIONS.NETWORK_CUT),
  manejar((req) => subscribers.bulkTvCut(validar(BulkFilterDto, req.body), usuarioDe(req))),
);

subscribersRouter.post(
  '/bulk/tv-restore',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  exigirPermisos(APP_PERMISSIONS.NETWORK_RECONNECT),
  manejar((req) => subscribers.bulkTvRestore(validar(BulkFilterDto, req.body), usuarioDe(req))),
);

subscribersRouter.post(
  '/check-duplicates',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.checkDuplicates(validar(CheckDuplicatesDto, req.body))),
);

subscribersRouter.get(
  '/export.xlsx',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req, res) => subscribers.listXlsx(res, req.query.search as string, req.query.status as string, req.query.branchId as string, req.query.servicio as string, req.query.planId as string, req.query.tecnologia as string, req.query.cuenta as string, req.query.deuda as string, req.query.sortBy as string, req.query.sortDir as string, usuarioDe(req))),
);

subscribersRouter.get(
  '/geo/cities',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.geoCities(req.query.department as string)),
);

subscribersRouter.get(
  '/geo/departments',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.geoDepartments()),
);

subscribersRouter.get(
  '/geo/localities',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.geoLocalities(req.query.city as string)),
);

subscribersRouter.get(
  '/geo/neighborhoods',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.geoNeighborhoods(req.query.locality as string)),
);

subscribersRouter.get(
  '/stats',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.stats()),
);

subscribersRouter.get(
  '/:id',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.detail(req.params.id, usuarioDe(req))),
);

subscribersRouter.patch(
  '/:id',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.update(req.params.id, validar(UpdateSubscriberDto, req.body), usuarioDe(req))),
);

subscribersRouter.get(
  '/:id/anexo.pdf',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req, res) => subscribers.anexoPdfEndpoint(req.params.id, res, usuarioDe(req))),
);

subscribersRouter.post(
  '/:id/bundle',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.applyBundle(req.params.id, validar(ApplyBundleDto, req.body), usuarioDe(req))),
);

subscribersRouter.post(
  '/:id/carta-retiro',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  subirUno('file', {
      storage: diskStorage({
        destination: (req, _file, cb) => {
          const dir = join(UPLOAD_ROOT, (req.params as { id: string }).id);
          mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (_req, file, cb) => cb(null, `${randomUUID()}${extensionDeAdjunto(file, EXT_CARTA_RETIRO) ?? '.pdf'}`),
      }),
      limits: { fileSize: MAX_FILE_BYTES },
      // La carta llega escaneada o fotografiada desde la ventanilla: PDF o imagen.
      fileFilter: (_req, file, cb) => {
        const ok = extensionDeAdjunto(file, EXT_CARTA_RETIRO) !== null;
        cb(ok ? null : new BadRequestException('La carta de retiro debe ser PDF o una imagen'), ok);
      },
    }),
  manejar((req) => subscribers.uploadCartaRetiro(req.params.id, ficheroDe(req), usuarioDe(req))),
);

subscribersRouter.get(
  '/:id/contract.pdf',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req, res) => subscribers.contractPdfEndpoint(req.params.id, res, usuarioDe(req))),
);

subscribersRouter.get(
  '/:id/contrato',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.contratoEstado(req.params.id, usuarioDe(req))),
);

subscribersRouter.post(
  '/:id/equipment/:equipmentId/return',
  autenticar,
  exigirArea('administracion', 'caja'),
  manejar((req) => subscribers.returnEquipment(req.params.id, req.params.equipmentId, validar(ReturnEquipmentDto, req.body), usuarioDe(req))),
);

subscribersRouter.get(
  '/:id/files',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.listFiles(req.params.id, usuarioDe(req))),
);

subscribersRouter.post(
  '/:id/files',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  subirUno('file', {
      storage: diskStorage({
        destination: (req, _file, cb) => {
          const dir = join(UPLOAD_ROOT, (req.params as { id: string }).id);
          mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (_req, file, cb) => cb(null, `${randomUUID()}${extensionDeAdjunto(file, ALLOWED_EXT) ?? '.bin'}`),
      }),
      limits: { fileSize: MAX_FILE_BYTES },
      // Se valida con `extensionDeAdjunto`, no con `extname(originalname)` a secas:
      // desde la galería del móvil el nombre puede llegar sin extensión y la foto
      // se rechazaba. La lista blanca es la misma; sólo cambia de dónde se deduce.
      fileFilter: (_req, file, cb) => {
        const ok = extensionDeAdjunto(file, ALLOWED_EXT) !== null;
        cb(ok ? null : new BadRequestException('Tipo de archivo no permitido'), ok);
      },
    }),
  manejar((req) => subscribers.upload(req.params.id, ficheroDe(req), req.body?.kind, usuarioDe(req))),
);

subscribersRouter.delete(
  '/:id/files/:fileId',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.deleteFile(req.params.id, req.params.fileId, usuarioDe(req))),
);

subscribersRouter.get(
  '/:id/files/:fileId/download',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req, res) => subscribers.download(req.params.id, req.params.fileId, res, usuarioDe(req))),
);

subscribersRouter.delete(
  '/:id/firma',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.borrarFirma(req.params.id, usuarioDe(req))),
);

subscribersRouter.post(
  '/:id/firma',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.firma(req.params.id, validar(FirmaDto, req.body), usuarioDe(req))),
);

subscribersRouter.get(
  '/:id/firma.png',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req, res) => subscribers.verFirma(req.params.id, res, usuarioDe(req))),
);

subscribersRouter.get(
  '/:id/form',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.editForm(req.params.id, usuarioDe(req))),
);

subscribersRouter.post(
  '/:id/house-photo',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  subirUno('file', {
      storage: diskStorage({
        destination: (req, _file, cb) => {
          const dir = join(UPLOAD_ROOT, (req.params as { id: string }).id);
          mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (_req, file, cb) => cb(null, `${randomUUID()}${extensionDeAdjunto(file, EXT_FOTO_VIVIENDA) ?? '.jpg'}`),
      }),
      limits: { fileSize: MAX_FILE_BYTES },
      // Sólo imágenes que el navegador sepa pintar: esta foto se enseña dentro de
      // la ficha, no se descarga. Un PDF o un .heic dejarían el hueco roto.
      fileFilter: (_req, file, cb) => {
        const ok = extensionDeAdjunto(file, EXT_FOTO_VIVIENDA) !== null;
        cb(ok ? null : new BadRequestException('La foto de la vivienda debe ser JPG, PNG o WEBP'), ok);
      },
    }),
  manejar((req) => subscribers.uploadHousePhoto(req.params.id, ficheroDe(req), usuarioDe(req))),
);

subscribersRouter.delete(
  '/:id/huella',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.borrarHuella(req.params.id, usuarioDe(req))),
);

subscribersRouter.post(
  '/:id/huella',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  subirUno('file', {
      storage: diskStorage({
        destination: (req, _file, cb) => {
          const dir = join(UPLOAD_ROOT, (req.params as { id: string }).id);
          mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (_req, file, cb) => cb(null, `huella-${Date.now()}${extensionDeAdjunto(file, EXT_HUELLA) ?? '.bin'}`),
      }),
      limits: { fileSize: 8 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        // Solo imagen: la huella se incrusta en el PDF del contrato, y un PDF o un
        // Word dentro de ese hueco no se puede dibujar. HEIC queda fuera por lo
        // mismo (el PDF no sabe dibujarlo), y por eso el mensaje dice cuáles sirven.
        const ok = extensionDeAdjunto(file, EXT_HUELLA) !== null;
        cb(ok ? null : new BadRequestException('La huella debe ser una imagen JPG, PNG o WEBP'), ok);
      },
    }),
  manejar((req) => subscribers.huella(req.params.id, ficheroDe(req), usuarioDe(req))),
);

subscribersRouter.get(
  '/:id/huella.png',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req, res) => subscribers.verHuella(req.params.id, res, usuarioDe(req))),
);

subscribersRouter.get(
  '/:id/invoices',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.invoices(req.params.id, usuarioDe(req))),
);

subscribersRouter.delete(
  '/:id/invoices/:invoiceId',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => subscribers.deleteInvoice(req.params.id, req.params.invoiceId, usuarioDe(req))),
);

subscribersRouter.patch(
  '/:id/invoices/:invoiceId',
  autenticar,
  exigirArea('contabilidad'),
  manejar((req) => subscribers.updateInvoice(req.params.id, req.params.invoiceId, validar(UpdateInvoiceDto, req.body), usuarioDe(req))),
);

subscribersRouter.post(
  '/:id/notes',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.addNote(req.params.id, validar(AddNoteDto, req.body), usuarioDe(req))),
);

subscribersRouter.delete(
  '/:id/notes/:noteId',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.deleteNote(req.params.id, req.params.noteId, usuarioDe(req))),
);

subscribersRouter.get(
  '/:id/paz-y-salvo.pdf',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req, res) => subscribers.pazYSalvo(req.params.id, res, usuarioDe(req))),
);

subscribersRouter.get(
  '/:id/plan',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.currentPlans(req.params.id, usuarioDe(req))),
);

subscribersRouter.post(
  '/:id/plan',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.changePlan(req.params.id, validar(AssignPlanDto, req.body), usuarioDe(req))),
);

subscribersRouter.post(
  '/:id/plans',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.changePlans(req.params.id, validar(AssignPlansDto, req.body), usuarioDe(req))),
);

subscribersRouter.post(
  '/:id/puntos',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.setPuntos(req.params.id, validar(SetPuntosDto, req.body), usuarioDe(req))),
);

subscribersRouter.patch(
  '/:id/servicios/estado',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.cambiarEstadoDeServicio(req.params.id, validar(ChangeServiceStatusDto, req.body), usuarioDe(req))),
);

subscribersRouter.get(
  '/:id/statement',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.statement(req.params.id, usuarioDe(req))),
);

subscribersRouter.get(
  '/:id/statement.pdf',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req, res) => subscribers.statementPdfEndpoint(req.params.id, res, usuarioDe(req))),
);

subscribersRouter.patch(
  '/:id/status',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.changeStatus(req.params.id, validar(ChangeStatusDto, req.body), usuarioDe(req))),
);
