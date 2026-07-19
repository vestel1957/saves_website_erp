import {
  BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { existsSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { TreasuryService } from './treasury.service';
import { cashClosePdf, receiptPdf } from '../common/pdf/pdf-docs';
import { CobranzasService } from './cobranzas.service';
import {
  CashAccountDto, CashCloseDto, CashOpenDto, CollectDto, EditTxDto, ExpenseDto,
  IncomeDto, TransferDto, TxCategoryDto, VoidTxDto,
} from './dto/cobranzas.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

/** Carpeta de comprobantes/evidencia de los movimientos de tesorería. */
const TREASURY_ROOT = join(process.cwd(), 'uploads', 'treasury');
type MulterFile = { originalname: string; filename: string; mimetype: string; size: number };

/** Tesorería: movimientos, cajas y cierres (migrado de saves-vestel). */
@Controller('treasury')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('contabilidad', 'administracion', 'caja')
export class TreasuryController {
  constructor(
    private readonly treasury: TreasuryService,
    private readonly cobranzas: CobranzasService,
  ) {}

  @Get('stats')
  stats(@Query('from') from?: string, @Query('to') to?: string, @Query('all') all?: string) {
    return this.treasury.stats({ from, to, all });
  }

  @Get('categories')
  categories() {
    return this.treasury.categories();
  }

  @Get('cash-closes')
  cashCloses(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('all') all?: string,
    @Query('cashAccountId') cashAccountId?: string,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.treasury.cashCloses({
      page: Number(page), pageSize: Number(pageSize), from, to, all,
      cashAccountId: cashAccountId ? Number(cashAccountId) : undefined,
    }, user!);
  }

  /** Cierres agregados por día/semana/mes (vista consolidada). */
  @Get('cash-closes/summary')
  cashClosesSummary(
    @Query('group') group?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('all') all?: string,
    @Query('cashAccountId') cashAccountId?: string,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.treasury.cashClosesSummary({
      group, from, to, all,
      cashAccountId: cashAccountId ? Number(cashAccountId) : undefined,
    }, user!);
  }

  /**
   * Arqueo de una caja en un día que aún no se ha cerrado, SIN escribir nada.
   * Lo consume el modal de cierre para que el cajero compare contra el cajón antes de
   * cerrar, en vez de descubrir el arqueo después de guardarlo.
   */
  @Get('cash-close/preview')
  cashClosePreview(
    @Query('cashAccountId') cashAccountId: string,
    @Query('date') date: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.treasury.cashClosePreview(Number(cashAccountId), date, user);
  }

  /**
   * Detalle de un cierre: sus cifras y los movimientos que lo componen.
   * Va declarada DESPUÉS de `cash-closes/summary`: si no, 'summary' entraría por `:id`.
   */
  @Get('cash-closes/:id')
  cashCloseDetail(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.treasury.cashCloseDetail(id, user);
  }

  /**
   * Informe del cierre (cobranza, bancos, servicios, meses, forma de pago, anulaciones,
   * egresos) de una caja en una fecha, sin necesidad de que esté cerrada.
   */
  @Get('cash-close/report')
  cashCloseReport(
    @Query('cashAccountId') cashAccountId: string,
    @Query('date') date: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.treasury.cashCloseReport(Number(cashAccountId), date, user);
  }

  /** PDF del cierre de caja (arqueo). */
  @Get('cash-closes/:id/pdf')
  async cashClosePdf(@Param('id') id: string, @Res() res: Response, @CurrentUser() user?: AuthUser) {
    const d = await this.treasury.cashClosePdfData(id, user!);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="cierre-caja.pdf"`);
    cashClosePdf(res, d);
  }

  /** PDF del recibo de caja (comprobante de pago). */
  @Get('receipts/:id/pdf')
  async receiptPdf(@Param('id') id: string, @Res() res: Response) {
    const d = await this.treasury.receiptPdfData(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="recibo-${d.number}.pdf"`);
    receiptPdf(res, d);
  }

  @Get('transactions')
  list(
    @Query('search') search?: string,
    @Query('type') type?: string,
    @Query('category') category?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('all') all?: string,
    @Query('cashAccountId') cashAccountId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.treasury.list({
      search, type, category, status, from, to, all,
      cashAccountId: cashAccountId ? Number(cashAccountId) : undefined,
      page: Number(page), pageSize: Number(pageSize),
    }, user as AuthUser);
  }

  @Get('transactions/:id')
  detail(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.treasury.detail(id, user);
  }

  /** Adjuntar el comprobante/evidencia de un movimiento (imagen o PDF). */
  @Post('transactions/:id/attach')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => { if (!existsSync(TREASURY_ROOT)) mkdirSync(TREASURY_ROOT, { recursive: true }); cb(null, TREASURY_ROOT); },
        filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`),
      }),
      limits: { fileSize: 15 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf'),
    }),
  )
  attach(@Param('id') id: string, @UploadedFile() file: MulterFile, @CurrentUser() user: AuthUser) {
    if (!file) throw new BadRequestException('Sube una imagen o PDF en el campo "file".');
    return this.treasury.attachTransaction(id, file, user);
  }

  /** Sirve el comprobante adjunto de un movimiento (inline, para preview autenticado). */
  @Get('transactions/:id/attachment')
  async attachment(@Param('id') id: string, @Res() res: Response, @CurrentUser() user: AuthUser) {
    const a = await this.treasury.getTransactionAttachment(id, user);
    return res.sendFile(join(TREASURY_ROOT, a.storedName));
  }

  // --- Cobranzas (escritura) ---

  /** Cajas disponibles (para selectores de recaudo/egreso/cierre). */
  @Get('cash-accounts')
  cashAccounts(@CurrentUser() user: AuthUser) {
    // Acotada a lo que este usuario puede ver: la cajera sólo su caja + los bancos.
    return this.cobranzas.cashAccounts(user);
  }

  /**
   * Qué caja puede ver quien pregunta. La pantalla lo usa para fijarle la suya a la
   * cajera (y no dejarla cambiar de caja) en vez de ofrecerle "todas".
   */
  @Get('mi-caja')
  miCaja(@CurrentUser() user: AuthUser) {
    return this.cobranzas.miCaja(user);
  }

  /** Crear una caja o banco. */
  @Post('cash-accounts')
  createCashAccount(@Body() dto: CashAccountDto, @CurrentUser() user: AuthUser) {
    return this.cobranzas.createCashAccount(dto, user);
  }

  /** Editar una caja (por su id legacy). */
  @Patch('cash-accounts/:id')
  updateCashAccount(@Param('id') id: string, @Body() dto: CashAccountDto, @CurrentUser() user: AuthUser) {
    return this.cobranzas.updateCashAccount(Number(id), dto, user);
  }

  /** Eliminar una caja (bloquea si tiene movimientos). */
  @Delete('cash-accounts/:id')
  deleteCashAccount(@Param('id') id: string) {
    return this.cobranzas.deleteCashAccount(Number(id));
  }

  /** Recalcular el saldo persistente de una caja desde sus movimientos. */
  @Post('cash-accounts/:id/recompute')
  recomputeCashAccount(@Param('id') id: string) {
    return this.cobranzas.recomputeCashAccount(Number(id));
  }

  /** Crear una categoría de transacción. */
  @Post('categories')
  createCategory(@Body() dto: TxCategoryDto) {
    return this.cobranzas.createCategory(dto);
  }

  /** Renombrar una categoría (propaga a las transacciones). */
  @Patch('categories/:id')
  updateCategory(@Param('id') id: string, @Body() dto: TxCategoryDto) {
    return this.cobranzas.updateCategory(id, dto);
  }

  /** Eliminar una categoría (bloquea si está en uso). */
  @Delete('categories/:id')
  deleteCategory(@Param('id') id: string) {
    return this.cobranzas.deleteCategory(id);
  }

  /** Facturas pendientes de un cliente (para el modal de recaudo). */
  @Get('subscribers/:id/debt')
  subscriberDebt(@Param('id') id: string) {
    return this.cobranzas.subscriberDebt(id);
  }

  /** Registrar un recaudo/pago (multipago en cascada + recibo). */
  @Post('collect')
  collect(@Body() dto: CollectDto, @CurrentUser() user: AuthUser) {
    return this.cobranzas.collect(dto, user);
  }

  /** Registrar un egreso/gasto de caja. */
  @Post('expenses')
  expense(@Body() dto: ExpenseDto, @CurrentUser() user: AuthUser) {
    return this.cobranzas.createExpense(dto, user);
  }

  /** Registrar un ingreso manual libre (no ligado a factura). */
  @Post('income')
  income(@Body() dto: IncomeDto, @CurrentUser() user: AuthUser) {
    return this.cobranzas.createIncome(dto, user);
  }

  /** Editar un movimiento (campos seguros; monto solo en no-ventas). */
  @Patch('transactions/:id')
  editTx(@Param('id') id: string, @Body() dto: EditTxDto, @CurrentUser() user: AuthUser) {
    return this.cobranzas.editTransaction(id, dto, user);
  }

  /** Transferir dinero entre dos cajas. */
  @Post('transfer')
  transfer(@Body() dto: TransferDto, @CurrentUser() user: AuthUser) {
    return this.cobranzas.createTransfer(dto, user);
  }

  /** Anular una transacción (soft-delete + reversa de saldo). */
  @Post('transactions/:id/void')
  voidTx(@Param('id') id: string, @Body() dto: VoidTxDto, @CurrentUser() user: AuthUser) {
    return this.cobranzas.voidTransaction(id, dto, user);
  }

  /** Cierre de caja (arqueo) de una caja en una fecha. */
  @Post('cash-close')
  cashClose(@Body() dto: CashCloseDto, @CurrentUser() user: AuthUser) {
    return this.cobranzas.createCashClose(dto, user);
  }

  /** Apertura de caja (base inicial). */
  @Post('cash-open')
  cashOpen(@Body() dto: CashOpenDto, @CurrentUser() user: AuthUser) {
    return this.cobranzas.openCash(dto, user);
  }

  /** Sugerencia de base para abrir: fondo fijo + arrastre del día anterior. */
  @Get('cash-open-suggest')
  cashOpenSuggest(@Query('cashAccountId') cashAccountId: string, @Query('date') date: string) {
    return this.cobranzas.cashOpenSuggest(Number(cashAccountId), date);
  }

  /** Aperturas recientes. */
  @Get('cash-opens')
  cashOpens(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.cobranzas.cashOpens({ page: Number(page), pageSize: Number(pageSize) });
  }
}
