/**
 * Rutas de subscribers — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en SubscribersController, que ya no lleva decoradores.
 *
 * Endpoints: 42
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirArea, exigirPermisos, usuarioDe } from '../core/auth/instancias';
import { ficheroDe, subirUno } from '../core/http/uploads';
import { SubscribersController, ALLOWED_EXT, MAX_FILE_BYTES, UPLOAD_ROOT } from './subscribers.controller';
import { contractsService, subscriberFilesService, subscriberGeoService, subscriberNotesService, subscribersService } from '../core/contenedor';
import { BadRequestException, NotFoundException } from '../core/http/errores';
import { diskStorage } from 'multer';
import type { Response } from 'express';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SubscribersService } from './subscribers.service';
import { SubscriberGeoService } from './subscriber-geo.service';
import { SubscriberFilesService } from './subscriber-files.service';
import { SubscriberNotesService } from './subscriber-notes.service';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';
import { UpdateSubscriberDto, AddNoteDto, UpdateInvoiceDto, CreateSubscriberDto, CheckDuplicatesDto, ChangeStatusDto } from './dto/update-subscriber.dto';
import { AssignPlanDto, AssignPlansDto } from '../plans/dto/plan.dto';
import { BulkFilterDto, BulkMessageDto } from './dto/bulk.dto';
import { pazYSalvoPdf, statementPdf } from './subscriber-pdf';
import { ContractsService } from '../contracts/contracts.service';
import { renderContratoLegacy } from '../contracts/contrato-legacy.render';
import { FirmaDto } from '../contracts/dto/clausula.dto';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const subscribers = new SubscribersController(subscribersService, subscriberGeoService, subscriberFilesService, subscriberNotesService, contractsService);

export const subscribersRouter = crearRouter();
subscribersRouter.get(
  '/',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.list(req.query.search as string, req.query.status as string, req.query.branchId as string, req.query.page as string, req.query.pageSize as string, req.query.withPlan as string, req.query.servicio as string, req.query.tecnologia as string, req.query.cuenta as string, req.query.deuda as string, req.query.sortBy as string, req.query.sortDir as string, usuarioDe(req))),
);

subscribersRouter.post(
  '/',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'caja'),
  manejar((req) => subscribers.create(validar(CreateSubscriberDto, req.body), usuarioDe(req))),
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
        filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`),
      }),
      limits: { fileSize: MAX_FILE_BYTES },
      fileFilter: (_req, file, cb) => {
        const ok = ALLOWED_EXT.has(extname(file.originalname).toLowerCase());
        cb(ok ? null : new BadRequestException('Tipo de archivo no permitido'), ok);
      },
    }),
  manejar((req) => subscribers.upload(req.params.id, ficheroDe(req), usuarioDe(req))),
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
        filename: (_req, file, cb) => cb(null, `huella-${Date.now()}${extname(file.originalname).toLowerCase()}`),
      }),
      limits: { fileSize: 8 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        // Solo imagen: la huella se incrusta en el PDF del contrato, y un PDF o un
        // Word dentro de ese hueco no se puede dibujar.
        const ok = ['.jpg', '.jpeg', '.png', '.webp'].includes(extname(file.originalname).toLowerCase());
        cb(ok ? null : new BadRequestException('La huella debe ser una imagen (JPG o PNG)'), ok);
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
