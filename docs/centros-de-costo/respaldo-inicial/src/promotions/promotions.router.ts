/**
 * Rutas de promotions — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en PromotionsController, que ya no lleva decoradores.
 *
 * Endpoints: 11
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirPermisos, usuarioDe } from '../core/auth/instancias';
import { PromotionsController } from './promotions.controller';
import { promotionsService } from '../core/contenedor';
import { PromotionsService } from './promotions.service';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';
import {
  ApplyPromotionDto,
  CreatePromotionDto,
  PromotionAudienceDto,
  UpdatePromotionDto,
} from './dto/promotions.dto';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const promotions = new PromotionsController(promotionsService);

export const promotionsRouter = crearRouter();
promotionsRouter.get(
  '/',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.SYSTEM_ADMIN),
  manejar((req) => promotions.list()),
);

promotionsRouter.post(
  '/',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.SYSTEM_ADMIN),
  manejar((req) => promotions.create(validar(CreatePromotionDto, req.body), usuarioDe(req))),
);

promotionsRouter.post(
  '/audience',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.SYSTEM_ADMIN),
  manejar((req) => promotions.audience(validar(PromotionAudienceDto, req.body))),
);

promotionsRouter.get(
  '/catalogs',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.SYSTEM_ADMIN),
  manejar((req) => promotions.catalogs()),
);

promotionsRouter.get(
  '/history',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.SYSTEM_ADMIN),
  manejar((req) => promotions.history(req.query.promotionId as string)),
);

promotionsRouter.get(
  '/pending-invoices',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.SYSTEM_ADMIN),
  manejar((req) => promotions.pendingInvoices(req.query.subscriberId as string)),
);

promotionsRouter.get(
  '/templates',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.SYSTEM_ADMIN),
  manejar((req) => promotions.templates()),
);

promotionsRouter.delete(
  '/templates/:id',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.SYSTEM_ADMIN),
  manejar((req) => promotions.removeTemplate(req.params.id)),
);

promotionsRouter.delete(
  '/:id',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.SYSTEM_ADMIN),
  manejar((req) => promotions.remove(req.params.id)),
);

promotionsRouter.put(
  '/:id',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.SYSTEM_ADMIN),
  manejar((req) => promotions.update(req.params.id, validar(UpdatePromotionDto, req.body), usuarioDe(req))),
);

promotionsRouter.get(
  '/:id/applications',
  autenticar,
  exigirPermisos(APP_PERMISSIONS.SYSTEM_ADMIN),
  manejar((req) => promotions.applications(req.params.id)),
);
