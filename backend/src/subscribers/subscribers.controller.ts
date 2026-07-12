import {
  BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch,
  Post, Query, Res, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import type { Response } from 'express';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SubscribersService } from './subscribers.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { UpdateSubscriberDto, AddNoteDto, UpdateInvoiceDto, CreateSubscriberDto } from './dto/update-subscriber.dto';
import { AssignPlanDto, AssignPlansDto } from '../plans/dto/plan.dto';
import { BulkFilterDto, BulkMessageDto } from './dto/bulk.dto';
import { pazYSalvoPdf, statementPdf } from './subscriber-pdf';
import { contractPdf } from '../common/pdf/pdf-docs';

/** Forma mínima del archivo que entrega multer (evita depender de @types/multer). */
type MulterFile = { originalname: string; filename: string; mimetype: string; size: number; path: string };

const UPLOAD_ROOT = join(process.cwd(), 'uploads', 'subscribers');
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB
const ALLOWED_EXT = new Set([
  '.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic',
  '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt', '.zip',
]);

/** Clientes / abonados ISP (vertical migrado de saves-vestel). */
@Controller('subscribers')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('administracion', 'contabilidad', 'tecnicos', 'caja')
export class SubscribersController {
  constructor(private readonly subscribers: SubscribersService) {}

  @Get('stats')
  stats() {
    return this.subscribers.stats();
  }

  @Get('branches')
  branches() {
    return this.subscribers.branches();
  }

  @Get('branches-stats')
  branchesStats() {
    return this.subscribers.branchesStats();
  }

  // ── Operaciones masivas por FILTRO (corta/reconecta TODOS los que cumplen) ──
  @Post('bulk/cut')
  bulkCut(@Body() dto: BulkFilterDto, @CurrentUser() user: AuthUser) {
    return this.subscribers.cutByFilter(dto, user);
  }

  @Post('bulk/reconnect')
  bulkReconnect(@Body() dto: BulkFilterDto, @CurrentUser() user: AuthUser) {
    return this.subscribers.reconnectByFilter(dto, user);
  }

  @Post('bulk/message')
  bulkMessage(@Body() dto: BulkMessageDto) {
    return this.subscribers.messageByFilter(dto, dto.message);
  }

  // ── Catálogos de dirección (cascada) ─────────────────────────
  @Get('geo/departments')
  geoDepartments() {
    return this.subscribers.geoDepartments();
  }

  @Get('geo/cities')
  geoCities(@Query('department') department?: string) {
    return this.subscribers.geoCities(department ? Number(department) : undefined);
  }

  @Get('geo/localities')
  geoLocalities(@Query('city') city?: string) {
    return this.subscribers.geoLocalities(city ? Number(city) : undefined);
  }

  @Get('geo/neighborhoods')
  geoNeighborhoods(@Query('locality') locality?: string) {
    return this.subscribers.geoNeighborhoods(locality ? Number(locality) : undefined);
  }

  @Post()
  create(@Body() dto: CreateSubscriberDto) {
    return this.subscribers.create(dto);
  }

  @Get()
  list(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('branchId') branchId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('withPlan') withPlan?: string,
    @Query('servicio') servicio?: string,
    @Query('tecnologia') tecnologia?: string,
    @Query('cuenta') cuenta?: string,
    @Query('deuda') deuda?: string,
  ) {
    return this.subscribers.list({ search, status, branchId, page: Number(page), pageSize: Number(pageSize), withPlan, servicio, tecnologia, cuenta, deuda });
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.subscribers.detail(id);
  }

  @Get(':id/form')
  editForm(@Param('id') id: string) {
    return this.subscribers.editForm(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateSubscriberDto) {
    return this.subscribers.update(id, dto);
  }

  /** Cambiar el plan del abonado (catálogo → precio de la próxima factura + perfil al router). */
  @Post(':id/plan')
  changePlan(@Param('id') id: string, @Body() dto: AssignPlanDto, @CurrentUser() user: AuthUser) {
    return this.subscribers.changePlan(id, dto.planId, user);
  }

  /** Cambiar varios planes a la vez (ej. Internet + TV) en una sola operación. */
  @Post(':id/plans')
  changePlans(@Param('id') id: string, @Body() dto: AssignPlansDto, @CurrentUser() user: AuthUser) {
    return this.subscribers.changePlans(id, dto.planIds, user);
  }

  // ── Archivos ────────────────────────────────────────────────────

  @Get(':id/files')
  listFiles(@Param('id') id: string) {
    return this.subscribers.listFiles(id);
  }

  @Post(':id/files')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (req, _file, cb) => {
          const dir = join(UPLOAD_ROOT, (req.params as { id: string }).id);
          mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`),
      }),
      limits: { fileSize: MAX_FILE_BYTES },
      fileFilter: (_req, file, cb) => {
        const ok = ALLOWED_EXT.has(extname(file.originalname).toLowerCase());
        cb(ok ? null : new BadRequestException('Tipo de archivo no permitido'), ok);
      },
    }),
  )
  async upload(@Param('id') id: string, @UploadedFile() file: MulterFile, @CurrentUser() user: AuthUser) {
    if (!file) throw new BadRequestException('No se recibió ningún archivo');
    // El archivo ya se escribió en disco; si el cliente no existe, lo limpiamos.
    try {
      return await this.subscribers.addFile(id, file, user?.name ?? user?.email);
    } catch (e) {
      try { unlinkSync(file.path); } catch { /* noop */ }
      throw e;
    }
  }

  @Get(':id/files/:fileId/download')
  async download(@Param('id') id: string, @Param('fileId') fileId: string, @Res() res: Response) {
    const f = await this.subscribers.fileMeta(id, fileId);
    const abs = join(UPLOAD_ROOT, id, f.storedName);
    if (!existsSync(abs)) throw new NotFoundException('El archivo no está en el servidor');
    res.setHeader('Content-Type', f.mimeType || 'application/octet-stream');
    res.download(abs, f.originalName);
  }

  @Delete(':id/files/:fileId')
  async deleteFile(@Param('id') id: string, @Param('fileId') fileId: string) {
    const storedName = await this.subscribers.deleteFile(id, fileId);
    try { unlinkSync(join(UPLOAD_ROOT, id, storedName)); } catch { /* archivo ya no existe */ }
    return { ok: true };
  }

  // ── Notas ────────────────────────────────────────────────────

  @Post(':id/notes')
  addNote(@Param('id') id: string, @Body() dto: AddNoteDto, @CurrentUser() user: AuthUser) {
    return this.subscribers.addNote(id, dto.body, user?.name ?? user?.email);
  }

  @Delete(':id/notes/:noteId')
  deleteNote(@Param('id') id: string, @Param('noteId') noteId: string) {
    return this.subscribers.deleteNote(id, noteId);
  }

  // ── Facturas ─────────────────────────────────────────────────

  @Get(':id/invoices')
  invoices(@Param('id') id: string) {
    return this.subscribers.invoices(id);
  }

  // ── Facturas: editar / eliminar ──────────────────────────────

  @Patch(':id/invoices/:invoiceId')
  updateInvoice(@Param('id') id: string, @Param('invoiceId') invoiceId: string, @Body() dto: UpdateInvoiceDto) {
    return this.subscribers.updateInvoice(id, invoiceId, dto);
  }

  @Delete(':id/invoices/:invoiceId')
  deleteInvoice(@Param('id') id: string, @Param('invoiceId') invoiceId: string) {
    return this.subscribers.deleteInvoice(id, invoiceId);
  }

  // ── Estado de cuenta ─────────────────────────────────────────

  @Get(':id/statement')
  statement(@Param('id') id: string) {
    return this.subscribers.statement(id);
  }

  @Get(':id/paz-y-salvo.pdf')
  async pazYSalvo(@Param('id') id: string, @Res() res: Response) {
    const data = await this.subscribers.statement(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="paz-y-salvo-${data.subscriber.abonado}.pdf"`);
    pazYSalvoPdf(res, data);
  }

  @Get(':id/contract.pdf')
  async contractPdfEndpoint(@Param('id') id: string, @Res() res: Response) {
    const data = await this.subscribers.contractData(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="contrato-${data.abonado}.pdf"`);
    contractPdf(res, data);
  }

  @Get(':id/statement.pdf')
  async statementPdfEndpoint(@Param('id') id: string, @Res() res: Response) {
    const data = await this.subscribers.statement(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="estado-cuenta-${data.subscriber.abonado}.pdf"`);
    statementPdf(res, data);
  }
}
