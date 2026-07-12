/**
 * Teléfonos en formato E.164 sin '+': solo dígitos con código de país
 * (ej. 573001112233). Como operamos en Colombia, si el usuario escribe un
 * número local de 10 dígitos le anteponemos el 57 automáticamente — nadie tiene
 * que teclear el código de país. Debe coincidir con backend/src/common/phone.util.ts.
 */

const DEFAULT_COUNTRY = "57";

/** Normaliza a E.164 sin '+'. Asume Colombia si vienen 10 dígitos. "" si va vacío. */
export function normalizePhone(raw?: string | null): string {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length === 10) digits = DEFAULT_COUNTRY + digits;
  return digits;
}

/** ¿Teléfono válido tras normalizar? (E.164: 10–15 dígitos). */
export function isValidPhone(raw?: string | null): boolean {
  return /^\d{10,15}$/.test(normalizePhone(raw));
}
