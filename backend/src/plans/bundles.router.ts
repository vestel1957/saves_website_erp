/**
 * Rutas de combos comerciales.
 *
 * ESCRITO A MANO (a diferencia de `plans.router.ts`): el generador de routers
 * deriva de `contrato-http.json`, que es la foto de los controladores Nest que
 * se portaron. Un módulo nuevo no está en ese contrato, así que no se regenera
 * —ni se pisa— al correr `npm run generar:routers`.
 *
 * Va en su propio prefijo y no colgando de `/plans` a propósito: `/plans/:id`
 * se tragaría un `/plans/bundles/:id` en PATCH y DELETE.
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirArea } from '../core/auth/instancias';
import { BundlesController } from './bundles.controller';
import { bundlesService } from '../core/contenedor';
import { CreateBundleDto, UpdateBundleDto } from './dto/bundle.dto';

const bundles = new BundlesController(bundlesService);

export const bundlesRouter = crearRouter();

// Leer el catálogo de combos lo necesita quien vende (caja, técnicos), igual
// que el catálogo de planes.
bundlesRouter.get(
  '/',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'sistemas', 'caja'),
  manejar((req) => bundles.list(req.query.activeOnly as string)),
);

// Catálogo de apps para armar el combo. Va antes de cualquier `/:id` y lo lee
// quien vende, que también necesita saber qué apps ofrece cada combo.
bundlesRouter.get(
  '/apps',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'tecnicos', 'sistemas', 'caja'),
  manejar(() => bundles.apps()),
);

// Escribir es fijar el PRECIO con el que se vende: mismas manos que el catálogo.
bundlesRouter.post(
  '/',
  autenticar,
  exigirArea('sistemas', 'administracion'),
  manejar((req) => bundles.create(validar(CreateBundleDto, req.body))),
);

bundlesRouter.patch(
  '/:id',
  autenticar,
  exigirArea('sistemas', 'administracion'),
  manejar((req) => bundles.update(req.params.id, validar(UpdateBundleDto, req.body))),
);

bundlesRouter.delete(
  '/:id',
  autenticar,
  exigirArea('sistemas', 'administracion'),
  manejar((req) => bundles.remove(req.params.id)),
);
