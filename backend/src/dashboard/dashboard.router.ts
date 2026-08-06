/**
 * Rutas de dashboard — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en DashboardController, que ya no lleva decoradores.
 *
 * Endpoints: 1
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { autenticar, exigirArea } from '../core/auth/instancias';
import { DashboardController } from './dashboard.controller';
import { dashboardService } from '../core/contenedor';
import { DashboardService } from './dashboard.service';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const dashboard = new DashboardController(dashboardService);

export const dashboardRouter = crearRouter();
dashboardRouter.get(
  '/',
  autenticar,
  exigirArea('gerencia'),
  manejar((req) => dashboard.summary()),
);
