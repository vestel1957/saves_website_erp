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
import { autenticar, exigirArea, exigirAreaCon, usuarioDe } from '../core/auth/instancias';
import { PlayhubController, ProductDto } from './playhub.controller';
import { playhubService } from '../core/contenedor';
import { IsString, MinLength } from 'class-validator';
import { PlayhubService } from './playhub.service';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const playhub = new PlayhubController(playhubService);

export const playhubRouter = crearRouter();
playhubRouter.get(
  '/catalog',
  autenticar,
  exigirAreaCon({ areas: ['administracion', 'tecnicos', 'gerencia', 'sistemas'], orPermission: [APP_PERMISSIONS.PLAYHUB_OPERATE] }),
  manejar((req) => playhub.catalog()),
);

playhubRouter.get(
  '/status',
  autenticar,
  exigirAreaCon({ areas: ['administracion', 'tecnicos', 'gerencia', 'sistemas'], orPermission: [APP_PERMISSIONS.PLAYHUB_OPERATE] }),
  manejar((req) => playhub.status()),
);

playhubRouter.get(
  '/subscribers/:id/eligibility',
  autenticar,
  exigirAreaCon({ areas: ['administracion', 'tecnicos', 'gerencia', 'sistemas'], orPermission: [APP_PERMISSIONS.PLAYHUB_OPERATE] }),
  manejar((req) => playhub.eligibility(usuarioDe(req), req.params.id)),
);

playhubRouter.get(
  '/subscribers/:id/live',
  autenticar,
  exigirAreaCon({ areas: ['administracion', 'tecnicos', 'gerencia', 'sistemas'], orPermission: [APP_PERMISSIONS.PLAYHUB_OPERATE] }),
  manejar((req) => playhub.live(usuarioDe(req), req.params.id)),
);

playhubRouter.get(
  '/subscribers/:id/local',
  autenticar,
  exigirAreaCon({ areas: ['administracion', 'tecnicos', 'gerencia', 'sistemas'], orPermission: [APP_PERMISSIONS.PLAYHUB_OPERATE] }),
  manejar((req) => playhub.local(usuarioDe(req), req.params.id)),
);

playhubRouter.post(
  '/subscribers/:id/subscribe',
  autenticar,
  exigirAreaCon({ areas: ['administracion', 'tecnicos', 'gerencia', 'sistemas'], orPermission: [APP_PERMISSIONS.PLAYHUB_OPERATE] }),
  manejar((req) => playhub.subscribe(usuarioDe(req), req.params.id, validar(ProductDto, req.body))),
);

playhubRouter.post(
  '/subscribers/:id/sync-customer',
  autenticar,
  exigirAreaCon({ areas: ['administracion', 'tecnicos', 'gerencia', 'sistemas'], orPermission: [APP_PERMISSIONS.PLAYHUB_OPERATE] }),
  manejar((req) => playhub.syncCustomer(usuarioDe(req), req.params.id)),
);

playhubRouter.post(
  '/subscribers/:id/sync-local',
  autenticar,
  exigirAreaCon({ areas: ['administracion', 'tecnicos', 'gerencia', 'sistemas'], orPermission: [APP_PERMISSIONS.PLAYHUB_OPERATE] }),
  manejar((req) => playhub.syncLocal(usuarioDe(req), req.params.id)),
);

playhubRouter.post(
  '/subscribers/:id/unsubscribe',
  autenticar,
  exigirAreaCon({ areas: ['administracion', 'tecnicos', 'gerencia', 'sistemas'], orPermission: [APP_PERMISSIONS.PLAYHUB_OPERATE] }),
  manejar((req) => playhub.unsubscribe(usuarioDe(req), req.params.id, validar(ProductDto, req.body))),
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
