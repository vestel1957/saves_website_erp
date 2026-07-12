import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { verifyToken } from './crypto.util';

/**
 * Authenticates the Bearer token and attaches the resolved user (with their
 * effective permissions) to req.user. Apply alongside PermissionsGuard:
 *   @UseGuards(JwtAuthGuard, PermissionsGuard)
 *
 * Existing production modules are left untouched — only the inventory routes
 * opt into real enforcement, so the live app keeps working during rollout.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers?.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Token de autenticación requerido.');
    }
    const payload = verifyToken(header.slice(7));
    if (!payload) {
      throw new UnauthorizedException('Token inválido o expirado.');
    }
    const user = await this.auth.resolveUser(payload.sub);
    if (!user) {
      throw new UnauthorizedException('Usuario no encontrado o inactivo.');
    }
    req.user = user;
    return true;
  }
}
