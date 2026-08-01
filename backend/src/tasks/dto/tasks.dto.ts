import { IsIn, IsInt, IsOptional, IsString, MinLength, Min } from 'class-validator';

export const TODO_STATUS = ['DUE', 'PROGRESS', 'DONE'] as const;
export const TODO_PRIORITY = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;

export class CreateTaskDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsIn(TODO_STATUS) status?: string;
  @IsOptional() @IsIn(TODO_PRIORITY) priority?: string;
  @IsOptional() @IsString() start?: string;
  @IsOptional() @IsString() dueDate?: string;
  @IsOptional() @IsString() description?: string;
  /** Orden asociada (`idorden`). 0 / ausente = nota suelta. */
  @IsOptional() @IsInt() @Min(0) orderId?: number;
  /** Responsable: `legacyId` del empleado (`aauth_users.id`), no el cuid. */
  @IsOptional() @IsInt() assigneeId?: number;
  @IsOptional() @IsInt() related?: number;
}

export class UpdateTaskDto {
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @IsOptional() @IsIn(TODO_STATUS) status?: string;
  @IsOptional() @IsIn(TODO_PRIORITY) priority?: string;
  @IsOptional() @IsString() start?: string;
  @IsOptional() @IsString() dueDate?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsInt() @Min(0) orderId?: number;
  @IsOptional() @IsInt() assigneeId?: number;
}

export type TaskFilter = {
  status?: string;
  priority?: string;
  search?: string;
  mine?: boolean;
  assignee?: string;
  orderId?: string;
  /** 'orden' = ligadas a una orden · 'nota' = notas sueltas (idorden = 0). */
  kind?: string;
  page?: number;
  pageSize?: number;
  /** Orden pedido por la cabecera de la tabla. */
  sortBy?: string;
  sortDir?: string;
};
