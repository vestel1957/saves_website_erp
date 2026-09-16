import { IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Min } from 'class-validator';

/**
 * Filtros del listado de movimientos de caja (`GET /treasury/transactions`).
 *
 * Hasta ahora los doce filtros viajaban como doce argumentos sueltos del handler y
 * cada uno nuevo obligaba a tocar controlador + router + `contrato-http.json` en el
 * mismo orden exacto. Con un DTO de query el router pasa `req.query` entero
 * (`validarQuery`) y añadir un filtro es añadir un campo aquí.
 *
 * En la query TODO llega como texto: la conversión implícita de `class-transformer`
 * es la que convierte `?page=2` en 2 (ver `core/http/validar.ts`).
 */
export class ListTxQueryDto {
  /** Texto libre: pagador, nota o nombre de la cuenta. */
  @IsOptional() @IsString()
  search?: string;

  @IsOptional() @IsIn(['INCOME', 'EXPENSE', 'TRANSFER'])
  type?: string;

  @IsOptional() @IsString()
  category?: string;

  @IsOptional() @IsIn(['VIGENTE', 'ANULADA'])
  status?: string;

  /** Periodo (YYYY-MM-DD). Sin él: año actual — o HOY, si quien mira es cajera. */
  @IsOptional() @IsString()
  from?: string;

  @IsOptional() @IsString()
  to?: string;

  /**
   * Hora del REGISTRO (`createdAt`, "HH:MM" en hora de Colombia). `date` es sólo el
   * día contable y no tiene hora: con estas dos el periodo pasa a ser una ventana de
   * `from horaDesde` a `to horaHasta` ("el 14 de 8:00 a 12:00"). Sin una de las dos,
   * ese extremo es el día entero.
   */
  @IsOptional() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  horaDesde?: string;

  @IsOptional() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  horaHasta?: string;

  /** `all=1` levanta el periodo por defecto y consulta el histórico completo. */
  @IsOptional() @IsString()
  all?: string;

  /** Una caja concreta (`CashAccount.legacyId`). Pedir una ajena es 403, no vacío. */
  @IsOptional() @IsInt()
  cashAccountId?: number;

  /**
   * Sede (`Branch.legacyId`, que es el mismo espacio de ids que `accounts.sede` del
   * legacy). **0 = los bancos**, que no son de ninguna sede — por eso se compara
   * contra `undefined` y nunca por verdadero/falso.
   *
   * No es una columna de `Transaction`: la sede vive en la CAJA, así que se traduce a
   * la lista de cajas de esa sede y se cruza con las que el usuario puede ver.
   */
  @IsOptional() @IsInt()
  sede?: number;

  /** Método de pago tal cual está en los datos: Cash, Bank, Card, Cheque, Balance, PAYU, WOMPI. */
  @IsOptional() @IsString()
  method?: string;

  /** Monto del movimiento (el que se ve en la lista: crédito si entra, débito si sale). */
  @IsOptional() @IsNumber() @Min(0)
  min?: number;

  @IsOptional() @IsNumber() @Min(0)
  max?: number;

  /** `1` = sólo los que tienen comprobante adjunto; `0` = sólo los que NO lo tienen. */
  @IsOptional() @IsIn(['0', '1'])
  attach?: string;

  @IsOptional() @IsInt() @Min(1)
  page?: number;

  @IsOptional() @IsInt() @Min(1)
  pageSize?: number;

  @IsOptional() @IsString()
  sortBy?: string;

  @IsOptional() @IsString()
  sortDir?: string;
}
