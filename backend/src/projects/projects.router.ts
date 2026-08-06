/**
 * Rutas de projects — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en ProjectsController, que ya no lleva decoradores.
 *
 * Endpoints: 8
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirArea } from '../core/auth/instancias';
import { ProjectsController } from './projects.controller';
import { projectsService } from '../core/contenedor';
import { ProjectsService, CreateProjectDto, MilestoneDto, UpdateProjectDto } from './projects.service';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const projects = new ProjectsController(projectsService);

export const projectsRouter = crearRouter();
projectsRouter.get(
  '/',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  manejar((req) => projects.list(req.query.search as string, req.query.status as string, req.query.page as string, req.query.pageSize as string, req.query.sortBy as string, req.query.sortDir as string)),
);

projectsRouter.post(
  '/',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  manejar((req) => projects.create(validar(CreateProjectDto, req.body))),
);

projectsRouter.delete(
  '/milestones/:mid',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  manejar((req) => projects.deleteMilestone(req.params.mid)),
);

projectsRouter.patch(
  '/milestones/:mid',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  manejar((req) => projects.updateMilestone(req.params.mid, validar(MilestoneDto, req.body))),
);

projectsRouter.get(
  '/stats',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  manejar((req) => projects.stats()),
);

projectsRouter.get(
  '/:id',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  manejar((req) => projects.detail(req.params.id)),
);

projectsRouter.patch(
  '/:id',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  manejar((req) => projects.update(req.params.id, validar(UpdateProjectDto, req.body))),
);

projectsRouter.post(
  '/:id/milestones',
  autenticar,
  exigirArea('administracion', 'gerencia'),
  manejar((req) => projects.addMilestone(req.params.id, validar(MilestoneDto, req.body))),
);
