import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { AuditService } from './audit.service';

/** Rutas de escritura que NO se auditan (ruido o sensibles). */
const AUDIT_SKIP = ['/auth/login', '/auth/refresh', '/whatsapp/webhook'];

/**
 * Bitácora global (reemplaza `historial_crm`): auto-audita TODA petición mutante
 * (POST/PATCH/PUT/DELETE) de la plataforma — quién, cuándo, módulo, entidad, IP —
 * salvo unas pocas rutas de ruido. Registrado globalmente. La auditoría nunca
 * rompe la operación de negocio (los errores se tragan en el servicio).
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const method: string = req.method;
    const url: string = req.originalUrl ?? req.url ?? '';
    const isWrite = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method);
    const skip = AUDIT_SKIP.some((p) => url.includes(p));

    if (!isWrite || skip) return next.handle();

    // /api/<módulo>/<entidad>/... → "módulo/entidad" como entity legible.
    const path = url.replace(/^\/api\//, '').split('?')[0];
    const parts = path.split('/').filter(Boolean);
    const entity = parts.slice(0, 2).join('/') || path;

    return next.handle().pipe(
      tap((result: any) => {
        void this.audit.record({
          userId: req.user?.id,
          action: `${method} /${path}`,
          entity,
          entityId: result?.id ?? (Array.isArray(parts) ? parts[1] : undefined),
          after: this.safeBody(req.body),
          ipAddress: req.ip ?? req.socket?.remoteAddress,
        });
      }),
    );
  }

  private safeBody(body: unknown) {
    if (!body || typeof body !== 'object') return body;
    const clone: Record<string, unknown> = { ...(body as Record<string, unknown>) };
    for (const k of ['password', 'passwordHash']) if (k in clone) clone[k] = '***';
    return clone;
  }
}
