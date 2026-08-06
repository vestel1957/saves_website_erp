/**
 * Rutas de clausulas — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en ClausulasController, que ya no lleva decoradores.
 *
 * Endpoints: 4
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirArea, exigirPermisos } from '../core/auth/instancias';
import { ClausulasController } from './clausulas.controller';
import { contractsService } from '../core/contenedor';
import { ContractsService } from './contracts.service';
import { ClausulaDto, UpdateClausulaDto } from './dto/clausula.dto';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const clausulas = new ClausulasController(contractsService);

export const clausulasRouter = crearRouter();
clausulasRouter.get(
  '/',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'caja', 'sistemas', 'gerencia'),
  manejar((req) => clausulas.list(req.query.soloActivas as string)),
);

clausulasRouter.post(
  '/',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'caja', 'sistemas', 'gerencia'),
  exigirPermisos(APP_PERMISSIONS.CONTRACTS_MANAGE),
  manejar((req) => clausulas.create(validar(ClausulaDto, req.body))),
);

clausulasRouter.delete(
  '/:id',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'caja', 'sistemas', 'gerencia'),
  exigirPermisos(APP_PERMISSIONS.CONTRACTS_MANAGE),
  manejar((req) => clausulas.remove(req.params.id)),
);

clausulasRouter.patch(
  '/:id',
  autenticar,
  exigirArea('administracion', 'contabilidad', 'caja', 'sistemas', 'gerencia'),
  exigirPermisos(APP_PERMISSIONS.CONTRACTS_MANAGE),
  manejar((req) => clausulas.update(req.params.id, validar(UpdateClausulaDto, req.body))),
);
