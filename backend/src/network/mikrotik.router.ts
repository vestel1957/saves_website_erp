/**
 * Rutas de network — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en MikrotikController, que ya no lleva decoradores.
 *
 * Endpoints: 17
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirArea, exigirPermisos, moduloRed, usuarioDe } from '../core/auth/instancias';
import { MikrotikController, KickDto, RouterUpsertDto, ToggleSecretDto } from './mikrotik.controller';
import { mikrotikAdminService } from '../core/contenedor';
import { Allow, IsBoolean, IsOptional, IsString } from 'class-validator';
import { MikrotikAdminService } from './mikrotik-admin.service';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const mikrotik = new MikrotikController(mikrotikAdminService);

export const mikrotikRouter = crearRouter();
mikrotikRouter.get(
  '/mikrotik/branches',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => mikrotik.branches()),
);

mikrotikRouter.get(
  '/mikrotik/mode',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => mikrotik.mode()),
);

mikrotikRouter.get(
  '/mikrotik/routers',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => mikrotik.routers()),
);

mikrotikRouter.post(
  '/mikrotik/routers',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  exigirPermisos(APP_PERMISSIONS.NETWORK_ROUTERS_MANAGE),
  moduloRed,
  manejar((req) => mikrotik.create(validar(RouterUpsertDto, req.body), usuarioDe(req))),
);

mikrotikRouter.delete(
  '/mikrotik/routers/:id',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => mikrotik.remove(req.params.id, usuarioDe(req))),
);

mikrotikRouter.patch(
  '/mikrotik/routers/:id',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  exigirPermisos(APP_PERMISSIONS.NETWORK_ROUTERS_MANAGE),
  moduloRed,
  manejar((req) => mikrotik.update(req.params.id, validar(RouterUpsertDto, req.body), usuarioDe(req))),
);

mikrotikRouter.post(
  '/mikrotik/routers/:id/default',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => mikrotik.setDefault(req.params.id, usuarioDe(req))),
);

mikrotikRouter.get(
  '/mikrotik/:id/active',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => mikrotik.active(req.params.id)),
);

mikrotikRouter.post(
  '/mikrotik/:id/active/kick',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  exigirPermisos(APP_PERMISSIONS.NETWORK_ROUTERS_MANAGE),
  moduloRed,
  manejar((req) => mikrotik.kick(req.params.id, validar(KickDto, req.body), usuarioDe(req))),
);

mikrotikRouter.get(
  '/mikrotik/:id/history',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => mikrotik.history(req.params.id, req.query.limit as string)),
);

mikrotikRouter.get(
  '/mikrotik/:id/ips',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => mikrotik.ips(req.params.id)),
);

mikrotikRouter.get(
  '/mikrotik/:id/profiles',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => mikrotik.profiles(req.params.id)),
);

mikrotikRouter.post(
  '/mikrotik/:id/secret/toggle',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  exigirPermisos(APP_PERMISSIONS.NETWORK_ROUTERS_MANAGE),
  moduloRed,
  manejar((req) => mikrotik.toggleSecret(req.params.id, validar(ToggleSecretDto, req.body), usuarioDe(req))),
);

mikrotikRouter.get(
  '/mikrotik/:id/secrets',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => mikrotik.secrets(req.params.id, req.query.search as string, req.query.page as string, req.query.pageSize as string, req.query.sortBy as string, req.query.sortDir as string)),
);

mikrotikRouter.get(
  '/mikrotik/:id/summary',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => mikrotik.summary(req.params.id)),
);

mikrotikRouter.get(
  '/mikrotik/:id/system',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => mikrotik.system(req.params.id)),
);

mikrotikRouter.post(
  '/mikrotik/:id/test',
  autenticar,
  exigirArea('tecnicos', 'administracion'),
  moduloRed,
  manejar((req) => mikrotik.test(req.params.id, usuarioDe(req))),
);
