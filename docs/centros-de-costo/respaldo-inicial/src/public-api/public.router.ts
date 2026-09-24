/**
 * Rutas de public — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en PublicController, que ya no lleva decoradores.
 *
 * Endpoints: 4
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { apiKey, apiKeyCon } from '../core/auth/instancias';
import { PublicController } from './public.controller';
import { publicService } from '../core/contenedor';
import { PublicService } from './public.service';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const publicControlador = new PublicController(publicService);

export const publicRouter = crearRouter();
publicRouter.get(
  '/v1/clients',
  apiKeyCon('clients:read'),
  manejar((req) => publicControlador.clients(req.query.page as string, req.query.pageSize as string, req.query.search as string)),
);

publicRouter.get(
  '/v1/clients/:id',
  apiKeyCon('clients:read'),
  manejar((req) => publicControlador.client(req.params.id)),
);

publicRouter.get(
  '/v1/clients/:id/invoices',
  apiKeyCon('invoices:read'),
  manejar((req) => publicControlador.clientInvoices(req.params.id, req.query.page as string, req.query.pageSize as string)),
);

publicRouter.get(
  '/v1/ping',
  apiKey,
  manejar((req) => publicControlador.ping()),
);
