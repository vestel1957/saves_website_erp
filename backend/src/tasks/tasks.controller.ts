import type { Response } from 'express';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { diskStorage } from 'multer';
import { BadRequestException, NotFoundException } from '../core/http/errores';
import { TasksService } from './tasks.service';
import { CreateTaskDto, UpdateTaskDto, NoteDto, AttachNoteDto } from './dto/tasks.dto';
import { AuthUser } from '../auth/current-user.decorator';
// Lo usan el `fileFilter` de la subida (que vive en el router generado) y la
// descarga: nunca se sirve un adjunto sin `enviarAdjuntoSeguro`.
import { enviarAdjuntoSeguro, extensionDeAdjunto, mimeAceptado, nombreEnDisco, MIMES_IMAGEN } from '../common/uploads';

/** Forma mínima del archivo que entrega multer (evita depender de @types/multer). */
type MulterFile = { originalname: string; filename: string; mimetype: string; size: number; path: string };

export const UPLOAD_ROOT = join(process.cwd(), 'uploads', 'tasks');
export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB
/**
 * Lo que se puede colgar de una tarea. Es la MISMA lista de las órdenes de compra:
 * a una tarea se le adjunta la planilla de Excel o el CSV que hay que trabajar, la
 * cotización en PDF o la foto de lo que quedó pendiente.
 *
 * La lista es explícita a propósito (ver `common/uploads.ts`): no se deriva del mapa
 * de MIME, para que añadir un tipo allá no lo habilite aquí de rebote.
 */
export const ALLOWED_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt', '.zip']);

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
  update(id: string, dto: UpdateTaskDto, user: AuthUser) { return this.tasks.update(id, dto, user); }
  remove(id: string) { return this.tasks.remove(id); }

  // ------------------------------------------------------------------ //
  //  Adjuntos                                                          //
  // ------------------------------------------------------------------ //

  files(id: string) { return this.tasks.listFiles(id); }

  /** Alta del adjunto. El binario ya está en disco (lo puso multer); aquí sólo se
   *  registra la metadata, con el nombre original decodificado. */
  upload(id: string, file: MulterFile, user: AuthUser) {
    return this.tasks.addFile(id, {
      // multer entrega el nombre en latin1: sin esto, "Cartera septiembre.xlsx" con
      // tilde llegaba mutilado a la lista.
      originalName: Buffer.from(file.originalname, 'latin1').toString('utf8'),
      storedName: file.filename,
      mimeType: file.mimetype,
      size: file.size,
    }, user);
  }

  async deleteFile(id: string, fileId: string) {
    const f = await this.tasks.deleteFile(id, fileId);
    // El registro ya no está; que el binario siga en disco no rompe nada, así que
    // el borrado del fichero no puede tumbar la respuesta.
    try { unlinkSync(join(UPLOAD_ROOT, id, f.storedName)); } catch { /* ya no estaba */ }
    return { id: fileId, deleted: true };
  }

  async download(id: string, fileId: string, res: Response) {
    const f = await this.tasks.fileMeta(id, fileId);
    const abs = join(UPLOAD_ROOT, id, f.storedName);
    if (!existsSync(abs)) throw new NotFoundException('El archivo ya no está en el servidor');
    return enviarAdjuntoSeguro(res, abs, f.originalName);
  }

  // ------------------------------------------------------------------ //
  //  Seguimiento: documentar la tarea igual que se documenta una orden  //
  // ------------------------------------------------------------------ //

  notes(id: string) { return this.tasks.notes(id); }

  /** Documentar: qué se hizo y en qué quedó. */
  addNote(id: string, dto: NoteDto, user: AuthUser) { return this.tasks.addNote(id, dto, user); }

  /** Documentar con foto de evidencia (y geo-etiquetado si el dispositivo lo da). */
  attachNote(id: string, file: MulterFile, dto: AttachNoteDto, user: AuthUser) {
    if (!file) throw new BadRequestException('Sube una imagen en el campo "file".');
    return this.tasks.addNoteAttachment(id, file, dto, user);
  }

  /** Sirve la foto de un renglón del seguimiento (inline, para el preview autenticado). */
  async noteAttachment(id: string, noteId: string, res: Response) {
    const a = await this.tasks.noteAttachment(id, noteId);
    const abs = join(UPLOAD_ROOT, id, a.storedName);
    if (!existsSync(abs)) throw new NotFoundException('La imagen ya no está en el servidor');
    return enviarAdjuntoSeguro(res, abs, a.originalName);
  }
}
