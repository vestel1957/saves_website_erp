/**
 * Rutas de data — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en DataController, que ya no lleva decoradores.
 *
 * Endpoints: 2
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { autenticar, exigirArea } from '../core/auth/instancias';
import { ficheroDe, subirUno } from '../core/http/uploads';
import { DataController } from './data.controller';
import { dataService } from '../core/contenedor';
import { BadRequestException } from '../core/http/errores';
import type { Response } from 'express';
import { DataService } from './data.service';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const data = new DataController(dataService);

export const dataRouter = crearRouter();
dataRouter.get(
  '/export/:entity',
  autenticar,
  exigirArea('sistemas', 'administracion'),
  manejar((req, res) => data.export(req.params.entity, res)),
);

dataRouter.post(
  '/import/equipment',
  autenticar,
  exigirArea('sistemas', 'administracion'),
  subirUno('file', { limits: { fileSize: 15 * 1024 * 1024 } }),
  manejar((req) => data.importEquipment(ficheroDe(req), req.query.commit as string)),
);
