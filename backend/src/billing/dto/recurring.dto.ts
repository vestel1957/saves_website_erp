import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, MinLength, ValidateNested } from 'class-validator';
import { InvoiceItemDto } from './facturas.dto';

/** Crear una plantilla de factura recurrente ("Reciclaje de ventas"). */
export class CreateRecurringDto {
  @IsString()
  subscriberId!: string;

  @IsOptional() @IsString()
  rec?: string; // periodicidad: '1 month', '1 day', ...

  @IsOptional() @IsString() @MinLength(1)
  notes?: string;

  @IsArray() @ValidateNested({ each: true }) @Type(() => InvoiceItemDto)
  items!: InvoiceItemDto[];
}
