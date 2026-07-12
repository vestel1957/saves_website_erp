/**
 * Utilidades de teléfono. Convención del sistema: guardamos los números en
 * formato E.164 SIN el '+', es decir solo dígitos con código de país
 * (ej. 573001112233). Como la empresa opera en Colombia, si el usuario escribe
 * un número local de 10 dígitos le anteponemos el 57 automáticamente: así nadie
 * tiene que teclear el código de país y el dato queda listo para WhatsApp/alertas.
 */

/** Código de país por defecto (Colombia). */
const DEFAULT_COUNTRY = '57';

/**
 * Normaliza un teléfono a E.164 sin '+'. Asume Colombia cuando el número viene
 * sin código de país (10 dígitos). Devuelve solo dígitos, o null si va vacío.
 */
export function normalizePhone(raw?: string | null): string | null {
  if (raw == null) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  // Prefijo internacional "00" → quitarlo (ej. 0057300… → 57300…).
  if (digits.startsWith('00')) digits = digits.slice(2);
  // Número local colombiano (10 dígitos, móvil 3xx o fijo) → anteponer el 57.
  if (digits.length === 10) digits = DEFAULT_COUNTRY + digits;
  return digits;
}

/** ¿Es un teléfono válido tras normalizar? (E.164: 10–15 dígitos). */
export function isValidPhone(normalized?: string | null): boolean {
  return !!normalized && /^\d{10,15}$/.test(normalized);
}
