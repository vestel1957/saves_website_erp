/**
 * Rutas de search — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en SearchController, que ya no lleva decoradores.
 *
 * Endpoints: 1
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { autenticar, usuarioDe } from '../core/auth/instancias';
import { SearchController } from './search.controller';
import { searchService } from '../core/contenedor';
import { SearchService } from './search.service';
import { esTecnicoDeCampo } from '../common/tecnico-scope';
import { ForbiddenException } from '../core/http/errores';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const search = new SearchController(searchService);

export const searchRouter = crearRouter();
searchRouter.post(
  '/ai',
  autenticar,
  manejar((req) => search.ai(req.body?.q, usuarioDe(req))),
);
