/**
 * Rutas de manuals — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en ManualsController, que ya no lleva decoradores.
 *
 * Endpoints: 2
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { autenticar, usuarioDe } from '../core/auth/instancias';
import { ManualsController } from './manuals.controller';
import { manualsService } from '../core/contenedor';
import type { Response } from 'express';
import { ManualsService } from './manuals.service';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const manuals = new ManualsController(manualsService);

export const manualsRouter = crearRouter();
manualsRouter.get(
  '/',
  autenticar,
  manejar((req) => manuals.list(usuarioDe(req))),
);

manualsRouter.get(
  '/:slug/pdf',
  autenticar,
  manejar((req, res) => manuals.pdf(req.params.slug, usuarioDe(req), res)),
);
