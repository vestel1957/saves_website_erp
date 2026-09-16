/**
 * Rutas de extras — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en ExtrasController, que ya no lleva decoradores.
 *
 * Endpoints: 6
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { autenticar, exigirArea, usuarioDe } from '../core/auth/instancias';
import { ficheroDe, subirUno } from '../core/http/uploads';
import { ExtrasController, DOC_ROOT, EXT_DOCUMENTO } from './extras.controller';
import { extrasService } from '../core/contenedor';
import { BadRequestException } from '../core/http/errores';
import { diskStorage } from 'multer';
import { existsSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { ExtrasService } from './extras.service';
import { extensionDeAdjunto } from '../common/uploads';
import { variosDeQuery } from '../common/filtros-query';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const extras = new ExtrasController(extrasService);

export const extrasRouter = crearRouter();
extrasRouter.get(
  '/documents',
  autenticar,
  exigirArea('sistemas', 'administracion'),
  manejar((req) => extras.documents()),
);

extrasRouter.post(
  '/documents',
  autenticar,
  exigirArea('sistemas', 'administracion'),
  subirUno('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => { if (!existsSync(DOC_ROOT)) mkdirSync(DOC_ROOT, { recursive: true }); cb(null, DOC_ROOT); },
        filename: (_req, file, cb) => cb(null, `${randomUUID()}${extensionDeAdjunto(file, EXT_DOCUMENTO) ?? '.bin'}`),
      }),
      limits: { fileSize: 25 * 1024 * 1024 },
      // No tenía NINGÚN filtro: aceptaba cualquier extensión. Se sirve siempre como
      // descarga (`res.download`), así que no era ejecutable en el navegador, pero
      // no hay razón para dejar que el repositorio documental acepte binarios.
      fileFilter: (_req, file, cb) => {
        const ok = extensionDeAdjunto(file, EXT_DOCUMENTO) !== null;
        cb(ok ? null : new BadRequestException('Tipo de archivo no permitido'), ok);
      },
    }),
  manejar((req) => extras.uploadDocument(ficheroDe(req), req.body)),
);

extrasRouter.post(
  '/documents/folder',
  autenticar,
  exigirArea('sistemas', 'administracion'),
  manejar((req) => extras.createFolder(req.body)),
);

extrasRouter.get(
  '/documents/:id/download',
  autenticar,
  exigirArea('sistemas', 'administracion'),
  manejar((req, res) => extras.download(req.params.id, res)),
);

extrasRouter.get(
  '/messages',
  autenticar,
  exigirArea('sistemas', 'administracion'),
  manejar((req) => extras.messages(req.query.search as string, req.query.page as string, req.query.pageSize as string)),
);

extrasRouter.get(
  '/playhub',
  autenticar,
  exigirArea('sistemas', 'administracion'),
  manejar((req) => extras.playhub(usuarioDe(req), req.query.search as string, req.query.page as string, req.query.pageSize as string, req.query.sortBy as string, req.query.sortDir as string, req.query.estado as string, req.query.megas as string, req.query.nivel as string, req.query.sede as string)),
);
