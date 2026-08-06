/**
 * Rutas de returns — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en ReturnsController, que ya no lleva decoradores.
 *
 * Endpoints: 6
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirArea, usuarioDe } from '../core/auth/instancias';
import { ReturnsController } from './returns.controller';
import { returnsService } from '../core/contenedor';
import { ReturnsService, CreateReturnDto, PayReturnDto } from './returns.service';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const returns = new ReturnsController(returnsService);

export const returnsRouter = crearRouter();
returnsRouter.get(
  '/',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => returns.list(req.query.search as string, req.query.status as string, req.query.page as string, req.query.pageSize as string, req.query.sortBy as string, req.query.sortDir as string)),
);

returnsRouter.post(
  '/',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => returns.create(validar(CreateReturnDto, req.body), usuarioDe(req))),
);

returnsRouter.get(
  '/stats',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => returns.stats()),
);

returnsRouter.delete(
  '/:id',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => returns.remove(req.params.id)),
);

returnsRouter.get(
  '/:id',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => returns.detail(req.params.id)),
);

returnsRouter.post(
  '/:id/pay',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => returns.pay(req.params.id, validar(PayReturnDto, req.body), usuarioDe(req))),
);
