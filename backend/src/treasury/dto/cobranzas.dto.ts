import {
  IsArray, IsDateString, IsInt, IsNumber, IsOptional, IsString, Min, MinLength,
} from 'class-validator';

/** Registrar un recaudo/pago que se aplica en cascada sobre las facturas pendientes. */
export class CollectDto {
  @IsString()
  subscriberId!: string;

  @IsNumber()
  @Min(1)
  amount!: number;

  @IsString()
  method!: string; // Cash | Bank | Balance | <pasarela>

  @IsOptional() @IsInt()
  cashAccountId?: number;

  @IsOptional() @IsString()
  accountName?: string;

  @IsOptional() @IsString()
  bankName?: string;

  @IsOptional() @IsDateString()
  date?: string;

  @IsOptional() @IsString()
  note?: string;

  /** Orden explícito de facturas a pagar (ids). Si se omite: más antiguas primero. */
  @IsOptional() @IsArray() @IsString({ each: true })
  invoiceIds?: string[];
}

/** Anular una transacción (soft-delete + reversa de saldo). */
export class VoidTxDto {
  @IsString() @MinLength(3)
  reason!: string;

  @IsOptional() @IsString()
  detail?: string;
}

/** Registrar un egreso/gasto de caja. */
export class ExpenseDto {
  @IsNumber() @Min(1)
  amount!: number;

  @IsString()
  category!: string;

  @IsString()
  method!: string;

  @IsOptional() @IsInt()
  cashAccountId?: number;

  @IsOptional() @IsString()
  accountName?: string;

  @IsOptional() @IsString()
  payerName?: string;

  /**
   * Opcional: ligar el egreso a un cliente (sin tocar sus facturas). Paridad
   * legacy `payerid`, que en egresos SÍ se usa —2.269 de 29.531— sobre todo en
   * Compras y Devoluciones; en ingresos es anecdótico (2 de 181).
   */
  @IsOptional() @IsString()
  subscriberId?: string;

  @IsOptional() @IsString()
  bankName?: string;

  @IsOptional() @IsDateString()
  date?: string;

  @IsOptional() @IsString()
  note?: string;
}

/** Transferencia de dinero entre dos cajas (egreso en origen + ingreso en destino). */
export class TransferDto {
  @IsInt()
  fromCashAccountId!: number;

  @IsOptional() @IsString()
  fromAccountName?: string;

  @IsInt()
  toCashAccountId!: number;

  @IsOptional() @IsString()
  toAccountName?: string;

  @IsNumber() @Min(1)
  amount!: number;

  @IsOptional() @IsDateString()
  date?: string;

  @IsOptional() @IsString()
  note?: string;
}

/** Apertura de caja: base inicial de una caja en una fecha. */
export class CashOpenDto {
  @IsInt()
  cashAccountId!: number;

  @IsOptional() @IsString()
  accountName?: string;

  @IsDateString()
  date!: string;

  @IsNumber() @Min(0)
  base!: number;

  @IsOptional() @IsString()
  note?: string;
}

/**
 * Cierre de caja de una caja en una fecha.
 *
 * Sólo caja y fecha: no hay base ni consignado que teclear. Réplica del legacy, donde la
 * base es cero y el cierre barre el efectivo entero del cajón (ver `cierre-legacy.ts`).
 * Todo lo demás se deriva del libro.
 */
export class CashCloseDto {
  @IsInt()
  cashAccountId!: number;

  @IsDateString()
  date!: string;
}

/**
 * Ingreso manual libre: un INCOME que NO se aplica a facturas (otros conceptos,
 * ingresos sin cliente). Equivale al `save_trans` con pay_type=Income del legacy.
 */
export class IncomeDto {
  @IsNumber() @Min(1)
  amount!: number;

  @IsString()
  category!: string;

  @IsString()
  method!: string;

  @IsOptional() @IsInt()
  cashAccountId?: number;

  @IsOptional() @IsString()
  accountName?: string;

  @IsOptional() @IsString()
  payerName?: string;

  /** Opcional: ligar el ingreso a un cliente (sin tocar sus facturas). */
  @IsOptional() @IsString()
  subscriberId?: string;

  @IsOptional() @IsString()
  bankName?: string;

  @IsOptional() @IsDateString()
  date?: string;

  @IsOptional() @IsString()
  note?: string;
}

/**
 * Editar un movimiento: campos seguros (categoría, nota, fecha, método, tercero).
 * El monto solo se permite editar en movimientos NO ligados a factura de venta
 * (los pagos de venta deben anularse y rehacerse para no descuadrar la cartera).
 */
export class EditTxDto {
  @IsOptional() @IsString()
  category?: string;

  @IsOptional() @IsString()
  note?: string;

  @IsOptional() @IsDateString()
  date?: string;

  @IsOptional() @IsString()
  method?: string;

  @IsOptional() @IsString()
  payerName?: string;

  @IsOptional() @IsString()
  accountName?: string;

  @IsOptional() @IsInt()
  cashAccountId?: number;

  @IsOptional() @IsString()
  bankName?: string;

  @IsOptional() @IsNumber() @Min(0)
  amount?: number;
}

/** Alta/edición de una caja o banco (Accounts del legacy). */
export class CashAccountDto {
  @IsString() @MinLength(1)
  holder!: string;

  /**
   * Fondo fijo: la plata que nunca sale del cajón, y por eso no entra en el excedente
   * del arqueo. Es por caja porque no es una constante del negocio (de los 3 cierres
   * reales que existen, uno cerró con base de 300.000). Omitido = no se toca.
   */
  @IsOptional() @IsNumber() @Min(0)
  fixedFund?: number;

  @IsOptional() @IsString()
  accountNumber?: string;

  @IsOptional() @IsInt()
  branchLegacy?: number;

  @IsOptional() @IsString()
  code?: string;

  @IsOptional() @IsString()
  address?: string;

  @IsOptional() @IsString()
  phone?: string;

  @IsOptional() @IsString()
  departmentRef?: string;
}

/** Alta/edición de una categoría de transacción. */
export class TxCategoryDto {
  @IsString() @MinLength(1)
  name!: string;
}
