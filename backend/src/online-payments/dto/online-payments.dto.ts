import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/**
 * Disparo manual del puente con el portal de pagos.
 *
 * `dias` se acota a 90: más atrás no es una reconexión, es reactivar a gente que
 * lleva meses sin servicio y que probablemente ya se retiró o volvió a deber.
 */
export class RunPuenteDto {
  @IsOptional() @IsInt() @Min(1) @Max(90) dias?: number;
  /** En simulación dice a quién reconectaría, sin tocar un solo equipo. */
  @IsOptional() @IsBoolean() dryRun?: boolean;
}

/**
 * Contraseña con la que el abonado entra al portal de pagos en línea.
 *
 * El tope de 72 no es decorativo: bcrypt —el que usa el portal— sólo mira los
 * primeros 72 bytes, así que a partir de ahí dos claves distintas abrirían igual.
 * El resto de reglas (ASCII imprimible) las comprueba el servicio, que es quien
 * puede explicar el porqué en el mensaje.
 */
export class ClavePortalDto {
  @IsString({ message: 'Falta la contraseña.' })
  @MinLength(6, { message: 'La contraseña debe tener al menos 6 caracteres.' })
  @MaxLength(72, { message: 'La contraseña no puede pasar de 72 caracteres.' })
  password!: string;
}
