/**
 * Bitácora global (sustituye a `AuditInterceptor`).
 *
 * Audita TODA petición mutante (POST/PATCH/PUT/DELETE) — quién, cuándo, módulo,
 * entidad, IP — salvo unas pocas rutas de ruido. Reemplaza al `historial_crm` del
 * legacy, así que no es un adorno: es el rastro con el que se responde "quién tocó
 * esta factura".
 *
 * El interceptor de Nest envolvía el flujo con RxJS y auditaba en el `tap`, o sea
 * SÓLO cuando el handler terminaba bien. Aquí se consigue lo mismo enganchándose al
 * evento `finish` de la respuesta y filtrando por código de estado: si la petición
 * acabó en error (4xx/5xx), no se audita, igual que antes. La ventaja es que el
 * registro sale del camino crítico — la respuesta ya se envió — en vez de colgar de
 * un `tap` que el cliente espera.
 */
import type { NextFunction, Request, Response } from 'express';
import type { AuditService } from '../common/audit/audit.service';

/** Rutas de escritura que NO se auditan (ruido o sensibles). */
const OMITIR = ['/auth/login', '/auth/refresh', '/whatsapp/webhook'];

const MUTANTES = ['POST', 'PATCH', 'PUT', 'DELETE'];

function cuerpoSeguro(body: unknown) {
  if (!body || typeof body !== 'object') return body;
  const copia: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const k of ['password', 'passwordHash']) if (k in copia) copia[k] = '***';
  return copia;
}

export function crearAuditoria(audit: AuditService) {
  return function auditoria(req: Request, res: Response, next: NextFunction) {
    const url = req.originalUrl ?? req.url ?? '';
    if (!MUTANTES.includes(req.method) || OMITIR.some((p) => url.includes(p))) {
      return next();
    }

    // El cuerpo se copia AQUÍ, antes de que el handler lo mute. Varios servicios
    // hacen `delete dto.x` o reasignan campos sobre `req.body`; leerlo en `finish`
    // guardaría el objeto ya manipulado, no lo que el usuario envió.
    const cuerpo = cuerpoSeguro(req.body);

    // Se intercepta `res.json` para quedarse con el id del registro devuelto. El
    // interceptor de Nest lo tenía a mano (auditaba el valor que retornaba el
    // handler) y lo usaba como `entityId`: sin esto, las CREACIONES perderían a qué
    // registro se refieren y la bitácora sólo diría "hubo un POST a /billing".
    let respuesta: unknown;
    const jsonOriginal = res.json.bind(res);
    res.json = (cuerpoRes: unknown) => {
      respuesta = cuerpoRes;
      return jsonOriginal(cuerpoRes);
    };

    res.on('finish', () => {
      // Sólo se auditan las operaciones que salieron bien, igual que el `tap` del
      // interceptor: un 403 o un 400 no cambiaron nada que registrar.
      if (res.statusCode >= 400) return;

      // /api/<módulo>/<entidad>/... → "módulo/entidad" como entity legible.
      const path = url.replace(/^\/api\//, '').split('?')[0];
      const partes = path.split('/').filter(Boolean);
      const entidad = partes.slice(0, 2).join('/') || path;

      void audit.record({
        userId: req.user?.id,
        action: `${req.method} /${path}`,
        entity: entidad,
        entityId: (respuesta as { id?: string } | undefined)?.id ?? partes[1],
        after: cuerpo,
        ipAddress: req.ip ?? req.socket?.remoteAddress,
      });
    });

    next();
  };
}
