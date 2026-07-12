import {
  BadRequestException, Body, Controller, Get, Param, Post, Query, Res,
  UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { existsSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { ExtrasService } from './extras.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';

const DOC_ROOT = join(process.cwd(), 'uploads', 'documents');

/** Módulos nicho: PlayHub/IPTV, mensajería interna, gestor documental. */
@Controller('extras')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('sistemas', 'administracion')
export class ExtrasController {
  constructor(private readonly extras: ExtrasService) {}

  // --- PlayHub ---
  @Get('playhub')
  playhub(@Query('search') search?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.extras.playhub({ search, page: Number(page), pageSize: Number(pageSize) });
  }

  // --- Mensajería ---
  @Get('messages')
  messages(@Query('search') search?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.extras.messages({ search, page: Number(page), pageSize: Number(pageSize) });
  }

  // --- Documental ---
  @Get('documents') documents() { return this.extras.documents(); }

  @Post('documents/folder') createFolder(@Body() body: { name: string }) {
    if (!body?.name?.trim()) throw new BadRequestException('Nombre de carpeta requerido.');
    return this.extras.createFolder(body.name.trim());
  }

  @Post('documents')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => { if (!existsSync(DOC_ROOT)) mkdirSync(DOC_ROOT, { recursive: true }); cb(null, DOC_ROOT); },
        filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`),
      }),
      limits: { fileSize: 25 * 1024 * 1024 },
    }),
  )
  async uploadDocument(@UploadedFile() file: any, @Body() body: { title?: string; folderId?: string }) {
    if (!file) throw new BadRequestException('Sube un archivo en el campo "file".');
    return this.extras.createDocument({
      title: body.title?.trim() || file.originalname,
      fileName: file.originalname,
      storedName: file.filename,
      folderId: body.folderId || undefined,
    });
  }

  @Get('documents/:id/download')
  async download(@Param('id') id: string, @Res() res: Response) {
    const d = await this.extras.getDocument(id);
    if (!d.storedName) throw new BadRequestException('Este documento no tiene archivo descargable (solo metadata migrada).');
    return res.download(join(DOC_ROOT, d.storedName), d.fileName ?? d.storedName);
  }
}
