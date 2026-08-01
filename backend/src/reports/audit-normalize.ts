/**
 * Normalización de la bitácora de auditoría para poder agruparla.
 *
 * `AuditLog.entity` y `.action` no guardan un nombre de entidad y un verbo, sino
 * la ruta HTTP con los IDs incrustados:
 *
 *   entity: "orders/cmrxqyhsm0007dzciiz4swt7d"
 *   action: "POST /support/tickets/cmrtp1j100001dz8t0hrhq7ot/status"
 *
 * Agrupar por esos valores tal cual produce un valor único por registro —en la
 * base viva son ~130 "entidades" y ~180 "acciones" distintas para 500 eventos—,
 * o sea un reporte que no agrupa nada. Aquí se reemplazan los identificadores por
 * `:id` y se extrae el módulo, que es lo que un humano quiere leer.
 *
 * Corregir el origen (guardar entidad y acción separadas al escribir la bitácora)
 * sería lo correcto, pero cambiaría el formato de los 500 registros existentes;
 * esto los deja legibles sin tocar lo ya escrito.
 */

/** Un cuid de Prisma: 'c' + ~24 alfanuméricos. */
const CUID = /\/c[a-z0-9]{20,}/g;
const UUID = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const NUMERICO = /\/\d+/g;

/** Sustituye los identificadores de una ruta por `:id`. */
export function normalizarRuta(valor: string | null | undefined): string {
  if (!valor) return '—';
  return valor.replace(CUID, '/:id').replace(UUID, '/:id').replace(NUMERICO, '/:id');
}

/**
 * Módulo al que pertenece el evento: el primer tramo de la ruta.
 *
 *   "support/tickets/cmr…"  → "support"
 *   "login"                  → "login"
 *   "network/olt"            → "network"
 */
export function moduloDe(entity: string | null | undefined): string {
  const e = (entity ?? '').trim();
  if (!e) return '—';
  // A minúsculas porque la bitácora escribe "Auth" en unos sitios y "auth" en
  // otros: sin esto salen como dos módulos distintos en el mismo reporte.
  const primero = e.split('/')[0]?.trim().toLowerCase();
  return primero || '—';
}
