/**
 * Rutas de responsibilities — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en ResponsibilitiesController, que ya no lleva decoradores.
 *
 * Endpoints: 3
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirArea, usuarioDe } from '../core/auth/instancias';
import { ResponsibilitiesController } from './responsibilities.controller';
import { responsibilitiesService } from '../core/contenedor';
import { ResponsibilitiesService } from './responsibilities.service';
import { SetHoldersDto } from './dto/responsibilities.dto';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const responsibilities = new ResponsibilitiesController(responsibilitiesService);

export const responsibilitiesRouter = crearRouter();
responsibilitiesRouter.get(
  '/',
  autenticar,
  exigirArea('sistemas', 'gerencia'),
  manejar((req) => responsibilities.list()),
);

responsibilitiesRouter.put(
  '/:post',
  autenticar,
  exigirArea('sistemas', 'gerencia'),
  manejar((req) => responsibilities.set(req.params.post, validar(SetHoldersDto, req.body), usuarioDe(req))),
);

responsibilitiesRouter.get(
  '/assignable',
  autenticar,
  exigirArea('sistemas', 'gerencia'),
  manejar((req) => responsibilities.assignable()),
);
