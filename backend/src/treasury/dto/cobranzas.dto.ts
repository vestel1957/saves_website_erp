import {
  IsArray, IsBoolean, IsDateString, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength,
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

  /**
   * Referencia externa del pago (id de la pasarela, referencia del corresponsal).
   * Va a la nota del movimiento igual que en el legacy, que la escribía como
   * "referencia: <id_orden>".
   */
  @IsOptional() @IsString()
  reference?: string;

  /** Orden explícito de facturas a pagar (ids). Si se omite: más antiguas primero. */
  @IsOptional() @IsArray() @IsString({ each: true })
  invoiceIds?: string[];

  /**
   * ¿Devolverle el servicio al pagar? Por defecto SÍ (paridad legacy: pagar reconecta).
   *
   * Se manda `false` cuando el cliente paga pero NO quiere volver a tener servicio —
   * el caso típico es el que se va: llega a saldar lo que debe y a retirarse. Antes
   * no había forma de decirlo desde caja y el recaudo lo reconectaba igual, así que
   * el cliente quedaba activo (y volviendo a facturar) sin haberlo pedido.
   *
   * Ojo: esto NO retira al cliente ni cambia su estado, solo se abstiene de tocar los
   * equipos. El retiro sigue siendo su propio trámite.
   */
  @IsOptional() @IsBoolean()
  reconectar?: boolean;

  /**
   * Recibir la plata SIN factura pendiente que cubrir: queda entera como saldo a
   * favor y se aplica sola a la factura del mes siguiente cuando nazca.
   *
   * El caso: el cliente está al día y quiere dejar pagado el mes que viene, que
   * todavía no se ha facturado (la corrida es el día 1). Hasta ahora el recaudo se
   * caía con "El cliente no tiene facturas pendientes" y había que emitirle la
   * factura por adelantado a mano.
   *
   * Es OPT-IN a propósito: sin esto, el cargue masivo de pagos convertiría en
   * anticipo cualquier fila que no cuadre con una factura, en vez de fallar y que
   * alguien la mire.
   */
  @IsOptional() @IsBoolean()
  comoAnticipo?: boolean;

  /**
   * Dejar pagados TAMBIÉN los próximos N meses, que todavía no se han facturado.
   *
   * Es la casilla "pagar también <mes>" del modal de recaudo. Sólo viaja el NÚMERO de
   * meses: el precio y el descuento por adelantar (`billing.advanceDiscountPct`) los
   * pone el servidor, para que nadie pueda cobrarse un mes a su antojo desde el
   * navegador. El recaudo se rechaza si el monto no alcanza o si al cliente le queda
   * alguna factura pendiente (esa deuda se comería el adelanto).
   */
  @IsOptional() @IsInt() @Min(1) @Max(12)
  adelantarMeses?: number;
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
   * Opcional: a quién se le paga, del directorio (`Supplier`, incluidos los
   * TERCEROS — categoría 3). Si viene, el nombre del beneficiario lo pone el
   * servidor a partir del directorio y no hace falta escribirlo.
   *
   * Existía el agujero de siempre: el beneficiario se tecleaba a mano y el mismo
   * de siempre entraba escrito de N maneras (hay 4.330 nombres distintos en los
   * egresos históricos, con duplicados invisibles del tipo "Dr Orlando Vesga"
   * dos veces). Ligarlo por id es lo que hace que el estado de cuenta del
   * proveedor cuadre.
   */
  @IsOptional() @IsString()
  supplierId?: string;

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

  /**
   * Opcional: centro de costo del asiento contable. Si no viene, el de la sede de la caja
   * (la de banco va a «Administración general»). Nunca obligatorio: no frena a la cajera.
   */
  @IsOptional() @IsString()
  costCenterId?: string;
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

/**
 * Apertura de caja. NO lleva base: la pone el servidor con el fondo fijo que
 * administración le fijó a esa caja más el arrastre del cierre anterior. Quien abre
 * sólo dice cuál y qué día — antes escribía la cifra a mano, que es justo lo que se
 * quiso quitar.
 */
export class CashOpenDto {
  /** Omitido = la caja asignada a quien abre (el caso de la cajera). */
  @IsOptional() @IsInt()
  cashAccountId?: number;

  @IsDateString()
  date!: string;
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

  /**
   * Opcional: centro de costo del asiento contable. Si no viene, el de la sede de la caja
   * (la de banco va a «Administración general»). Nunca obligatorio: no frena a la cajera.
   */
  @IsOptional() @IsString()
  costCenterId?: string;
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

/**
 * Alta rápida de un beneficiario (`Supplier`) desde el propio movimiento.
 *
 * Es la vía corta para que el directorio se llene solo con lo que de verdad se
 * paga: si el tercero no está en el desplegable se crea aquí mismo, sin salir a
 * Proveedores. Lo completo (NIT, banco, cuenta…) se sigue editando allá.
 */
export class BeneficiaryDto {
  @IsString() @MinLength(1)
  name!: string;

  /** 1 productos · 2 servicios · 3 terceros (el default aquí). */
  @IsOptional() @IsInt()
  category?: number;

  /**
   * NIT o cédula. OBLIGATORIO: sin documento el directorio se vuelve a llenar de
   * repetidos, que es el problema que resuelve. Se guarda como lo escriben y se
   * compara sin puntos ni guiones.
   */
  @IsString() @MinLength(5) @MaxLength(30)
  nit!: string;

  @IsOptional() @IsString()
  phone?: string;
}
