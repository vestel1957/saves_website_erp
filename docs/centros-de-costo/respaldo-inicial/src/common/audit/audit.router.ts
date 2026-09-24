/**
 * Rutas de activity — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en AuditController, que ya no lleva decoradores.
 *
 * Endpoints: 1
 */
import { crearRouter, manejar } from '../../core/http/ruta';
import { autenticar, exigirArea } from '../../core/auth/instancias';
import { AuditController } from './audit.controller';
import { auditService } from '../../core/contenedor';
import { AuditService } from './audit.service';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const audit = new AuditController(auditService);

export const auditRouter = crearRouter();
auditRouter.get(
  '/',
  autenticar,
  exigirArea('sistemas'),
  manejar((req) => audit.list(req.query.search as string, req.query.entity as string, req.query.userId as string, req.query.from as string, req.query.to as string, req.query.page as string, req.query.pageSize as string, req.query.sortBy as string, req.query.sortDir as string)),
);
