/**
 * Rutas de portal-pagos — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en PortalPagosController, que ya no lleva decoradores.
 *
 * Endpoints: 5
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { PortalPagosController } from './portal-pagos.controller';
import { portalPagosService } from '../core/contenedor';
import type { Request, Response } from 'express';
import { Logger } from '../core/logger';
import { PortalPagosService } from './portal-pagos.service';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const portalPagos = new PortalPagosController(portalPagosService);

export const portalPagosRouter = crearRouter();
portalPagosRouter.post(
  '/aplicar_discount',
  manejar((req, res) => portalPagos.aplicarDiscount(req, req.body, res)),
);

portalPagosRouter.post(
  '/get_due_customer',
  manejar((req, res) => portalPagos.getDueCustomer(req, req.body, res)),
);

portalPagosRouter.post(
  '/inv_list',
  manejar((req, res) => portalPagos.invList(req, req.body, res)),
);

portalPagosRouter.post(
  '/pay_due_customer',
  manejar((req, res) => portalPagos.payDueCustomer(req, req.body, res)),
);

portalPagosRouter.post(
  '/view_service',
  manejar((req, res) => portalPagos.viewService(req, req.body, res)),
);
