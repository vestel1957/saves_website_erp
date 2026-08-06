import { BadRequestException, NotFoundException } from '../core/http/errores';
import { StaffDocumentKind } from '@prisma/client';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/current-user.decorator';

/** Forma mínima del archivo que entrega multer (evita depender de @types/multer). */
export type ArchivoSubido = {
  originalname: string;
  filename: string;
  mimetype: string;
  size: number;
  path: string;
};

export const TIPOS_DOCUMENTO = ['CV', 'IDENTITY', 'CONTRACT', 'CERTIFICATE', 'OTHER'] as const;

export class SubirDocumentoDto {
  @IsOptional() @IsIn(TIPOS_DOCUMENTO) kind?: StaffDocumentKind;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
}

/** Etiquetas en español para la UI y los listados. */
export const ETIQUETA_TIPO: Record<StaffDocumentKind, string> = {
  CV: 'Hoja de vida',
  IDENTITY: 'Documento de identidad',
  CONTRACT: 'Contrato',
  CERTIFICATE: 'Certificado / examen',
  OTHER: 'Otro',
};

/**
 * Carpeta de documentos de un funcionario (metadata en BD; el binario lo escribe
 * multer en `uploads/staff/<staffId>/`).
 *
 * Cuelga de `Staff` y no de `Employee`: ver el comentario del modelo. Lo que hay
 * que recordar al tocar esto es que una hoja de vida trae cédula, dirección,
 * teléfono y firma — se sirve solo por endpoint autenticado, nunca como archivo
 * estático, y el nombre en disco no se deriva jamás del nombre que manda el
 * cliente (ver common/uploads.ts).
 */
export class StaffDocumentsService {
  constructor(private readonly prisma: PrismaService) {}

  private async exigirFuncionario(staffId: string) {
    const s = await this.prisma.staff.findUnique({ where: { id: staffId }, select: { id: true, name: true } });
    if (!s) throw new NotFoundException('Empleado no encontrado');
    return s;
  }

  /** Documentos del funcionario, del más reciente al más viejo. */
  async listar(staffId: string) {
    await this.exigirFuncionario(staffId);
    const filas = await this.prisma.staffDocument.findMany({
      where: { staffId },
      orderBy: { createdAt: 'desc' },
    });
    return {
      total: filas.length,
      /** Cuántos hay de cada tipo, para que la ficha muestre qué falta. */
      porTipo: TIPOS_DOCUMENTO.map((k) => ({
        kind: k,
        label: ETIQUETA_TIPO[k],
        total: filas.filter((f) => f.kind === k).length,
      })),
      documentos: filas.map((f) => ({
        id: f.id,
        kind: f.kind,
        kindLabel: ETIQUETA_TIPO[f.kind],
        fileName: f.fileName,
        mimeType: f.mimeType,
        size: f.size,
        description: f.description,
        uploadedBy: f.uploadedBy,
        createdAt: f.createdAt,
      })),
    };
  }

  /** Registra la metadata de un archivo que multer ya dejó en disco. */
  async agregar(staffId: string, archivo: ArchivoSubido, dto: SubirDocumentoDto, user?: AuthUser) {
    await this.exigirFuncionario(staffId);
    const row = await this.prisma.staffDocument.create({
      data: {
        staffId,
        kind: dto.kind ?? 'OTHER',
        // multer entrega el nombre en latin1; sin esto "Hoja de vida Andrés.pdf"
        // se guarda con la tilde rota y así se descarga después.
        fileName: Buffer.from(archivo.originalname, 'latin1').toString('utf8'),
        storedName: archivo.filename,
        mimeType: archivo.mimetype,
        size: archivo.size,
        description: dto.description?.trim() || null,
        uploadedById: user?.id ?? null,
        uploadedBy: user?.name || user?.email || null,
      },
    });
    return { id: row.id, fileName: row.fileName, kind: row.kind, size: row.size, createdAt: row.createdAt };
  }

  /**
   * Metadata para servir el archivo. Valida que el documento sea DE ese
   * funcionario: sin esta comprobación, conocer un id de documento bastaría para
   * bajarse la cédula de cualquiera pidiéndolo bajo otro empleado.
   */
  async meta(staffId: string, docId: string) {
    const f = await this.prisma.staffDocument.findFirst({ where: { id: docId, staffId } });
    if (!f) throw new NotFoundException('Documento no encontrado');
    return f;
  }

  /** Borra el registro y devuelve el nombre en disco para que el controller lo elimine. */
  async eliminar(staffId: string, docId: string) {
    const f = await this.meta(staffId, docId);
    await this.prisma.staffDocument.delete({ where: { id: f.id } });
    return f.storedName;
  }

  /** Valida el tipo recibido por multipart (llega como texto suelto, no por el pipe). */
  static tipoValido(kind?: string): StaffDocumentKind {
    if (!kind) return 'OTHER';
    if (!(TIPOS_DOCUMENTO as readonly string[]).includes(kind)) {
      throw new BadRequestException(`Tipo de documento no válido: ${kind}`);
    }
    return kind as StaffDocumentKind;
  }
}
