import { IsOptional, IsString, Matches, MinLength } from 'class-validator';

/** Restablece la contraseña de un usuario (la fija un administrador). */
export class ResetPasswordDto {
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres.' })
  password!: string;

  /**
   * Los 6 dígitos que le llegaron por WhatsApp AL DUEÑO de la cuenta. Opcional
   * aquí y exigido en el servicio: la exigencia es un ajuste
   * (`security.passwordOtpRequired`), y el mensaje de "falta el código" tiene que
   * explicar a quién le llega — no puede salir como un 400 seco de validación.
   */
  @IsOptional()
  @IsString()
  @Matches(/^\s*\d(\s*\d){5}\s*$/, { message: 'El código son 6 dígitos.' })
  code?: string;
}
