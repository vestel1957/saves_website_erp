import {
  BadRequestException, Body, Controller, Get, Param, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { existsSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { SupportService } from './support.service';
import {
  SupportWriteService, CreateTicketDto, UpdateStatusDto, AssignDto, PriorityDto, SignatureDto, ThreadDto, AttachDto,
  AssignEquipmentDto, ConsumeMaterialsDto,
} from './support-write.service';
import { serviceOrderPdf } from '../common/pdf/pdf-docs';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { enviarAdjuntoSeguro, mimeAceptado, nombreEnDisco, MIMES_IMAGEN } from '../common/uploads';

/** Carpeta de evidencias fotográficas de las órdenes de soporte. */
const SUPPORT_ROOT = join(process.cwd(), 'uploads', 'support');
type MulterFile = { originalname: string; filename: string; mimetype: string; size: number };

/** Soporte: órdenes/tickets, llamadas, encuestas (migrado de saves-vestel). */
@Controller('support')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('tecnicos', 'administracion', 'caja')
export class SupportController {
  constructor(
    private readonly support: SupportService,
    private readonly write: SupportWriteService,
  ) {}

  @Get('stats') stats() { return this.support.stats(); }
  @Get('filter-options') filterOptions() { return this.support.filterOptions(); }

  // --- Escritura ---
  @Get('technicians') technicians() { return this.write.technicians(); }
  @Post('tickets') createTicket(@Body() dto: CreateTicketDto, @CurrentUser() user: AuthUser) { return this.write.createTicket(dto, user); }
  @Post('tickets/:id/status') updateStatus(@Param('id') id: string, @Body() dto: UpdateStatusDto, @CurrentUser() user: AuthUser) { return this.write.updateStatus(id, dto, user); }
  @Post('tickets/:id/assign') assign(@Param('id') id: string, @Body() dto: AssignDto) { return this.write.assign(id, dto); }
  @Post('tickets/:id/priority') setPriority(@Param('id') id: string, @Body() dto: PriorityDto) { return this.write.setPriority(id, dto); }
  @Post('tickets/:id/signature') sign(@Param('id') id: string, @Body() dto: SignatureDto) { return this.write.saveSignature(id, dto); }
  /** Sirve el PNG de la firma dibujada de una orden. */
  @Get('tickets/:id/signature.png')
  async signaturePng(@Param('id') id: string, @Res() res: Response) {
    const file = join(process.cwd(), 'uploads', 'signatures', `${id}.png`);
    if (!existsSync(file)) return res.status(404).send('sin firma');
    return enviarAdjuntoSeguro(res, file, `firma-${id}.png`);
  }
  @Post('tickets/:id/thread') thread(@Param('id') id: string, @Body() dto: ThreadDto, @CurrentUser() user: AuthUser) { return this.write.addThread(id, dto, user); }

  // --- Equipo y material de la orden ---
  @Get('equipment/available') availableEquipment(@Query('search') search?: string) { return this.write.availableEquipment(search); }
  @Get('materials/search') searchMaterials(@Query('search') search?: string) { return this.write.searchMaterials(search); }
  @Post('tickets/:id/equipment') assignEquipment(@Param('id') id: string, @Body() dto: AssignEquipmentDto, @CurrentUser() user: AuthUser) { return this.write.assignEquipment(id, dto, user); }
  @Post('tickets/:id/materials') consumeMaterials(@Param('id') id: string, @Body() dto: ConsumeMaterialsDto, @CurrentUser() user: AuthUser) { return this.write.consumeMaterials(id, dto, user); }

  /** PDF de la orden de servicio (acta técnica). */
  @Get('tickets/:id/pdf')
  async ticketPdf(@Param('id') id: string, @Res() res: Response) {
    const data = await this.support.serviceOrderPdfData(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Orden_${data.code}.pdf"`);
    serviceOrderPdf(res, data);
  }

  /** Adjuntar una foto de evidencia al hilo (con geo-etiquetado opcional). Solo imágenes. */
  @Post('tickets/:id/attach')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => { if (!existsSync(SUPPORT_ROOT)) mkdirSync(SUPPORT_ROOT, { recursive: true }); cb(null, SUPPORT_ROOT); },
        filename: (_req, file, cb) => cb(null, nombreEnDisco(randomUUID(), file.mimetype)),
      }),
      limits: { fileSize: 15 * 1024 * 1024 },
      // Lista blanca de MIME concretos, no `startsWith('image/')`: aquél aceptaba
      // cualquier `image/loquesea` y la extensión salía del nombre del cliente.
      fileFilter: (_req, file, cb) => cb(null, mimeAceptado(file.mimetype, MIMES_IMAGEN)),
    }),
  )
  attach(
    @Param('id') id: string,
    @UploadedFile() file: MulterFile,
    @Body() dto: AttachDto,
    @CurrentUser() user: AuthUser,
  ) {
    if (!file) throw new BadRequestException('Sube una imagen en el campo "file".');
    return this.write.addAttachment(id, file, dto, user);
  }

  /** Sirve la imagen adjunta de una entrada del hilo (inline, para preview autenticado vía blob). */
  @Get('threads/:threadId/attachment')
  async attachment(@Param('threadId') threadId: string, @Res() res: Response) {
    const a = await this.support.getThreadAttachment(threadId);
    return enviarAdjuntoSeguro(res, join(SUPPORT_ROOT, a.storedName), a.storedName);
  }

  @Get('tickets')
  tickets(@Query('search') search?: string, @Query('status') status?: string, @Query('type') type?: string, @Query('tec') tec?: string, @Query('priority') priority?: string, @Query('sede') sede?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('all') all?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string, @CurrentUser() user?: AuthUser) {
    return this.support.tickets({ search, status, type, tec, priority, sede, from, to, all, page: Number(page), pageSize: Number(pageSize) }, user);
  }

  /** "Mi jornada": órdenes y contadores del técnico logueado (para el workspace /inicio). */
  @Get('my-work') myWork(@CurrentUser() user: AuthUser) { return this.support.myWork(user); }

  @Get('tickets/:id') ticketDetail(@Param('id') id: string, @CurrentUser() user?: AuthUser) { return this.support.ticketDetail(id, user); }

}
