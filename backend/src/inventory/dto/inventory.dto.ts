import { Type } from 'class-transformer';
import { IsArray, IsInt, IsNumber, IsOptional, IsString, Min, MinLength, ValidateNested } from 'class-validator';

export class CreateMaterialDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsString() categoryId?: string;
  @IsOptional() @IsString() warehouseId?: string;
  @IsOptional() @IsNumber() @Min(0) price?: number;
  @IsOptional() @IsNumber() @Min(0) cost?: number;
  @IsOptional() @IsNumber() @Min(0) taxRate?: number;
  @IsOptional() @IsInt() @Min(0) qty?: number;
  @IsOptional() @IsInt() @Min(0) alert?: number;
  @IsOptional() @IsString() description?: string;
}

export class UpdateMaterialDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsString() categoryId?: string;
  @IsOptional() @IsNumber() @Min(0) price?: number;
  @IsOptional() @IsNumber() @Min(0) cost?: number;
  @IsOptional() @IsNumber() @Min(0) taxRate?: number;
  @IsOptional() @IsInt() @Min(0) qty?: number;
  @IsOptional() @IsInt() @Min(0) alert?: number;
  @IsOptional() @IsString() description?: string;
}

export class SimpleCatalogDto {
  @IsString() @MinLength(1) title!: string;
  @IsOptional() @IsString() extra?: string;
}

export class WarehouseDto extends SimpleCatalogDto {
  /**
   * Encargado de la bodega: quien recibe y firma los traspasos que entran aquí.
   * Cadena vacía = desasignar; no enviar el campo = dejarlo como está.
   */
  @IsOptional() @IsString() managerId?: string;
}

export class TransferItemDto {
  @IsString() materialId!: string;
  @IsInt() @Min(1) qty!: number;
}

export class TransferDto {
  @IsString() fromWarehouseId!: string;
  @IsString() toWarehouseId!: string;
  @IsOptional() @IsString() observations?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => TransferItemDto) items!: TransferItemDto[];
}

/** Recibir un acta: el código de firma solo se exige en el flujo nuevo (con destino). */
export class ReceiveActaDto {
  @IsOptional() @IsString() code?: string;
}
