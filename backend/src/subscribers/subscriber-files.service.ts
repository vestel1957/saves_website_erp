import { NotFoundException } from '../core/http/errores';
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
 * El catálogo de tipos de documento vive en `subscriber-file-kinds.ts` (lo comparten
 * el controlador, el estado de cuenta y la pantalla). Se reexporta la marca de la
 * carta de retiro porque es la que ya importaban `SubscribersService` y el router.
 */
export { KIND_CARTA_RETIRO } from './subscriber-file-kinds';

/**
 * Adjuntos de un cliente (metadata en BD; el binario lo guarda multer en disco).
 * Extraído de SubscribersService: bloque autónomo sobre `subscriberFile`.
 */
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
      // Para qué es el adjunto (`VIVIENDA` = foto de la casa). La ficha saca de
      // aquí la foto de arriba sin pedir una lista aparte.
      kind: f.kind,
      createdAt: f.createdAt,
      // Los adjuntos que vienen del sistema anterior (`meta_data` type=6) no traen
      // fecha de subida: allá la tabla no la guarda. `createdAt` es la de importación,
      // así que la pantalla no la muestra como si fuera la del archivo.
      legacy: f.legacyId != null,
    }));
  }

  /**
   * Registra la metadata de un archivo ya guardado en disco por multer.
   *
   * `kind` marca PARA QUÉ es el adjunto (carta de retiro, suspensión, solicitud,
   * foto de la vivienda…). El catálogo y su validación están en
   * `subscriber-file-kinds.ts`; aquí llega ya normalizado. Sin él, adjunto sin
   * clasificar, como los que bajan del sistema anterior.
   */
  async addFile(id: string, file: UploadedFileMeta, uploadedByName?: string, user?: AuthUser, kind?: string) {
    await exigirSedeSuscriptor(this.prisma, user, id);
    const row = await this.prisma.subscriberFile.create({
      data: {
        subscriberId: id,
        originalName: Buffer.from(file.originalname, 'latin1').toString('utf8'),
        storedName: file.filename,
        mimeType: file.mimetype,
        size: file.size,
        uploadedByName: uploadedByName ?? null,
        kind: kind ?? null,
      },
    });
    return {
      id: row.id,
      name: row.originalName,
      mimeType: row.mimeType,
      size: row.size,
      kind: row.kind,
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
