import {
  BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Res,
  UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import type { Response } from 'express';
import { createReadStream, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as ExcelJS from 'exceljs';
import { OrdersService } from './orders.service';
import { AddNoteDto, ApproveOrderDto, CancelOrderDto, CategoryNameDto, CreateOrderDto, CreateSupplierDto, PayOrderDto, ReceiveOrderDto, UpdateOrderDto } from './dto/orders.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequireArea } from '../auth/require-area.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { purchaseOrderPdf } from '../common/pdf/pdf-docs';

/** Forma mínima del archivo que entrega multer (evita depender de @types/multer). */
type MulterFile = { originalname: string; filename: string; mimetype: string; size: number; path: string };

const UPLOAD_ROOT = join(process.cwd(), 'uploads', 'orders');
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB
const ALLOWED_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt', '.zip']);

/** Órdenes de compra / servicio + proveedores (migrado de saves-vestel). */
@Controller('orders')
@UseGuards(JwtAuthGuard, AreaGuard, PermissionsGuard)
// Compras salió del perfil de caja (2026-07-29): quien recauda no ordena compras.
// Se quita también aquí y no sólo del menú — si no, la API seguía abierta a `caja`.
// Ninguna pantalla suya llama a `/orders`: el único consumidor fuera de /ordenes es
// OrdersFilterButton, que vive dentro de las propias pantallas de compras.
@RequireArea('administracion')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get('stats') stats() { return this.orders.stats(); }

  @Get('suppliers')
  suppliers(@Query('category') category?: string, @Query('search') search?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string, @Query('sortBy') sortBy?: string, @Query('sortDir') sortDir?: string) {
    return this.orders.suppliers({ category, search, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir });
  }
  @Post('suppliers') createSupplier(@Body() dto: CreateSupplierDto) { return this.orders.createSupplier(dto); }
  @Get('suppliers/:id/statement') supplierStatement(@Param('id') id: string) { return this.orders.supplierStatement(id); }
  @Patch('suppliers/:id') updateSupplier(@Param('id') id: string, @Body() dto: CreateSupplierDto) { return this.orders.updateSupplier(id, dto); }
  @Delete('suppliers/:id') deleteSupplier(@Param('id') id: string) { return this.orders.deleteSupplier(id); }

  @Get('branches') branches() { return this.orders.branches(); }

  @Get('categories') categories() { return this.orders.categories(); }
  @Post('categories') createCategory(@Body() dto: CategoryNameDto) { return this.orders.createCategory(dto); }
  @Patch('categories/:id') updateCategory(@Param('id') id: string, @Body() dto: CategoryNameDto) { return this.orders.updateCategory(id, dto); }
  @Delete('categories/:id') deleteCategory(@Param('id') id: string) { return this.orders.deleteCategory(id); }

  @Get()
  list(
    @Query('kind') kind?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('category') category?: string,
    @Query('branch') branch?: string,
    @Query('supplier') supplier?: string,
    @Query('minTotal') minTotal?: string,
    @Query('maxTotal') maxTotal?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('sortBy') sortBy?: string, @Query('sortDir') sortDir?: string,
  ) {
    return this.orders.list({ kind, status, search, category, branch, supplier, minTotal, maxTotal, from, to, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir });
  }

  /** Export a Excel del listado (mismos filtros). Va ANTES de :id para no colisionar. */
  @Get('export.xlsx')
  async exportXlsx(
    @Res() res: Response,
    @Query('kind') kind?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('category') category?: string,
    @Query('branch') branch?: string,
    @Query('supplier') supplier?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const rows = await this.orders.exportRows({ kind, status, search, category, branch, supplier, from, to });
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Vestel';
    const ws = wb.addWorksheet('Órdenes');
    ws.columns = [
      { header: 'N°', key: 'tid', width: 8 },
      { header: 'Tipo', key: 'kind', width: 10 },
      { header: 'Proveedor', key: 'supplier', width: 32 },
      { header: 'Fecha', key: 'date', width: 12 },
      { header: 'Estado', key: 'status', width: 16 },
      { header: 'Total', key: 'total', width: 14 },
      { header: 'Pagado', key: 'paid', width: 14 },
      { header: 'Saldo', key: 'balance', width: 14 },
      { header: 'Sede', key: 'branchRef', width: 14 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      ws.addRow({ ...r, date: r.date ? new Date(r.date).toISOString().slice(0, 10) : '', balance: Math.round(((r.total ?? 0) - (r.paid ?? 0)) * 100) / 100 });
    }
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="ordenes-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(buffer);
  }

  @Get(':id') detail(@Param('id') id: string) { return this.orders.detail(id); }
  @Post() create(@Body() dto: CreateOrderDto, @CurrentUser() user: AuthUser) { return this.orders.create(dto, user); }
  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateOrderDto, @CurrentUser() user: AuthUser) { return this.orders.update(id, dto, user); }

  // --- Flujo de aprobación ---
  // Firmar exige el código que llega al WhatsApp del autorizador: primero se pide
  // (`approve/otp`) y después se aprueba con él. Las dos rutas van tras el mismo
  // permiso — pedir el código ya revela el proveedor y el monto de la orden.
  @RequirePermissions(APP_PERMISSIONS.PURCHASES_APPROVE)
  @Post(':id/approve/otp') approveOtp(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.orders.requestApprovalOtp(id, user); }
  @RequirePermissions(APP_PERMISSIONS.PURCHASES_APPROVE)
  @Post(':id/approve') approve(@Param('id') id: string, @Body() dto: ApproveOrderDto, @CurrentUser() user: AuthUser) { return this.orders.approve(id, user, dto.otp); }
  @Post(':id/cancel') cancel(@Param('id') id: string, @Body() dto: CancelOrderDto, @CurrentUser() user: AuthUser) { return this.orders.cancel(id, user, dto.reason); }
  @Post(':id/finalize') finalize(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.orders.finalize(id, user); }

  @Post(':id/receive') receive(@Param('id') id: string, @Body() dto: ReceiveOrderDto, @CurrentUser() user: AuthUser) { return this.orders.receive(id, dto, user); }
  @Post(':id/pay') pay(@Param('id') id: string, @Body() dto: PayOrderDto, @CurrentUser() user: AuthUser) { return this.orders.paySupplyOrder(id, dto, user); }
  @Post(':id/notes') addNote(@Param('id') id: string, @Body() dto: AddNoteDto, @CurrentUser() user: AuthUser) { return this.orders.addNote(id, dto, user); }
  @Delete(':id/notes/:noteId') removeNote(@Param('id') id: string, @Param('noteId') noteId: string) { return this.orders.removeNote(id, noteId); }
  @Delete(':id') remove(@Param('id') id: string) { return this.orders.remove(id); }

  // --- PDF imprimible (con cuadro de firmas) ---
  @Get(':id/pdf')
  async pdf(@Param('id') id: string, @Res() res: Response) {
    const d = await this.orders.pdfData(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="orden-${d.tid}.pdf"`);
    purchaseOrderPdf(res, {
      tid: d.tid, kind: d.kind, status: d.status, date: d.date, dueDate: d.dueDate,
      branchRef: d.branchRef, categoryRef: undefined, notes: d.notes,
      supplier: d.supplier ? { name: d.supplier.name, nit: d.supplier.nit, phone: d.supplier.phone } : null,
      items: d.items.map((it) => ({ ...it, product: it.product ?? '—' })),
      noteLines: d.noteLines.map((n) => ({ ...n, type: n.type ?? 'Nota' })),
      subtotal: d.subtotal, tax: d.tax, total: d.total, paid: d.paid, balance: d.balance,
      createdByName: d.approval.createdByName, firstBy: d.approval.firstBy, secondBy: d.approval.secondBy,
    });
  }

  // --- Adjuntos (factura del proveedor, cotizaciones…) ---
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
    try {
      return await this.orders.addFile(id, { originalName: file.originalname, storedName: file.filename, mimeType: file.mimetype, size: file.size }, user);
    } catch (e) {
      // La orden no existe u otro fallo: no dejar el binario huérfano en disco.
      try { unlinkSync(file.path); } catch { /* ya no está */ }
      throw e;
    }
  }

  @Get(':id/files/:fileId/download')
  async download(@Param('id') id: string, @Param('fileId') fileId: string, @Res() res: Response) {
    const f = await this.orders.fileMeta(id, fileId);
    const path = join(UPLOAD_ROOT, id, f.storedName);
    if (!existsSync(path)) throw new BadRequestException('El archivo no está en el disco.');
    res.setHeader('Content-Type', f.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.originalName)}"`);
    createReadStream(path).pipe(res);
  }

  @Delete(':id/files/:fileId')
  async deleteFile(@Param('id') id: string, @Param('fileId') fileId: string, @CurrentUser() user: AuthUser) {
    const f = await this.orders.deleteFile(id, fileId, user);
    const path = join(UPLOAD_ROOT, id, f.storedName);
    try { unlinkSync(path); } catch { /* metadata borrada; binario ya no estaba */ }
    return { ok: true };
  }
}
