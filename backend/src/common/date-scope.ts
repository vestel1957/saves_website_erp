/**
 * Alcance de fecha por defecto = AÑO ACTUAL, para acelerar listas/stats
 * (la data de años anteriores es ~90% del volumen y casi no se consulta).
 * Override: pasar `from`/`to` para un rango específico, o `all` para todo el histórico.
 * NO se aplica a cartera/deuda (que es saldo, no fecha) — esa se calcula siempre completa.
 */
export function scopeDate(
  from?: string,
  to?: string,
  all?: string | boolean,
): { gte?: Date; lte?: Date } | undefined {
  if (all === '1' || all === 'true' || all === true) return undefined; // histórico completo
  if (from || to) {
    const r: { gte?: Date; lte?: Date } = {};
    if (from) r.gte = new Date(from);
    if (to) r.lte = new Date(to);
    return r;
  }
  const year = new Date().getFullYear();
  return { gte: new Date(`${year}-01-01T00:00:00.000Z`) }; // por defecto: desde el 1 de enero de este año
}

export function currentYear(): number {
  return new Date().getFullYear();
}
