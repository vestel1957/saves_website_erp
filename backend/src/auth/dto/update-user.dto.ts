import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

/** Edición de los datos básicos del usuario (nombre y/o correo). */
export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;
}
