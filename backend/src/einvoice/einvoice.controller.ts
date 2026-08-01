import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { EinvoiceService } from './einvoice.service';
import { EinvoiceEmitService } from './einvoice-emit.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AreaGuard } from '../auth/area.guard';
import { RequireArea } from '../auth/require-area.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { BulkEflagsDto, SetEflagsDto, UpdateSiigoAccountDto } from './dto/einvoice.dto';

/** Nota crédito electrónica: motivo + causa DIAN (1=Devolución, 2=Anulación, 3=Rebaja, 4=Otros). */
class CreditNoteDto {
  @IsString() @MinLength(3) reason!: string;
  @IsOptional() @IsInt() @Min(1) @Max(4) cause?: number;
}

/** Facturación electrónica DIAN (panel + emisión Siigo). */
@Controller('einvoice')
@UseGuards(JwtAuthGuard, AreaGuard)
@RequireArea('contabilidad')
export class EinvoiceController {
  constructor(
    private readonly einvoice: EinvoiceService,
    private readonly emit: EinvoiceEmitService,
  ) {}

  @Get('stats') stats() { return this.einvoice.stats(); }
  @Get('mode') mode() { return { live: this.emit.isLive, mode: this.emit.isLive ? 'LIVE' : 'DRY_RUN' }; }
  /** Emite (o simula) la e-factura DIAN de una SubInvoice. */
  @Post('emit/:invoiceId') emitInvoice(@Param('invoiceId') invoiceId: string, @CurrentUser() user: AuthUser) {
    return this.emit.emit(invoiceId, user);
  }
  /** Emite (o simula) en lote las facturas pendientes por timbrar de una sede. */
  @Post('emit-branch/:branchId') emitBranch(@Param('branchId') branchId: string, @CurrentUser() user: AuthUser) {
    return this.emit.emitBranch(branchId, user);
  }
  /** Reintenta una e-factura en ERROR (reemite su factura). */
  @Post(':id/retry') retry(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.emit.retry(id, user);
  }
  /** Emite (o simula) una NOTA CRÉDITO ante la DIAN para una factura ya emitida. */
  @Post('credit-note/:invoiceId') creditNote(@Param('invoiceId') invoiceId: string, @Body() dto: CreditNoteDto, @CurrentUser() user: AuthUser) {
    return this.emit.emitCreditNote(invoiceId, dto.reason, dto.cause ?? 2, user);
  }
  @Get()
  list(@Query('search') search?: string, @Query('type') type?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('all') all?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string, @Query('sortBy') sortBy?: string, @Query('sortDir') sortDir?: string) {
    return this.einvoice.list({ search, type, from, to, all, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir });
  }

  // --- Emisión por sede: sedes → clientes → flags TV/Internet ---
  @Get('branches') branches() { return this.einvoice.branches(); }
  @Get('branches/:id/subscribers')
  branchSubscribers(@Param('id') id: string, @Query('search') search?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string, @Query('sort') sort?: string, @Query('dir') dir?: string) {
    return this.einvoice.branchSubscribers(id, { search, page: Number(page), pageSize: Number(pageSize), sort, dir });
  }
  @Patch('subscribers/:id/eflags') setEflags(@Param('id') id: string, @Body() dto: SetEflagsDto) { return this.einvoice.setEflags(id, dto); }
  @Post('eflags-bulk') bulkEflags(@Body() dto: BulkEflagsDto) { return this.einvoice.bulkEflags(dto); }

  // --- Configuración de cuentas Siigo (mapeo DIAN + credenciales) ---
  @Get('accounts') accounts() { return this.einvoice.accounts(); }
  @Patch('accounts/:id') updateAccount(@Param('id') id: string, @Body() dto: UpdateSiigoAccountDto) { return this.einvoice.updateAccount(id, dto); }
  @Post('accounts/:id/test') testAccount(@Param('id') id: string) { return this.einvoice.testAccount(id); }

  @Get(':id') detail(@Param('id') id: string) { return this.einvoice.detail(id); }
}
