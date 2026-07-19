/** Campos de nombre "partidos" del modelo legacy de suscriptor. */
export type SubscriberNameParts = {
  firstName: string | null;
  secondName: string | null;
  lastName1: string | null;
  lastName2: string | null;
  companyName: string | null;
  fullName: string | null;
};

/**
 * Nombre visible del suscriptor a partir de los campos legacy partidos.
 * Prioridad: fullName → nombre+apellidos → razón social. Devuelve `null` si no hay nada.
 *
 * Helper canónico: reemplaza las ~14 copias locales de `subName`.
 */
export function subName(s: SubscriberNameParts | null | undefined): string | null {
  if (!s) return null;
  if (s.fullName && s.fullName.trim()) return s.fullName.trim();
  const person = [s.firstName, s.secondName, s.lastName1, s.lastName2]
    .map((p) => (p || '').trim())
    .filter(Boolean)
    .join(' ');
  return person || (s.companyName || '').trim() || null;
}

/** Igual que `subName` pero con un texto de reserva cuando no hay nombre. */
export function displayName(s: SubscriberNameParts, fallback = 'Sin nombre'): string {
  return subName(s) ?? fallback;
}
