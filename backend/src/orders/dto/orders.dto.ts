import { Type } from 'class-transformer';
import { IsArray, IsInt, IsNumber, IsOptional, IsString, Min, MinLength, ValidateNested } from 'class-validator';

export class OrderItemDto {
  @IsOptional() @IsString() materialId?: string;
  @IsString() @MinLength(1) product!: string;
  @IsInt() @Min(1) qty!: number;
  @IsNumber() @Min(0) price!: number;
  @IsOptional() @IsNumber() @Min(0) taxRate?: number;
}

export class CreateOrderDto {
  @IsString() supplierId!: string;
  @IsOptional() @IsString() orderDate?: string;
  @IsOptional() @IsString() dueDate?: string;
  @IsOptional() @IsString() warehouseId?: string; // bodega destino (MaterialWarehouse)
  @IsOptional() @IsString() categoryRef?: string; // categoría de compra (PurchaseCategory.name)
  @IsOptional() @IsString() notes?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => OrderItemDto) items!: OrderItemDto[];
}

export class CategoryNameDto {
  @IsString() @MinLength(1) name!: string;
}

export class ReceiveItemDto {
  @IsString() itemId!: string;
  @IsInt() @Min(0) received!: number; // cantidad recibida ABSOLUTA
}
export class ReceiveOrderDto {
  @IsOptional() @IsString() warehouseId?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => ReceiveItemDto) items!: ReceiveItemDto[];
}

export class CreateSupplierDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsInt() category?: number; // 1 productos, 2 servicios
  @IsOptional() @IsString() nit?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() bank?: string;
  @IsOptional() @IsString() account?: string;
  @IsOptional() @IsString() company?: string;
}

/** Pago/abono a una orden de compra (o devolución). Crea un movimiento de tesorería. */
export class PayOrderDto {
  @IsNumber() @Min(1) amount!: number;
  @IsString() method!: string; // Cash | Bank
  @IsOptional() @IsInt() cashAccountId?: number;
  @IsOptional() @IsString() accountName?: string;
  @IsOptional() @IsString() bankName?: string;
  @IsOptional() @IsString() date?: string;
  @IsOptional() @IsString() note?: string;
}
