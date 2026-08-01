import { SetMetadata } from '@nestjs/common';

export const AREAS_KEY = 'required_areas';

/**
 * Declara las áreas de acceso Vestel que pueden usar una ruta/controlador.
 * Semántica OR: basta con pertenecer a UNA de las áreas listadas.
 * El superusuario (system.admin) pasa siempre. Enforzado por AreaGuard.
 *
 * Los valores son los slugs de área (sin el prefijo `area.`):
 *   'gerencia' | 'administracion' | 'contabilidad' | 'tecnicos' | 'sistemas'
 */
export const RequireArea = (...areas: string[]) => SetMetadata(AREAS_KEY, areas);

export const AREA_OR_PERMS_KEY = 'required_areas_or_permissions';

/**
 * Permisos que TAMBIÉN abren una ruta gateada por área, sin pertenecer al área.
 *
 * Existe por el Jefe de bodega (`warehouse-manager`): manda sobre el inventario
 * entero (`inventory.admin`) pero no tiene ningún `area.*`, así que el AreaGuard lo
 * dejaba fuera de sus propias rutas —era el 403 conocido de todo /inventory—. Con
 * esto una ruta puede decir "área tecnicos/caja, o quien tenga inventory.admin".
 *
 * Es un OR con las áreas, no un AND: no sustituye a `@RequirePermissions`, que sigue
 * siendo la exigencia dura de la ruta.
 */
export const OrPermission = (...perms: string[]) => SetMetadata(AREA_OR_PERMS_KEY, perms);
