import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';

/** Formatos de descuento fieles al legacy `format_discount`. */
export const DISCOUNT_FORMATS = ['%', 'flat', 'b_p', 'bflat'] as const;
export type DiscountFormat = (typeof DISCOUNT_FORMATS)[number];

/** Estados de cliente válidos (espejo del enum Prisma SubscriberStatus). */
export const SUBSCRIBER_STATUSES = [
  'ACTIVO', 'CARTERA', 'COMPROMISO', 'CORTADO', 'DEPURADO', 'EVENTO',
  'EXONERADO', 'INSTALAR', 'POR_RETIRAR', 'REPORTADO', 'RETIRADO',
  'SUSPENDIDO', 'INACTIVO',
] as const;

/** Crear una promoción (solo superusuario). */
export class CreatePromotionDto {
  @IsString() @MinLength(2)
  name!: string;

  @IsOptional() @IsString()
  description?: string;

  /** Formato del descuento (%/monto fijo × antes/después de impuesto). */
  @IsOptional() @IsIn(DISCOUNT_FORMATS)
  discountFormat?: DiscountFormat;

  /** Porcentaje (requerido si discountFormat es '%' o 'b_p'). */
  @IsOptional() @IsInt() @Min(1) @Max(100)
  percentage?: number;

  /** Monto fijo en $ (requerido si discountFormat es 'flat' o 'bflat'). */
  @IsOptional() @IsNumber() @Min(1)
  flatAmount?: number;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsOptional() @IsBoolean()
  active?: boolean;

  /** Disponible para todos los funcionarios (ignora `assigneeIds`). */
  @IsOptional() @IsBoolean()
  global?: boolean;

  /** IDs (Staff.id) de los funcionarios autorizados a aplicarla. */
  @IsOptional() @IsArray() @IsString({ each: true })
  assigneeIds?: string[];

  /** Si viene, es una promo POR ESTADO DE CLIENTE (no por funcionario). */
  @IsOptional() @IsIn(SUBSCRIBER_STATUSES)
  subscriberStatus?: (typeof SUBSCRIBER_STATUSES)[number];
}

/** Editar una promoción (todos los campos opcionales). */
export class UpdatePromotionDto {
  @IsOptional() @IsString() @MinLength(2)
  name?: string;

  @IsOptional() @IsString()
  description?: string;

  @IsOptional() @IsIn(DISCOUNT_FORMATS)
  discountFormat?: DiscountFormat;

  @IsOptional() @IsInt() @Min(1) @Max(100)
  percentage?: number;

  @IsOptional() @IsNumber() @Min(1)
  flatAmount?: number;

  @IsOptional() @IsDateString()
  startDate?: string;

  @IsOptional() @IsDateString()
  endDate?: string;

  @IsOptional() @IsBoolean()
  active?: boolean;

  @IsOptional() @IsBoolean()
  global?: boolean;

  @IsOptional() @IsArray() @IsString({ each: true })
  assigneeIds?: string[];

  /** null explícito = quitar el estado (volver a promo por funcionario). */
  @IsOptional() @IsIn([...SUBSCRIBER_STATUSES, null])
  subscriberStatus?: (typeof SUBSCRIBER_STATUSES)[number] | null;
}

/** Aplicar una promoción a una factura. */
export class ApplyPromotionDto {
  @IsString()
  invoiceId!: string;
}
