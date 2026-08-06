/**
 * Rutas de admin — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en ApiKeysController, que ya no lleva decoradores.
 *
 * Endpoints: 5
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { autenticar, exigirPermisos, usuarioDe } from '../core/auth/instancias';
import { ApiKeysController } from './api-keys.controller';
import { apiKeysService } from '../core/contenedor';
import { ALL_SCOPES, ApiKeysService, CreateApiKeyDto } from './api-keys.service';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const apiKeys = new ApiKeysController(apiKeysService);

export const apiKeysRouter = crearRouter();
apiKeysRouter.get(
  '/api-keys',
  autenticar,
  exigirPermisos('system.admin'),
  manejar((req) => apiKeys.list()),
);

apiKeysRouter.post(
  '/api-keys',
  autenticar,
  exigirPermisos('system.admin'),
  manejar((req) => apiKeys.create(req.body, usuarioDe(req))),
);

apiKeysRouter.patch(
  '/api-keys/:id',
  autenticar,
  exigirPermisos('system.admin'),
  manejar((req) => apiKeys.toggle(req.params.id, req.body)),
);

apiKeysRouter.post(
  '/api-keys/:id/revoke',
  autenticar,
  exigirPermisos('system.admin'),
  manejar((req) => apiKeys.revoke(req.params.id)),
);

apiKeysRouter.get(
  '/api-keys/scopes',
  autenticar,
  exigirPermisos('system.admin'),
  manejar((req) => apiKeys.scopes()),
);
