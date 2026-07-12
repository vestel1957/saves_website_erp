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

/** Nota crédito / débito sobre una factura. */
export class CreateNoteDto {
  @IsIn(['CREDITO', 'DEBITO'])
  type!: 'CREDITO' | 'DEBITO';

  @IsNumber() @Min(1)
  amount!: number;

  @IsOptional() @IsString()
  description?: string;
}
