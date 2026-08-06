/**
 * Rutas de payment-imports — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en PaymentImportsController, que ya no lleva decoradores.
 *
 * Endpoints: 5
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { autenticar, exigirArea, usuarioDe } from '../core/auth/instancias';
import { ficheroDe, subirUno } from '../core/http/uploads';
import { PaymentImportsController } from './payment-imports.controller';
import { paymentImportsService } from '../core/contenedor';
import { BadRequestException } from '../core/http/errores';
import { PaymentImportsService } from './payment-imports.service';

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
  subirUno('file', { limits: { fileSize: 20 * 1024 * 1024 } }),
  manejar((req) => paymentImports.upload(ficheroDe(req), req.body?.date, usuarioDe(req))),
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

paymentImportsRouter.post(
  '/:id/process',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => paymentImports.process(req.params.id, usuarioDe(req))),
);
