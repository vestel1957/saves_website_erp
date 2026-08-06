/**
 * Rutas de plans — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en PlansController, que ya no lleva decoradores.
 *
 * Endpoints: 4
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirArea } from '../core/auth/instancias';
import { PlansController } from './plans.controller';
import { plansService } from '../core/contenedor';
import { ServiceKind } from '@prisma/client';
import { PlansService } from './plans.service';
import { CreatePlanDto, UpdatePlanDto } from './dto/plan.dto';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const plans = new PlansController(plansService);

export const plansRouter = crearRouter();
plansRouter.get(
  '/',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'sistemas', 'caja'),
  manejar((req) => plans.list(req.query.activeOnly as string, req.query.kind as ServiceKind)),
);

plansRouter.post(
  '/',
  autenticar,
  exigirArea('sistemas', 'administracion'),
  manejar((req) => plans.create(validar(CreatePlanDto, req.body))),
);

plansRouter.delete(
  '/:id',
  autenticar,
  exigirArea('sistemas', 'administracion'),
  manejar((req) => plans.remove(req.params.id)),
);

plansRouter.patch(
  '/:id',
  autenticar,
  exigirArea('sistemas', 'administracion'),
  manejar((req) => plans.update(req.params.id, validar(UpdatePlanDto, req.body))),
);
