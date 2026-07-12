import { createHmac, randomBytes } from 'crypto';

/**
 * Primitivas de las claves de API públicas. La clave en claro se muestra UNA
 * sola vez al crearla; en la BD guardamos únicamente `keyHash` (HMAC-SHA256 con
 * pepper = AUTH_SECRET). Formato: `sv_live_<48 hex>`.
 */

function pepper(): string {
  const s = process.env.AUTH_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('AUTH_SECRET requerido para firmar claves de API.');
  }
  return 'nexus-dev-secret-change-me';
}

export function generateApiKey(): { key: string; keyHash: string; keyPrefix: string } {
  const key = `sv_live_${randomBytes(24).toString('hex')}`;
  return { key, keyHash: hashApiKey(key), keyPrefix: `${key.slice(0, 14)}…` };
}

export function hashApiKey(key: string): string {
  return createHmac('sha256', pepper()).update(key.trim()).digest('hex');
}

/** Extrae la clave de `X-API-Key` o de `Authorization: ApiKey <clave>`. */
export function extractApiKey(headers: Record<string, unknown>): string | null {
  const x = headers['x-api-key'];
  if (typeof x === 'string' && x.trim()) return x.trim();
  const auth = headers['authorization'];
  if (typeof auth === 'string') {
    const m = auth.match(/^ApiKey\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  return null;
}
