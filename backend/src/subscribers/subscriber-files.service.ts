import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/current-user.decorator';
import { exigirSedeSuscriptor } from '../common/sede-scope';

/** Forma mínima del archivo que entrega multer. */
type UploadedFileMeta = {
  originalname: string;
  filename: string;
  mimetype: string;
  size: number;
};

/**
 * Adjuntos de un cliente (metadata en BD; el binario lo guarda multer en disco).
 * Extraído de SubscribersService: bloque autónomo sobre `subscriberFile`.
 */
@Injectable()
export class SubscriberFilesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Lista de archivos adjuntos del cliente (metadata). */
  async listFiles(id: string, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, id);
    const files = await this.prisma.subscriberFile.findMany({
      where: { subscriberId: id },
      orderBy: { createdAt: 'desc' },
    });
    return files.map((f) => ({
      id: f.id,
      name: f.originalName,
      mimeType: f.mimeType,
      size: f.size,
      uploadedBy: f.uploadedByName,
      createdAt: f.createdAt,
    }));
  }

  /** Registra la metadata de un archivo ya guardado en disco por multer. */
  async addFile(id: string, file: UploadedFileMeta, uploadedByName?: string, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, id);
    const row = await this.prisma.subscriberFile.create({
      data: {
        subscriberId: id,
        originalName: Buffer.from(file.originalname, 'latin1').toString('utf8'),
        storedName: file.filename,
        mimeType: file.mimetype,
        size: file.size,
        uploadedByName: uploadedByName ?? null,
      },
    });
    return {
      id: row.id,
      name: row.originalName,
      mimeType: row.mimeType,
      size: row.size,
      createdAt: row.createdAt,
    };
  }

  /** Metadata de un archivo (para descargar/servir). Valida que pertenezca al cliente. */
  async fileMeta(subscriberId: string, fileId: string, user?: AuthUser) {
    await exigirSedeSuscriptor(this.prisma, user, subscriberId);
    const f = await this.prisma.subscriberFile.findFirst({ where: { id: fileId, subscriberId } });
    if (!f) throw new NotFoundException('Archivo no encontrado');
    return f;
  }

  /** Elimina el registro del archivo. Devuelve el nombre en disco para que el controller lo borre. */
  async deleteFile(subscriberId: string, fileId: string, user?: AuthUser) {
    const f = await this.fileMeta(subscriberId, fileId, user);
    await this.prisma.subscriberFile.delete({ where: { id: f.id } });
    return f.storedName;
  }
}
