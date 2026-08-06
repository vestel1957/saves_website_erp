/**
 * Rutas de staff — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en StaffController, que ya no lleva decoradores.
 *
 * Endpoints: 22
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirArea, exigirPermisos, usuarioDe } from '../core/auth/instancias';
import { ficheroDe, subirUno } from '../core/http/uploads';
import { StaffController, DOCS_ROOT, MAX_DOC_BYTES } from './staff.controller';
import { performanceService, staffDocumentsService, staffService } from '../core/contenedor';
import { BadRequestException, NotFoundException } from '../core/http/errores';
import { diskStorage } from 'multer';
import type { Response } from 'express';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MIMES_DOCUMENTO, enviarAdjuntoSeguro, mimeAceptado, nombreEnDisco } from '../common/uploads';
import { StaffDocumentsService, type ArchivoSubido } from './staff-documents.service';
import { StaffService, CreateStaffDto, UpdateStaffDto, SetStaffPermissionsDto, SetStaffRolesDto, CreateStaffAccountDto, SetStaffAccountActiveDto, SetStaffBannedDto, ResetStaffPasswordDto } from './staff.service';
import { PerformanceService } from '../reports/performance.service';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const staff = new StaffController(staffService, staffDocumentsService, performanceService);

export const staffRouter = crearRouter();
staffRouter.get(
  '/',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  manejar((req) => staff.list(usuarioDe(req), req.query.search as string, req.query.role as string, req.query.areaId as string, req.query.inhabilitados as string, req.query.page as string, req.query.pageSize as string, req.query.sortBy as string, req.query.sortDir as string)),
);

staffRouter.post(
  '/',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  manejar((req) => staff.create(validar(CreateStaffDto, req.body))),
);

staffRouter.get(
  '/areas',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  manejar((req) => staff.areas()),
);

staffRouter.get(
  '/role-catalog',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  manejar((req) => staff.roleCatalog()),
);

staffRouter.get(
  '/stats',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  manejar((req) => staff.stats()),
);

staffRouter.get(
  '/:id',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  manejar((req) => staff.detail(req.params.id)),
);

staffRouter.patch(
  '/:id',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  manejar((req) => staff.update(req.params.id, validar(UpdateStaffDto, req.body), usuarioDe(req))),
);

staffRouter.post(
  '/:id/account',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  exigirPermisos(APP_PERMISSIONS.SYSTEM_ADMIN),
  manejar((req) => staff.createAccount(req.params.id, validar(CreateStaffAccountDto, req.body), usuarioDe(req))),
);

staffRouter.patch(
  '/:id/account/active',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  exigirPermisos(APP_PERMISSIONS.SYSTEM_ADMIN),
  manejar((req) => staff.setAccountActive(req.params.id, validar(SetStaffAccountActiveDto, req.body), usuarioDe(req))),
);

staffRouter.post(
  '/:id/account/password',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  exigirPermisos(APP_PERMISSIONS.SYSTEM_ADMIN),
  manejar((req) => staff.resetPassword(req.params.id, validar(ResetStaffPasswordDto, req.body), usuarioDe(req))),
);

staffRouter.post(
  '/:id/account/password/code',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  exigirPermisos(APP_PERMISSIONS.SYSTEM_ADMIN),
  manejar((req) => staff.requestPasswordCode(req.params.id, usuarioDe(req))),
);

staffRouter.get(
  '/:id/account/password/policy',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  exigirPermisos(APP_PERMISSIONS.SYSTEM_ADMIN),
  manejar((req) => staff.passwordPolicy(req.params.id)),
);

staffRouter.get(
  '/:id/audit',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  manejar((req) => staff.audit(req.params.id)),
);

staffRouter.patch(
  '/:id/banned',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  exigirPermisos(APP_PERMISSIONS.SYSTEM_ADMIN),
  manejar((req) => staff.setBanned(req.params.id, validar(SetStaffBannedDto, req.body), usuarioDe(req))),
);

staffRouter.get(
  '/:id/documents',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  exigirPermisos(APP_PERMISSIONS.HR_EMPLOYEES_READ),
  manejar((req) => staff.listDocuments(req.params.id)),
);

staffRouter.post(
  '/:id/documents',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  exigirPermisos(APP_PERMISSIONS.HR_EMPLOYEES_WRITE),
  subirUno('file', {
      storage: diskStorage({
        destination: (req, _file, cb) => {
          const dir = join(DOCS_ROOT, (req.params as { id: string }).id);
          mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        // La extensión sale del MIME ya validado por `fileFilter`, NUNCA del
        // `originalname`: por ahí es por donde entraba un .html disfrazado.
        filename: (_req, file, cb) => cb(null, nombreEnDisco(randomUUID(), file.mimetype)),
      }),
      limits: { fileSize: MAX_DOC_BYTES },
      fileFilter: (_req, file, cb) => {
        const ok = mimeAceptado(file.mimetype, MIMES_DOCUMENTO);
        cb(ok ? null : new BadRequestException('Solo se aceptan PDF, imágenes o Word'), ok);
      },
    }),
  manejar((req) => staff.uploadDocument(req.params.id, ficheroDe(req), req.body?.kind, req.body?.description, usuarioDe(req))),
);

staffRouter.delete(
  '/:id/documents/:docId',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  exigirPermisos(APP_PERMISSIONS.HR_EMPLOYEES_WRITE),
  manejar((req) => staff.deleteDocument(req.params.id, req.params.docId)),
);

staffRouter.get(
  '/:id/documents/:docId/download',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  exigirPermisos(APP_PERMISSIONS.HR_EMPLOYEES_READ),
  manejar((req, res) => staff.downloadDocument(req.params.id, req.params.docId, res)),
);

staffRouter.get(
  '/:id/permissions',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  manejar((req) => staff.permissions(req.params.id)),
);

staffRouter.patch(
  '/:id/permissions',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  exigirPermisos(APP_PERMISSIONS.SYSTEM_ADMIN),
  manejar((req) => staff.setPermissions(req.params.id, validar(SetStaffPermissionsDto, req.body), usuarioDe(req))),
);

staffRouter.get(
  '/:id/rendimiento',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  manejar((req) => staff.rendimiento(req.params.id, req.query.from as string, req.query.to as string)),
);

staffRouter.patch(
  '/:id/roles',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  exigirPermisos(APP_PERMISSIONS.SYSTEM_ADMIN),
  manejar((req) => staff.setRoles(req.params.id, validar(SetStaffRolesDto, req.body), usuarioDe(req))),
);
