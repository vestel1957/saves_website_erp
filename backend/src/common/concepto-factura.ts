/**
 * Cómo se nombra una factura en el papel de caja: `julio CTA:123456`.
 *
 * Es literalmente lo que hacía el legacy en `invoices/view-print-ltr.php`: el mes de
 * la factura —o el nombre del producto cuando es una factura fija, que no tiene
 * mes— más el número de cuenta. Vive aquí porque lo usan tanto el recibo de caja
 * (tesorería) como la impresión de la factura (facturación).
 *
 * `invoiceDate` es columna `date`, así que el mes se lee en UTC: en la zona de la
 * sesión, una factura del día 1 se leería como del mes anterior (ver
 * [[sql-crudo-fechas-date]]).
 */
const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/**
 * Lo que se está pagando en un renglón de recaudo: `{ mes, concepto }`.
 *
 * El MES sale siempre de `invoiceDate` (no hay columna de periodo, ni aquí ni en el
 * legacy). En la recurrente el mes de emisión ES el mes cobrado; en la FIJA no es un
 * periodo de servicio sino el mes en que se generó el cargo, y por eso a esa se le
 * añade el CONCEPTO (instalación, reconexión, o la mensualidad re-facturada a mano,
 * que en esta base también viaja como FIJA). Sin el concepto, una fija se leería como
 * si fuera la mensualidad de ese mes.
 *
 * `invoiceDate` es columna `date` → se lee en UTC (ver [[sql-crudo-fechas-date]]).
 */
export function periodoDeFactura(inv: {
  kind: string;
  invoiceDate: Date;
  items?: { productName: string | null }[];
}): { mes: string; concepto: string | null } {
  const d = new Date(inv.invoiceDate);
  return {
    mes: `${MESES[d.getUTCMonth()]} de ${d.getUTCFullYear()}`,
    concepto: inv.kind === 'FIJA' ? (inv.items?.[0]?.productName || 'Cargo') : null,
  };
}

/**
 * El mismo rótulo, pero para un mes que TODAVÍA NO SE HA FACTURADO: el pago
 * adelantado. Se reusa el `tid` de la factura del recibo, exactamente como el legacy
 * (`view-print-ltr2.php:288` imprime `Septiembre CTA : <tid de la factura pagada>`),
 * porque la factura de ese mes no existe: nace en la corrida del día 1.
 */
export function conceptoMesAdelantado(fecha: Date, tid: number | null): string {
  const mes = MESES[new Date(fecha).getUTCMonth()];
  return tid == null ? mes : `${mes} CTA:${tid}`;
}

export function conceptoFactura(inv: {
  tid: number;
  kind: string;
  invoiceDate: Date;
  items?: { productName: string | null }[];
}): string {
  const base = inv.kind === 'FIJA'
    ? (inv.items?.[0]?.productName || 'Cargo')
    : MESES[new Date(inv.invoiceDate).getUTCMonth()];
  return `${base} CTA:${inv.tid}`;
}
