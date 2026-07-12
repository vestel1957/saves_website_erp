import { ArrayMinSize, ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { ServiceKind } from '@prisma/client';

/** Crear un plan del catálogo. */
export class CreatePlanDto {
  @IsString() @MinLength(1) @MaxLength(120)
  name!: string;

  @IsOptional() @IsEnum(ServiceKind)
  kind?: ServiceKind; // default INTERNET

  @IsOptional() @IsString() @MaxLength(120)
  pppProfile?: string; // perfil en el router; vacío = no se empuja a Mikrotik

  @IsNumber() @Min(0)
  price!: number;

  @IsOptional() @IsNumber() @Min(0)
  taxRate?: number; // IVA% (TV=19, internet=0). default 0

  @IsOptional() @IsInt() @Min(0)
  megas?: number;

  @IsOptional() @IsBoolean()
  active?: boolean;
}

/** Actualizar un plan (todos los campos opcionales). */
export class UpdatePlanDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  name?: string;

  @IsOptional() @IsEnum(ServiceKind)
  kind?: ServiceKind;

  @IsOptional() @IsString() @MaxLength(120)
  pppProfile?: string;

  @IsOptional() @IsNumber() @Min(0)
  price?: number;

  @IsOptional() @IsNumber() @Min(0)
  taxRate?: number;

  @IsOptional() @IsInt() @Min(0)
  megas?: number;

  @IsOptional() @IsBoolean()
  active?: boolean;
}

/** Asignar un plan del catálogo a un abonado (cambio de plan). */
export class AssignPlanDto {
  @IsString() @MinLength(1)
  planId!: string;
}

/**
 * Asignar varios planes a la vez (ej. Internet + TV en un solo cambio).
 * Cada planId actualiza el servicio de su propio `kind`.
 */
export class AssignPlansDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(6)
  @IsString({ each: true })
  planIds!: string[];
}
