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
export type SubscriberStatusName = (typeof SUBSCRIBER_STATUSES)[number];

/**
 * Público de una promoción: A QUÉ CLIENTES alcanza. Las dimensiones se combinan
 * con Y (estado Activo + sede Yopal = activos DE Yopal) y dentro de cada una con O
 * (Activo o Cartera). Una dimensión vacía no filtra. `allSubscribers` manda sobre
 * todas: alcanza a todos los clientes.
 */
export class PromotionAudienceDto {
  /** Alcanza a TODOS los clientes (ignora los demás criterios). */
  @IsOptional() @IsBoolean()
  allSubscribers?: boolean;

  /** Estados de cliente alcanzados. */
  @IsOptional() @IsArray() @IsIn(SUBSCRIBER_STATUSES, { each: true })
  subscriberStatuses?: SubscriberStatusName[];

  /** Clientes puntuales alcanzados (Subscriber.id). */
  @IsOptional() @IsArray() @IsString({ each: true })
  subscriberIds?: string[];

  /** Planes contratados alcanzados (Plan.id). */
  @IsOptional() @IsArray() @IsString({ each: true })
  planIds?: string[];

  /** Sedes alcanzadas (Branch.id). */
  @IsOptional() @IsArray() @IsString({ each: true })
  branchIds?: string[];

  /** Barrios alcanzados (id legacy del barrio = `Subscriber.neighborhood`). */
  @IsOptional() @IsArray() @IsString({ each: true })
  neighborhoodRefs?: string[];
}

/** Crear una promoción (solo superusuario). */
export class CreatePromotionDto extends PromotionAudienceDto {
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

  /**
   * Guardar además la FORMA de esta campaña como plantilla reutilizable (nombre,
   * descuento y fechas). No incluye el público a propósito: la misma campaña se
   * dirige cada vez a gente distinta.
   */
  @IsOptional() @IsBoolean()
  saveAsTemplate?: boolean;
}

/** Editar una promoción (todos los campos opcionales). */
export class UpdatePromotionDto extends PromotionAudienceDto {
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
}

/** Aplicar una promoción a una factura. */
export class ApplyPromotionDto {
  @IsString()
  invoiceId!: string;
}
