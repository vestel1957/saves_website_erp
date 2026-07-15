import { Type } from 'class-transformer';
import {
  IsArray, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, Min, MinLength, ValidateNested,
} from 'class-validator';

export class InvoiceItemDto {
  @IsOptional() @IsString()
  productName?: string;

  @IsString() @MinLength(1)
  description!: string;

  @IsNumber() @Min(0)
  qty!: number;

  @IsNumber() @Min(0)
  price!: number;

  @IsOptional() @IsNumber() @Min(0)
  taxRate?: number;
}

/** Crear una factura (manual o clonada de la última del cliente). */
export class CreateInvoiceDto {
  @IsString()
  subscriberId!: string;

  @IsOptional() @IsDateString()
  invoiceDate?: string;

  @IsOptional() @IsDateString()
  dueDate?: string;

  @IsOptional() @IsString()
  notes?: string;

  @IsArray() @ValidateNested({ each: true }) @Type(() => InvoiceItemDto)
  items!: InvoiceItemDto[];
}

/** Generar facturas recurrentes en lote (clona la última factura de cada cliente). */
export class GenerateInvoicesDto {
  @IsOptional() @IsString()
  branchId?: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  subscriberIds?: string[];

  @IsOptional() @IsDateString()
  invoiceDate?: string;

  @IsOptional() @IsInt() @Min(1)
  dueDays?: number;

  @IsOptional() @IsInt() @Min(1)
  limit?: number;
}

/**
 * Tipos de retención de la factura de venta (legacy `invoices.tipo_retencion`).
 * ReteICA no existe en el legacy — no agregar sin decisión de negocio.
 */
export const RETENTION_TYPES = ['Retefuente Servicios', 'Compras', 'Personas no declarantes', 'Reteiva'] as const;
export type RetentionLabel = (typeof RETENTION_TYPES)[number];

/** Etiqueta del legacy → valor del enum Prisma `RetentionType`. */
export const RETENTION_LABEL_TO_ENUM: Record<RetentionLabel, 'RETEFUENTE_SERVICIOS' | 'COMPRAS' | 'PERSONAS_NO_DECLARANTES' | 'RETEIVA'> = {
  'Retefuente Servicios': 'RETEFUENTE_SERVICIOS',
  Compras: 'COMPRAS',
  'Personas no declarantes': 'PERSONAS_NO_DECLARANTES',
  Reteiva: 'RETEIVA',
};

/** Nota crédito / débito sobre una factura. */
export class CreateNoteDto {
  @IsIn(['CREDITO', 'DEBITO'])
  type!: 'CREDITO' | 'DEBITO';

  @IsNumber() @Min(1)
  amount!: number;

  @IsOptional() @IsString()
  description?: string;

  /**
   * Tipo de retención, opcional. Paridad legacy: la retención de VENTA se captura
   * únicamente desde el modal de nota crédito/débito y su valor lo digita el usuario
   * (`amount`); el sistema no lo calcula.
   */
  @IsOptional() @IsIn(RETENTION_TYPES as unknown as string[])
  retentionType?: RetentionLabel;
}

/** Anulación de una factura de venta (legacy `Transactions::cancelinvoice`, motivo por GET). */
export class VoidInvoiceDto {
  @IsString() @MinLength(3)
  reason!: string;
}
