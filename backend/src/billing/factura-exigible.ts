/**
 * ¿Esta factura ya se puede cobrar?
 *
 * La mensualidad se emite el día 1 del mes que cubre, así que la recurrente es
 * exigible desde que nace y esto no la filtra. Lo que sí filtra es la factura de un
 * mes que TODAVÍA no ha empezado: un anticipo ([[pago-adelantado-legacy]]) o una
 * corrida manual que alguien lance con `invoiceDate` de un mes futuro.
 *
 * Ese renglón NO es mora. Todo lo que CASTIGA por deber —el paso automático a Cartera,
 * los recordatorios de cobro— tiene que contar solo lo exigible, o se manda a Cartera
 * y se sale a cobrar por un mes que aún no empieza.
 *
 * Los informes de cartera y la ficha del cliente sí muestran la factura futura: ahí no
 * se castiga a nadie, y esconderla haría que el cliente no supiera que ya existe.
 *
 * Entre el 2026-08-28 y el 2026-09-01 la recurrente se emitió un mes por adelantado y
 * este filtro era la pieza que evitaba que medio padrón cayera en Cartera. Se revirtió
 * al mes corriente (ver `CronService.scheduledRecurringBilling`), pero el filtro se
 * queda: las facturas futuras siguen existiendo por las otras dos vías.
 *
 * `invoiceDate` es columna `date` → todo en UTC (ver [[sql-crudo-fechas-date]]).
 */

/** Primer día del mes SIGUIENTE al de `d`, a medianoche UTC. */
export function inicioDelMesSiguiente(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

/** Primer día del mes de `d`, a medianoche UTC. */
export function inicioDelMes(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** ¿El mes que cubre la factura ya empezó? */
export function esExigible(invoiceDate: Date, hoy: Date): boolean {
  return invoiceDate < inicioDelMesSiguiente(hoy);
}

/**
 * Fragmento `where` de Prisma para quedarse solo con lo exigible.
 * Se compone con el resto del filtro: `{ ...whereExigible(hoy), status: {...} }`.
 */
export function whereExigible(hoy: Date) {
  return { invoiceDate: { lt: inicioDelMesSiguiente(hoy) } };
}
