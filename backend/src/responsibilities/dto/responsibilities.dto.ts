import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsOptional, IsString, MinLength, ValidateNested } from 'class-validator';

export class HolderDto {
  @IsString() @MinLength(1) userId!: string;
  /** El titular del cargo. Si nadie viene marcado, el servicio nombra al primero. */
  @IsOptional() @IsBoolean() isPrimary?: boolean;
  /** Avisarle también al WhatsApp (exige que el usuario tenga teléfono registrado). */
  @IsOptional() @IsBoolean() notifyWhatsapp?: boolean;
}

/** Reemplaza la lista completa de encargados de un cargo. Vacío = dejarlo vacante. */
export class SetHoldersDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => HolderDto) holders!: HolderDto[];
}
