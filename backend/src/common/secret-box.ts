import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

/**
 * secret-box — cifrado simétrico en reposo para credenciales de dispositivos
 * (NBI de GenieACS, y extensible a Mikrotik/OLT). AES-256-GCM: confidencialidad
 * + autenticación (el tag detecta manipulación).
 *
 * La llave se deriva (scrypt) de `SECRET_ENC_KEY` — o `AUTH_SECRET` como respaldo,
 * así no hay que configurar una variable nueva para arrancar. En producción es
 * OBLIGATORIA: si falta, cifrar/descifrar aborta en vez de usar una llave débil
 * conocida (credenciales triviales de recuperar). En desarrollo hay fallback.
 *
 * Compatibilidad hacia atrás: `decryptSecret` devuelve TAL CUAL cualquier valor
 * que NO tenga el prefijo `enc:v1:` (las filas viejas en texto plano siguen
 * funcionando). Al reguardarse desde la UI quedan cifradas. `encryptSecret('')`
 * devuelve '' (no ciframos el vacío: "sin credencial" se distingue a simple vista).
 */

const PREFIX = 'enc:v1:';
const IV_LEN = 12; // GCM estándar
const TAG_LEN = 16;

let keyCache: Buffer | null = null;

function getKey(): Buffer {
  if (keyCache) return keyCache;
  const secret = process.env.SECRET_ENC_KEY || process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'SECRET_ENC_KEY/AUTH_SECRET no está definido (o es muy corto): no se pueden cifrar credenciales en producción.',
      );
    }
    // Solo desarrollo: llave derivada de un valor conocido para no frenar el flujo local.
    keyCache = scryptSync('nexus-dev-secret-change-me', 'saves-secret-box', 32);
    return keyCache;
  }
  keyCache = scryptSync(secret, 'saves-secret-box', 32);
  return keyCache;
}

/** ¿El valor almacenado está cifrado por este módulo? */
export function isEncrypted(stored: string | null | undefined): boolean {
  return typeof stored === 'string' && stored.startsWith(PREFIX);
}

/** Cifra una credencial para guardarla. El vacío se deja vacío. */
export function encryptSecret(plain: string | null | undefined): string {
  if (!plain) return '';
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

/**
 * Descifra una credencial guardada. Los valores en texto plano (sin prefijo) se
 * devuelven tal cual (legacy). Si el texto cifrado no se puede abrir (llave
 * cambiada / dato corrupto) devuelve '' en vez de reventar, para que la acción
 * falle limpio como "sin credencial / credenciales inválidas".
 */
export function decryptSecret(stored: string | null | undefined): string {
  if (!stored) return '';
  if (!isEncrypted(stored)) return stored; // legacy en texto plano
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const iv = raw.subarray(0, IV_LEN);
    const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = raw.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}
