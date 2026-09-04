/**
 * Rutas de payment-imports — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en PaymentImportsController, que ya no lleva decoradores.
 *
 * Endpoints: 7
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { autenticar, exigirArea, usuarioDe } from '../core/auth/instancias';
import { ficheroDe, subirUno } from '../core/http/uploads';
import { PaymentImportsController, PAYMENT_IMPORTS_ROOT } from './payment-imports.controller';
import { paymentImportsService } from '../core/contenedor';
import type { Response } from 'express';
import { diskStorage } from 'multer';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BadRequestException } from '../core/http/errores';
import { PaymentImportsService } from './payment-imports.service';
import { enviarAdjuntoSeguro } from '../common/uploads';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const paymentImports = new PaymentImportsController(paymentImportsService);

export const paymentImportsRouter = crearRouter();
paymentImportsRouter.get(
  '/',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => paymentImports.list()),
);

paymentImportsRouter.post(
  '/upload',
  autenticar,
  exigirArea('administracion'),
  subirUno('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => { if (!existsSync(PAYMENT_IMPORTS_ROOT)) mkdirSync(PAYMENT_IMPORTS_ROOT, { recursive: true }); cb(null, PAYMENT_IMPORTS_ROOT); },
        filename: (_req, _file, cb) => cb(null, `${randomUUID()}.xlsx`),
      }),
      limits: { fileSize: 20 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => cb(/\.xlsx$/i.test(file.originalname) ? null : new BadRequestException('Solo se aceptan archivos .xlsx'), /\.xlsx$/i.test(file.originalname)),
    }),
  manejar((req) => paymentImports.upload(ficheroDe(req), req.body?.date, req.body?.mode, usuarioDe(req))),
);

paymentImportsRouter.delete(
  '/:id',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => paymentImports.remove(req.params.id)),
);

paymentImportsRouter.get(
  '/:id',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => paymentImports.detail(req.params.id)),
);

paymentImportsRouter.get(
  '/:id/file',
  autenticar,
  exigirArea('administracion'),
  manejar((req, res) => paymentImports.file(req.params.id, res)),
);

paymentImportsRouter.post(
  '/:id/process',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => paymentImports.process(req.params.id, req.query.limit as string | undefined, usuarioDe(req))),
);

paymentImportsRouter.post(
  '/:id/retry',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => paymentImports.retry(req.params.id)),
);
