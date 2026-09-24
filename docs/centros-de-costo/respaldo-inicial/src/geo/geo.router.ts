/**
 * Rutas de geo — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en GeoController, que ya no lleva decoradores.
 *
 * Endpoints: 7
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar, validarQuery } from '../core/http/validar';
import { autenticar, exigirArea, usuarioDe } from '../core/auth/instancias';
import { GeoController } from './geo.controller';
import { geoService } from '../core/contenedor';
import { GeoService } from './geo.service';
import { MapQueryDto, PingDto, RouteDto, SetSubscriberLocationDto } from './dto/geo.dto';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const geo = new GeoController(geoService);

export const geoRouter = crearRouter();
geoRouter.get(
  '/coverage',
  autenticar,
  exigirArea('gerencia', 'administracion', 'contabilidad', 'tecnicos', 'sistemas', 'caja'),
  manejar((req) => geo.coverage(usuarioDe(req))),
);

geoRouter.post(
  '/ping',
  autenticar,
  exigirArea('gerencia', 'administracion', 'contabilidad', 'tecnicos', 'sistemas', 'caja'),
  manejar((req) => geo.ping(usuarioDe(req), validar(PingDto, req.body))),
);

geoRouter.get(
  '/points',
  autenticar,
  exigirArea('gerencia', 'administracion', 'contabilidad', 'tecnicos', 'sistemas', 'caja'),
  manejar((req) => geo.points(usuarioDe(req), validarQuery(MapQueryDto, req.query))),
);

geoRouter.post(
  '/route',
  autenticar,
  exigirArea('gerencia', 'administracion', 'contabilidad', 'tecnicos', 'sistemas', 'caja'),
  manejar((req) => geo.route(usuarioDe(req), validar(RouteDto, req.body))),
);

geoRouter.put(
  '/subscribers/:id/location',
  autenticar,
  exigirArea('gerencia', 'administracion', 'tecnicos', 'sistemas'),
  manejar((req) => geo.setSubscriberLocation(usuarioDe(req), req.params.id, validar(SetSubscriberLocationDto, req.body))),
);

geoRouter.get(
  '/technicians',
  autenticar,
  exigirArea('gerencia', 'administracion', 'sistemas'),
  manejar((req) => geo.technicians(usuarioDe(req), req.query.horas as string)),
);

geoRouter.get(
  '/trail/:userId',
  autenticar,
  exigirArea('gerencia', 'administracion', 'sistemas'),
  manejar((req) => geo.trail(req.params.userId, req.query.fecha as string)),
);
