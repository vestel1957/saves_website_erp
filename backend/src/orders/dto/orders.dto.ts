import { Transform, Type } from 'class-transformer';
import { IsArray, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

/** Tipos de retención colombianos (legacy `purchase.tipo_retencion`). */
export const RETENTION_TYPES = ['Retefuente Servicios', 'Compras', 'Personas no declarantes', 'Reteiva'] as const;
/** Tipos de nota sobre una orden de compra (legacy `Purchase::crear_nota`). */
export const NOTE_TYPES = ['Nota Credito', 'Nota Debito', 'Retencion'] as const;

export class OrderItemDto {
  @IsOptional() @IsString() materialId?: string;
  @IsString() @MinLength(1) product!: string;
  @IsInt() @Min(1) qty!: number;
  @IsNumber() @Min(0) price!: number;
  @IsOptional() @IsNumber() @Min(0) taxRate?: number;
}

/**
 * Datos de la consignación de la orden (a qué cuenta se paga). Van en la orden y
 * no sólo en el proveedor: la orden impresa tiene que decir a dónde se consignó
 * aunque el proveedor cambie de cuenta después.
 */
export class ConsignacionDto {
  @IsOptional() @IsString() @MaxLength(80) payBank?: string;
  @IsOptional() @IsString() @MaxLength(40) payAccountType?: string;
  @IsOptional() @IsString() @MaxLength(40) payAccount?: string;
  @IsOptional() @IsString() @MaxLength(120) payHolder?: string;
  @IsOptional() @IsString() @MaxLength(30) payHolderDoc?: string;
}

export class CreateOrderDto extends ConsignacionDto {
  @IsString() supplierId!: string;
  @IsOptional() @IsString() orderDate?: string;
  @IsOptional() @IsString() dueDate?: string;
  @IsOptional() @IsString() warehouseId?: string; // bodega destino (MaterialWarehouse)
  /** Sede de la orden (`Branch.name`, lo que el legacy guarda en `purchase.refer`). */
  @IsOptional() @IsString() branch?: string;
  @IsOptional() @IsString() categoryRef?: string; // categoría de compra (PurchaseCategory.name)
  @IsOptional() @IsString() notes?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => OrderItemDto) items!: OrderItemDto[];
  // Retención capturada al crear la orden (legacy newinvoice.php). Se materializa como nota de retención.
  @IsOptional() @IsString() @IsIn(RETENTION_TYPES as unknown as string[]) retentionType?: string;
  @IsOptional() @IsNumber() @Min(0) retention?: number;
}

/** Edición de una orden PENDIENTE: cabecera y/o reemplazo de ítems. */
export class UpdateOrderDto extends ConsignacionDto {
  /**
   * Estado a la fuerza. SOLO lo aplica el superusuario (el servicio lo rechaza a
   * cualquier otro): es para corregir una orden mal encaminada, no un atajo al flujo
   * —aprobar, pagar, recibir y finalizar siguen teniendo su endpoint, que sí mueve
   * plata y stock—. Ver `ESTADOS_ORDEN` en orders.service.
   */
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() orderDate?: string;
  @IsOptional() @IsString() dueDate?: string;
  @IsOptional() @IsString() categoryRef?: string;
  @IsOptional() @IsString() notes?: string;
  /** Bodega destino y sede: se corrigen en cualquier estado mientras no se haya recibido nada. */
  @IsOptional() @IsString() warehouseId?: string;
  @IsOptional() @IsString() branch?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => OrderItemDto) items?: OrderItemDto[];
}

/** Cancelación con motivo (queda en la bitácora). */
export class CancelOrderDto {
  @IsOptional() @IsString() reason?: string;
}

/**
 * Aprobación (1ª o 2ª firma). `otp` es el código que le llegó al WhatsApp del
 * firmante; se pide con `POST /orders/:id/approve/otp`. Opcional en el DTO porque
 * la exigencia es un ajuste (`signature.otpRequired`) y el error de "falta el
 * código" tiene que salir del servicio, con su explicación, y no de un 400 pelado
 * de validación.
 */
export class ApproveOrderDto {
  @IsOptional() @IsString() otp?: string;
}

/** Nota (crédito/débito/retención) sobre una orden de compra ya creada. */
export class AddNoteDto {
  @IsString() @IsIn(NOTE_TYPES as unknown as string[]) type!: string; // Nota Credito | Nota Debito | Retencion
  @IsOptional() @IsString() @IsIn(RETENTION_TYPES as unknown as string[]) retentionType?: string; // requerido si type=Retencion
  @IsNumber() @Min(0.01) amount!: number; // monto absoluto (el signo lo pone el tipo)
  /** Observación: por qué se aplica la nota. Obligatoria, igual que en las notas de factura. */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'Escribe la observación de la nota: por qué se aplica.' })
  @MinLength(5, { message: 'La observación debe explicar el motivo de la nota (mínimo 5 caracteres).' })
  @MaxLength(500, { message: 'La observación no puede pasar de 500 caracteres.' })
  description!: string;
}

export class CategoryNameDto {
  @IsString() @MinLength(1) name!: string;
}

export class ReceiveItemDto {
  @IsString() itemId!: string;
  @IsInt() @Min(0) received!: number; // cantidad recibida ABSOLUTA
  /**
   * Producto de la bodega destino al que se suma lo recibido. Sin él se usa el ligado
   * al ítem o el del mismo nombre en la bodega; si no hay ninguno, se crea.
   */
  @IsOptional() @IsString() materialId?: string;
}
export class ReceiveOrderDto {
  /** Bodega donde entra el material. Sin ella se usa la de la orden; si la orden tampoco tiene, es un error. */
  @IsOptional() @IsString() warehouseId?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => ReceiveItemDto) items!: ReceiveItemDto[];
}

export class CreateSupplierDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsInt() category?: number; // 1 productos, 2 servicios, 3 terceros
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
  /** Fecha del pago (YYYY-MM-DD). Decide en qué día —y en qué cierre— entra el egreso. */
  @IsOptional() @IsDateString() date?: string;
  /** Motivo del pago. El servidor lo cuelga de la referencia "Pago orden de compra #tid". */
  @IsOptional() @IsString() note?: string;
}
