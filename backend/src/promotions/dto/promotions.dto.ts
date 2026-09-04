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
 * A qué FACTURAS del cliente alcanza el descuento automático de ventanilla (espejo
 * del enum Prisma `PromotionInvoiceScope`). `MENSUALIDAD_DEL_MES` es el pronto pago;
 * `MENSUALIDADES_PENDIENTES`, la campaña de recuperación de cartera; y
 * `CUALQUIER_PENDIENTE` rebaja además los cargos sueltos. Ver
 * `promotions/descuento-al-cobrar.ts`.
 */
export const INVOICE_SCOPES = [
  'MENSUALIDAD_DEL_MES', 'MENSUALIDADES_PENDIENTES', 'CUALQUIER_PENDIENTE',
] as const;
export type InvoiceScopeName = (typeof INVOICE_SCOPES)[number];

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
   * A qué facturas del cliente alcanza el descuento AUTOMÁTICO de ventanilla. Por
   * omisión, sólo la mensualidad del mes en curso (pronto pago): una campaña que
   * rebaje la mora se pide a propósito.
   */
  @IsOptional() @IsIn(INVOICE_SCOPES)
  invoiceScope?: InvoiceScopeName;

  /**
   * Publicar la promoción en el PORTAL DE PAGOS EN LÍNEA (vestel.com.co/crm). Sólo
   * vale para descuentos de PORCENTAJE cuyo público sea por estado (o todos): el
   * portal no sabe de planes, sedes, barrios ni clientes sueltos.
   */
  @IsOptional() @IsBoolean()
  portalPublish?: boolean;

  /**
   * El PORTAL DE PAGOS cobra ya con el descuento puesto: la rebaja se concede por
   * adelantado y baja el total de la factura en el legacy, que es de donde el portal
   * saca lo que cobra. Excluyente con `portalPublish` (ver `descuento-portal.ts`).
   */
  @IsOptional() @IsBoolean()
  portalPreapply?: boolean;

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

  /**
   * A qué facturas del cliente alcanza el descuento AUTOMÁTICO de ventanilla. Por
   * omisión, sólo la mensualidad del mes en curso (pronto pago): una campaña que
   * rebaje la mora se pide a propósito.
   */
  @IsOptional() @IsIn(INVOICE_SCOPES)
  invoiceScope?: InvoiceScopeName;

  /**
   * El PORTAL DE PAGOS cobra ya con el descuento puesto: la rebaja se concede por
   * adelantado y baja el total de la factura en el legacy, que es de donde el portal
   * saca lo que cobra. Excluyente con `portalPublish` (ver `descuento-portal.ts`).
   */
  @IsOptional() @IsBoolean()
  portalPreapply?: boolean;

  /** Publicar (o dejar de publicar) la promoción en el portal de pagos en línea. */
  @IsOptional() @IsBoolean()
  portalPublish?: boolean;
}

/** Aplicar una promoción a una factura. */
export class ApplyPromotionDto {
  @IsString()
  invoiceId!: string;
}
