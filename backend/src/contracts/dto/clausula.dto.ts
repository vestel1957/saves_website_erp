import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

/**
 * Cláusula de permanencia mínima.
 *
 * `valores` tiene que traer TANTOS valores como meses: es lo que el contrato le
 * promete al cliente que pagará si se retira en cada mes, y un hueco ahí no es un
 * campo vacío sino una cifra que nadie pactó. El servicio lo revalida.
 */
export class ClausulaDto {
  @IsString() @MinLength(3)
  nombre!: string;

  @IsInt() @Min(1) @Max(12)
  meses!: number;

  /** Valor total del cargo por conexión que se difiere o descuenta (COP). */
  @IsInt() @Min(0)
  vTotal!: number;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(12) @IsInt({ each: true }) @Min(0, { each: true })
  valores!: number[];

  @IsOptional() @IsBoolean()
  activa?: boolean;
}

export class UpdateClausulaDto {
  @IsOptional() @IsString() @MinLength(3)
  nombre?: string;

  @IsOptional() @IsInt() @Min(1) @Max(12)
  meses?: number;

  @IsOptional() @IsInt() @Min(0)
  vTotal?: number;

  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(12) @IsInt({ each: true }) @Min(0, { each: true })
  valores?: number[];

  @IsOptional() @IsBoolean()
  activa?: boolean;
}

/** Firma capturada en el navegador (canvas → PNG en base64). */
export class FirmaDto {
  @IsString() @MinLength(64)
  dataUrl!: string;
}
