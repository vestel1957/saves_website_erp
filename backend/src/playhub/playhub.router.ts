/**
 * Rutas de playhub — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en PlayhubController, que ya no lleva decoradores.
 *
 * Endpoints: 11
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirArea } from '../core/auth/instancias';
import { PlayhubController, ProductDto } from './playhub.controller';
import { playhubService } from '../core/contenedor';
import { IsString, MinLength } from 'class-validator';
import { PlayhubService } from './playhub.service';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const playhub = new PlayhubController(playhubService);

export const playhubRouter = crearRouter();
playhubRouter.get(
  '/catalog',
  autenticar,
  exigirArea('administracion', 'tecnicos', 'gerencia', 'sistemas'),
  manejar((req) => playhub.catalog()),
);

playhubRouter.get(
  '/status',
  autenticar,
  exigirArea('administracion', 'tecnicos', 'gerencia', 'sistemas'),
  manejar((req) => playhub.status()),
);

playhubRouter.get(
  '/subscribers/:id/eligibility',
  autenticar,
  exigirArea('administracion', 'tecnicos', 'gerencia', 'sistemas'),
  manejar((req) => playhub.eligibility(req.params.id)),
);

playhubRouter.get(
  '/subscribers/:id/live',
  autenticar,
  exigirArea('administracion', 'tecnicos', 'gerencia', 'sistemas'),
  manejar((req) => playhub.live(req.params.id)),
);

playhubRouter.get(
  '/subscribers/:id/local',
  autenticar,
  exigirArea('administracion', 'tecnicos', 'gerencia', 'sistemas'),
  manejar((req) => playhub.local(req.params.id)),
);

playhubRouter.post(
  '/subscribers/:id/subscribe',
  autenticar,
  exigirArea('administracion', 'tecnicos', 'gerencia', 'sistemas'),
  manejar((req) => playhub.subscribe(req.params.id, validar(ProductDto, req.body))),
);

playhubRouter.post(
  '/subscribers/:id/sync-customer',
  autenticar,
  exigirArea('administracion', 'tecnicos', 'gerencia', 'sistemas'),
  manejar((req) => playhub.syncCustomer(req.params.id)),
);

playhubRouter.post(
  '/subscribers/:id/sync-local',
  autenticar,
  exigirArea('administracion', 'tecnicos', 'gerencia', 'sistemas'),
  manejar((req) => playhub.syncLocal(req.params.id)),
);

playhubRouter.post(
  '/subscribers/:id/unsubscribe',
  autenticar,
  exigirArea('administracion', 'tecnicos', 'gerencia', 'sistemas'),
  manejar((req) => playhub.unsubscribe(req.params.id, validar(ProductDto, req.body))),
);

playhubRouter.post(
  '/sync-all',
  autenticar,
  exigirArea('administracion', 'tecnicos', 'gerencia', 'sistemas'),
  manejar((req) => playhub.syncAll(req.query.limit as string)),
);

playhubRouter.get(
  '/sync-status',
  autenticar,
  exigirArea('administracion', 'tecnicos', 'gerencia', 'sistemas'),
  manejar((req) => playhub.syncStatus()),
);
