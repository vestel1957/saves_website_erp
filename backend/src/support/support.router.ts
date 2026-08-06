/**
 * Rutas de support — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en SupportController, que ya no lleva decoradores.
 *
 * Endpoints: 37
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirArea, exigirPermisos, usuarioDe } from '../core/auth/instancias';
import { ficheroDe, subirUno } from '../core/http/uploads';
import { SupportController, AutenticarOnuDto, MoverAgendaDto, NoAtendidaDto, SUPPORT_ROOT, SaveOrderScoresDto } from './support.controller';
import { agendaService, geofenceService, onuProvisionService, orderScoreService, performanceService, supportService, supportWriteService } from '../core/contenedor';
import { BadRequestException } from '../core/http/errores';
import { IsArray, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { diskStorage } from 'multer';
import { existsSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import * as ExcelJS from 'exceljs';
import { SupportService } from './support.service';
import { AgendaService, type FiltrosAgenda } from './agenda.service';
import { catalogoDeOrdenes } from './order-types';
import { GeofenceService } from './geofence.service';
import {
  SupportWriteService, CreateTicketDto, UpdateStatusDto, AssignDto, PriorityDto, SignatureDto, ThreadDto, AttachDto,
  AssignEquipmentDto, ConsumeMaterialsDto,
} from './support-write.service';
import { OnuProvisionService } from './onu-provision.service';
import { OrderScoreService } from './order-score.service';
import { PUNTAJE_MAX, PUNTAJE_MIN } from './order-score.policy';
import { PerformanceService } from '../reports/performance.service';
import { serviceOrderPdf } from '../common/pdf/pdf-docs';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';
import { enviarAdjuntoSeguro, mimeAceptado, nombreEnDisco, MIMES_IMAGEN } from '../common/uploads';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const support = new SupportController(supportService, supportWriteService, geofenceService, onuProvisionService, performanceService, agendaService, orderScoreService);

export const supportRouter = crearRouter();
supportRouter.get(
  '/agenda',
  autenticar,
  exigirArea('caja', 'administracion'),
  manejar((req) => support.agendaTablero(usuarioDe(req), req.query as unknown as Record<string, string>)),
);

supportRouter.get(
  '/agenda/export.xlsx',
  autenticar,
  exigirArea('caja', 'administracion'),
  manejar((req, res) => support.agendaXlsx(res, usuarioDe(req), req.query as unknown as Record<string, string>)),
);

supportRouter.post(
  '/agenda/mover',
  autenticar,
  exigirArea('caja', 'administracion'),
  manejar((req) => support.agendaMover(validar(MoverAgendaDto, req.body), usuarioDe(req))),
);

supportRouter.get(
  '/equipment/available',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  manejar((req) => support.availableEquipment(req.query.search as string)),
);

supportRouter.get(
  '/filter-options',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  manejar((req) => support.filterOptions(usuarioDe(req))),
);

supportRouter.get(
  '/geofence-report',
  autenticar,
  exigirArea('gerencia', 'administracion', 'sistemas'),
  manejar((req) => support.geofenceReport(req.query.dias as string)),
);

supportRouter.get(
  '/known-ips',
  autenticar,
  exigirArea('gerencia', 'administracion', 'sistemas'),
  manejar((req) => support.knownIps(req.query.dias as string)),
);

supportRouter.get(
  '/materials/search',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  manejar((req) => support.searchMaterials(req.query.search as string)),
);

supportRouter.get(
  '/mi-agenda',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  manejar((req) => support.miAgenda(usuarioDe(req), req.query.fecha as string)),
);

supportRouter.get(
  '/mi-jornada',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  manejar((req) => support.miJornada(usuarioDe(req))),
);

supportRouter.get(
  '/mi-rendimiento',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  manejar((req) => support.miRendimiento(usuarioDe(req), req.query.from as string, req.query.to as string)),
);

supportRouter.get(
  '/mi-turno',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  manejar((req) => support.miTurno(usuarioDe(req), req.query.fecha as string)),
);

supportRouter.post(
  '/mi-turno/no-atendida',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  manejar((req) => support.noAtendida(validar(NoAtendidaDto, req.body), usuarioDe(req))),
);

supportRouter.post(
  '/office-ips',
  autenticar,
  exigirArea('gerencia', 'administracion', 'sistemas'),
  manejar((req) => support.setOfficeIps(req.body, usuarioDe(req))),
);

supportRouter.get(
  '/order-catalog',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  manejar((req) => support.orderCatalog()),
);

supportRouter.get(
  '/order-scores',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja', 'gerencia', 'sistemas'),
  manejar((req) => support.orderScores()),
);

supportRouter.put(
  '/order-scores',
  autenticar,
  exigirArea('gerencia', 'sistemas'),
  manejar((req) => support.saveOrderScores(validar(SaveOrderScoresDto, req.body), usuarioDe(req))),
);

supportRouter.get(
  '/stats',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  manejar((req) => support.stats(usuarioDe(req))),
);

supportRouter.get(
  '/technicians',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  manejar((req) => support.technicians()),
);

supportRouter.get(
  '/threads/:threadId/attachment',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  manejar((req, res) => support.attachment(req.params.threadId, res)),
);

supportRouter.get(
  '/tickets',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  manejar((req) => support.tickets(req.query.search as string, req.query.status as string, req.query.type as string, req.query.tec as string, req.query.priority as string, req.query.sede as string, req.query.from as string, req.query.to as string, req.query.all as string, req.query.page as string, req.query.pageSize as string, req.query.sortBy as string, req.query.sortDir as string, usuarioDe(req))),
);

supportRouter.post(
  '/tickets',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  manejar((req) => support.createTicket(validar(CreateTicketDto, req.body), usuarioDe(req))),
);

supportRouter.get(
  '/tickets/export.xlsx',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  manejar((req, res) => support.ticketsXlsx(res, req.query.search as string, req.query.status as string, req.query.type as string, req.query.tec as string, req.query.priority as string, req.query.sede as string, req.query.from as string, req.query.to as string, req.query.all as string, usuarioDe(req))),
);

supportRouter.get(
  '/tickets/:id',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  manejar((req) => support.ticketDetail(req.params.id, usuarioDe(req))),
);

supportRouter.post(
  '/tickets/:id/assign',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  manejar((req) => support.assign(req.params.id, validar(AssignDto, req.body))),
);

supportRouter.post(
  '/tickets/:id/attach',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  subirUno('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => { if (!existsSync(SUPPORT_ROOT)) mkdirSync(SUPPORT_ROOT, { recursive: true }); cb(null, SUPPORT_ROOT); },
        filename: (_req, file, cb) => cb(null, nombreEnDisco(randomUUID(), file.mimetype)),
      }),
      limits: { fileSize: 15 * 1024 * 1024 },
      // Lista blanca de MIME concretos, no `startsWith('image/')`: aquél aceptaba
      // cualquier `image/loquesea` y la extensión salía del nombre del cliente.
      fileFilter: (_req, file, cb) => cb(null, mimeAceptado(file.mimetype, MIMES_IMAGEN)),
    }),
  manejar((req) => support.attach(req.params.id, ficheroDe(req), validar(AttachDto, req.body), usuarioDe(req))),
);

supportRouter.post(
  '/tickets/:id/equipment',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  manejar((req) => support.assignEquipment(req.params.id, validar(AssignEquipmentDto, req.body), usuarioDe(req))),
);

supportRouter.post(
  '/tickets/:id/materials',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  manejar((req) => support.consumeMaterials(req.params.id, validar(ConsumeMaterialsDto, req.body), usuarioDe(req))),
);

supportRouter.get(
  '/tickets/:id/onu',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  manejar((req) => support.onuEstado(req.params.id, usuarioDe(req))),
);

supportRouter.post(
  '/tickets/:id/onu/autenticar',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  exigirPermisos(APP_PERMISSIONS.NETWORK_OLT_MANAGE),
  manejar((req) => support.autenticarOnu(req.params.id, validar(AutenticarOnuDto, req.body), usuarioDe(req))),
);

supportRouter.post(
  '/tickets/:id/onu/velocidad',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  exigirPermisos(APP_PERMISSIONS.NETWORK_OLT_MANAGE),
  manejar((req) => support.aplicarVelocidadOnu(req.params.id, usuarioDe(req))),
);

supportRouter.get(
  '/tickets/:id/pdf',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  manejar((req, res) => support.ticketPdf(req.params.id, res, usuarioDe(req))),
);

supportRouter.post(
  '/tickets/:id/priority',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  manejar((req) => support.setPriority(req.params.id, validar(PriorityDto, req.body))),
);

supportRouter.post(
  '/tickets/:id/signature',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  manejar((req) => support.sign(req.params.id, validar(SignatureDto, req.body))),
);

supportRouter.get(
  '/tickets/:id/signature.png',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  manejar((req, res) => support.signaturePng(req.params.id, res)),
);

supportRouter.post(
  '/tickets/:id/status',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  manejar((req, res) => support.updateStatus(req.params.id, validar(UpdateStatusDto, req.body), usuarioDe(req), req)),
);

supportRouter.post(
  '/tickets/:id/thread',
  autenticar,
  exigirArea('tecnicos', 'administracion', 'caja'),
  manejar((req) => support.thread(req.params.id, validar(ThreadDto, req.body), usuarioDe(req))),
);
