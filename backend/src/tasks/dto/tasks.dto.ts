import { IsIn, IsInt, IsOptional, IsString, MinLength, Min } from 'class-validator';

export const TODO_STATUS = ['DUE', 'PROGRESS', 'DONE'] as const;
export const TODO_PRIORITY = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;

export class CreateTaskDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsIn(TODO_STATUS) status?: string;
  @IsOptional() @IsIn(TODO_PRIORITY) priority?: string;
  @IsOptional() @IsString() start?: string;
  @IsOptional() @IsString() dueDate?: string;
  /** Fecha en que se realizó (YYYY-MM-DD). Sólo cuenta si nace Hecha; sin ella, hoy. */
  @IsOptional() @IsString() doneDate?: string;
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
  /** Fecha en que se realizó (YYYY-MM-DD), para corregirla si se hizo otro día. */
  @IsOptional() @IsString() doneDate?: string;
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

/**
 * En qué quedó la tarea al documentarla. Es la lista corta equivalente al select de
 * "solución / causa" del seguimiento de una orden, pero pensada para un pendiente de
 * oficina y no para una visita: lo que hace falta saber al leerla de vuelta es si
 * avanzó, si está esperando a alguien o si ya no hay nada que hacer.
 *
 * Cerrada a propósito (texto libre hay de sobra en el mensaje): es lo que permite
 * mirar una tarea vieja y entender en dos palabras por qué lleva ahí un mes.
 */
export const TASK_STAGES = [
  'Avance',
  'A la espera de un tercero',
  'A la espera del cliente',
  'Bloqueada',
  'Se reprograma',
  'Resuelta',
  'No procede',
] as const;

/** Un renglón del seguimiento escrito a mano (el «Documentar» de la orden). */
export class NoteDto {
  @IsOptional() @IsString() message?: string;
  /** Etiqueta de la lista de arriba. Se valida contra ella para que la bitácora no
   *  se llene de variantes escritas a mano del mismo estado. */
  @IsOptional() @IsIn(TASK_STAGES as unknown as string[]) stage?: string;
}

/** Lo mismo, pero con la foto de evidencia (multipart: los campos llegan como texto). */
export class AttachNoteDto {
  @IsOptional() @IsString() message?: string;
  @IsOptional() @IsIn(TASK_STAGES as unknown as string[]) stage?: string;
  @IsOptional() @IsString() lat?: string; // coordenadas de quien sube la foto
  @IsOptional() @IsString() lng?: string;
}
