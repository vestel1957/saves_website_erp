import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Datos que un usuario puede cambiar de SÍ MISMO desde "Mi perfil".
 *
 * Es a propósito un subconjunto de `UpdateStaffDto`: aquí no aparecen `areaId`,
 * `entryDate`, `role` ni `sedeAccede`. Esos los fija RRHH/sistemas desde la ficha
 * del empleado; si el interesado pudiera cambiarlos se caería el sentido de que
 * exista un permiso para editarlos (el legacy sí los dejaba en el formulario de
 * `user/update`, y por eso el área y la fecha de ingreso eran datos poco fiables).
 *
 * Cadena vacía = borrar el dato (se normaliza a NULL); campo ausente = no se toca.
 */
export class UpdateProfileDto {
  @IsOptional() @IsString() @MinLength(2, { message: 'El nombre no puede quedar vacío.' }) @MaxLength(120)
  name?: string;

  @IsOptional() @IsString() @MaxLength(40)
  docNumber?: string;

  @IsOptional() @IsString() @MaxLength(40)
  phone?: string;

  @IsOptional() @IsString() @MaxLength(40)
  phoneAlt?: string;

  @IsOptional() @IsString() @MaxLength(200)
  address?: string;

  @IsOptional() @IsString() @MaxLength(80)
  city?: string;

  @IsOptional() @IsString() @MaxLength(80)
  region?: string;

  @IsOptional() @IsString() @MaxLength(80)
  country?: string;

  @IsOptional() @IsString() @MaxLength(10)
  rh?: string;

  @IsOptional() @IsString() @MaxLength(120)
  eps?: string;

  @IsOptional() @IsString() @MaxLength(120)
  pension?: string;
}

/** Cambio de la propia contraseña: exige la actual (igual que el legacy) y el código de WhatsApp. */
export class ChangePasswordDto {
  @IsString()
  currentPassword!: string;

  @IsString()
  @MinLength(8, { message: 'La contraseña nueva debe tener al menos 8 caracteres.' })
  @MaxLength(72)
  newPassword!: string;

  /**
   * Los 6 dígitos que llegaron por WhatsApp. Opcional aquí y exigido en el
   * servicio: la exigencia es un ajuste (`security.passwordOtpRequired`) y el
   * mensaje de "falta el código" tiene que poder explicar de dónde sacarlo.
   */
  @IsOptional()
  @IsString()
  @Matches(/^\s*\d(\s*\d){5}\s*$/, { message: 'El código son 6 dígitos.' })
  code?: string;
}
