/**
 * Rutas de projects — ── FICHERO GENERADO ──
 *
 * Lo genera `scripts/generar-routers.ts` desde el contrato extraído del
 * controlador. Cablea HTTP -> método: extrae los argumentos de `req` y llama.
 * La lógica sigue viviendo en ProjectsController, que ya no lleva decoradores.
 *
 * Endpoints: 12
 */
import { crearRouter, manejar } from '../core/http/ruta';
import { validar } from '../core/http/validar';
import { autenticar, exigirAreaCon, usuarioDe } from '../core/auth/instancias';
import { ProjectsController } from './projects.controller';
import { projectsService } from '../core/contenedor';
import { ProjectsService, CreateProjectDto, MilestoneDto, ProjectMaterialsDto, UpdateProjectDto } from './projects.service';
import { respuestaMaterial } from '../common/material-stock';

/** Instancia única del controlador. Las dependencias salen del contenedor. */
const projects = new ProjectsController(projectsService);

export const projectsRouter = crearRouter();
projectsRouter.get(
  '/',
  autenticar,
  exigirAreaCon({ areas: ['administracion', 'gerencia'], orPermission: ['screen.proyectos'] }),
  manejar((req) => projects.list(req.query.search as string, req.query.status as string, req.query.page as string, req.query.pageSize as string, req.query.sortBy as string, req.query.sortDir as string)),
);

projectsRouter.post(
  '/',
  autenticar,
  exigirAreaCon({ areas: ['administracion', 'gerencia'], orPermission: ['screen.proyectos'] }),
  manejar((req) => projects.create(validar(CreateProjectDto, req.body))),
);

projectsRouter.get(
  '/materials/search',
  autenticar,
  exigirAreaCon({ areas: ['administracion', 'gerencia'], orPermission: ['screen.proyectos'] }),
  manejar((req) => projects.searchMaterials(usuarioDe(req), req.query.search as string, req.query.warehouseId as string, req.query.categoryId as string, req.query.page as string, req.query.pageSize as string)),
);

projectsRouter.get(
  '/materials/warehouses',
  autenticar,
  exigirAreaCon({ areas: ['administracion', 'gerencia'], orPermission: ['screen.proyectos'] }),
  manejar((req) => projects.materialWarehouses(usuarioDe(req), req.query.search as string)),
);

projectsRouter.delete(
  '/materials/:mid',
  autenticar,
  exigirAreaCon({ areas: ['administracion', 'gerencia'], orPermission: ['screen.proyectos'] }),
  manejar((req) => projects.deleteMaterial(req.params.mid)),
);

projectsRouter.delete(
  '/milestones/:mid',
  autenticar,
  exigirAreaCon({ areas: ['administracion', 'gerencia'], orPermission: ['screen.proyectos'] }),
  manejar((req) => projects.deleteMilestone(req.params.mid)),
);

projectsRouter.patch(
  '/milestones/:mid',
  autenticar,
  exigirAreaCon({ areas: ['administracion', 'gerencia'], orPermission: ['screen.proyectos'] }),
  manejar((req) => projects.updateMilestone(req.params.mid, validar(MilestoneDto, req.body))),
);

projectsRouter.get(
  '/stats',
  autenticar,
  exigirAreaCon({ areas: ['administracion', 'gerencia'], orPermission: ['screen.proyectos'] }),
  manejar((req) => projects.stats()),
);

projectsRouter.get(
  '/:id',
  autenticar,
  exigirAreaCon({ areas: ['administracion', 'gerencia'], orPermission: ['screen.proyectos'] }),
  manejar((req) => projects.detail(req.params.id)),
);

projectsRouter.patch(
  '/:id',
  autenticar,
  exigirAreaCon({ areas: ['administracion', 'gerencia'], orPermission: ['screen.proyectos'] }),
  manejar((req) => projects.update(req.params.id, validar(UpdateProjectDto, req.body))),
);

projectsRouter.post(
  '/:id/materials',
  autenticar,
  exigirAreaCon({ areas: ['administracion', 'gerencia'], orPermission: ['screen.proyectos'] }),
  manejar((req) => projects.addMaterials(req.params.id, validar(ProjectMaterialsDto, req.body), usuarioDe(req))),
);

projectsRouter.post(
  '/:id/milestones',
  autenticar,
  exigirAreaCon({ areas: ['administracion', 'gerencia'], orPermission: ['screen.proyectos'] }),
  manejar((req) => projects.addMilestone(req.params.id, validar(MilestoneDto, req.body))),
);
