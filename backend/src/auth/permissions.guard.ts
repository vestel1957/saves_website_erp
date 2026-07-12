import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from './require-permissions.decorator';
import { INV_PERMISSIONS, SUPERADMIN_PERMISSION } from './permissions.catalog';

/**
 * Enforces @RequirePermissions(). Must run AFTER JwtAuthGuard, which populates
 * req.user.permissions. `system.admin` (global superadmin) passes ANY check;
 * `inventory.admin` (inventory superuser) passes only `inventory.*` checks — it
 * is NOT a global bypass, so the Jefe de bodega owns inventory but not HR/payroll.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest();
    const granted: string[] = req?.user?.permissions ?? [];

    if (granted.includes(SUPERADMIN_PERMISSION)) {
      return true;
    }
    // `inventory.admin` es superusuario SOLO del inventario, no del resto del ERP.
    const hasInvAdmin = granted.includes(INV_PERMISSIONS.ADMIN);
    const ok = required.every(
      (p) => granted.includes(p) || (hasInvAdmin && p.startsWith('inventory.')),
    );
    if (!ok) {
      throw new ForbiddenException('No tienes permiso para realizar esta acción.');
    }
    return true;
  }
}
