import { ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, ValidateIf } from 'class-validator';

/** Marca/desmarca qué servicios de un cliente se facturan electrónicamente. */
export class SetEflagsDto {
  @IsOptional() @IsBoolean()
  tv?: boolean;

  @IsOptional() @IsBoolean()
  internet?: boolean;
}

/** Marca en lote una columna (TV/Internet) para un conjunto de clientes. */
export class BulkEflagsDto {
  @IsArray() @ArrayNotEmpty() @IsString({ each: true })
  subscriberIds!: string[];

  @IsIn(['tv', 'internet'])
  service!: 'tv' | 'internet';

  @IsBoolean()
  value!: boolean;
}

/**
 * Marca en lote TODA la sede que cumpla el filtro (no una lista de ids). Los
 * campos del filtro son los mismos de la lista para que lo que se marca sea
 * exactamente lo que el usuario está viendo.
 */
export class BranchBulkEflagsDto {
  @IsIn(['tv', 'internet'])
  service!: 'tv' | 'internet';

  @IsBoolean()
  value!: boolean;

  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsIn(['facturables', 'todos']) estado?: string;
  @IsOptional() @IsIn(['', 'si', 'no']) marcados?: string;
}

/** Nullable int: acepta undefined (no cambia), null (limpia) o entero. */
const NullableInt = () => (target: object, key: string) => {
  IsOptional()(target, key);
  ValidateIf((_o, v) => v !== null)(target, key);
  IsInt()(target, key);
};

/** Configuración editable de una cuenta Siigo (mapeo DIAN + credenciales). */
export class UpdateSiigoAccountDto {
  @IsOptional() @IsString() companyName?: string;
  @IsOptional() @IsIn(['Tv', 'Internet', 'Todo']) role?: string;
  @IsOptional() @IsString() username?: string;
  /** Solo se guarda si viene con contenido (no se puede leer de vuelta). */
  @IsOptional() @IsString() accessKey?: string;
  @IsOptional() @IsString() apiBaseUrl?: string;
  @IsOptional() @IsString() authUrl?: string;
  @IsOptional() @IsString() subscriptionKey?: string;
  @IsOptional() @IsString() contactEmail?: string;
  @IsOptional() @IsBoolean() active?: boolean;

  @NullableInt() documentId?: number | null;
  @NullableInt() creditNoteDocumentId?: number | null;
  @NullableInt() sellerId?: number | null;
  @NullableInt() ivaTaxId?: number | null;
  @NullableInt() paymentCash?: number | null;
  @NullableInt() paymentCredit?: number | null;
  /** Vendedor/cobrador con el que se crea el tercero en Siigo (`related_users`). */
  @NullableInt() customerSellerId?: number | null;
  /** ¿Mandar el documento a la DIAN al crearlo? Apagado, Siigo lo deja en borrador. */
  @IsOptional() @IsBoolean() autoStamp?: boolean;
}
