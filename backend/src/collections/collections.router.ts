/**
 * Rutas de collections — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en CollectionsController, que ya no lleva decoradores.
 *
 * Endpoints: 6
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirArea, usuarioDe } from '../core/auth/instancias';
import { CollectionsController } from './collections.controller';
import { collectionsService } from '../core/contenedor';
import type { Response } from 'express';
import { CollectionsService, AgreementFilter } from './collections.service';
import { CreateCallDto } from './dto/collections.dto';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const collections = new CollectionsController(collectionsService);

export const collectionsRouter = crearRouter();
collectionsRouter.post(
  '/',
  autenticar,
  exigirArea('administracion', 'caja'),
  manejar((req) => collections.create(validar(CreateCallDto, req.body), usuarioDe(req))),
);

collectionsRouter.get(
  '/agreements',
  autenticar,
  exigirArea('administracion', 'caja'),
  manejar((req) => collections.agreements(req.query as unknown as Record<string, string | undefined>, usuarioDe(req))),
);

collectionsRouter.get(
  '/agreements/export.csv',
  autenticar,
  exigirArea('administracion', 'caja'),
  manejar((req, res) => collections.exportAgreements(req.query as unknown as Record<string, string | undefined>, usuarioDe(req), res)),
);

collectionsRouter.get(
  '/response-types',
  autenticar,
  exigirArea('administracion', 'caja'),
  manejar((req) => collections.responseTypes()),
);

collectionsRouter.get(
  '/subscriber/:subscriberId',
  autenticar,
  exigirArea('administracion', 'caja'),
  manejar((req) => collections.bySubscriber(req.params.subscriberId)),
);

collectionsRouter.delete(
  '/:id',
  autenticar,
  exigirArea('administracion', 'caja'),
  manejar((req) => collections.remove(req.params.id)),
);
