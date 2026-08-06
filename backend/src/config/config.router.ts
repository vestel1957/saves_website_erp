/**
 * Rutas de config — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en ConfigController, que ya no lleva decoradores.
 *
 * Endpoints: 9
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirArea } from '../core/auth/instancias';
import { ConfigController } from './config.controller';
import { configDataService } from '../core/contenedor';
import { CategoryDto, ConfigDataService, UpdateBranchDto, UpdateCompanyDto } from './config.service';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const config = new ConfigController(configDataService);

export const configRouter = crearRouter();
configRouter.get(
  '/branches',
  autenticar,
  exigirArea('sistemas'),
  manejar((req) => config.branches()),
);

configRouter.patch(
  '/branches/:id',
  autenticar,
  exigirArea('sistemas'),
  manejar((req) => config.updateBranch(req.params.id, validar(UpdateBranchDto, req.body))),
);

configRouter.get(
  '/cash-accounts',
  autenticar,
  exigirArea('sistemas'),
  manejar((req) => config.cashAccounts()),
);

configRouter.get(
  '/categories',
  autenticar,
  exigirArea('sistemas'),
  manejar((req) => config.categories()),
);

configRouter.post(
  '/categories',
  autenticar,
  exigirArea('sistemas'),
  manejar((req) => config.createCategory(validar(CategoryDto, req.body))),
);

configRouter.delete(
  '/categories/:id',
  autenticar,
  exigirArea('sistemas'),
  manejar((req) => config.deleteCategory(req.params.id)),
);

configRouter.patch(
  '/categories/:id',
  autenticar,
  exigirArea('sistemas'),
  manejar((req) => config.updateCategory(req.params.id, validar(CategoryDto, req.body))),
);

configRouter.get(
  '/company',
  autenticar,
  exigirArea('sistemas'),
  manejar((req) => config.company()),
);

configRouter.patch(
  '/company',
  autenticar,
  exigirArea('sistemas'),
  manejar((req) => config.updateCompany(validar(UpdateCompanyDto, req.body))),
);
