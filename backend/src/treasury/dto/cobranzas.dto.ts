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

/** Cierre de caja (arqueo) de una caja en una fecha. */
export class CashCloseDto {
  @IsInt()
  cashAccountId!: number;

  @IsDateString()
  date!: string;

  @IsOptional() @IsNumber() @Min(0)
  base?: number;

  @IsOptional() @IsNumber() @Min(0)
  deposited?: number;
}
