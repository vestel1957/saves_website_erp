import { TasksService } from './tasks.service';
import { CreateTaskDto, UpdateTaskDto } from './dto/tasks.dto';
import { AuthUser } from '../auth/current-user.decorator';

/** Tareas / to-do (migrado de `Tools.php` del legacy saves-vestel). */
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  stats(user: AuthUser) { return this.tasks.stats(user); }
  assignees() { return this.tasks.assignees(); }

  list(q: Record<string, string | undefined>, user: AuthUser) {
    return this.tasks.list({
      status: q.status, priority: q.priority, search: q.search,
      mine: q.mine === 'true', assignee: q.assignee, orderId: q.orderId, kind: q.kind,
      page: Number(q.page), pageSize: Number(q.pageSize),
      sortBy: q.sortBy, sortDir: q.sortDir,
    }, user);
  }

  detail(id: string) { return this.tasks.detail(id); }
  create(dto: CreateTaskDto, user: AuthUser) { return this.tasks.create(dto, user); }
  update(id: string, dto: UpdateTaskDto) { return this.tasks.update(id, dto); }
  remove(id: string) { return this.tasks.remove(id); }
}
