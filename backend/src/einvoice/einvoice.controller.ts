import { IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { EinvoiceService } from './einvoice.service';
import { EinvoiceEmitService } from './einvoice-emit.service';
import { AuthUser } from '../auth/current-user.decorator';
import { BulkEflagsDto, SetEflagsDto, UpdateSiigoAccountDto } from './dto/einvoice.dto';

/** Nota crédito electrónica: motivo + causa DIAN (1=Devolución, 2=Anulación, 3=Rebaja, 4=Otros). */
export class CreditNoteDto {
  @IsString() @MinLength(3) reason!: string;
  @IsOptional() @IsInt() @Min(1) @Max(4) cause?: number;
}

/** Facturación electrónica DIAN (panel + emisión Siigo). */
export class EinvoiceController {
  constructor(
    private readonly einvoice: EinvoiceService,
    private readonly emit: EinvoiceEmitService,
  ) {}

  stats() { return this.einvoice.stats(); }
  mode() { return { live: this.emit.isLive, mode: this.emit.isLive ? 'LIVE' : 'DRY_RUN' }; }
  /** Emite (o simula) la e-factura DIAN de una SubInvoice. */
  emitInvoice(invoiceId: string, user: AuthUser) {
    return this.emit.emit(invoiceId, user);
  }
  /** Emite (o simula) en lote las facturas pendientes por timbrar de una sede. */
  emitBranch(branchId: string, user: AuthUser) {
    return this.emit.emitBranch(branchId, user);
  }
  /** Reintenta una e-factura en ERROR (reemite su factura). */
  retry(id: string, user: AuthUser) {
    return this.emit.retry(id, user);
  }
  /** Emite (o simula) una NOTA CRÉDITO ante la DIAN para una factura ya emitida. */
  creditNote(invoiceId: string, dto: CreditNoteDto, user: AuthUser) {
    return this.emit.emitCreditNote(invoiceId, dto.reason, dto.cause ?? 2, user);
  }
  list(search?: string, type?: string, from?: string, to?: string, all?: string, page?: string, pageSize?: string, sortBy?: string, sortDir?: string) {
    return this.einvoice.list({ search, type, from, to, all, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir });
  }

  // --- Emisión por sede: sedes → clientes → flags TV/Internet ---
  branches() { return this.einvoice.branches(); }
  branchSubscribers(id: string, search?: string, page?: string, pageSize?: string, sort?: string, dir?: string) {
    return this.einvoice.branchSubscribers(id, { search, page: Number(page), pageSize: Number(pageSize), sort, dir });
  }
  setEflags(id: string, dto: SetEflagsDto) { return this.einvoice.setEflags(id, dto); }
  bulkEflags(dto: BulkEflagsDto) { return this.einvoice.bulkEflags(dto); }

  // --- Configuración de cuentas Siigo (mapeo DIAN + credenciales) ---
  accounts() { return this.einvoice.accounts(); }
  updateAccount(id: string, dto: UpdateSiigoAccountDto) { return this.einvoice.updateAccount(id, dto); }
  testAccount(id: string) { return this.einvoice.testAccount(id); }

  detail(id: string) { return this.einvoice.detail(id); }
}
