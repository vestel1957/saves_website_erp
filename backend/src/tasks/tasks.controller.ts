import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { CreateTaskDto, UpdateTaskDto } from './dto/tasks.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

/** Tareas / to-do (migrado de `Tools.php` del legacy saves-vestel). */
@Controller('tasks')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('administracion', 'gerencia', 'tecnicos', 'caja')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get('stats') stats(@CurrentUser() user: AuthUser) { return this.tasks.stats(user); }
  @Get('assignees') assignees() { return this.tasks.assignees(); }

  @Get()
  list(@Query() q: Record<string, string | undefined>, @CurrentUser() user: AuthUser) {
    return this.tasks.list({
      status: q.status, priority: q.priority, search: q.search,
      mine: q.mine === 'true', assignee: q.assignee, orderId: q.orderId, kind: q.kind,
      page: Number(q.page), pageSize: Number(q.pageSize),
      sortBy: q.sortBy, sortDir: q.sortDir,
    }, user);
  }

  @Get(':id') detail(@Param('id') id: string) { return this.tasks.detail(id); }
  @Post() create(@Body() dto: CreateTaskDto, @CurrentUser() user: AuthUser) { return this.tasks.create(dto, user); }
  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateTaskDto) { return this.tasks.update(id, dto); }
  @Delete(':id') remove(@Param('id') id: string) { return this.tasks.remove(id); }
}
