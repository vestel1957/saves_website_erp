import { IsArray, IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

/** Filtro para operaciones masivas por-filtro (mismos campos que la lista de clientes). */
export class BulkFilterDto {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsString() servicio?: string; // internet | tv | combo
  @IsOptional() @IsString() tecnologia?: string; // FTTH | EOC
  @IsOptional() @IsString() cuenta?: string; // aldia | debe | compromiso | compromiso-vencido | compromiso-vigente
  @IsOptional() @IsString() deuda?: string; // 1 | gt2 | fija (debe su mensualidad o más)
  /**
   * Trozo del lote que la pantalla parte para enseñar el avance: se opera sobre
   * estos ids, pero SÓLO los que además cumplen el filtro (y la sede del usuario).
   */
  @IsOptional() @IsArray() @IsString({ each: true }) ids?: string[];
  @IsOptional() @IsBoolean() tanda?: boolean;
}

export class BulkMessageDto extends BulkFilterDto {
  @IsString() @MinLength(1) message!: string;
}
