import { Type } from 'class-transformer';
import {
  IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, Min, MinLength, ValidateNested,
} from 'class-validator';

export class InvoiceItemDto {
  @IsOptional() @IsString()
  productName?: string;

  /**
   * `Material.legacyId` (pid del legacy) cuando la línea salió del catálogo. Deja el
   * rastro al producto que el legacy guardaba en `invoice_items.pid`; escribir a mano
   * (texto libre) manda 0, como hasta ahora.
   */
  @IsOptional() @IsInt() @Min(0)
  productId?: number;

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

  /**
   * Tipo de factura (el `tipo_factura` del legacy). Solo FIJA y RECURRENTE: las notas
   * crédito/débito son el otro par del enum, pero cuelgan de una factura existente y
   * se crean por `POST /billing/invoices/:id/notes` — emitirlas por aquí las dejaría
   * huérfanas. Por defecto FIJA, que es lo que ofrecía primero el legacy y lo que se
   * venía creando.
   */
  @IsOptional() @IsIn(['FIJA', 'RECURRENTE'])
  kind?: 'FIJA' | 'RECURRENTE';

  @IsOptional() @IsString()
  notes?: string;

  @IsArray() @ValidateNested({ each: true }) @Type(() => InvoiceItemDto)
  items!: InvoiceItemDto[];
}

/** Generar facturas recurrentes en lote (una mensualidad por abonado, desde su plan). */
export class GenerateInvoicesDto {
  @IsOptional() @IsString()
  branchId?: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  subscriberIds?: string[];

  @IsOptional() @IsDateString()
  invoiceDate?: string;

  @IsOptional() @IsInt() @Min(1)
  dueDays?: number;

  /**
   * Tope de abonados a procesar. OMITIDO = TODOS los facturables, que es lo que la
   * corrida del mes necesita (el legacy factura al grupo entero, sin tope:
   * Invoices_model.php:1111). No poner un default: un tope silencioso deja el mes
   * a medio facturar y el lote reporta éxito igual.
   */
  @IsOptional() @IsInt() @Min(1)
  limit?: number;

  /**
   * Simulación: calcula el lote completo y NO escribe nada (ni facturas, ni el
   * descuento de los contadores de promo, ni el asiento contable). Devuelve `plan`
   * con la decisión y el motivo por abonado. Sirve para previsualizar la corrida
   * del mes y para compararla contra la del legacy antes del corte.
   */
  @IsOptional() @IsBoolean()
  dryRun?: boolean;

  /**
   * Solo con `dryRun`. Simula el mes como si aún NO se hubiera facturado: ignora las
   * facturas del propio mes objetivo (que si no harían omitir a todo el mundo por
   * `alreadyBilled`) y lee los contadores de promo de la última factura ANTERIOR al
   * mes. Es lo que permite re-simular un mes ya facturado —p.ej. el que emitió el
   * legacy— y comparar factura por factura.
   */
  @IsOptional() @IsBoolean()
  asIfUnbilled?: boolean;
}

/**
 * Tipos de retención de la factura de venta (legacy `invoices.tipo_retencion`).
 * ReteICA no existe en el legacy — no agregar sin decisión de negocio.
 */
export const RETENTION_TYPES = ['Retefuente Servicios', 'Compras', 'Personas no declarantes', 'Reteiva'] as const;
export type RetentionLabel = (typeof RETENTION_TYPES)[number];

/** Etiqueta del legacy → valor del enum Prisma `RetentionType`. */
export const RETENTION_LABEL_TO_ENUM: Record<RetentionLabel, 'RETEFUENTE_SERVICIOS' | 'COMPRAS' | 'PERSONAS_NO_DECLARANTES' | 'RETEIVA'> = {
  'Retefuente Servicios': 'RETEFUENTE_SERVICIOS',
  Compras: 'COMPRAS',
  'Personas no declarantes': 'PERSONAS_NO_DECLARANTES',
  Reteiva: 'RETEIVA',
};

/** Nota crédito / débito sobre una factura. */
export class CreateNoteDto {
  @IsIn(['CREDITO', 'DEBITO'])
  type!: 'CREDITO' | 'DEBITO';

  @IsNumber() @Min(1)
  amount!: number;

  @IsOptional() @IsString()
  description?: string;

  /**
   * Tipo de retención, opcional. Paridad legacy: la retención de VENTA se captura
   * únicamente desde el modal de nota crédito/débito y su valor lo digita el usuario
   * (`amount`); el sistema no lo calcula.
   */
  @IsOptional() @IsIn(RETENTION_TYPES as unknown as string[])
  retentionType?: RetentionLabel;
}

/** Anulación de una factura de venta (legacy `Transactions::cancelinvoice`, motivo por GET). */
export class VoidInvoiceDto {
  @IsString() @MinLength(3)
  reason!: string;
}
