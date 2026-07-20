import { IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Motivos válidos de un punto. Cerrado a propósito: `reason` alimenta la auditoría. */
export const GEO_REASONS = [
  'ticket.open',
  'ticket.close',
  'ticket.attach',
  'subscriber.capture',
  'manual',
] as const;

/** Registrar la posición del funcionario en el momento de una acción. */
export class PingDto {
  @IsNumber() @Min(-90) @Max(90)
  lat!: number;

  @IsNumber() @Min(-180) @Max(180)
  lng!: number;

  @IsOptional() @IsNumber() @Min(0)
  accuracy?: number; // metros reportados por el navegador

  @IsIn(GEO_REASONS as unknown as string[])
  reason!: string;

  @IsOptional() @IsString() @MaxLength(40)
  refType?: string;

  @IsOptional() @IsString() @MaxLength(60)
  refId?: string;
}

/** Fijar las coordenadas de un abonado (botón "capturar GPS aquí" o pin en el mapa). */
export class SetSubscriberLocationDto {
  @IsNumber() @Min(-90) @Max(90)
  lat!: number;

  @IsNumber() @Min(-180) @Max(180)
  lng!: number;

  @IsOptional() @IsNumber() @Min(0)
  accuracy?: number;

  /**
   * `campo` = el técnico está parado en el domicilio (se graba además un GeoPing).
   * `mapa` = alguien colocó el pin desde la oficina, sin estar allí.
   */
  @IsOptional() @IsIn(['campo', 'mapa'])
  source?: string;
}

/** Ruta desde donde está el funcionario hasta un destino. */
export class RouteDto {
  @IsNumber() @Min(-90) @Max(90)
  fromLat!: number;

  @IsNumber() @Min(-180) @Max(180)
  fromLng!: number;

  @IsOptional() @IsNumber() @Min(-90) @Max(90)
  toLat?: number;

  @IsOptional() @IsNumber() @Min(-180) @Max(180)
  toLng?: number;

  /** Destino por abonado: se leen sus coordenadas guardadas en el servidor, que
   * es lo habitual y evita que el cliente tenga que mandarlas de vuelta. */
  @IsOptional() @IsString() @MaxLength(40)
  subscriberId?: string;
}

/** Filtros del mapa. */
export class MapQueryDto {
  @IsOptional() @IsString() @MaxLength(80)
  q?: string; // nombre, abonado o dirección

  @IsOptional() @IsString() @MaxLength(40)
  sede?: string; // Branch.id (cuid) — es lo que devuelve el selector de sedes

  @IsOptional() @IsIn(['1', '0', 'true', 'false'])
  naps?: string; // incluir cajas NAP (default sí)

  @IsOptional() @IsIn(['1', '0', 'true', 'false'])
  subs?: string; // incluir abonados (default sí)
}
