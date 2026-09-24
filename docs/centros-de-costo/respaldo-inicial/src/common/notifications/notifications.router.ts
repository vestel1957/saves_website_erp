/**
 * Rutas de notifications — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en NotificationsController, que ya no lleva decoradores.
 *
 * Endpoints: 4
 */
import { crearRouter, manejar } from '../../core/http/ruta';
import { autenticar, usuarioDe } from '../../core/auth/instancias';
import { NotificationsController } from './notifications.controller';
import { notificationsService } from '../../core/contenedor';
import { NotificationsService } from './notifications.service';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const notifications = new NotificationsController(notificationsService);

export const notificationsRouter = crearRouter();
notificationsRouter.get(
  '/',
  autenticar,
  manejar((req) => notifications.list(usuarioDe(req))),
);

notificationsRouter.post(
  '/read-all',
  autenticar,
  manejar((req) => notifications.readAll(usuarioDe(req))),
);

notificationsRouter.post(
  '/read-group',
  autenticar,
  manejar((req) => notifications.readGroup(usuarioDe(req), req.body)),
);

notificationsRouter.post(
  '/:id/read',
  autenticar,
  manejar((req) => notifications.read(usuarioDe(req), req.params.id)),
);
