import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ProjectsService, CreateProjectDto, MilestoneDto, UpdateProjectDto } from './projects.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';

/** Proyectos (migrado de saves-vestel). */
@Controller('projects')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('administracion', 'gerencia')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get('stats') stats() { return this.projects.stats(); }
  @Get()
  list(@Query('search') search?: string, @Query('status') status?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.projects.list({ search, status, page: Number(page), pageSize: Number(pageSize) });
  }
  @Get(':id') detail(@Param('id') id: string) { return this.projects.detail(id); }
  @Post() create(@Body() dto: CreateProjectDto) { return this.projects.create(dto); }
  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateProjectDto) { return this.projects.update(id, dto); }

  @Post(':id/milestones') addMilestone(@Param('id') id: string, @Body() dto: MilestoneDto) { return this.projects.createMilestone(id, dto); }
  @Patch('milestones/:mid') updateMilestone(@Param('mid') mid: string, @Body() dto: MilestoneDto) { return this.projects.updateMilestone(mid, dto); }
  @Delete('milestones/:mid') deleteMilestone(@Param('mid') mid: string) { return this.projects.deleteMilestone(mid); }
}
