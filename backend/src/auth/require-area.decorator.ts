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
