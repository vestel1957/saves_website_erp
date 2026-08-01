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
