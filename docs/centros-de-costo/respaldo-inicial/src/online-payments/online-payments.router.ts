/**
 * Rutas de online-payments — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en OnlinePaymentsController, que ya no lleva decoradores.
 *
 * Endpoints: 6
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirArea, usuarioDe } from '../core/auth/instancias';
import { OnlinePaymentsController } from './online-payments.controller';
import { onlinePaymentsService } from '../core/contenedor';
import { OnlinePaymentsService } from './online-payments.service';
import { ClavePortalDto, RunPuenteDto } from './dto/online-payments.dto';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const onlinePayments = new OnlinePaymentsController(onlinePaymentsService);

export const onlinePaymentsRouter = crearRouter();
onlinePaymentsRouter.get(
  '/',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'gerencia'),
  manejar((req) => onlinePayments.list(req.query as unknown as Record<string, string>)),
);

onlinePaymentsRouter.get(
  '/clave/:subscriberId',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'gerencia', 'caja'),
  manejar((req) => onlinePayments.credencial(req.params.subscriberId, usuarioDe(req))),
);

onlinePaymentsRouter.post(
  '/clave/:subscriberId',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'caja'),
  manejar((req) => onlinePayments.cambiarClave(req.params.subscriberId, validar(ClavePortalDto, req.body), usuarioDe(req))),
);

onlinePaymentsRouter.post(
  '/run',
  autenticar,
  exigirArea('administracion'),
  manejar((req) => onlinePayments.run(validar(RunPuenteDto, req.body), usuarioDe(req))),
);

onlinePaymentsRouter.get(
  '/summary',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'gerencia'),
  manejar((req) => onlinePayments.summary(req.query as unknown as Record<string, string>)),
);

onlinePaymentsRouter.get(
  '/:id',
  autenticar,
  exigirArea('contabilidad', 'administracion', 'gerencia'),
  manejar((req) => onlinePayments.detail(req.params.id)),
);
