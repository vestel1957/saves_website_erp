import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * "Olvidé mi contraseña" desde la pantalla de ingreso. Son rutas ABIERTAS (sin
 * sesión), así que la validación se queda en la forma —que sea un correo, que el
 * código sean 6 dígitos— y nunca en si existe: el servicio responde igual para
 * todos los correos para no regalar la lista de empleados a quien la tantee.
 */

/** Paso 1: a qué correo. */
export class ForgotPasswordDto {
  @IsEmail({}, { message: 'Escribe un correo válido.' })
  @MaxLength(160)
  email!: string;
}

/** Paso 2: el código que llegó por WhatsApp (se comprueba, no se gasta). */
export class ForgotCheckDto {
  @IsEmail({}, { message: 'Escribe un correo válido.' })
  @MaxLength(160)
  email!: string;

  @IsString()
  @Matches(/^\s*\d(\s*\d){5}\s*$/, { message: 'El código son 6 dígitos.' })
  code!: string;
}

/** Paso 3: la contraseña nueva, con el mismo código (ahora sí se gasta). */
export class ForgotResetDto extends ForgotCheckDto {
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres.' })
  @MaxLength(72)
  password!: string;
}
