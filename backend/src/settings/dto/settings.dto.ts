import { IsObject, IsOptional } from 'class-validator';

/**
 * Ajustes key/value.
 *
 * El servicio ya se defiende de las claves desconocidas (sólo escribe las del
 * catálogo `SETTING_DEFS`), así que esto no es la única barrera. Lo que aporta el
 * DTO es la forma: con `whitelist: true`, un `@Body()` tipado como interfaz suelta
 * NO se valida ni se filtra —el ValidationPipe omite por completo los tipos que no
 * son clase—, de modo que cualquier cosa llegaba al servicio. Y por aquí pasan los
 * interruptores `network.mikrotikLive` / `network.oltLive`, que deciden si un corte
 * de servicio se ejecuta de verdad contra los routers.
 */
export class UpdateSettingsDto {
  @IsOptional()
  @IsObject()
  values?: Record<string, string>;
}

/** Metas de negocio. El servicio ignora los campos fuera de `GOAL_FIELDS`. */
export class UpdateGoalsDto {
  [clave: string]: unknown;
}
