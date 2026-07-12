import { IsInt, IsString, MinLength } from 'class-validator';

/** Login del abonado: número de abonado + documento (cédula/NIT). */
export class PortalLoginDto {
  @IsInt()
  abonado!: number;

  @IsString() @MinLength(3)
  document!: string;
}
