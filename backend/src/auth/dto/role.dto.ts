import { IsArray, IsOptional, IsString, MinLength } from 'class-validator';

/** Crea un rol personalizado (plantilla de permisos). */
export class CreateRoleDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() area?: string;
  @IsArray() @IsString({ each: true }) permissions!: string[];
}

/** Edita un rol personalizado. Todos los campos opcionales (patch parcial). */
export class UpdateRoleDto {
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() area?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) permissions?: string[];
}
