/**
 * Rutas de tasks — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en TasksController, que ya no lleva decoradores.
 *
 * Endpoints: 15
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirArea, usuarioDe } from '../core/auth/instancias';
import { ficheroDe, subirUno } from '../core/http/uploads';
import { TasksController, ALLOWED_EXT, MAX_FILE_BYTES, UPLOAD_ROOT } from './tasks.controller';
import { tasksService } from '../core/contenedor';
import type { Response } from 'express';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { diskStorage } from 'multer';
import { BadRequestException, NotFoundException } from '../core/http/errores';
import { TasksService } from './tasks.service';
import { CreateTaskDto, UpdateTaskDto, NoteDto, AttachNoteDto } from './dto/tasks.dto';
import { enviarAdjuntoSeguro, extensionDeAdjunto, mimeAceptado, nombreEnDisco, MIMES_IMAGEN } from '../common/uploads';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const tasks = new TasksController(tasksService);

export const tasksRouter = crearRouter();
tasksRouter.get(
  '/',
  autenticar,
  exigirArea('administracion', 'gerencia', 'caja'),
  manejar((req) => tasks.list(req.query as unknown as Record<string, string | undefined>, usuarioDe(req))),
);

tasksRouter.post(
  '/',
  autenticar,
  exigirArea('administracion', 'gerencia', 'caja'),
  manejar((req) => tasks.create(validar(CreateTaskDto, req.body), usuarioDe(req))),
);

tasksRouter.get(
  '/assignees',
  autenticar,
  exigirArea('administracion', 'gerencia', 'caja'),
  manejar((req) => tasks.assignees()),
);

tasksRouter.get(
  '/stats',
  autenticar,
  exigirArea('administracion', 'gerencia', 'caja'),
  manejar((req) => tasks.stats(usuarioDe(req))),
);

tasksRouter.delete(
  '/:id',
  autenticar,
  exigirArea('administracion', 'gerencia', 'caja'),
  manejar((req) => tasks.remove(req.params.id)),
);

tasksRouter.get(
  '/:id',
  autenticar,
  exigirArea('administracion', 'gerencia', 'caja'),
  manejar((req) => tasks.detail(req.params.id)),
);

tasksRouter.patch(
  '/:id',
  autenticar,
  exigirArea('administracion', 'gerencia', 'caja'),
  manejar((req) => tasks.update(req.params.id, validar(UpdateTaskDto, req.body), usuarioDe(req))),
);

tasksRouter.get(
  '/:id/files',
  autenticar,
  exigirArea('administracion', 'gerencia', 'caja'),
  manejar((req) => tasks.files(req.params.id)),
);

tasksRouter.post(
  '/:id/files',
  autenticar,
  exigirArea('administracion', 'gerencia', 'caja'),
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
      // Se valida con `extensionDeAdjunto` y no con la extensión del nombre a secas:
      // adjuntando desde el móvil el nombre puede llegar sin extensión. La lista
      // blanca es la misma; sólo cambia de dónde se deduce.
      fileFilter: (_req, file, cb) => {
        const ok = extensionDeAdjunto(file, ALLOWED_EXT) !== null;
        cb(ok ? null : new BadRequestException('Tipo de archivo no permitido'), ok);
      },
    }),
  manejar((req) => tasks.upload(req.params.id, ficheroDe(req), usuarioDe(req))),
);

tasksRouter.delete(
  '/:id/files/:fileId',
  autenticar,
  exigirArea('administracion', 'gerencia', 'caja'),
  manejar((req) => tasks.deleteFile(req.params.id, req.params.fileId)),
);

tasksRouter.get(
  '/:id/files/:fileId/download',
  autenticar,
  exigirArea('administracion', 'gerencia', 'caja'),
  manejar((req, res) => tasks.download(req.params.id, req.params.fileId, res)),
);

tasksRouter.get(
  '/:id/notes',
  autenticar,
  exigirArea('administracion', 'gerencia', 'caja'),
  manejar((req) => tasks.notes(req.params.id)),
);

tasksRouter.post(
  '/:id/notes',
  autenticar,
  exigirArea('administracion', 'gerencia', 'caja'),
  manejar((req) => tasks.addNote(req.params.id, validar(NoteDto, req.body), usuarioDe(req))),
);

tasksRouter.post(
  '/:id/notes/attach',
  autenticar,
  exigirArea('administracion', 'gerencia', 'caja'),
  subirUno('file', {
      storage: diskStorage({
        destination: (req, _file, cb) => {
          const dir = join(UPLOAD_ROOT, (req.params as { id: string }).id);
          mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (_req, file, cb) => cb(null, nombreEnDisco(randomUUID(), file.mimetype)),
      }),
      limits: { fileSize: 15 * 1024 * 1024 },
      // Lista blanca de MIME concretos (la misma del hilo de la orden): la evidencia
      // es una foto, y la extensión se deduce del tipo y no del nombre del cliente.
      fileFilter: (_req, file, cb) => cb(null, mimeAceptado(file.mimetype, MIMES_IMAGEN)),
    }),
  manejar((req) => tasks.attachNote(req.params.id, ficheroDe(req), validar(AttachNoteDto, req.body), usuarioDe(req))),
);

tasksRouter.get(
  '/:id/notes/:noteId/attachment',
  autenticar,
  exigirArea('administracion', 'gerencia', 'caja'),
  manejar((req, res) => tasks.noteAttachment(req.params.id, req.params.noteId, res)),
);
