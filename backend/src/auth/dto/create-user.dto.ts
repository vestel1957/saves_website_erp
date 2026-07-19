import { IsArray, IsEmail, IsInt, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(2)
  name!: string;

  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres.' })
  password!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roleKeys?: string[];

  /**
   * Sedes a las que accede (`Branch.legacyId`).
   * Lista vacía u omitida = SIN restricción: ve todas las sedes.
   */
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  sedesAccede?: number[];
}
