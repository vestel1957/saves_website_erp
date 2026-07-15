import { Body, Controller, Delete, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { BillingService } from './billing.service';
import { invoicePdf } from './billing-pdf';
import { FacturasService } from './facturas.service';
import { RecurringService } from './recurring.service';
import { CreateInvoiceDto, CreateNoteDto, GenerateInvoicesDto, VoidInvoiceDto } from './dto/facturas.dto';
import { CreateRecurringDto } from './dto/recurring.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

/** Facturación y cartera (vertical migrado de saves-vestel). */
@Controller('billing')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('contabilidad', 'caja')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly facturas: FacturasService,
    private readonly recurring: RecurringService,
  ) {}

  /** PDF de la factura (impresión estándar Vestel). */
  @Get('invoices/:id/pdf')
  async invoicePdf(@Param('id') id: string, @Res() res: Response) {
    const inv = await this.billing.detail(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="factura-${inv.tid}.pdf"`);
    invoicePdf(res, inv as any);
  }

  @Get('stats')
  stats(@Query('from') from?: string, @Query('to') to?: string, @Query('all') all?: string) {
    return this.billing.stats({ from, to, all });
  }

  @Get('aging')
  aging() {
    return this.billing.aging();
  }

  @Get('invoices')
  list(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('ron') ron?: string,
    @Query('branchId') branchId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('all') all?: string,
    @Query('overdue') overdue?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.billing.list({ search, status, ron, branchId, from, to, all, overdue, page: Number(page), pageSize: Number(pageSize) });
  }

  /** Envía la factura por WhatsApp (PDF adjunto) al cliente. */
  @Post('invoices/:id/whatsapp')
  sendWhatsapp(@Param('id') id: string) {
    return this.billing.sendWhatsapp(id);
  }

  /** Envía la factura por correo (PDF adjunto) al cliente. */
  @Post('invoices/:id/email')
  sendEmail(@Param('id') id: string) {
    return this.billing.sendEmail(id);
  }

  @Get('invoices/:id')
  detail(@Param('id') id: string) {
    return this.billing.detail(id);
  }

  // --- Escritura (Cobranza) ---

  /** Última factura del cliente (para clonar en "Nueva factura"). */
  @Get('subscribers/:id/last-invoice')
  lastInvoice(@Param('id') id: string) {
    return this.facturas.lastInvoice(id);
  }

  /** Crear una factura. */
  @Post('invoices')
  create(@Body() dto: CreateInvoiceDto, @CurrentUser() user: AuthUser) {
    return this.facturas.createInvoice(dto, user);
  }

  /** Generar facturas recurrentes en lote. */
  @Post('invoices/generate')
  generate(@Body() dto: GenerateInvoicesDto, @CurrentUser() user: AuthUser) {
    return this.facturas.generate(dto, user);
  }

  /** Listado de notas crédito/débito. */
  @Get('notes')
  listNotes(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
    @Query('type') type?: string,
  ) {
    return this.facturas.listNotes({ page: Number(page), pageSize: Number(pageSize), search, type });
  }

  /** Crear nota crédito/débito sobre una factura. */
  @Post('invoices/:id/notes')
  createNote(@Param('id') id: string, @Body() dto: CreateNoteDto, @CurrentUser() user: AuthUser) {
    return this.facturas.createNote(id, dto, user);
  }

  /** Anular una factura de venta (motivo obligatorio). */
  @Post('invoices/:id/void')
  voidInvoice(@Param('id') id: string, @Body() dto: VoidInvoiceDto, @CurrentUser() user: AuthUser) {
    return this.facturas.voidInvoice(id, dto, user);
  }

  // --- Reciclaje de ventas (plantillas recurrentes) ---

  @Get('recurring/stats')
  recStats() {
    return this.recurring.stats();
  }

  @Get('recurring')
  recList(@Query('search') search?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.recurring.list({ search, page: Number(page), pageSize: Number(pageSize) });
  }

  @Get('recurring/:id')
  recDetail(@Param('id') id: string) {
    return this.recurring.detail(id);
  }

  @Post('recurring')
  recCreate(@Body() dto: CreateRecurringDto, @CurrentUser() user: AuthUser) {
    return this.recurring.create(dto, user);
  }

  /** Generar una factura real a partir de la plantilla. */
  @Post('recurring/:id/run')
  recRun(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.recurring.run(id, user);
  }

  /** Activar/desactivar plantilla. */
  @Post('recurring/:id/toggle')
  recToggle(@Param('id') id: string, @Body() body: { active: boolean }) {
    return this.recurring.toggle(id, !!body.active);
  }

  @Delete('recurring/:id')
  recRemove(@Param('id') id: string) {
    return this.recurring.remove(id);
  }
}
