import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { extractApiKey, hashApiKey } from './api-key.util';

export const SCOPES_KEY = 'api_scopes';
/** Declara los scopes exigidos por una ruta pública (semántica AND). */
export const RequireScopes = (...scopes: string[]) => SetMetadata(SCOPES_KEY, scopes);

/** Ventana deslizante en memoria por clave (peticiones/hora). */
const hits = new Map<string, number[]>();
const WINDOW_MS = 60 * 60 * 1000;

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const raw = extractApiKey(req.headers ?? {});
    if (!raw) throw new UnauthorizedException('Falta la cabecera X-API-Key.');

    const key = await this.prisma.apiKey.findUnique({ where: { keyHash: hashApiKey(raw) } });
    if (!key || !key.active || key.revokedAt) {
      throw new UnauthorizedException('Clave de API inválida o revocada.');
    }

    // IP allowlist (si está configurada).
    const ip = clientIp(req);
    if (key.ipAllowlist.length > 0 && !key.ipAllowlist.includes(ip)) {
      throw new ForbiddenException('IP no autorizada para esta clave.');
    }

    // Scopes exigidos por la ruta.
    const required = this.reflector.getAllAndOverride<string[]>(SCOPES_KEY, [
      context.getHandler(), context.getClass(),
    ]) ?? [];
    const missing = required.filter((s) => !key.scopes.includes(s));
    if (missing.length > 0) {
      throw new ForbiddenException(`La clave no tiene los permisos: ${missing.join(', ')}.`);
    }

    // Rate limit (salvo ignoreLimits o límite 0).
    if (!key.ignoreLimits && key.rateLimit > 0) {
      const now = Date.now();
      const arr = (hits.get(key.id) ?? []).filter((t) => now - t < WINDOW_MS);
      if (arr.length >= key.rateLimit) {
        throw new ForbiddenException('Límite de peticiones por hora superado.');
      }
      arr.push(now);
      hits.set(key.id, arr);
    }

    // Auditoría ligera de uso (best-effort, no bloquea).
    void this.prisma.apiKey.update({
      where: { id: key.id },
      data: { lastUsedAt: new Date(), lastUsedIp: ip, usageCount: { increment: 1 } },
    }).catch(() => undefined);

    req.apiKey = { id: key.id, name: key.name, scopes: key.scopes };
    return true;
  }
}

function clientIp(req: any): string {
  // Usar SOLO `req.ip`. Con `trust proxy` activado en main.ts, Express ya resuelve
  // la IP real del cliente a partir del X-Forwarded-For que fija NUESTRO proxy.
  // Parsear el header crudo (como antes) tomaba el primer elemento, que lo controla
  // el cliente: bastaba `X-Forwarded-For: <ip-permitida>` para saltarse la allowlist
  // de IP de la clave y envenenar el `lastUsedIp` del registro forense.
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}
