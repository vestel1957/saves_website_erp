import { BadRequestException } from '../core/http/errores';
import { diskStorage } from 'multer';
import { existsSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { ExtrasService } from './extras.service';
// Lo usa el `fileFilter` de la subida, que vive en el router generado.
import { extensionDeAdjunto } from '../common/uploads';
import { variosDeQuery } from '../common/filtros-query';
import { AuthUser } from '../auth/current-user.decorator';

export const DOC_ROOT = join(process.cwd(), 'uploads', 'documents');
/** Extensiones que admite el repositorio documental. */
export const EXT_DOCUMENTO = new Set([
  '.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.txt', '.zip',
]);

/** Módulos nicho: PlayHub/IPTV, mensajería interna, gestor documental. */
export class ExtrasController {
  constructor(private readonly extras: ExtrasService) {}

  // --- PlayHub ---
  playhub(user: AuthUser, search?: string, page?: string, pageSize?: string, sortBy?: string, sortDir?: string, estado?: string, megas?: string, nivel?: string, sede?: string) {
    return this.extras.playhub(user, {
      search, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir, estado,
      // Varios valores en el mismo parámetro, separados por comas, como el resto
      // de listados (`?megas=300,600`).
      megas: variosDeQuery(megas), nivel: variosDeQuery(nivel), sede: variosDeQuery(sede),
    });
  }

  // --- Mensajería ---
  messages(search?: string, page?: string, pageSize?: string) {
    return this.extras.messages({ search, page: Number(page), pageSize: Number(pageSize) });
  }

  // --- Documental ---
  documents() { return this.extras.documents(); }

  createFolder(body: { name: string }) {
    if (!body?.name?.trim()) throw new BadRequestException('Nombre de carpeta requerido.');
    return this.extras.createFolder(body.name.trim());
  }

  async uploadDocument(file: any, body: { title?: string; folderId?: string }) {
    if (!file) throw new BadRequestException('Sube un archivo en el campo "file".');
    return this.extras.createDocument({
      title: body.title?.trim() || file.originalname,
      fileName: file.originalname,
      storedName: file.filename,
      folderId: body.folderId || undefined,
    });
  }

  async download(id: string, res: Response) {
    const d = await this.extras.getDocument(id);
    if (!d.storedName) throw new BadRequestException('Este documento no tiene archivo descargable (solo metadata migrada).');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.download(join(DOC_ROOT, d.storedName), d.fileName ?? d.storedName);
  }
}
