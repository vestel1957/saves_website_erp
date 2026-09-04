/**
 * Condición de pago de una factura (`billing_terms` del legacy).
 *
 * El recibo de caja la imprime al pie ("Condiciones: Consignacion"), y es lo único
 * que se usa de esa tabla. En el legacy vivo queda una sola fila —la 2, que llevan
 * 197.854 de las 197.856 facturas—, así que se traduce el id aquí en vez de importar
 * y sincronizar un catálogo de una fila.
 */
export const TERMINOS_PAGO: Record<number, string> = { 2: 'Consignacion' };

export const terminoDePago = (id?: number | null): string | null =>
  (id != null ? TERMINOS_PAGO[id] : undefined) ?? null;
