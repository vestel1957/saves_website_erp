import { IsIn, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';
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

/** Pedir una nota crédito/débito para el cliente y asignársela a quien la emite. */
export class CreateNoteRequestDto {
  @IsString() subscriberId!: string;
  @IsIn(['CREDITO', 'DEBITO']) type!: 'CREDITO' | 'DEBITO';
  /** Monto sugerido; lo decide quien emite. */
  @IsOptional() @IsNumber() @Min(0) amount?: number;
  @IsString() @MinLength(5) reason!: string;
  @IsString() assignedToId!: string;
}

/** Cerrar una solicitud: se aplicó la nota o no procede. */
export class ResolveNoteRequestDto {
  @IsIn(['APLICADA', 'RECHAZADA']) status!: 'APLICADA' | 'RECHAZADA';
  @IsOptional() @IsString() response?: string;
}
