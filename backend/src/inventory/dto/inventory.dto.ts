import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsString, Min, MinLength, ValidateNested } from 'class-validator';

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
  /**
   * Empleado dueño de la bodega, si es la bodega personal de un técnico (`Staff.id`).
   * Es lo que la convierte en "su" bodega: de ahí gasta material en sus órdenes y
   * ahí le entrega la cajera. Cadena vacía = volverla una bodega general.
   */
  @IsOptional() @IsString() technicianStaffId?: string;
  /**
   * Sede de la bodega (`Branch.legacyId`). Es lo que ata la bodega con las cajeras
   * que responden por ella; `null`/0 = bodega sin sede (las de tránsito).
   */
  @IsOptional() @IsInt() branchLegacy?: number | null;
  /**
   * Bodega PRINCIPAL de su sede: a donde el técnico devuelve el material que le
   * sobra. Marcarla desmarca la que lo fuera antes en esa sede (una por sede).
   */
  @IsOptional() @IsBoolean() isMain?: boolean;
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
