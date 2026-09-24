/**
 * Rutas de settings — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en SettingsController, que ya no lleva decoradores.
 *
 * Endpoints: 4
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirArea, usuarioDe } from '../core/auth/instancias';
import { SettingsController } from './settings.controller';
import { settingsService } from '../core/contenedor';
import { SettingsService } from './settings.service';
import { UpdateGoalsDto, UpdateSettingsDto } from './dto/settings.dto';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const settings = new SettingsController(settingsService);

export const settingsRouter = crearRouter();
settingsRouter.get(
  '/',
  autenticar,
  exigirArea('sistemas', 'gerencia'),
  manejar((req) => settings.list()),
);

settingsRouter.put(
  '/',
  autenticar,
  exigirArea('sistemas', 'gerencia'),
  manejar((req) => settings.update(validar(UpdateSettingsDto, req.body), usuarioDe(req))),
);

settingsRouter.get(
  '/goals',
  autenticar,
  exigirArea('sistemas', 'gerencia'),
  manejar((req) => settings.goals()),
);

settingsRouter.put(
  '/goals',
  autenticar,
  exigirArea('sistemas', 'gerencia'),
  manejar((req) => settings.updateGoals(validar(UpdateGoalsDto, req.body), usuarioDe(req))),
);
