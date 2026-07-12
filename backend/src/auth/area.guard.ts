import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AREAS_KEY } from './require-area.decorator';
import { SUPERADMIN_PERMISSION } from './permissions.catalog';

/**
 * Enforza @RequireArea(). Debe correr DESPUÉS de JwtAuthGuard (que puebla
 * req.user.permissions). Semántica OR: el usuario pasa si tiene el permiso
 * `area.<slug>` de ALGUNA de las áreas requeridas. El superadministrador
 * (`system.admin`) pasa cualquier verificación.
 *
 * Es defensa en profundidad a nivel API que complementa el bloqueo por ruta
 * del middleware del frontend; la frontera real sigue siendo el backend.
 */
@Injectable()
export class AreaGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(AREAS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest();
    const granted: string[] = req?.user?.permissions ?? [];

    if (granted.includes(SUPERADMIN_PERMISSION)) return true;

    const ok = required.some((slug) => granted.includes(`area.${slug}`));
    if (!ok) {
      throw new ForbiddenException('No perteneces al área requerida para esta acción.');
    }
    return true;
  }
}
