import { ProjectsService, CreateProjectDto, MilestoneDto, ProjectMaterialsDto, UpdateProjectDto } from './projects.service';
import { AuthUser } from '../auth/current-user.decorator';
import { respuestaMaterial } from '../common/material-stock';

/** Proyectos (migrado de saves-vestel). */
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  stats() { return this.projects.stats(); }
  list(search?: string, status?: string, page?: string, pageSize?: string, sortBy?: string, sortDir?: string) {
    return this.projects.list({ search, status, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir });
  }
  detail(id: string) { return this.projects.detail(id); }
  create(dto: CreateProjectDto) { return this.projects.create(dto); }
  update(id: string, dto: UpdateProjectDto) { return this.projects.update(id, dto); }

  addMilestone(id: string, dto: MilestoneDto) { return this.projects.createMilestone(id, dto); }
  updateMilestone(mid: string, dto: MilestoneDto) { return this.projects.updateMilestone(mid, dto); }
  deleteMilestone(mid: string) { return this.projects.deleteMilestone(mid); }

  materialWarehouses(user: AuthUser, search?: string) { return this.projects.materialWarehouses(user, search); }
  /** Sin `page` responde el array de antes: el navegador que no ha recargado (ver `respuestaMaterial`). */
  async searchMaterials(user: AuthUser, search?: string, warehouseId?: string, categoryId?: string, page?: string, pageSize?: string) {
    return respuestaMaterial(await this.projects.searchMaterials(user, { search, warehouseId, categoryId, page, pageSize }), page);
  }
  addMaterials(id: string, dto: ProjectMaterialsDto, user: AuthUser) { return this.projects.addMaterials(id, dto, user); }
  deleteMaterial(mid: string) { return this.projects.deleteMaterial(mid); }
}
