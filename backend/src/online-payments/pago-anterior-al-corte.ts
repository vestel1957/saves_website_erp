/**
 * ¿Este pago del portal es ANTERIOR al último corte del abonado?
 *
 * Un pago solo puede levantar un corte que vino antes que él. Si al cliente lo
 * cortaron DESPUÉS de pagar, el corte es por otra deuda —la factura siguiente, o el
 * saldo que el pago no alcanzó a cubrir— y ese pago no la salda.
 *
 * Pasó en el arrastre del 2026-08-28 (30 días hacia atrás): el abonado 53495 pagó
 * JULIO el 30-07, lo cortaron el 24-08 por AGOSTO, y el puente lo reconectó con el
 * pago de julio. Quedó navegando con dos facturas pendientes, y como él otros siete
 * (911, 56004, 56434, 57072, 2997, 55983, 3013).
 *
 * Se compara por DÍA y el mismo día NO cuenta como anterior: las órdenes de corte del
 * legacy no tienen hora (`tickets.created` es `date`), y cortar por la mañana y pagar
 * por la tarde es justo el caso normal que sí se debe reconectar.
 */

export type OrdenParaCorte = { id: string; subscriberId: string; diaPago: string };
export type CorteDeOrden = { subscriberId: string | null; created: Date };

/**
 * Día del pago en Colombia, 'YYYY-MM-DD'.
 *
 * Sale del texto `fecha` del portal (guardado en `rawInit`), que es hora de reloj de
 * Colombia. NO de `createdAt`: la ingesta hizo `new Date(fecha)` en un proceso que corre
 * en Europe/Berlin, así que ese instante está corrido 6-7 h y un pago de las 00:30 cae
 * en el día anterior. `createdAt` queda solo de respaldo.
 */
export function diaDelPago(rawInit: unknown, createdAt: Date): string {
  const fecha = (rawInit as { fecha?: unknown } | null)?.fecha;
  if (typeof fecha === 'string' && /^\d{4}-\d{2}-\d{2}/.test(fecha)) return fecha.slice(0, 10);
  return createdAt.toISOString().slice(0, 10);
}

/** Ids de las órdenes cuyo abonado fue cortado en un día POSTERIOR al del pago. */
export function pagosAnterioresAlCorte(ordenes: OrdenParaCorte[], cortes: CorteDeOrden[]): Set<string> {
  // `Ticket.created` es `@db.Date`: medianoche UTC exacta, su parte de fecha es el día.
  const ultimoCorte = new Map<string, string>();
  for (const c of cortes) {
    if (!c.subscriberId) continue;
    const d = c.created.toISOString().slice(0, 10);
    const previo = ultimoCorte.get(c.subscriberId);
    if (!previo || d > previo) ultimoCorte.set(c.subscriberId, d);
  }
  return new Set(
    ordenes
      .filter((o) => {
        const corte = ultimoCorte.get(o.subscriberId);
        return !!corte && corte > o.diaPago;
      })
      .map((o) => o.id),
  );
}
