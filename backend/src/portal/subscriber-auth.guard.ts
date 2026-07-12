import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { verifySubscriberToken } from '../auth/crypto.util';

/**
 * Autentica el token de ABONADO (portal de autoservicio) y adjunta el id a
 * `req.subscriberId`. Rechaza tokens de staff (no llevan kind='subscriber').
 */
@Injectable()
export class SubscriberAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers?.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Sesión requerida.');
    const payload = verifySubscriberToken(header.slice(7));
    if (!payload) throw new UnauthorizedException('Sesión inválida o expirada.');
    req.subscriberId = payload.sub;
    return true;
  }
}

/** Inyecta el id del abonado autenticado (poblado por SubscriberAuthGuard). */
export const CurrentSubscriber = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  return ctx.switchToHttp().getRequest().subscriberId;
});
