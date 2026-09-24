import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'crypto';

/**
 * Zero-dependency auth primitives built on Node's crypto.
 * - Passwords: scrypt with a per-user random salt, stored as `salt:hash` (hex).
 * - Tokens: compact HMAC-SHA256 signed token (JWT-shaped) — no external libs.
 * - Compatibilidad legacy: hashes migrados de Aauth (vestel) se guardan como
 *   `aauth:<salt>:<sha256hex>` donde salt = md5(id legacy) y hash = sha256(salt+clave).
 *   Se aceptan en el login y se re-hashean a scrypt en el primer acceso exitoso.
 */

const TOKEN_TTL_SECONDS = 60 * 60 * 12; // 12h

/**
 * Resuelve el secreto de firma de forma perezosa (en cada uso), no al importar
 * el módulo: así respeta el `AUTH_SECRET` que pm2/ConfigModule inyectan al
 * arrancar. En producción es OBLIGATORIO — si falta, abortamos en vez de firmar
 * con un secreto débil y conocido (tokens forjables). En desarrollo se permite
 * un fallback para no frenar el flujo local.
 */
function getSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (secret && secret.length >= 16) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'AUTH_SECRET no está definido (o es muy corto). Configúralo con un valor aleatorio largo antes de arrancar en producción.',
    );
  }
  return 'nexus-dev-secret-change-me';
}

export function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(plain, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  if (stored.startsWith('aauth:')) {
    const [, salt, hash] = stored.split(':');
    if (!salt || !hash) return false;
    const derived = createHash('sha256').update(salt + plain).digest();
    const expected = Buffer.from(hash, 'hex');
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  }
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const derived = scryptSync(plain, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** true si el hash guardado es del esquema legacy (Aauth) y conviene re-hashear a scrypt. */
export function isLegacyHash(stored: string): boolean {
  return stored.startsWith('aauth:');
}

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64url');

export interface TokenPayload {
  sub: string; // user id
  email: string;
  name: string;
  iat: number;
  exp: number;
  /** Slugs de área de acceso (p.ej. ["contabilidad"]) para el gate del edge middleware. */
  areas?: string[];
  /** true si el usuario es superadministrador (ve/accede a todo). */
  sa?: boolean;
  /**
   * true si es JEFE DE BODEGA (`inventory.admin`). Va aparte de `areas` porque no
   * es un área: el rol no tiene ninguna, y sin embargo la API le abre las rutas de
   * equipos con `@OrPermission(INV_PERMISSIONS.ADMIN)`. Sin este claim el edge lo
   * rebotaba antes de cargar la única pantalla que tiene (Transferencias de
   * equipos), que es justo la que él y nadie más puede armar.
   */
  inv?: boolean;
  /**
   * Tiene la pantalla Proyectos concedida a título personal (`screen.proyectos`).
   * Es el caso de los técnicos autorizados uno a uno (2026-09-21): su área no es la
   * dueña de /proyectos y el edge los rebotaba aunque la API ya los dejara pasar.
   */
  prj?: boolean;
}

export function signToken(
  user: { id: string; email: string; name: string },
  claims?: { areas?: string[]; sa?: boolean; inv?: boolean; prj?: boolean },
): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    JSON.stringify({
      sub: user.id,
      email: user.email,
      name: user.name,
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
      // Si se pasan claims, `areas` se emite SIEMPRE (aunque sea []) para que el
      // middleware distinga un token nuevo (enforce) de uno viejo sin el claim.
      ...(claims ? { areas: claims.areas ?? [], sa: !!claims.sa, inv: !!claims.inv, prj: !!claims.prj } : {}),
    }),
  );
  const signature = createHmac('sha256', getSecret())
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

// ── Tokens de ABONADO (portal de autoservicio) ──────────────────────────────
// Token separado del de staff: lleva `kind:'subscriber'`. Aunque comparte firma
// (mismo AUTH_SECRET), los guards de staff lo rechazan porque `sub` no es un
// empleado (resolveUser → null), y el guard del portal exige kind='subscriber'.
const SUBSCRIBER_TTL_SECONDS = 60 * 60 * 4; // 4h

export interface SubscriberTokenPayload {
  sub: string; // subscriber id
  kind: 'subscriber';
  abonado: number;
  iat: number;
  exp: number;
}

export function signSubscriberToken(sub: { id: string; abonado: number }): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    JSON.stringify({ sub: sub.id, kind: 'subscriber', abonado: sub.abonado, iat: now, exp: now + SUBSCRIBER_TTL_SECONDS }),
  );
  const signature = createHmac('sha256', getSecret()).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export function verifySubscriberToken(token: string): SubscriberTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const expected = createHmac('sha256', getSecret()).update(`${header}.${payload}`).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString()) as SubscriberTokenPayload;
    if (decoded.kind !== 'subscriber' || decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return decoded;
  } catch {
    return null;
  }
}

/** Returns the decoded payload, or null when the token is invalid/expired. */
export function verifyToken(token: string): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const expected = createHmac('sha256', getSecret())
    .update(`${header}.${payload}`)
    .digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString()) as TokenPayload;
    if (decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return decoded;
  } catch {
    return null;
  }
}
