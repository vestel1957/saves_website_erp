import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

/**
 * Filtros del listado de cajas NAP (`GET /network/naps`).
 *
 * Antes los filtros viajaban como siete argumentos sueltos del handler y cada uno
 * nuevo obligaba a tocar controlador + router + `contrato-http.json` en el mismo
 * orden exacto. Con un DTO de query el router pasa `req.query` entera
 * (`validarQuery`) y añadir un filtro es añadir un campo aquí. Mismo patrón que
 * `ListTxQueryDto` en tesorería.
 *
 * En la query TODO llega como texto: la conversión implícita de `class-transformer`
 * es la que convierte `?page=2` en 2 (ver `core/http/validar.ts`).
 */
export class ListNapsQueryDto {
  /** Texto libre: nombre de la NAP o su dirección (poste / referencia). */
  @IsOptional() @IsString()
  search?: string;

  @IsOptional() @IsString()
  branchId?: string;

  /**
   * VLAN concreta (`Vlan.id`) o el literal `none` para las NAPs que no tienen
   * ninguna asignada — que son pocas (6 de 1.398) y justo por eso interesa
   * poder pescarlas.
   */
  @IsOptional() @IsString()
  vlanId?: string;

  /**
   * Ocupación de los puertos, mirando `Port.status`:
   * - `libres`: le queda al menos un puerto Disponible (es la pregunta de campo:
   *   "¿dónde conecto a este cliente?").
   * - `llenas`: tiene puertos registrados y ninguno Disponible.
   * - `vacias`: no tiene ningún puerto Ocupado.
   *
   * Ojo: se mide sobre los puertos REGISTRADOS, no sobre `portCount`. Hay 39 NAPs
   * sin ningún puerto en la tabla y 114 donde el registro no cuadra con el número
   * declarado; ésas no son "llenas", simplemente no tienen puertos que mirar.
   */
  @IsOptional() @IsIn(['libres', 'llenas', 'vacias'])
  ocupacion?: string;

  /**
   * Dirección de la NAP, que en la práctica es el BARRIO o sector
   * (`dir_nap` del legacy): 493 distintos en 1.398 NAPs.
   *
   * Llega ya normalizada (mayúsculas y sin espacios de sobra) porque los datos
   * del legacy traen el mismo barrio escrito de varias formas — `Rosales` y
   * `ROSALES` son 23 + 15 NAPs del mismo sitio, y 71 direcciones llevan espacios
   * pegados. Las opciones salen de `GET /network/nap-addresses`.
   */
  @IsOptional() @IsString()
  address?: string;

  /** Conmutador viejo de la pantalla (`sort=vlan`). Manda `sortBy`/`sortDir` si vienen. */
  @IsOptional() @IsString()
  sort?: string;

  @IsOptional() @IsInt() @Min(1)
  page?: number;

  @IsOptional() @IsInt() @Min(1)
  pageSize?: number;

  @IsOptional() @IsString()
  sortBy?: string;

  @IsOptional() @IsIn(['asc', 'desc'])
  sortDir?: string;
}
