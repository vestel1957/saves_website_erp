import { IsArray, IsEmail, IsInt, IsOptional, IsString, MinLength } from 'class-validator';

/** Edición de los datos básicos del usuario (nombre y/o correo). */
export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  /**
   * Sedes a las que accede (`Branch.legacyId`). Omitirlo deja el valor como está;
   * enviar `[]` quita la restricción y le devuelve el acceso a todas las sedes.
   */
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  sedesAccede?: number[];
}
