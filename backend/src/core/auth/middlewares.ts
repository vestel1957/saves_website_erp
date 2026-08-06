/**
 * Middleware de autenticación y autorización (sustituye a los 7 guards de Nest).
 *
 * Los guards eran funciones puras sobre `req`, así que el port es directo. Lo que
 * cambia es CÓMO se declaran: antes el `Reflector` leía metadatos que los decoradores
 * dejaban en la clase y en el método, con reglas de precedencia invisibles en el
 * código. Aquí las áreas y los permisos son argumentos de la función, escritos en la
 * misma línea de la ruta. Esa era la queja de fondo con Nest —"menos magia"—, y es
 * también lo que hace auditable de un vistazo quién entra a cada endpoint.
 *
 * OJO con el orden: `autenticar` debe ir SIEMPRE antes que `exigirArea` /
 * `exigirPermisos`, que leen el `req.user` que aquél puebla. Montarlos al revés
 * dejaría pasar a todo el mundo, porque un `permissions` vacío no coincide con nada
 * pero tampoco existe usuario que rechazar. `rutaProtegida()` (ver ruta.ts) los
 * compone en el orden correcto para que no dependa de la memoria de quien escribe.
 */
import type { NextFunction, Request, Response } from 'express';
import type { AuthUser } from '../../auth/current-user.decorator';
import { esTecnicoDeCampo } from '../../common/tecnico-scope';
import { verifyToken, verifySubscriberToken } from '../../auth/crypto.util';
import { INV_PERMISSIONS, SUPERADMIN_PERMISSION } from '../../auth/permissions.catalog';
import { extractApiKey, hashApiKey } from '../../public-api/api-key.util';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuthService } from '../../auth/auth.service';
import { ForbiddenException, HttpException, HttpStatus, UnauthorizedException } from '../http/errores';

/** Express no conoce estos campos; se declaran para no ir con `any` por el código. */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      subscriberId?: string;
      apiKey?: { id: string; name: string; scopes: string[] };
    }
  }
}

export type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

/**
 * Envuelve un middleware asíncrono para que un `throw` acabe en el manejador de
 * errores. Sin esto, Express 4 ignora las promesas rechazadas y la petición se queda
 * colgada hasta el timeout en vez de responder 401.
 */
function asinc(fn: Middleware): Middleware {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ---------------------------------------------------------------------------
// Autenticación de personal (JwtAuthGuard)
// ---------------------------------------------------------------------------

export function crearAutenticar(auth: AuthService): Middleware {
  return asinc(async (req, _res, next) => {
    const header = req.headers?.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Token de autenticación requerido.');
    }
    const payload = verifyToken(header.slice(7));
    if (!payload) {
      throw new UnauthorizedException('Token inválido o expirado.');
    }
    const user = await auth.resolveUser(payload.sub);
    if (!user) {
      throw new UnauthorizedException('Usuario no encontrado o inactivo.');
    }
    req.user = user;
    next();
  });
}

// ---------------------------------------------------------------------------
// Áreas (AreaGuard) y permisos (PermissionsGuard)
// ---------------------------------------------------------------------------

/**
 * Exige pertenecer a UNA de las áreas (semántica OR). El superadministrador pasa
 * siempre. `orPermission` son permisos que abren la ruta sin tener área: existe por
 * el Jefe de bodega, que manda sobre el inventario (`inventory.admin`) y no tiene
 * ningún `area.*`.
 */
export function exigirArea(...areas: string[]): Middleware {
  return exigirAreaCon({ areas });
}

export function exigirAreaCon(opciones: { areas: string[]; orPermission?: string[] }): Middleware {
  const { areas, orPermission = [] } = opciones;
  return (req, _res, next) => {
    if (areas.length === 0) return next();

    const concedidos = req.user?.permissions ?? [];
    if (concedidos.includes(SUPERADMIN_PERMISSION)) return next();
    if (orPermission.some((p) => concedidos.includes(p))) return next();

    if (!areas.some((slug) => concedidos.includes(`area.${slug}`))) {
      throw new ForbiddenException('No perteneces al área requerida para esta acción.');
    }
    next();
  };
}

/**
 * Exige TODOS los permisos listados (semántica AND). `system.admin` pasa cualquier
 * comprobación; `inventory.admin` pasa sólo las de `inventory.*` — no es un bypass
 * global, para que el Jefe de bodega mande en inventario pero no en nómina.
 */
export function exigirPermisos(...permisos: string[]): Middleware {
  return (req, _res, next) => {
    if (permisos.length === 0) return next();

    const concedidos = req.user?.permissions ?? [];
    if (concedidos.includes(SUPERADMIN_PERMISSION)) return next();

    const tieneInvAdmin = concedidos.includes(INV_PERMISSIONS.ADMIN);
    const ok = permisos.every(
      (p) => concedidos.includes(p) || (tieneInvAdmin && p.startsWith('inventory.')),
    );
    if (!ok) {
      throw new ForbiddenException('No tienes permiso para realizar esta acción.');
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Módulo RED / ISP frente al técnico de campo (ModuloRedGuard)
// ---------------------------------------------------------------------------

/**
 * Cierra el módulo de Red al técnico de campo. Es LISTA BLANCA: lo que el técnico
 * conserva son dos lecturas, que se montan con `abiertoAlTecnico()` en vez de con
 * esto. Cualquier ruta nueva de red nace cerrada para él, que es el lado correcto
 * cuando detrás hay cortes de servicio y routers.
 *
 * No cubre autenticar la ONU ni aplicar velocidad dentro de una orden: eso vive en
 * el módulo de soporte y sigue exigiendo `network.olt.manage`, que el técnico tiene
 * porque es su trabajo de campo.
 */
export const moduloRed: Middleware = (req, _res, next) => {
  if (!esTecnicoDeCampo(req.user)) return next();
  throw new ForbiddenException('Red / ISP y Mikrotik no están en tu perfil.');
};

/** Marca explícita de "esta ruta de red SÍ la ve el técnico": simplemente no monta
 *  `moduloRed`. Se expone como función con nombre para que el permiso quede escrito
 *  en la ruta y no como una omisión silenciosa que nadie sabe si fue intencionada. */
export const abiertoAlTecnico: Middleware = (_req, _res, next) => next();

// ---------------------------------------------------------------------------
// Portal del abonado (SubscriberAuthGuard)
// ---------------------------------------------------------------------------

/** Autentica el token de ABONADO y adjunta su id a `req.subscriberId`.
 *  Rechaza tokens de personal (no llevan kind='subscriber'). */
export const autenticarAbonado: Middleware = (req, _res, next) => {
  const header = req.headers?.authorization;
  if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Sesión requerida.');
  const payload = verifySubscriberToken(header.slice(7));
  if (!payload) throw new UnauthorizedException('Sesión inválida o expirada.');
  req.subscriberId = payload.sub;
  next();
};

// ---------------------------------------------------------------------------
// Freno del login (LoginThrottleGuard)
// ---------------------------------------------------------------------------

/**
 * Throttle anti-fuerza-bruta por IP, en memoria y sin dependencias. El estado vive
 * en el proceso; con varias instancias cada una lleva su cuenta, lo cual sigue
 * acotando el abuso.
 *
 * Se crea con una fábrica —y no como constante de módulo— para que cada punto de
 * montaje tenga su propio contador, igual que Nest instanciaba el guard por
 * controlador. Compartir el mapa entre el login de personal y el del portal haría
 * que los intentos de uno consumieran la cuota del otro.
 */
export function crearFrenoDeLogin(opciones: { max?: number; ventanaMs?: number } = {}): Middleware {
  const max = opciones.max ?? 10;
  const ventanaMs = opciones.ventanaMs ?? 5 * 60 * 1000;
  const intentos = new Map<string, number[]>();

  return (req, _res, next) => {
    const clave = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    const ahora = Date.now();
    const recientes = (intentos.get(clave) ?? []).filter((t) => ahora - t < ventanaMs);

    if (recientes.length >= max) {
      throw new HttpException(
        'Demasiados intentos de inicio de sesión. Espera unos minutos e inténtalo de nuevo.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    recientes.push(ahora);
    intentos.set(clave, recientes);
    // Limpieza oportunista para no acumular IPs viejas indefinidamente.
    if (intentos.size > 5000) {
      for (const [k, v] of intentos) {
        if (v.every((t) => ahora - t >= ventanaMs)) intentos.delete(k);
      }
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// API pública por clave (ApiKeyGuard)
// ---------------------------------------------------------------------------

/** Ventana deslizante en memoria por clave (peticiones/hora). */
const usosPorClave = new Map<string, number[]>();
const VENTANA_MS = 60 * 60 * 1000;

/**
 * Autentica por `X-API-Key` y exige los scopes indicados (semántica AND).
 * Los scopes se pasan aquí en vez de por metadatos: son parte del contrato de la
 * ruta y ahora se leen en la misma línea.
 */
export function crearApiKey(prisma: PrismaService, ...scopes: string[]): Middleware {
  return asinc(async (req, _res, next) => {
    const bruta = extractApiKey(req.headers ?? {});
    if (!bruta) throw new UnauthorizedException('Falta la cabecera X-API-Key.');

    const clave = await prisma.apiKey.findUnique({ where: { keyHash: hashApiKey(bruta) } });
    if (!clave || !clave.active || clave.revokedAt) {
      throw new UnauthorizedException('Clave de API inválida o revocada.');
    }

    // Usar SÓLO `req.ip`. Con `trust proxy` activado, Express ya resuelve la IP real
    // del cliente desde el X-Forwarded-For que fija NUESTRO proxy. Parsear el header
    // crudo tomaría el primer elemento, que lo controla el cliente: bastaría
    // `X-Forwarded-For: <ip-permitida>` para saltarse la allowlist.
    const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    if (clave.ipAllowlist.length > 0 && !clave.ipAllowlist.includes(ip)) {
      throw new ForbiddenException('IP no autorizada para esta clave.');
    }

    const faltantes = scopes.filter((s) => !clave.scopes.includes(s));
    if (faltantes.length > 0) {
      throw new ForbiddenException(`La clave no tiene los permisos: ${faltantes.join(', ')}.`);
    }

    if (!clave.ignoreLimits && clave.rateLimit > 0) {
      const ahora = Date.now();
      const arr = (usosPorClave.get(clave.id) ?? []).filter((t) => ahora - t < VENTANA_MS);
      if (arr.length >= clave.rateLimit) {
        throw new ForbiddenException('Límite de peticiones por hora superado.');
      }
      arr.push(ahora);
      usosPorClave.set(clave.id, arr);
    }

    // Auditoría ligera de uso (best-effort, no bloquea).
    void prisma.apiKey
      .update({
        where: { id: clave.id },
        data: { lastUsedAt: new Date(), lastUsedIp: ip, usageCount: { increment: 1 } },
      })
      .catch(() => undefined);

    req.apiKey = { id: clave.id, name: clave.name, scopes: clave.scopes };
    next();
  });
}

/**
 * Devuelve el usuario autenticado. Sustituye al parámetro `@CurrentUser()`.
 *
 * Lanza si no hay usuario en vez de devolver `undefined`: en Nest el decorador
 * tipaba `AuthUser` pero podía entregar `undefined` si alguien olvidaba el guard, y
 * el fallo aparecía más tarde y lejos, como un "cannot read property id of
 * undefined" dentro de un servicio. Aquí salta en la frontera y señala la ruta.
 */
export function usuarioDe(req: Request): AuthUser {
  if (!req.user) {
    throw new UnauthorizedException('Ruta sin autenticación: falta el middleware `autenticar`.');
  }
  return req.user;
}

/** Igual que `usuarioDe`, pero para las rutas del portal del abonado. */
export function abonadoDe(req: Request): string {
  if (!req.subscriberId) {
    throw new UnauthorizedException('Ruta sin sesión de abonado.');
  }
  return req.subscriberId;
}
