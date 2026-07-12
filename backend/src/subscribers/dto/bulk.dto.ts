import { IsOptional, IsString, MinLength } from 'class-validator';

/** Filtro para operaciones masivas por-filtro (mismos campos que la lista de clientes). */
export class BulkFilterDto {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsString() servicio?: string; // internet | tv | combo
  @IsOptional() @IsString() tecnologia?: string; // FTTH | EOC
  @IsOptional() @IsString() cuenta?: string; // aldia | debe | compromiso
  @IsOptional() @IsString() deuda?: string; // 1 | gt2
}

export class BulkMessageDto extends BulkFilterDto {
  @IsString() @MinLength(1) message!: string;
}
