import { ProjectsService, CreateProjectDto, MilestoneDto, UpdateProjectDto } from './projects.service';

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
}
