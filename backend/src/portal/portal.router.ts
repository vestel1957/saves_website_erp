/**
 * Rutas de portal — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en PortalController, que ya no lleva decoradores.
 *
 * Endpoints: 2
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticarAbonado, abonadoDe, crearFrenoDeLogin } from '../core/auth/instancias';
import { PortalController } from './portal.controller';
import { portalService } from '../core/contenedor';
import { PortalService } from './portal.service';
import { PortalLoginDto } from './dto/portal.dto';

/** Freno propio de este router: su contador no se comparte con otros logins. */
const frenoDeLogin = crearFrenoDeLogin();

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const portal = new PortalController(portalService);

export const portalRouter = crearRouter();
portalRouter.post(
  '/login',
  frenoDeLogin,
  manejar((req) => portal.login(validar(PortalLoginDto, req.body))),
);

portalRouter.get(
  '/me',
  autenticarAbonado,
  manejar((req) => portal.me(abonadoDe(req))),
);
