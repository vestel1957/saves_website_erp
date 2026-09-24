/**
 * Rutas de my-promotions — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en MyPromotionsController, que ya no lleva decoradores.
 *
 * Endpoints: 2
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirArea, usuarioDe } from '../core/auth/instancias';
import { MyPromotionsController } from './promotions.controller';
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
const myPromotions = new MyPromotionsController(promotionsService);

export const myPromotionsRouter = crearRouter();
myPromotionsRouter.get(
  '/',
  autenticar,
  exigirArea('contabilidad', 'caja'),
  manejar((req) => myPromotions.available(req.query.invoiceId as string)),
);

myPromotionsRouter.post(
  '/:id/apply',
  autenticar,
  exigirArea('contabilidad', 'caja'),
  manejar((req) => myPromotions.apply(req.params.id, validar(ApplyPromotionDto, req.body), usuarioDe(req))),
);
