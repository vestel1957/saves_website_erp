/**
 * Rutas de tasks — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en TasksController, que ya no lleva decoradores.
 *
 * Endpoints: 7
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirArea, usuarioDe } from '../core/auth/instancias';
import { TasksController } from './tasks.controller';
import { tasksService } from '../core/contenedor';
import { TasksService } from './tasks.service';
import { CreateTaskDto, UpdateTaskDto } from './dto/tasks.dto';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const tasks = new TasksController(tasksService);

export const tasksRouter = crearRouter();
tasksRouter.get(
  '/',
  autenticar,
  exigirArea('administracion', 'gerencia', 'tecnicos', 'caja'),
  manejar((req) => tasks.list(req.query as unknown as Record<string, string | undefined>, usuarioDe(req))),
);

tasksRouter.post(
  '/',
  autenticar,
  exigirArea('administracion', 'gerencia', 'tecnicos', 'caja'),
  manejar((req) => tasks.create(validar(CreateTaskDto, req.body), usuarioDe(req))),
);

tasksRouter.get(
  '/assignees',
  autenticar,
  exigirArea('administracion', 'gerencia', 'tecnicos', 'caja'),
  manejar((req) => tasks.assignees()),
);

tasksRouter.get(
  '/stats',
  autenticar,
  exigirArea('administracion', 'gerencia', 'tecnicos', 'caja'),
  manejar((req) => tasks.stats(usuarioDe(req))),
);

tasksRouter.delete(
  '/:id',
  autenticar,
  exigirArea('administracion', 'gerencia', 'tecnicos', 'caja'),
  manejar((req) => tasks.remove(req.params.id)),
);

tasksRouter.get(
  '/:id',
  autenticar,
  exigirArea('administracion', 'gerencia', 'tecnicos', 'caja'),
  manejar((req) => tasks.detail(req.params.id)),
);

tasksRouter.patch(
  '/:id',
  autenticar,
  exigirArea('administracion', 'gerencia', 'tecnicos', 'caja'),
  manejar((req) => tasks.update(req.params.id, validar(UpdateTaskDto, req.body))),
);
