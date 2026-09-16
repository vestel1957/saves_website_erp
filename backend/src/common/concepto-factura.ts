/**
 * Cómo se nombra una factura en el papel de caja: `julio CTA:123456`.
 *
 * El mes de la factura más el número de cuenta, como el legacy en
 * `invoices/view-print-ltr.php`. Vive aquí porque lo usan las dos entradas del
 * recibo de rollo: la de tesorería (recaudo) y la de facturación (imprimir una
 * factura).
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

/**
 * ¿Este renglón es una AFILIACIÓN? El catálogo mezcla «Afiliación» y «Afiliacion»
 * (y arrastra nombres con espacios delante, ver [[nombres-legacy-con-espacios]]),
 * así que se compara sin tildes y sin bordes.
 */
const normalizado = (nombre: string) =>
  nombre.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

export const esAfiliacion = (nombre: string | null | undefined): boolean =>
  !!nombre && normalizado(nombre).startsWith('afiliaci');

/** \u00bfEste rengl\u00f3n es un TRASLADO? Mismo cuidado: \u00abTraslado \u00bb, \u00abtraslado\u00bb, \u00abTRASLADO INTERNET\u00bb. */
export const esTraslado = (nombre: string | null | undefined): boolean =>
  !!nombre && normalizado(nombre).startsWith('traslado');

/** Cargos que en el recibo se nombran por lo que son, no por el mes. */
const tieneNombrePropio = (nombre: string | null | undefined): boolean =>
  esAfiliacion(nombre) || esTraslado(nombre);

/**
 * Cómo se nombra UNA FACTURA en el recibo de rollo: `julio CTA:454716` — el mes de
 * la factura y su número de cuenta, y nada más.
 *
 * Vale para los dos bloques del papel: lo que se acaba de pagar y lo que sigue
 * debiendo. **Nunca el producto.** El legacy sí lo mezclaba —para una factura Fija
 * imprimía el nombre del ítem (`view-print-ltr.php:284`) y al imprimir una factura
 * suelta desglosaba sus renglones—, y por ahí se colaba el PLAN en el papel del
 * cliente: "100 Megas F-S CTA:438298", "Traslado CTA:504982", o la mensualidad
 * abierta en Internet + Televisión + punto adicional. Es una divergencia deliberada
 * y pedida (2026-09-05): en el recibo va el MES que se está pagando, sin discriminar
 * servicios. El desglose por concepto sigue estando en la factura en hoja
 * (`billing-pdf.ts`) y en la pantalla de la factura.
 *
 * LA EXCEPCIÓN es la AFILIACIÓN (2026-09-07). No es un periodo: es lo que se cobra
 * el día que el cliente entra, y rotulada por mes el papel decía «septiembre
 * CTA:505002 — $70.000», exactamente igual que una mensualidad. El cliente se iba
 * creyendo que había pagado el mes y volvía a los días a reclamar la factura del 1º.
 * Aquí no hay servicio que discriminar —el renglón dice «Afiliación Combo», no un
 * plan—, así que la regla de arriba no se rompe: se cumple mejor.
 *
 * Y el TRASLADO (2026-09-14), por lo mismo: la factura #505134 ($30.000, renglón
 * «Traslado») salía como «septiembre CTA:505134» y parecía la mensualidad.
 *
 * `invoiceDate` es columna `date` → se lee en UTC: formateado en la zona de la
 * sesión, una factura del día 1 caería en el mes anterior (ver
 * [[sql-crudo-fechas-date]]).
 */
export function conceptoFactura(inv: {
  tid: number;
  invoiceDate: Date;
  /** Sólo hace falta para reconocer afiliación y traslado; sin ítems se rotula por mes. */
  items?: { productName: string | null }[];
}): string {
  const cargo = inv.items?.find((it) => tieneNombrePropio(it.productName));
  const rotulo = cargo
    ? cargo.productName!.trim()
    : MESES[new Date(inv.invoiceDate).getUTCMonth()];
  return `${rotulo} CTA:${inv.tid}`;
}
