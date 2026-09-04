/**
 * Rutas de network — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en GenieacsController, que ya no lleva decoradores.
 *
 * Endpoints: 17
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirArea, exigirPermisos, moduloRed, usuarioDe } from '../core/auth/instancias';
import { GenieacsController, BatchDto, RefreshDto, ServerUpsertDto, WifiDto } from './genieacs.controller';
import { genieacsService } from '../core/contenedor';
import { ArrayNotEmpty, Allow, IsArray, IsOptional, IsString } from 'class-validator';
import { GenieacsService } from './genieacs.service';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const genieacs = new GenieacsController(genieacsService);

export const genieacsRouter = crearRouter();
genieacsRouter.post(
  '/genieacs/cut-tv',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => genieacs.cutTv(validar(BatchDto, req.body), usuarioDe(req))),
);

genieacsRouter.get(
  '/genieacs/dashboard',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => genieacs.dashboard(req.query.serverId as string)),
);

genieacsRouter.get(
  '/genieacs/history',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => genieacs.history(req.query.serverId as string, req.query.limit as string)),
);

genieacsRouter.post(
  '/genieacs/install-provision',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => genieacs.install(req.body?.serverId, usuarioDe(req))),
);

genieacsRouter.get(
  '/genieacs/inventory',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => genieacs.inventory(req.query.serverId as string, req.query.search as string, req.query.model as string, req.query.manufacturer as string, req.query.estado as string, req.query.sortBy as string, req.query.sortDir as string, req.query.page as string, req.query.pageSize as string)),
);

genieacsRouter.get(
  '/genieacs/mode',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => genieacs.mode()),
);

genieacsRouter.post(
  '/genieacs/refresh',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => genieacs.refresh(validar(RefreshDto, req.body), usuarioDe(req))),
);

genieacsRouter.post(
  '/genieacs/restore-tv',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => genieacs.restoreTv(validar(BatchDto, req.body), usuarioDe(req))),
);

genieacsRouter.get(
  '/genieacs/servers',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => genieacs.servers()),
);

genieacsRouter.post(
  '/genieacs/servers',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => genieacs.create(validar(ServerUpsertDto, req.body), usuarioDe(req))),
);

genieacsRouter.delete(
  '/genieacs/servers/:id',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => genieacs.remove(req.params.id, usuarioDe(req))),
);

genieacsRouter.patch(
  '/genieacs/servers/:id',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => genieacs.update(req.params.id, validar(ServerUpsertDto, req.body), usuarioDe(req))),
);

genieacsRouter.post(
  '/genieacs/servers/:id/default',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => genieacs.setDefault(req.params.id)),
);

genieacsRouter.post(
  '/genieacs/servers/:id/test',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => genieacs.test(req.params.id, usuarioDe(req))),
);

genieacsRouter.post(
  '/genieacs/tv-cut-subscribers',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  exigirPermisos(APP_PERMISSIONS.NETWORK_CUT),
  moduloRed,
  manejar((req) => genieacs.tvCutSubs(validar(BatchDto, req.body), usuarioDe(req))),
);

genieacsRouter.post(
  '/genieacs/tv-restore-subscribers',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  exigirPermisos(APP_PERMISSIONS.NETWORK_RECONNECT),
  moduloRed,
  manejar((req) => genieacs.tvRestoreSubs(validar(BatchDto, req.body), usuarioDe(req))),
);

genieacsRouter.post(
  '/genieacs/wifi',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => genieacs.setWifi(validar(WifiDto, req.body), usuarioDe(req))),
);
