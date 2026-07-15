import { IsOptional, IsString, MinLength } from 'class-validator';

/** Valor de `drespuesta` que marca un compromiso/acuerdo de pago (legacy). */
export const AGREEMENT_DETAIL = 'Acuerdo de Pago';

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
