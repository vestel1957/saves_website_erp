import { BadRequestException, NotFoundException } from '../core/http/errores';
import { orden } from '../common/pagination-params';
import { Prisma, TodoStatus, TodoPriority } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/current-user.decorator';
import { CreateTaskDto, UpdateTaskDto, TaskFilter, NoteDto, AttachNoteDto } from './dto/tasks.dto';
import { hoyEnColombia } from '../common/fecha-colombia';
import { autorDeOrden, autorDeSeguimiento, type FirmaDeSeguimiento, SEGUIMIENTO_DEL_SISTEMA } from '../support/autor-orden';

/** Cómo se nombran los estados y las prioridades cuando el sistema los escribe en
 *  el seguimiento. "Estado: DUE → DONE" no lo entiende nadie fuera de la base. */
const ESTADO_ES: Record<string, string> = { DUE: 'Pendiente', PROGRESS: 'En progreso', DONE: 'Hecha' };
const PRIORIDAD_ES: Record<string, string> = { LOW: 'Baja', MEDIUM: 'Media', HIGH: 'Alta', URGENT: 'Urgente' };

/** Fecha suelta tal como se lee en la bitácora (sin hora: la tarea las guarda `@db.Date`). */
const fechaEs = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : 'sin fecha');

/**
 * Tareas / to-do (migrado de `Tools.php` + tabla `todolist` del legacy).
 *
 * Dos naturalezas conviven en la misma tabla, tal como en el legacy:
 *  · Tareas ligadas a una orden (`orderId` = `idorden`), del tipo "Revisar orden #N".
 *  · Notas sueltas del personal (`orderId` = 0).
 *
 * `employeeId`/`assigneeId` son ids legacy (`aauth_users.id`), no ids del stack
 * nuevo: se resuelven contra `Staff.legacyId` para mostrar nombres.
 */
export class TasksService {
  constructor(private readonly prisma: PrismaService) {}

  /** Staff del usuario autenticado (vínculo por correo). Null si no tiene ficha. */
  private async staffOf(user?: AuthUser) {
    if (!user?.email) return null;
    return this.prisma.staff.findFirst({ where: { email: user.email }, select: { id: true, legacyId: true, name: true } });
  }

  /** Mapa legacyId → nombre, para pintar responsable/autor sin N+1 consultas. */
  private async namesByLegacyId(ids: number[]) {
    const uniq = [...new Set(ids.filter((n) => n > 0))];
    if (!uniq.length) return new Map<number, string>();
    const rows = await this.prisma.staff.findMany({ where: { legacyId: { in: uniq } }, select: { legacyId: true, name: true } });
    return new Map(rows.map((r) => [r.legacyId!, r.name]));
  }

  async stats(user?: AuthUser) {
    const me = await this.staffOf(user);
    const [due, progress, done, mine, overdue] = await Promise.all([
      this.prisma.todoTask.count({ where: { status: 'DUE' } }),
      this.prisma.todoTask.count({ where: { status: 'PROGRESS' } }),
      this.prisma.todoTask.count({ where: { status: 'DONE' } }),
      me?.legacyId
        ? this.prisma.todoTask.count({ where: { status: { not: 'DONE' }, OR: [{ employeeId: me.legacyId }, { assigneeId: me.legacyId }] } })
        : Promise.resolve(0),
      this.prisma.todoTask.count({ where: { status: { not: 'DONE' }, dueDate: { lt: new Date(new Date().toISOString().slice(0, 10)) } } }),
    ]);
    return { pendientes: due, enProgreso: progress, hechas: done, mias: mine, vencidas: overdue };
  }

  /**
   * Columnas ordenables de la tabla de tareas. `assignee` se muestra como
   * nombre pero en la fila solo está el id legacy del empleado (el nombre se
   * resuelve luego con un mapa), así que se ordena por ese id: agrupa por
   * persona, aunque no sea alfabético.
   */
  private static readonly ORDEN_LISTA = {
    name: 'name', status: 'status', priority: 'priority',
    tdate: 'tdate', dueDate: 'dueDate', orderId: 'orderId', assignee: 'assigneeId',
    // Las heredadas del legacy no tienen fecha de realización (13 mil): al final
    // siempre, o "más recientes primero" abría con puras celdas vacías.
    doneDate: (dir: 'asc' | 'desc') => ({ doneDate: { sort: dir, nulls: 'last' as const } }),
    author: 'createdByName',
  };

  async list(f: TaskFilter, user?: AuthUser) {
    const page = Math.max(1, Number(f.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(f.pageSize) || 25));
    const where: Prisma.TodoTaskWhereInput = {};

    if (f.status) where.status = f.status as TodoStatus;
    if (f.priority) where.priority = f.priority as TodoPriority;
    if (f.orderId) where.orderId = Number(f.orderId);
    // "Solo órdenes" / "solo notas sueltas": en el legacy idorden=0 significa nota libre.
    if (f.kind === 'orden') where.orderId = { gt: 0 };
    else if (f.kind === 'nota') where.orderId = 0;

    if (f.mine) {
      const me = await this.staffOf(user);
      // Sin ficha de empleado vinculada no hay `eid`, pero desde que la tarea se firma
      // con la cuenta (`createdById`) sí hay por dónde reconocer las propias. El -1 es
      // el hueco: sin ficha, esa pata no casa con nada en vez de traerlas todas.
      const legacyId = me?.legacyId ?? -1;
      where.OR = [{ employeeId: legacyId }, { assigneeId: legacyId }, ...(user?.id ? [{ createdById: user.id }] : [])];
    } else if (f.assignee) {
      where.OR = [{ employeeId: Number(f.assignee) }, { assigneeId: Number(f.assignee) }];
    }

    const search = (f.search || '').trim();
    if (search) {
      const like: Prisma.TodoTaskWhereInput[] = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
      const n = Number(search);
      if (Number.isInteger(n) && n > 0) like.push({ orderId: n });
      // AND explícito: si ya hay un OR de responsable, un segundo OR lo pisaría.
      where.AND = [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), { OR: like }];
    }

    const [rows, total] = await Promise.all([
      this.prisma.todoTask.findMany({ where, orderBy: orden(f, TasksService.ORDEN_LISTA, [{ tdate: 'desc' }, { legacyId: 'desc' }]), skip: (page - 1) * pageSize, take: pageSize, include: { _count: { select: { files: true, notes: true } } } }),
      this.prisma.todoTask.count({ where }),
    ]);
    const names = await this.namesByLegacyId(rows.flatMap((r) => [r.employeeId, r.assigneeId]));
    const hoy = new Date().toISOString().slice(0, 10);
    return {
      items: rows.map((r) => ({
        id: r.id, legacyId: r.legacyId, name: r.name, status: r.status, priority: r.priority,
        tdate: r.tdate, start: r.start, dueDate: r.dueDate, doneDate: r.doneDate, description: r.description,
        orderId: r.orderId || null,
        // El nombre sellado manda; el `eid` es sólo el respaldo de lo heredado.
        author: r.createdByName ?? names.get(r.employeeId) ?? null,
        authorSource: r.createdBySource ?? null,
        assignee: names.get(r.assigneeId) ?? null,
        // Cuántos adjuntos lleva: la tabla pinta el clip sin tener que pedir la
        // lista de ficheros de cada fila. Lo mismo con los renglones de
        // seguimiento: la lista dice de un vistazo cuáles están documentadas.
        files: r._count.files,
        notes: r._count.notes,
        overdue: r.status !== 'DONE' && !!r.dueDate && r.dueDate.toISOString().slice(0, 10) < hoy,
      })),
      total, page, pageSize, pages: Math.ceil(total / pageSize),
    };
  }

  async detail(id: string) {
    const t = await this.prisma.todoTask.findUnique({
      where: { id },
      include: {
        files: { orderBy: { createdAt: 'asc' } },
        // El seguimiento va en la misma consulta que la ficha: la pantalla de la
        // tarea es una sola cosa —qué hay que hacer y qué se lleva hecho— y
        // partirla en dos peticiones sólo hacía parpadear el hilo.
        notes: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!t) throw new NotFoundException('Tarea no encontrada');
    const names = await this.namesByLegacyId([t.employeeId, t.assigneeId, ...t.notes.map((n) => n.employeeId)]);
    const { files, notes, ...fila } = t;
    return {
      ...fila,
      author: t.createdByName ?? names.get(t.employeeId) ?? null,
      authorSource: t.createdBySource ?? null,
      assignee: names.get(t.assigneeId) ?? null,
      /// Responsable en id, para que la ficha pueda reasignar sin adivinar cuál es.
      assigneeId: t.assigneeId || null,
      files: files.map(TasksService.vistaDeAdjunto),
      notes: notes.map((n) => TasksService.vistaDeNota(n, names)),
    };
  }

  // ------------------------------------------------------------------ //
  //  Seguimiento (lo que en una orden se llama "documentar")            //
  // ------------------------------------------------------------------ //

  /** Forma con la que un renglón del seguimiento sale a la pantalla. */
  private static vistaDeNota(
    n: {
      id: string; message: string | null; stage: string | null; auto: boolean;
      authorName: string | null; employeeId: number; attach: string | null;
      attachName: string | null; geoLat: string | null; geoLng: string | null; createdAt: Date;
    },
    names: Map<number, string>,
  ) {
    return {
      id: n.id, message: n.message, stage: n.stage, auto: n.auto,
      // El nombre sellado manda; el `eid` sólo es el respaldo de lo heredado, igual
      // que en el hilo de la orden.
      author: n.authorName ?? names.get(n.employeeId) ?? null,
      attach: n.attach ? (n.attachName ?? 'Foto') : null,
      geoLat: n.geoLat, geoLng: n.geoLng,
      at: n.createdAt,
    };
  }

  /** El seguimiento de una tarea, del renglón más viejo al más nuevo. */
  async notes(id: string) {
    await this.exigirTarea(id);
    const rows = await this.prisma.todoTaskNote.findMany({ where: { taskId: id }, orderBy: { createdAt: 'asc' } });
    const names = await this.namesByLegacyId(rows.map((r) => r.employeeId));
    return rows.map((n) => TasksService.vistaDeNota(n, names));
  }

  /**
   * Con qué se firma lo que se escribe en el seguimiento. Misma regla que en la
   * orden (`SupportWriteService.firmaDeSeguimiento`): la ficha de empleado se busca
   * para sacar el `eid`, pero que no aparezca no deja el renglón sin autor — el
   * nombre se guarda igual, y si la consulta falla se firma con lo que hay en la
   * sesión. Perder la documentación de alguien por no poder leer su ficha sería
   * mucho peor que un `eid` en 0.
   */
  private async firmaDeSeguimiento(user?: AuthUser | null): Promise<FirmaDeSeguimiento> {
    if (!user?.id) return SEGUIMIENTO_DEL_SISTEMA;
    let ficha = null;
    try {
      ficha = await this.staffOf(user);
    } catch {
      ficha = null;
    }
    return autorDeSeguimiento(user, ficha);
  }

  /** Documenta la tarea: el texto de lo que se hizo y en qué quedó. */
  async addNote(id: string, dto: NoteDto, user?: AuthUser) {
    await this.exigirTarea(id);
    const message = dto.message?.trim() || null;
    const stage = dto.stage?.trim() || null;
    if (!message && !stage) throw new BadRequestException('Escribe qué se hizo o elige en qué quedó.');
    const n = await this.prisma.todoTaskNote.create({
      data: { taskId: id, message, stage, ...(await this.firmaDeSeguimiento(user)) },
    });
    return TasksService.vistaDeNota(n, await this.namesByLegacyId([n.employeeId]));
  }

  /**
   * Documenta con una FOTO de evidencia (y, si el dispositivo la dio, desde dónde
   * se tomó). El binario ya lo dejó multer en `uploads/tasks/<taskId>/`; aquí sólo
   * se registra el renglón.
   */
  async addNoteAttachment(
    id: string,
    file: { filename: string; originalname: string },
    dto: AttachNoteDto,
    user?: AuthUser,
  ) {
    await this.exigirTarea(id);
    const n = await this.prisma.todoTaskNote.create({
      data: {
        taskId: id,
        message: dto.message?.trim() || null,
        stage: dto.stage?.trim() || null,
        attach: file.filename,
        attachName: Buffer.from(file.originalname, 'latin1').toString('utf8'),
        geoLat: dto.lat?.trim() || null,
        geoLng: dto.lng?.trim() || null,
        ...(await this.firmaDeSeguimiento(user)),
      },
    });
    return TasksService.vistaDeNota(n, await this.namesByLegacyId([n.employeeId]));
  }

  /** Metadata de la foto de un renglón, comprobando que sea de ESA tarea (si no, el
   *  id de una nota ajena serviría para verla desde cualquier tarea). */
  async noteAttachment(id: string, noteId: string) {
    const n = await this.prisma.todoTaskNote.findFirst({ where: { id: noteId, taskId: id } });
    if (!n?.attach) throw new NotFoundException('Esa entrada del seguimiento no tiene foto');
    return { storedName: n.attach, originalName: n.attachName ?? n.attach };
  }

  /**
   * Anota en el seguimiento algo que hizo el sistema (el cambio de estado, de
   * responsable, de fecha). Nunca puede tumbar la operación que lo provocó: la
   * tarea ya se guardó, y quedarse sin la línea de bitácora es infinitamente menos
   * grave que devolver un 500 por ella.
   */
  private async anotar(taskId: string, message: string, user?: AuthUser | null) {
    const firma = await this.firmaDeSeguimiento(user).catch(() => SEGUIMIENTO_DEL_SISTEMA);
    await this.prisma.todoTaskNote
      .create({ data: { taskId, message, auto: true, ...firma } })
      .catch(() => undefined);
  }

  // ------------------------------------------------------------------ //
  //  Adjuntos (metadata; el binario vive en uploads/tasks/<id>/)        //
  // ------------------------------------------------------------------ //

  /** Forma con la que un adjunto sale a la pantalla. Una sola, para que la lista,
   *  la subida y el detalle no se contradigan. */
  private static vistaDeAdjunto(f: {
    id: string; originalName: string; mimeType: string; size: number;
    uploadedByName: string | null; createdAt: Date;
  }) {
    return { id: f.id, name: f.originalName, mimeType: f.mimeType, size: f.size, by: f.uploadedByName, at: f.createdAt };
  }

  /** Adjuntos de una tarea. La tarea tiene que existir: si no, es un 404 y no una
   *  lista vacía (una tarea borrada y una sin adjuntos no son lo mismo). */
  async listFiles(id: string) {
    await this.exigirTarea(id);
    const files = await this.prisma.todoTaskFile.findMany({ where: { taskId: id }, orderBy: { createdAt: 'asc' } });
    return files.map(TasksService.vistaDeAdjunto);
  }

  private async exigirTarea(id: string) {
    const t = await this.prisma.todoTask.findUnique({ where: { id }, select: { id: true } });
    if (!t) throw new NotFoundException('Tarea no encontrada');
    return t;
  }

  /** Registra la metadata de un fichero que multer ya dejó en disco. */
  async addFile(
    id: string,
    meta: { originalName: string; storedName: string; mimeType: string; size: number },
    user?: AuthUser,
  ) {
    await this.exigirTarea(id);
    const f = await this.prisma.todoTaskFile.create({
      data: { taskId: id, ...meta, uploadedByName: user?.name ?? user?.email ?? null },
    });
    // Que el adjunto deje rastro EN EL TIEMPO: la lista de ficheros dice qué hay
    // colgado, pero no cuándo apareció ni en respuesta a qué. En el seguimiento sí.
    await this.anotar(id, `adjuntó «${meta.originalName}»`, user);
    return TasksService.vistaDeAdjunto(f);
  }

  /** Metadata de un adjunto, comprobando que sea de ESA tarea (si no, el id de un
   *  fichero ajeno serviría para bajarlo desde cualquier tarea). */
  async fileMeta(id: string, fileId: string) {
    const f = await this.prisma.todoTaskFile.findFirst({ where: { id: fileId, taskId: id } });
    if (!f) throw new NotFoundException('Adjunto no encontrado');
    return f;
  }

  /** Quita el adjunto. Devuelve la fila para que el controlador borre el binario. */
  async deleteFile(id: string, fileId: string) {
    const f = await this.fileMeta(id, fileId);
    await this.prisma.todoTaskFile.delete({ where: { id: f.id } });
    return f;
  }

  /** Responsables seleccionables: empleados con ficha legacy (los que la tabla referencia). */
  async assignees() {
    const rows = await this.prisma.staff.findMany({
      where: { legacyId: { not: null }, banned: false },
      select: { legacyId: true, name: true },
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => ({ id: r.legacyId, name: r.name }));
  }

  private dOnly(s?: string | null) {
    if (!s) return null;
    const d = new Date(`${String(s).slice(0, 10)}T00:00:00Z`);
    return isNaN(d.getTime()) ? null : d;
  }

  /**
   * La fecha de realización que pide el usuario, validada: no puede ser futura (la
   * tarea no se ha hecho mañana) ni, si se da `creada`, anterior al día de creación.
   */
  private fechaNoFutura(texto: string, creada?: Date) {
    const d = this.dOnly(texto);
    if (!d) throw new BadRequestException('La fecha de realización no es válida.');
    if (d > hoyEnColombia()) throw new BadRequestException('La fecha de realización no puede ser futura.');
    if (creada && d < creada) throw new BadRequestException(`La fecha de realización no puede ser anterior a la creación de la tarea (${fechaEs(creada)}).`);
    return d;
  }

  async create(dto: CreateTaskDto, user?: AuthUser) {
    const me = await this.staffOf(user);
    // Quién la crea se sella aquí, con la misma firma que una orden de servicio: el
    // `eid` sólo lo tiene quien tiene ficha de empleado, así que por sí solo dejaba
    // sin autor a media plantilla. Ver `support/autor-orden.ts`.
    const autor = user ? autorDeOrden(user) : null;
    // `legacyId` es obligatorio y único en el modelo (viene del ETL). Para las tareas
    // nacidas en el stack nuevo seguimos la secuencia por encima del máximo legacy,
    // así no chocan con una reejecución del ETL sobre el histórico.
    const max = await this.prisma.todoTask.aggregate({ _max: { legacyId: true } });
    const legacyId = (max._max.legacyId ?? 0) + 1;
    const hoy = hoyEnColombia();
    const status = (dto.status as TodoStatus) ?? 'DUE';
    const creada = await this.prisma.todoTask.create({
      data: {
        legacyId,
        tdate: hoy,
        name: dto.name.trim(),
        status,
        // Nace Hecha (se apunta algo que ya se hizo): se realizó hoy salvo que diga otra
        // cosa. No se valida contra la creación: es justo el caso de apuntarla tarde.
        doneDate: status === 'DONE' ? (dto.doneDate ? this.fechaNoFutura(dto.doneDate) : hoy) : null,
        priority: (dto.priority as TodoPriority) ?? 'MEDIUM',
        start: this.dOnly(dto.start),
        dueDate: this.dOnly(dto.dueDate),
        description: dto.description?.trim() || null,
        orderId: dto.orderId ?? 0,
        employeeId: me?.legacyId ?? 0,
        assigneeId: dto.assigneeId ?? me?.legacyId ?? 0,
        related: dto.related ?? null,
        createdByName: autor?.createdByName ?? null,
        createdById: autor?.createdById ?? null,
        createdBySource: autor?.createdBySource ?? 'SISTEMA',
      },
    });
    // El primer renglón del seguimiento: que la bitácora empiece en el día uno y no
    // en el primer avance, para que "no tiene nada documentado" se distinga de
    // "nadie la ha tocado".
    await this.anotar(creada.id, 'Tarea creada.', user);
    return creada;
  }

  async update(id: string, dto: UpdateTaskDto, user?: AuthUser) {
    const t = await this.prisma.todoTask.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Tarea no encontrada');
    const data: Prisma.TodoTaskUpdateInput = {};
    // Lo que cambia se va apuntando en castellano para el seguimiento: quién movió
    // el estado, quién la reasignó y quién corrió la fecha son las tres preguntas
    // que la tarea nunca podía responder. Mismo gesto que "Orden corregida por…".
    const cambios: string[] = [];
    if (dto.name !== undefined) {
      data.name = dto.name.trim();
      if (data.name !== (t.name ?? '')) cambios.push(`nombre: «${t.name ?? '—'}» → «${data.name}»`);
    }
    if (dto.status !== undefined) {
      data.status = dto.status as TodoStatus;
      if (data.status !== t.status) cambios.push(`estado: ${ESTADO_ES[t.status] ?? t.status} → ${ESTADO_ES[data.status] ?? data.status}`);
    }
    // Fecha de realización: se sella sola al pasar a Hecha y se borra al reabrirla.
    // Quien la cierra puede corregirla (la hizo ayer y la marca hoy); sólo tiene
    // sentido en una tarea Hecha.
    const estadoFinal = (data.status as TodoStatus | undefined) ?? t.status;
    let doneDate: Date | null = t.doneDate;
    if (estadoFinal !== 'DONE') {
      if (dto.doneDate) throw new BadRequestException('Solo una tarea Hecha tiene fecha de realización.');
      doneDate = null;
    } else if (dto.doneDate) {
      doneDate = this.fechaNoFutura(dto.doneDate, t.tdate);
    } else if (t.status !== 'DONE') {
      // Recién cerrada: hoy. Una heredada ya Hecha sin fecha no se inventa al editar
      // otra cosa: sigue en blanco hasta que alguien la escriba.
      doneDate = hoyEnColombia();
    }
    if (fechaEs(doneDate) !== fechaEs(t.doneDate)) {
      data.doneDate = doneDate;
      // Al cerrar/reabrir el cambio de estado ya lo dice; sólo se anota aparte la corrección.
      if (t.status === 'DONE' && estadoFinal === 'DONE') cambios.push(`realizada: ${fechaEs(t.doneDate)} → ${fechaEs(doneDate)}`);
      else if (doneDate) cambios.push(`realizada el ${fechaEs(doneDate)}`);
    }
    if (dto.priority !== undefined) {
      data.priority = dto.priority as TodoPriority;
      if (data.priority !== t.priority) cambios.push(`prioridad: ${PRIORIDAD_ES[t.priority] ?? t.priority} → ${PRIORIDAD_ES[data.priority] ?? data.priority}`);
    }
    if (dto.start !== undefined) {
      data.start = this.dOnly(dto.start);
      if (fechaEs(data.start) !== fechaEs(t.start)) cambios.push(`inicio: ${fechaEs(t.start)} → ${fechaEs(data.start)}`);
    }
    if (dto.dueDate !== undefined) {
      data.dueDate = this.dOnly(dto.dueDate);
      if (fechaEs(data.dueDate) !== fechaEs(t.dueDate)) cambios.push(`vence: ${fechaEs(t.dueDate)} → ${fechaEs(data.dueDate)}`);
    }
    if (dto.description !== undefined) {
      data.description = dto.description?.trim() || null;
      if ((data.description ?? '') !== (t.description ?? '')) cambios.push('se cambió el detalle');
    }
    if (dto.assigneeId !== undefined) {
      data.assigneeId = dto.assigneeId ?? 0;
      if (data.assigneeId !== t.assigneeId) {
        const names = await this.namesByLegacyId([t.assigneeId, data.assigneeId]);
        cambios.push(`responsable: ${names.get(t.assigneeId) ?? 'sin asignar'} → ${names.get(data.assigneeId) ?? 'sin asignar'}`);
      }
    }
    if (dto.orderId !== undefined) {
      data.orderId = dto.orderId ?? 0;
      if (data.orderId !== t.orderId) cambios.push(`orden: ${t.orderId || 'ninguna'} → ${data.orderId || 'ninguna'}`);
    }
    const actualizada = await this.prisma.todoTask.update({ where: { id }, data });
    if (cambios.length) await this.anotar(id, `${cambios.join('; ')}.`, user);
    return actualizada;
  }

  async remove(id: string) {
    const t = await this.prisma.todoTask.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Tarea no encontrada');
    await this.prisma.todoTask.delete({ where: { id } });
    return { id, deleted: true };
  }
}
