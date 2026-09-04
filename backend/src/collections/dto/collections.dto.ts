import { IsOptional, IsString, MinLength } from 'class-validator';
import { ACUERDO_DE_PAGO } from '../llamada-catalogo';

/**
 * Valor de `drespuesta` que marca un compromiso/acuerdo de pago (legacy).
 * El catálogo de la cascada manda; esto es el nombre con el que ya se conocía.
 */
export const AGREEMENT_DETAIL = ACUERDO_DE_PAGO;

/** Registro de una llamada de cobranza (legacy `llamadas`). */
export class CreateCallDto {
  @IsString() subscriberId!: string; // iduser
  @IsOptional() @IsString() callType?: string; // tllamada
  @IsOptional() @IsString() responseType?: string; // trespuesta
  @IsString() @MinLength(1) responseDetail!: string; // drespuesta
  @IsOptional() @IsString() date?: string; // fcha (default hoy)
  @IsOptional() @IsString() time?: string; // hra (HH:mm)
  @IsOptional() @IsString() dueDate?: string; // fecha_vence (requerido si es Acuerdo de Pago)
  @IsOptional() @IsString() notes?: string;
}
