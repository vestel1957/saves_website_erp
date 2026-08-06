import { BadRequestException } from '../core/http/errores';
import { diskStorage } from 'multer';
import { existsSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { ExtrasService } from './extras.service';

export const DOC_ROOT = join(process.cwd(), 'uploads', 'documents');
/** Extensiones que admite el repositorio documental. */
export const EXT_DOCUMENTO = new Set([
  '.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.txt', '.zip',
]);

/** Módulos nicho: PlayHub/IPTV, mensajería interna, gestor documental. */
export class ExtrasController {
  constructor(private readonly extras: ExtrasService) {}

  // --- PlayHub ---
  playhub(search?: string, page?: string, pageSize?: string, sortBy?: string, sortDir?: string) {
    return this.extras.playhub({ search, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir });
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
