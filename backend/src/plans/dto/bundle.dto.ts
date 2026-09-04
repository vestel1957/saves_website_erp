import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsNumber, IsOptional, IsString, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

/** Un plan dentro del combo, con el precio que se le pone DENTRO del combo. */
export class BundleItemDto {
  @IsString() @MinLength(1)
  planId!: string;

  /** Base sin IVA. El IVA lo pone el plan (internet 0, TV 19). */
  @IsNumber() @Min(0)
  price!: number;
}

/** Crear un combo comercial. */
export class CreateBundleDto {
  @IsString() @MinLength(1) @MaxLength(120)
  name!: string;

  @IsOptional() @IsString() @MaxLength(400)
  description?: string;

  @IsOptional() @IsBoolean()
  active?: boolean;

  /**
   * Mínimo 2: un "combo" de un solo plan es un plan. Máximo 4, que son los
   * tipos de servicio que existen (internet, TV, puntos, streaming).
   */
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(4)
  @ValidateNested({ each: true }) @Type(() => BundleItemDto)
  items!: BundleItemDto[];

  /**
   * Códigos de las apps (catálogo PlayHub) que el cliente puede elegir con el
   * combo. Lista vacía = el combo no ofrece apps. El backend comprueba que
   * existan y que sean apps, no cupos.
   */
  @IsOptional()
  @IsArray() @ArrayMaxSize(20)
  @IsString({ each: true })
  allowedApps?: string[];
}

/** Actualizar un combo. `items` llega completo y reemplaza al anterior. */
export class UpdateBundleDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  name?: string;

  @IsOptional() @IsString() @MaxLength(400)
  description?: string;

  @IsOptional() @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(4)
  @ValidateNested({ each: true }) @Type(() => BundleItemDto)
  items?: BundleItemDto[];

  /**
   * Códigos de las apps (catálogo PlayHub) que el cliente puede elegir con el
   * combo. Lista vacía = el combo no ofrece apps. El backend comprueba que
   * existan y que sean apps, no cupos.
   */
  @IsOptional()
  @IsArray() @ArrayMaxSize(20)
  @IsString({ each: true })
  allowedApps?: string[];
}

/** Aplicar un combo a un abonado. */
export class ApplyBundleDto {
  @IsString() @MinLength(1)
  bundleId!: string;
}
